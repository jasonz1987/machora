import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import ssh2 from "ssh2";
import { getConfigDir } from "../store.mjs";

const { Client, utils } = ssh2;
const MAX_OUTPUT = 64 * 1024;

export const sshDeploymentProvider = {
  type: "ssh",
  label: "SSH server",
  probe: probeSshTarget,
  bootstrap: bootstrapSshTarget,
  authorizeHost: authorizeSshHost,
  revokeHost: revokeSshHost,
  remove: removeSshTarget,
};

export async function probeSshTarget(input) {
  const config = normalizeSshTargetInput(input);
  if (!config.password) throw badRequest("SSH password is required for the initial trust setup");
  const connection = await connect({ ...config, password: config.password });
  try {
    const result = await execRemote(connection.client, "printf 'machora-controller-ready'");
    if (result.code !== 0 || result.stdout !== "machora-controller-ready") throw new Error(result.stderr || "SSH connection check failed");
    return {
      provider: "ssh",
      host: config.host,
      port: config.port,
      username: config.username,
      hostKey: connection.hostKey,
    };
  } finally {
    connection.client.end();
  }
}

export async function bootstrapSshTarget({ id, name, input }) {
  const config = normalizeSshTargetInput(input);
  if (!config.password) throw badRequest("SSH password is required for the initial trust setup");
  const expectedFingerprint = normalizeFingerprint(input.hostFingerprint);
  if (!expectedFingerprint) throw badRequest("Confirm the server fingerprint before establishing trust");
  const credentialDirectory = path.join(getConfigDir(), "deployments", id);
  const privateKeyPath = path.join(credentialDirectory, "controller_ed25519");
  const publicKeyPath = `${privateKeyPath}.pub`;
  const marker = controllerMarker(id);
  const keys = utils.generateKeyPairSync("ed25519", { comment: marker });
  const publicKey = taggedPublicKey(keys.public, marker);
  let passwordConnection;
  let observedHostKey;
  try {
    passwordConnection = await connect({ ...config, password: config.password, expectedFingerprint });
    observedHostKey = passwordConnection.hostKey;
    await installAuthorizedKey(passwordConnection.client, publicKey, marker);
    passwordConnection.client.end();
    passwordConnection = null;

    await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
    await writeFile(privateKeyPath, keys.private, { mode: 0o600 });
    await writeFile(publicKeyPath, `${publicKey}\n`, { mode: 0o600 });
    const verified = await connect({ ...config, privateKey: keys.private, expectedFingerprint });
    try {
      const result = await execRemote(verified.client, "printf 'machora-key-ready'");
      if (result.code !== 0 || result.stdout !== "machora-key-ready") throw new Error(result.stderr || "Controller key verification failed");
    } finally {
      verified.client.end();
    }
    return {
      id,
      name,
      provider: "ssh",
      config: { host: config.host, port: config.port, username: config.username },
      hostKey: observedHostKey || { fingerprint: expectedFingerprint, algorithm: input.hostKeyAlgorithm || null },
      controllerCredential: {
        privateKeyPath,
        publicKeyPath,
        fingerprint: publicKeyFingerprint(publicKey),
        marker,
      },
      status: "ready",
      authorizations: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString(),
    };
  } catch (error) {
    passwordConnection?.client.end();
    if (observedHostKey) {
      const cleanupConnection = await connect({ ...config, password: config.password, expectedFingerprint }).catch(() => null);
      if (cleanupConnection) {
        await removeAuthorizedKey(cleanupConnection.client, marker).catch(() => {});
        cleanupConnection.client.end();
      }
    }
    await rm(credentialDirectory, { recursive: true, force: true }).catch(() => {});
    throw deploymentError(error);
  }
}

export async function authorizeSshHost(target, authorization) {
  const publicKey = taggedPublicKey(authorization.publicKey, authorization.marker);
  const connection = await connectToTarget(target);
  try {
    await installAuthorizedKey(connection.client, publicKey, authorization.marker);
  } finally {
    connection.client.end();
  }
}

export async function revokeSshHost(target, authorization) {
  const connection = await connectToTarget(target);
  try {
    await removeAuthorizedKey(connection.client, authorization.marker);
  } finally {
    connection.client.end();
  }
}

export async function removeSshTarget(target) {
  const directory = path.dirname(target.controllerCredential.privateKeyPath);
  const connection = await connectToTarget(target);
  try {
    await removeAuthorizedKey(connection.client, target.controllerCredential.marker);
  } finally {
    connection.client.end();
  }
  await rm(directory, { recursive: true, force: true });
}

export function normalizeSshTargetInput(input = {}) {
  const host = String(input.host || "").trim();
  const username = String(input.username || "").trim();
  const port = Number(input.port || 22);
  if (!host || host.length > 255 || /[\s/@]/.test(host)) throw badRequest("Enter a valid SSH hostname or IP address");
  if (!/^[a-z_][a-z0-9_.-]{0,63}$/i.test(username)) throw badRequest("Enter a valid SSH username");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw badRequest("SSH port must be an integer from 1 to 65535");
  return { host, port, username, password: String(input.password || "") };
}

