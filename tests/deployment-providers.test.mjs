import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ssh2 from "ssh2";
import { bootstrapSshTarget, normalizeSshTargetInput, probeSshTarget, publicKeyFingerprint, removeSshTarget, sshFingerprint } from "../lib/deployment-providers/ssh.mjs";

test("validates SSH deployment target connection fields", () => {
  assert.deepEqual(normalizeSshTargetInput({ host: "deploy.example.com", port: "2222", username: "release", password: "once" }), { host: "deploy.example.com", port: 2222, username: "release", password: "once" });
  assert.throws(() => normalizeSshTargetInput({ host: "bad host", username: "release" }), /valid SSH hostname/);
  assert.throws(() => normalizeSshTargetInput({ host: "deploy.example.com", port: 70000, username: "release" }), /1 to 65535/);
});

test("creates stable SHA256 fingerprints for server and user keys", () => {
  assert.equal(sshFingerprint(Buffer.from("machora")), "SHA256:Rv6C9DGezzwPl/JyyRXDsCL0sH+L5WMPlOpqpuGkJFI");
  const keys = ssh2.utils.generateKeyPairSync("ed25519", { comment: "machora-test" });
  assert.match(publicKeyFingerprint(keys.public), /^SHA256:[A-Za-z0-9+/]{40,}$/);
});

test("probes, bootstraps, verifies, and removes controller SSH trust", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "machora-ssh-provider-"));
  const previousConfigDirectory = process.env.MACHORA_CONFIG_DIR;
  process.env.MACHORA_CONFIG_DIR = temporaryDirectory;
  const hostKeys = ssh2.utils.generateKeyPairSync("ed25519", { comment: "machora-test-server" });
  const commands = [];
  const server = new ssh2.Server({ hostKeys: [hostKeys.private] }, (client) => {
    client.on("authentication", (context) => {
      if (context.method === "password" && context.password === "one-time-password") context.accept();
      else if (context.method === "publickey") context.accept();
      else context.reject();
    });
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("exec", (acceptExec, _reject, info) => {
        commands.push(info.command);
        const stream = acceptExec();
        if (info.command.includes("machora-controller-ready")) stream.write("machora-controller-ready");
        if (info.command.includes("machora-key-ready")) stream.write("machora-key-ready");
        stream.exit(0); stream.end();
      });
    }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  const input = { provider: "ssh", host: "127.0.0.1", port, username: "deploy", password: "one-time-password" };
  try {
    const probe = await probeSshTarget(input);
    assert.equal(probe.hostKey.fingerprint, publicKeyFingerprint(hostKeys.public));
    const target = await bootstrapSshTarget({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "test-server", input: { ...input, hostFingerprint: probe.hostKey.fingerprint } });
    assert.equal(target.status, "ready"); assert.equal(Object.hasOwn(target.config, "password"), false);
    assert.match(await readFile(target.controllerCredential.privateKeyPath, "utf8"), /OPENSSH PRIVATE KEY/);
    assert.ok(commands.some((command) => command.includes("machora:controller:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")));
    await removeSshTarget(target);
    await assert.rejects(() => readFile(target.controllerCredential.privateKeyPath, "utf8"), /ENOENT/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousConfigDirectory == null) delete process.env.MACHORA_CONFIG_DIR;
    else process.env.MACHORA_CONFIG_DIR = previousConfigDirectory;
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