export function publicKeyFingerprint(publicKey) {
  const fields = String(publicKey || "").trim().split(/\s+/);
  if (fields.length < 2 || !/^(?:ssh-|ecdsa-)/.test(fields[0])) throw badRequest("Invalid SSH public key");
  return sshFingerprint(Buffer.from(fields[1], "base64"));
}

export function sshFingerprint(key) {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

function normalizeFingerprint(value) {
  const fingerprint = String(value || "").trim();
  return /^SHA256:[A-Za-z0-9+/]{20,}$/.test(fingerprint) ? fingerprint : "";
}

function hostKeyAlgorithm(key) {
  if (!Buffer.isBuffer(key) || key.length < 5) return "unknown";
  const length = key.readUInt32BE(0);
  return length > 0 && length <= key.length - 4 ? key.subarray(4, 4 + length).toString("utf8") : "unknown";
}

function connect(options) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let observedHostKey = null;
    let fingerprintMismatch = false;
    const fail = (error) => {
      client.removeAllListeners();
      client.end();
      reject(fingerprintMismatch
        ? Object.assign(new Error("SSH server fingerprint changed; connection refused"), { statusCode: 409 })
        : deploymentError(error));
    };
    client.once("ready", () => resolve({ client, hostKey: observedHostKey }));
    client.once("error", fail);
    client.connect({
      host: options.host,
      port: options.port,
      username: options.username,
      password: options.password || undefined,
      privateKey: options.privateKey || undefined,
      readyTimeout: 15_000,
      keepaliveInterval: 5_000,
      keepaliveCountMax: 2,
      hostVerifier(key) {
        const fingerprint = sshFingerprint(key);
        observedHostKey = { fingerprint, algorithm: hostKeyAlgorithm(key) };
        if (options.expectedFingerprint && fingerprint !== options.expectedFingerprint) {
          fingerprintMismatch = true;
          return false;
        }
        return true;
      },
    });
  });
}

async function connectToTarget(target) {
  const privateKey = await readFile(target.controllerCredential.privateKeyPath, "utf8");
  return connect({
    ...target.config,
    privateKey,
    expectedFingerprint: target.hostKey.fingerprint,
  });
}

function execRemote(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error);
      let stdout = "";
      let stderr = "";
      stream.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-MAX_OUTPUT); });
      stream.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-MAX_OUTPUT); });
      stream.once("error", reject);
      stream.once("close", (code) => resolve({ code: Number(code ?? 0), stdout: stdout.trim(), stderr: stderr.trim() }));
    });
  });
}

async function installAuthorizedKey(client, publicKey, marker) {
  const key = taggedPublicKey(publicKey, marker);
  const command = [
    "umask 077",
    "mkdir -p \"$HOME/.ssh\"",
    "touch \"$HOME/.ssh/authorized_keys\"",
    `{ grep -vF ${shellQuote(marker)} \"$HOME/.ssh/authorized_keys\" > \"$HOME/.ssh/authorized_keys.machora\" || true; }`,
    `printf '%s\\n' ${shellQuote(key)} >> \"$HOME/.ssh/authorized_keys.machora\"`,
    "mv \"$HOME/.ssh/authorized_keys.machora\" \"$HOME/.ssh/authorized_keys\"",
    "chmod 700 \"$HOME/.ssh\"",
    "chmod 600 \"$HOME/.ssh/authorized_keys\"",
  ].join(" && ");
  const result = await execRemote(client, command);
  if (result.code !== 0) throw new Error(result.stderr || "Could not install the SSH public key");
}

async function removeAuthorizedKey(client, marker) {
  const command = [
    "umask 077",
    "mkdir -p \"$HOME/.ssh\"",
    "touch \"$HOME/.ssh/authorized_keys\"",
    `{ grep -vF ${shellQuote(marker)} \"$HOME/.ssh/authorized_keys\" > \"$HOME/.ssh/authorized_keys.machora\" || true; }`,
    "mv \"$HOME/.ssh/authorized_keys.machora\" \"$HOME/.ssh/authorized_keys\"",
    "chmod 600 \"$HOME/.ssh/authorized_keys\"",
  ].join(" && ");
  const result = await execRemote(client, command);
  if (result.code !== 0) throw new Error(result.stderr || "Could not revoke the SSH public key");
}

function taggedPublicKey(value, marker) {
  const fields = String(value || "").trim().split(/\s+/);
  if (fields.length < 2 || !/^(?:ssh-|ecdsa-)/.test(fields[0]) || !/^[A-Za-z0-9+/=]+$/.test(fields[1])) throw badRequest("Invalid SSH public key");
  return `${fields[0]} ${fields[1]} ${marker}`;
}

function controllerMarker(targetId) {
  return `machora:controller:${targetId}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function deploymentError(error) {
  if (error?.statusCode) return error;
  const message = String(error?.message || "SSH connection failed")
    .replace(/All configured authentication methods failed/i, "SSH authentication failed")
    .replace(/Timed out while waiting for handshake/i, "SSH connection timed out");
  return Object.assign(new Error(message), { statusCode: /authentication/i.test(message) ? 401 : 502 });
}
