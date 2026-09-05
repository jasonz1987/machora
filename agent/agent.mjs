#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const VERSION = "0.11.5";
const runtimeTools = new Set(["node", "java", "python"]);
const runtimeInventoryRefreshInterval = 5 * 60_000;
const toolInventoryRefreshInterval = 5 * 60_000;
const heartbeatTimeout = 10_000;
const heartbeatRetryDelays = [2_000, 5_000, 10_000];
let cachedTools = [{ id: "node", name: "Node.js", version: process.versions.node }];
let toolInventoryUpdatedAt = null;
let toolInventoryRefreshPromise;
let cachedManagedInventory;
let managedInventoryUpdatedAt = null;
let managedInventoryRefreshPromise;
let cachedWindowsPaths;
const legacyAgentDirectory = path.join(os.homedir(), ".rdev-agent");
const defaultAgentDirectory = path.join(os.homedir(), ".machora-agent");
const agentDirectory = process.env.MACHORA_AGENT_DIR
  || process.env.RDEV_AGENT_DIR
  || (!existsSync(path.join(defaultAgentDirectory, "config.json")) && existsSync(path.join(legacyAgentDirectory, "config.json")) ? legacyAgentDirectory : defaultAgentDirectory);
const configPath = path.join(agentDirectory, "config.json");
let executionEnvironment;
refreshExecutionEnvironment();
const [, , command = "run", ...argumentsList] = process.argv;

try {
  if (command === "enroll") await enroll(parseOptions(argumentsList));
  else if (command === "run") await runAgent(parseOptions(argumentsList));
  else if (["version", "--version", "-v"].includes(command)) console.log(VERSION);
  else printHelp(1);
} catch (error) {
  log("error", error.message);
  process.exitCode = 1;
}

async function enroll(options) {
  const controller = normalizeController(options.controller);
  if (!options.token) throw new Error("Missing --token");
  await Promise.all([refreshDetectedTools(), refreshManagedRuntimeInventory()]);
  const report = await machineReport();
  const response = await fetch(`${controller}/api/enroll/${encodeURIComponent(options.token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(report),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Enrollment failed with HTTP ${response.status}`);
  if (!result.credentials?.agentId || !result.credentials?.secret) throw new Error("Controller did not return Agent credentials");
  const workspace = resolveWorkspace(result.host.workspace);
  await mkdir(workspace, { recursive: true });
  await writeConfig({
    version: 1,
    controller,
    agentId: result.credentials.agentId,
    secret: result.credentials.secret,
    alias: result.host.alias,
    workspace,
    enrolledAt: new Date().toISOString(),
  });
  console.log(`machora Agent enrolled as ${result.host.alias}`);
}

async function runAgent(options) {
  const config = await readConfig();
  let stopping = false;
  let activeJob = null;
  let completedJobs = [];
  if (options.once) await Promise.all([refreshDetectedTools(), refreshManagedRuntimeInventory()]);
  let backgroundInventoryStarted = false;
  const refreshBackgroundInventory = () => {
    if (activeJob) return;
    refreshDetectedTools().catch((error) => log("warn", `tool inventory refresh failed: ${error.message}`));
    refreshManagedRuntimeInventory().catch((error) => log("warn", `runtime inventory refresh failed: ${error.message}`));
  };
  const runtimeRefreshTimer = setInterval(() => {
    refreshBackgroundInventory();
  }, runtimeInventoryRefreshInterval);
  runtimeRefreshTimer.unref?.();
  const toolRefreshTimer = setInterval(() => {
    if (!activeJob) refreshDetectedTools().catch((error) => log("warn", `tool inventory refresh failed: ${error.message}`));
  }, toolInventoryRefreshInterval);
  toolRefreshTimer.unref?.();
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });
  do {
    try {
      const result = await sendHeartbeat(config, completedJobs, activeJob?.progress ? [activeJob.progress] : []);
      completedJobs = [];
      log("info", `heartbeat accepted for ${result.host.alias}`);
      if (!backgroundInventoryStarted) {
        backgroundInventoryStarted = true;
        setTimeout(refreshBackgroundInventory, 0).unref?.();
      }
      const nextJob = result.jobs?.find((job) => job.id !== activeJob?.id);
      if (!activeJob && nextJob) {
        const jobState = { id: nextJob.id, progress: { id: nextJob.id, status: "running", currentStep: null, steps: nextJob.steps || [], startedAt: new Date().toISOString() } };
        jobState.promise = executeJob(config, nextJob, (progress) => { jobState.progress = progress; });
        activeJob = jobState;
        jobState.promise.then((jobResult) => completedJobs.push(jobResult)).finally(() => { activeJob = null; });
      }
    } catch (error) {
      log("warn", error.message);
      if (options.once) throw error;
    }
    if (options.once) {
      if (activeJob) {
        const pendingJob = activeJob.promise;
        await pendingJob;
        activeJob = null;
        await sendHeartbeat(config, completedJobs, []);
        completedJobs = [];
      }
      break;
    }
    if (stopping) break;
    if (activeJob) await Promise.race([delay(2_000), activeJob.promise.catch(() => {})]);
    else await delay(10_000);
  } while (!stopping);
  clearInterval(runtimeRefreshTimer);
  clearInterval(toolRefreshTimer);
}

async function sendHeartbeat(config, jobResults = [], jobUpdates = []) {
  const body = JSON.stringify({ ...await machineReport(config.workspace), jobResults, jobUpdates });
  let lastError;
  for (let attempt = 0; attempt <= heartbeatRetryDelays.length; attempt += 1) {
    try {
      const response = await fetch(`${config.controller}/api/agent/heartbeat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.secret}`,
          "x-machora-agent-id": config.agentId,
        },
        body,
        signal: AbortSignal.timeout(heartbeatTimeout),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Heartbeat failed with HTTP ${response.status}`);
      return result;
    } catch (error) {
      lastError = error;
      if (attempt === heartbeatRetryDelays.length) break;
      await delay(heartbeatRetryDelays[attempt]);
    }
  }
  throw new Error(`Heartbeat failed after ${heartbeatRetryDelays.length + 1} attempts: ${lastError?.message || "unknown error"}`);
}

async function executeJob(config, job, onProgress = () => {}) {
  const startedAt = new Date().toISOString();
  const steps = (job.steps || []).map((step) => ({ ...step, status: "pending", startedAt: null, finishedAt: null }));
  let liveOutput = "";
  const report = (currentStep = null, output = liveOutput) => {
    liveOutput = String(output || "").slice(-32 * 1024);
    onProgress({ id: job.id, status: "running", currentStep, steps: steps.map((step) => ({ ...step })), startedAt, output: liveOutput });
  };
  const runStep = async (id, task) => {
    const step = steps.find((item) => item.id === id);
    if (step) { step.status = "running"; step.startedAt = new Date().toISOString(); report(id); }
    try {
      const value = await task();
      if (step) { step.status = "succeeded"; step.finishedAt = new Date().toISOString(); report(null); }
      return value;
    } catch (error) {
      if (step) { step.status = "failed"; step.finishedAt = new Date().toISOString(); report(null); }
      throw error;
    }
  };
  log("info", `starting ${job.type}${job.operation ? `:${job.operation}` : ""} job ${job.id}`);
  try {
    let result;
    if (job.type === "sync") {
      result = await runStep("sync", () => syncProject(config, job));
    } else if (job.type === "host-command") {
      result = await runStep("command", () => runHostCommand(config, job, (output) => report("command", output)));
      refreshExecutionEnvironment();
      refreshDetectedTools({ force: true }).catch((error) => log("warn", `tool inventory refresh failed: ${error.message}`));
    } else if (job.type === "deployment-access") {
      result = await runStep("deployment", () => manageDeploymentAccess(job));
    } else if (job.type === "runtime") {
      result = await runStep("runtime", () => manageRuntime(job, (output) => report("runtime", output)));
      refreshDetectedTools({ force: true }).catch((error) => log("warn", `tool inventory refresh failed: ${error.message}`));
    } else {
      const outputs = [];
      const synced = await runStep("sync", () => syncProject(config, job));
      if (synced.output) outputs.push(renderStageOutput("Git sync", synced.output));
      if (job.prepareCommand) {
        const prepared = await runStep("prepare", () => prepareProject(config, job));
        if (prepared.output) outputs.push(renderStageOutput("Dependencies", prepared.output));
      }
      const operated = await runStep("operation", () => runProjectCommand(config, job));
      if (operated.output) outputs.push(renderStageOutput(job.operation || "Command", operated.output));
      result = {
        output: outputs.join("\n\n"),
        result: { ...operated.result, action: job.operation, syncAction: synced.result.action, commit: synced.result.commit },
      };
    }
    log("info", `completed job ${job.id}`);
    return { id: job.id, ok: true, startedAt, steps, output: result.output, result: result.result };
  } catch (error) {
    log("warn", `job ${job.id} failed: ${error.message}`);
    return { id: job.id, ok: false, startedAt, steps, output: error.output || "", error: error.message, result: { exitCode: error.exitCode ?? null } };
  }
}

async function syncProject(config, job) {
  const project = job.project || {};
  const target = safeProjectPath(config.workspace, project.remotePath);
  if (!project.gitRemote || String(project.gitRemote).startsWith("-")) throw new Error("Project Git remote is missing or invalid");
  if (!project.branch || String(project.branch).startsWith("-")) throw new Error("Project branch is missing or invalid");
  const git = resolveCommand("git");
  if (!git) throw new Error("Git is not installed on this task machine");
  await runProcess(git, ["check-ref-format", "--branch", project.branch], { cwd: config.workspace, timeout: 10_000 });
  const targetInfo = await stat(target).catch(() => null);
  const gitEnvironment = {
    ...executionEnvironment,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: executionEnvironment.GIT_SSH_COMMAND || "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
  };
  let action;
  let output = "";
  if (!targetInfo) {
    await mkdir(path.dirname(target), { recursive: true });
    const cloned = await runProcess(git, ["clone", "--branch", project.branch, "--single-branch", project.gitRemote, target], { cwd: config.workspace, env: gitEnvironment, timeout: 30 * 60_000 });
    output = cloned.output;
    action = "clone";
  } else {
    if (!targetInfo.isDirectory() || !await stat(path.join(target, ".git")).catch(() => null)) throw new Error(`Remote path exists but is not a Git repository: ${target}`);
    const dirty = await runProcess(git, ["-C", target, "status", "--porcelain=v1", "--untracked-files=all"], { env: gitEnvironment, timeout: 30_000 });
    if (dirty.output.trim()) throw Object.assign(new Error("Task-machine checkout has local changes; refusing to overwrite them"), { output: dirty.output });
    const origin = await runProcess(git, ["-C", target, "remote", "get-url", "origin"], { env: gitEnvironment, timeout: 30_000 });
    if (origin.output.trim() !== project.gitRemote) throw new Error("Task-machine checkout origin does not match this machora project");
    const fetchResult = await runProcess(git, ["-C", target, "fetch", "origin", project.branch], { env: gitEnvironment, timeout: 30 * 60_000 });
    const checkoutResult = await runProcess(git, ["-C", target, "checkout", project.branch], { env: gitEnvironment, timeout: 60_000 });
    const mergeResult = await runProcess(git, ["-C", target, "merge", "--ff-only", "FETCH_HEAD"], { env: gitEnvironment, timeout: 10 * 60_000 });
    output = [fetchResult.output, checkoutResult.output, mergeResult.output].filter(Boolean).join("\n");
    action = "pull";
  }
  if (job.trigger?.source === "git-hook") {
    const triggerRef = String(job.trigger.ref || "");
    const triggerSha = String(job.trigger.sha || "").toLowerCase();
    if (!/^(?:refs\/heads|refs\/tags)\/[A-Za-z0-9._\/-]+$/.test(triggerRef) || !/^[0-9a-f]{40,64}$/.test(triggerSha)) throw new Error("Git trigger ref or commit is invalid");
    await runProcess(git, ["check-ref-format", triggerRef], { cwd: target, env: gitEnvironment, timeout: 10_000 });
    const fetchedTrigger = await runProcess(git, ["-C", target, "fetch", "origin", triggerRef], { env: gitEnvironment, timeout: 30 * 60_000 });
    const fetchedSha = await runProcess(git, ["-C", target, "rev-parse", "FETCH_HEAD"], { env: gitEnvironment, timeout: 30_000 });
    if (fetchedSha.output.trim().toLowerCase() !== triggerSha) throw new Error("The pushed Git ref no longer matches the triggering commit");
    const checkoutTrigger = await runProcess(git, ["-C", target, "checkout", "--detach", "FETCH_HEAD"], { env: gitEnvironment, timeout: 60_000 });
    output = [output, fetchedTrigger.output, checkoutTrigger.output].filter(Boolean).join("\n");
    action = job.trigger.event;
  }
  const commit = await runProcess(git, ["-C", target, "rev-parse", "--short=12", "HEAD"], { env: gitEnvironment, timeout: 30_000 });
  return { output, result: { action, commit: commit.output.trim(), exitCode: 0 } };
}

async function runProjectCommand(config, job) {
  const target = safeProjectPath(config.workspace, job.project?.remotePath);
  if (!await stat(path.join(target, ".git")).catch(() => null)) throw new Error("Remote project is not ready; sync it before running commands");
  if (!job.command) throw new Error(`No command is configured for ${job.operation || "this operation"}`);
  const environment = await projectRuntimeEnvironment(job, target);
  if (job.operation === "dev") return startDevPreview(config, job, target, environment);
  return runShell(job.command, target, 30 * 60_000, undefined, environment);
}

async function runHostCommand(config, job, onOutput) {
  if (!job.command) throw new Error("Remote command is empty");
  const target = await safeWorkingDirectory(config.workspace, job.workingDirectory || config.workspace);
  return runShell(job.command, target, 60 * 60_000, onOutput);
}

async function manageDeploymentAccess(job) {
  const deployment = validateDeploymentJob(job.deployment);
  const directory = path.join(agentDirectory, "deployments", deployment.id);
  const privateKeyPath = path.join(directory, "id_ed25519");
  const publicKeyPath = `${privateKeyPath}.pub`;
  const knownHostsPath = path.join(directory, "known_hosts");
  const sshConfigPath = path.join(directory, "ssh_config");
  if (job.operation === "revoke") {
    await rm(directory, { recursive: true, force: true });
    return { output: `Removed the SSH credential for ${deployment.name}`, result: { action: "revoke", exitCode: 0, alias: deployment.alias } };
  }
  if (job.operation === "prepare") {
    const sshKeygen = resolveCommand("ssh-keygen");
    const sshKeyscan = resolveCommand("ssh-keyscan");
    if (!sshKeygen || !sshKeyscan || !resolveCommand("ssh")) throw new Error("OpenSSH client tools (ssh, ssh-keygen, and ssh-keyscan) are required on this task machine");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!await stat(privateKeyPath).catch(() => null)) {
      await runProcess(sshKeygen, ["-q", "-t", "ed25519", "-N", "", "-C", deployment.marker, "-f", privateKeyPath], { timeout: 30_000 });
    }
    const scan = await runProcess(sshKeyscan, ["-T", "10", "-p", String(deployment.port), deployment.host], { timeout: 20_000 });
    const matchingHostKey = scan.output.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#") && publicKeyLineFingerprint(line) === deployment.hostFingerprint);
    if (!matchingHostKey) throw new Error(`SSH server fingerprint did not match ${deployment.hostFingerprint}`);
    await writeFile(knownHostsPath, `${matchingHostKey}\n`, { mode: 0o600 });
    await writeFile(sshConfigPath, renderDeploymentSshConfig(deployment, privateKeyPath, knownHostsPath), { mode: 0o600 });
    await ensureDeploymentSshInclude();
    const publicKey = (await readFile(publicKeyPath, "utf8")).trim();
    return {
      output: `Prepared ${deployment.alias}\nServer fingerprint: ${deployment.hostFingerprint}\nTask-machine key: ${publicKeyFingerprint(publicKey)}`,
      result: {
        action: "prepare", exitCode: 0, publicKey, fingerprint: publicKeyFingerprint(publicKey),
        alias: deployment.alias, configPath: sshConfigPath,
      },
    };
  }
  if (job.operation === "verify") {
    const ssh = resolveCommand("ssh");
    if (!ssh || !await stat(sshConfigPath).catch(() => null)) throw new Error("The task-machine SSH credential has not been prepared");
    const userSshConfig = await ensureDeploymentSshInclude();
    const verified = await runProcess(ssh, ["-F", userSshConfig, deployment.alias, "printf 'machora-agent-ready'"], { timeout: 20_000 });
    if (verified.output.trim() !== "machora-agent-ready") throw Object.assign(new Error("SSH verification returned an unexpected response"), { output: verified.output });
    return { output: `Verified ${deployment.alias} from this task machine`, result: { action: "verify", exitCode: 0, alias: deployment.alias, configPath: sshConfigPath } };
  }
  throw new Error(`Unsupported deployment access operation: ${job.operation}`);
}

async function ensureDeploymentSshInclude() {
  const sshDirectory = path.join(os.homedir(), ".ssh");
  const userConfigPath = path.join(sshDirectory, "config");
  const includePattern = path.join(agentDirectory, "deployments", "*", "ssh_config").replaceAll("\\", "/").replaceAll('"', '\\"');
  const includeLine = `Include "${includePattern}"`;
  await mkdir(sshDirectory, { recursive: true, mode: 0o700 });
  const current = await readFile(userConfigPath, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
  if (!current.split(/\r?\n/).some((line) => line.trim() === includeLine)) {
    const separator = current && !current.endsWith("\n") ? "\n" : "";
    await writeFile(userConfigPath, `${current}${separator}# Machora deployment targets\n${includeLine}\n`, { mode: 0o600 });
  }
  return userConfigPath;
}

function validateDeploymentJob(value) {
  const deployment = value && typeof value === "object" ? value : {};
  const port = Number(deployment.port);
  if (!/^[0-9a-f-]{20,}$/i.test(String(deployment.id || ""))) throw new Error("Deployment target ID is invalid");
  if (!String(deployment.host || "") || /[\s/@]/.test(String(deployment.host))) throw new Error("Deployment target host is invalid");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Deployment target SSH port is invalid");
  if (!/^[a-z_][a-z0-9_.-]{0,63}$/i.test(String(deployment.username || ""))) throw new Error("Deployment target user is invalid");
  if (!/^SHA256:[A-Za-z0-9+/]{20,}$/.test(String(deployment.hostFingerprint || ""))) throw new Error("Deployment target fingerprint is invalid");
  if (!/^machora-[a-z0-9-]{2,70}$/.test(String(deployment.alias || ""))) throw new Error("Deployment target alias is invalid");
  if (!/^machora:target:[0-9a-f-]+:host:[0-9a-f-]+$/i.test(String(deployment.marker || ""))) throw new Error("Deployment authorization marker is invalid");
  return { ...deployment, port };
}

function renderDeploymentSshConfig(deployment, privateKeyPath, knownHostsPath) {
  const normalizePath = (value) => String(value).replaceAll("\\", "/").replaceAll('"', '\\"');
  return [
    `Host ${deployment.alias}`,
    `  HostName ${deployment.host}`,
    `  Port ${deployment.port}`,
    `  User ${deployment.username}`,
    `  IdentityFile \"${normalizePath(privateKeyPath)}\"`,
    `  UserKnownHostsFile \"${normalizePath(knownHostsPath)}\"`,
    "  IdentitiesOnly yes",
    "  BatchMode yes",
    "  StrictHostKeyChecking yes",
    "  ConnectTimeout 10",
    "  ServerAliveInterval 10",
    "  ServerAliveCountMax 2",
    "",
  ].join("\n");
}

function publicKeyLineFingerprint(line) {
  const fields = String(line || "").trim().split(/\s+/);
  const index = fields.findIndex((field) => /^(?:ssh-|ecdsa-)/.test(field));
  if (index === -1 || !fields[index + 1]) return "";
  return sshFingerprint(Buffer.from(fields[index + 1], "base64"));
}

function publicKeyFingerprint(line) {
  const fields = String(line || "").trim().split(/\s+/);
  if (fields.length < 2) throw new Error("Generated SSH public key is invalid");
  return sshFingerprint(Buffer.from(fields[1], "base64"));
}

function sshFingerprint(key) {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

async function manageRuntime(job, onOutput) {
  const request = validateRuntimeJob(job);
  const mise = await ensureMise(onOutput);
  const environment = miseEnvironment();
  const spec = request.version ? `${request.tool}@${request.version}` : request.tool;
  if (request.operation === "query") {
    const queried = await runProcess(mise, ["ls-remote", request.tool], { env: environment, timeout: 5 * 60_000, onOutput });
    const versions = queried.output.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,99}$/.test(line)).slice(-200);
    const inventory = await refreshManagedRuntimeInventory({ force: true });
    return { output: queried.output, result: { action: "query", tool: request.tool, versions, ...inventory } };
  }
  if (request.operation === "install") {
    const installed = await runProcess(mise, ["install", spec], { env: environment, timeout: 60 * 60_000, onOutput });
    const verified = await verifyRuntime(mise, request, environment);
    const inventory = await refreshManagedRuntimeInventory({ force: true });
    return { output: [installed.output, verified.output].filter(Boolean).join("\n"), result: { action: "install", tool: request.tool, version: request.version, ...inventory } };
  }
  if (request.operation === "uninstall") {
    const removed = await runProcess(mise, ["uninstall", spec], { env: environment, timeout: 30 * 60_000, onOutput });
    const inventory = await refreshManagedRuntimeInventory({ force: true });
    return { output: removed.output || `Removed ${spec}`, result: { action: "uninstall", tool: request.tool, version: request.version, ...inventory } };
  }
  const verified = await verifyRuntime(mise, request, environment);
  const inventory = await refreshManagedRuntimeInventory({ force: true });
  return { output: verified.output, result: { action: "verify", tool: request.tool, version: request.version, ...inventory } };
}

function validateRuntimeJob(job) {
  const operation = String(job.operation || "").toLowerCase();
  const tool = String(job.runtime?.tool || "").toLowerCase();
  const version = String(job.runtime?.version || "").trim() || null;
  if (!["query", "install", "uninstall", "verify"].includes(operation)) throw new Error("Runtime operation is invalid");
  if (!runtimeTools.has(tool)) throw new Error("Runtime must be node, java, or python");
  if (operation !== "query" && (!version || !/^[A-Za-z0-9][A-Za-z0-9._+:-]{0,99}$/.test(version))) throw new Error("Runtime version is invalid");
  return { operation, tool, version };
}

async function projectRuntimeEnvironment(job, target) {
  if (job._runtimeEnvironment) return job._runtimeEnvironment;
  const entries = Object.entries(job.project?.toolchain || {}).filter(([tool, version]) => runtimeTools.has(tool) && version);
  if (!entries.length) return executionEnvironment;
  const mise = await ensureMise();
  const environment = miseEnvironment();
  const specs = entries.map(([tool, version]) => `${tool}@${version}`);
  for (const spec of specs) {
    await runProcess(mise, ["where", spec], { cwd: target, env: environment, timeout: 30_000 }).catch(() => {
      throw new Error(`Project runtime ${spec} is not installed on this task machine. Install it from Manage runtimes first.`);
    });
  }
  const resolved = await runProcess(mise, ["env", "--json", ...specs], { cwd: target, env: environment, timeout: 60_000 });
  const values = JSON.parse(resolved.output || "{}");
  const merged = { ...miseEnvironment(), ...values };
  const pathKey = Object.keys(values).find((key) => key.toLowerCase() === "path");
  if (pathKey) merged.PATH = values[pathKey];
  job._runtimeEnvironment = merged;
  return merged;
}

async function verifyRuntime(mise, request, environment) {
  const command = request.tool === "java" ? ["java", "-version"] : request.tool === "python" ? ["python", "--version"] : ["node", "--version"];
  return runProcess(mise, ["exec", `${request.tool}@${request.version}`, "--", ...command], { env: environment, timeout: 60_000 });
}

function misePaths() {
  const root = path.join(agentDirectory, "runtimes");
  return {
    root,
    bin: process.env.MACHORA_MISE_BIN || path.join(root, "bin", os.platform() === "win32" ? "mise.exe" : "mise"),
    data: path.join(root, "data"),
    cache: path.join(root, "cache"),
    config: path.join(root, "config"),
    state: path.join(root, "state"),
  };
}

function miseEnvironment() {
  const paths = misePaths();
  return {
    ...executionEnvironment,
    MISE_DATA_DIR: paths.data,
    MISE_CACHE_DIR: paths.cache,
    MISE_CONFIG_DIR: paths.config,
    MISE_STATE_DIR: paths.state,
    MISE_YES: "1",
    MISE_COLOR: "0",
    MISE_QUIET: "1",
    MISE_NO_CONFIG: "1",
    MISE_NO_HOOKS: "1",
    MISE_HTTP_TIMEOUT: executionEnvironment.MACHORA_MISE_HTTP_TIMEOUT || executionEnvironment.MISE_HTTP_TIMEOUT || "5m",
    MISE_HTTP_DOWNLOAD_TIMEOUT: executionEnvironment.MACHORA_MISE_HTTP_DOWNLOAD_TIMEOUT || executionEnvironment.MISE_HTTP_DOWNLOAD_TIMEOUT || "60m",
    MISE_HTTP_RETRIES: executionEnvironment.MACHORA_MISE_HTTP_RETRIES || executionEnvironment.MISE_HTTP_RETRIES || "5",
  };
}

async function ensureMise(onOutput) {
  const paths = misePaths();
  if (await stat(paths.bin).catch(() => null)) return paths.bin;
  if (process.env.MACHORA_MISE_BIN) throw new Error(`Configured mise executable does not exist: ${paths.bin}`);
  onOutput?.("Installing the isolated mise runtime manager…");
  const platform = os.platform() === "darwin" ? "macos" : os.platform() === "win32" ? "windows" : os.platform() === "linux" ? "linux" : "";
  const architecture = os.arch() === "x64" ? "x64" : os.arch() === "arm64" ? "arm64" : "";
  if (!platform || !architecture) throw new Error(`mise is not supported on ${os.platform()} ${os.arch()}`);
  const headers = { accept: "application/vnd.github+json", "user-agent": `machora-agent/${VERSION}` };
  const releaseResponse = await fetch("https://api.github.com/repos/jdx/mise/releases/latest", { headers, signal: AbortSignal.timeout(30_000) });
  if (!releaseResponse.ok) throw new Error(`Unable to resolve mise release (HTTP ${releaseResponse.status})`);
  const release = await releaseResponse.json();
  const suffix = `${platform}-${architecture}${platform === "windows" ? ".exe" : ""}`;
  const asset = release.assets?.find((item) => item.name === `mise-${release.tag_name}-${suffix}`);
  const checksums = release.assets?.find((item) => item.name === "SHASUMS256.txt");
  if (!asset?.browser_download_url || !checksums?.browser_download_url) throw new Error(`No mise binary is available for ${platform}-${architecture}`);
  const [binaryResponse, checksumResponse] = await Promise.all([
    fetch(asset.browser_download_url, { headers, signal: AbortSignal.timeout(5 * 60_000) }),
    fetch(checksums.browser_download_url, { headers, signal: AbortSignal.timeout(30_000) }),
  ]);
  if (!binaryResponse.ok || !checksumResponse.ok) throw new Error("Unable to download mise and its checksum");
  const binary = Buffer.from(await binaryResponse.arrayBuffer());
  const checksumText = await checksumResponse.text();
  const expected = checksumText.split(/\r?\n/).find((line) => line.trim().endsWith(asset.name))?.trim().split(/\s+/, 1)[0]?.toLowerCase();
  const actual = createHash("sha256").update(binary).digest("hex");
  if (!expected || expected !== actual) throw new Error("mise download checksum verification failed");
  await mkdir(path.dirname(paths.bin), { recursive: true, mode: 0o700 });
  const temporary = `${paths.bin}.${process.pid}.tmp`;
  await writeFile(temporary, binary, { mode: 0o700 });
  if (os.platform() !== "win32") await chmod(temporary, 0o700);
  await rename(temporary, paths.bin);
  onOutput?.(`Installed mise ${release.tag_name} in the Agent runtime directory`);
  return paths.bin;
}

async function inspectManagedRuntimes() {
  const paths = misePaths();
  const installed = await stat(paths.bin).catch(() => null);
  if (!installed) return { runtimeManager: { provider: "mise", status: "not-installed", version: null, managedRoot: paths.root }, runtimes: [] };
  try {
    const environment = miseEnvironment();
    const [versionResult, listResult] = await Promise.all([
      runProcess(paths.bin, ["--version"], { env: environment, timeout: 10_000 }),
      runProcess(paths.bin, ["ls", "--installed", "--json"], { env: environment, timeout: 30_000 }),
    ]);
    return {
      runtimeManager: { provider: "mise", status: "ready", version: cleanVersion(versionResult.output.match(/\d{4}\.\d+\.\d+|\d+\.\d+\.\d+/)?.[0] || versionResult.output), managedRoot: paths.root },
      runtimes: parseMiseInstalled(listResult.output),
    };
  } catch (error) {
    return { runtimeManager: { provider: "mise", status: "error", version: null, managedRoot: paths.root, error: error.message }, runtimes: [] };
  }
}

async function refreshManagedRuntimeInventory({ force = false } = {}) {
  if (managedInventoryRefreshPromise) {
    const current = await managedInventoryRefreshPromise;
    if (!force) return current;
  }
  managedInventoryRefreshPromise = inspectManagedRuntimes().then((inventory) => {
    cachedManagedInventory = inventory;
    managedInventoryUpdatedAt = new Date().toISOString();
    return inventory;
  }).finally(() => { managedInventoryRefreshPromise = null; });
  return managedInventoryRefreshPromise;
}

function managedRuntimeInventory() {
  return cachedManagedInventory || {
    runtimeManager: { provider: "mise", status: "checking", version: null, managedRoot: misePaths().root },
    runtimes: [],
  };
}

function parseMiseInstalled(output) {
  let value;
  try { value = JSON.parse(output || "{}"); } catch { return []; }
  const runtimes = [];
  const add = (tool, version) => {
    const normalizedTool = String(tool || "").split(":").at(-1).toLowerCase();
    const normalizedVersion = String(version?.version || version || "").trim();
    if (runtimeTools.has(normalizedTool) && normalizedVersion && !runtimes.some((item) => item.tool === normalizedTool && item.version === normalizedVersion)) runtimes.push({ tool: normalizedTool, version: normalizedVersion, installed: true, provider: "mise" });
  };
  if (Array.isArray(value)) for (const item of value) add(item.tool || item.plugin || item.name, item.version);
  else for (const [tool, versions] of Object.entries(value || {})) for (const version of Array.isArray(versions) ? versions : [versions]) add(tool, version);
  return runtimes;
}

async function prepareProject(config, job) {
  const target = safeProjectPath(config.workspace, job.project?.remotePath);
  const outputs = [];
  const environment = await projectRuntimeEnvironment(job, target);
  if (job.prepareCommand) {
    const installed = await runShell(job.prepareCommand, target, 30 * 60_000, undefined, environment);
    if (installed.output) outputs.push(installed.output);
  }
  if (job.project?.projectType === "Flutter" && os.platform() === "darwin" && await stat(path.join(target, "ios", "Podfile")).catch(() => null)) {
    const pod = resolveCommand("pod");
    if (!pod) throw new Error("Flutter iOS dependencies require CocoaPods, but pod is not installed on this task machine");
    const installedPods = await runProcess(pod, ["install"], { cwd: path.join(target, "ios"), env: environment, timeout: 30 * 60_000 });
    if (installedPods.output) outputs.push(installedPods.output);
  }
  return { output: outputs.join("\n"), result: { action: "prepare", exitCode: 0 } };
}

async function runShell(command, target, timeout, onOutput, environment = executionEnvironment) {
  const { shell, args, windowsVerbatimArguments } = shellInvocation(command, environment);
  const completed = await runProcess(shell, args, { cwd: target, timeout, env: { ...environment, CI: "1" }, onOutput, windowsVerbatimArguments });
  return { output: completed.output, result: { exitCode: 0 } };
}

function shellInvocation(command, environment) {
  if (os.platform() !== "win32") return { shell: "/bin/sh", args: ["-c", command], windowsVerbatimArguments: false };
  // Match Node's shell execution: cmd consumes the outer quotes itself. CRT
  // argument escaping would insert backslashes and corrupt embedded quotes.
  return {
    shell: environment.ComSpec || path.win32.join(environment.SystemRoot || "C:\\Windows", "System32", "cmd.exe"),
    args: ["/d", "/s", "/c", `"${command}"`],
    windowsVerbatimArguments: true,
  };
}

async function startDevPreview(config, job, target, environment = executionEnvironment) {
  const port = commandPort(job.command) || normalizePreviewPort(job.project?.devPort);
  const command = devCommand(job.command, job.project?.projectType, port);
  const logsDirectory = path.join(agentDirectory, "jobs");
  await mkdir(logsDirectory, { recursive: true, mode: 0o700 });
  const logPath = path.join(logsDirectory, `${job.id}.log`);
  const descriptor = openSync(logPath, "a");
  const { shell, args, windowsVerbatimArguments } = shellInvocation(command, environment);
  const previewEnvironment = { ...environment, CI: "0", HOST: "0.0.0.0", HOSTNAME: "0.0.0.0" };
  if (port) previewEnvironment.PORT = String(port);
  const child = spawn(shell, args, {
    cwd: target,
    env: os.platform() === "win32" ? normalizeWindowsPath(previewEnvironment) : previewEnvironment,
    windowsHide: true,
    windowsVerbatimArguments,
    detached: true,
    stdio: ["ignore", descriptor, descriptor],
  });
  child.unref();
  closeSync(descriptor);
  await delay(2000);
  if (child.exitCode != null) {
    const output = await readFile(logPath, "utf8").catch(() => "");
    throw Object.assign(new Error(`Dev preview exited with code ${child.exitCode}`), { output, exitCode: child.exitCode });
  }
  const hostAddress = String(job.project?.hostAddress || "").replace(/^::ffff:/, "");
  const previewHost = hostAddress && !["127.0.0.1", "::1"].includes(hostAddress) ? hostAddress : os.hostname();
  const previewUrl = port ? `http://${previewHost}:${port}/` : null;
  const initialOutput = await readFile(logPath, "utf8").catch(() => "");
  return {
    output: `${initialOutput.slice(-16 * 1024)}${initialOutput ? "\n" : ""}Preview process ${child.pid} started${previewUrl ? ` at ${previewUrl}` : " (port managed by the project)"}`,
    result: { action: "dev", exitCode: 0, previewUrl, processId: child.pid, logPath },
  };
}

function devCommand(command, projectType, port) {
  const value = String(command || "");
  if (/flutter/i.test(projectType || "") || /--(?:web-)?port\b/.test(value)) return value;
  const separator = /^\s*npm\s+(?:run\s+)?(?:dev|start)\b/.test(value) ? " --" : "";
  if (/next\.js/i.test(projectType || "") && !/(?:--hostname|-H)\b/.test(value)) return `${value}${separator} --hostname 0.0.0.0${port ? ` --port ${port}` : ""}`;
  if (/(?:vite|sveltekit|astro|angular)/i.test(projectType || "") && !/--host\b/.test(value)) return `${value}${separator} --host 0.0.0.0${port ? ` --port ${port}` : ""}`;
  return value;
}

function normalizePreviewPort(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 65535 ? number : null;
}

function commandPort(command) {
  const match = String(command || "").match(/(?:--(?:web-)?port(?:=|\s+)|(?:^|\s)-p\s+)(\d{1,5})(?:\s|$)/);
  return normalizePreviewPort(match?.[1]);
}

function renderStageOutput(label, output) {
  return `--- ${label} ---\n${output}`;
}

function safeProjectPath(workspace, target) {
  const root = path.resolve(workspace);
  const resolved = path.resolve(String(target || ""));
  const relative = path.relative(root, resolved);
  if (!target || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Project path is outside the configured task-machine workspace");
  return resolved;
}

async function safeWorkingDirectory(workspace, target) {
  const root = path.resolve(workspace);
  const resolved = path.resolve(String(target || root));
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Working directory is outside the configured task-machine workspace");
  const information = await stat(resolved).catch(() => null);
  if (!information?.isDirectory()) throw new Error(`Working directory does not exist: ${resolved}`);
  return resolved;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const environment = options.env || executionEnvironment;
    const child = spawn(command, args, { cwd: options.cwd, env: os.platform() === "win32" ? normalizeWindowsPath(environment) : environment, windowsHide: true, windowsVerbatimArguments: options.windowsVerbatimArguments || false });
    let output = "";
    let truncated = false;
    const append = (chunk) => {
      if (output.length >= 64 * 1024) { truncated = true; return; }
      output += String(chunk).slice(0, 64 * 1024 - output.length);
      options.onOutput?.(`${output}${truncated ? "\n[machora output truncated]" : ""}`.trim());
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => { child.kill("SIGTERM"); }, options.timeout || 30 * 60_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const rendered = `${output}${truncated ? "\n[machora output truncated]" : ""}`.trim();
      if (code === 0) resolve({ output: rendered, exitCode: 0 });
      else reject(Object.assign(new Error(signal ? `Command stopped by ${signal}` : `Command exited with code ${code}`), { output: rendered, exitCode: code }));
    });
  });
}

async function machineReport(workspace) {
  const tools = cachedTools;
  const cpu = await sampleCpu();
  const managed = managedRuntimeInventory();
  return {
    hostname: os.hostname(),
    os: normalizeOs(os.platform()),
    arch: os.arch(),
    cpu,
    memory: Math.round((1 - os.freemem() / os.totalmem()) * 100),
    capabilities: detectCapabilities(tools),
    tools,
    runtimeManager: managed.runtimeManager,
    runtimes: managed.runtimes,
    health: {
      toolInventoryUpdatedAt,
      toolInventoryStatus: toolInventoryRefreshPromise ? "refreshing" : toolInventoryUpdatedAt ? "ready" : "starting",
      runtimeInventoryUpdatedAt: managedInventoryUpdatedAt,
      runtimeInventoryStatus: managed.runtimeManager?.status || "unknown",
    },
    workspace,
    agentVersion: VERSION,
  };
}

async function sampleCpu() {
  const first = cpuTimes();
  await delay(300);
  const second = cpuTimes();
  const total = second.total - first.total;
  const idle = second.idle - first.idle;
  return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
}

function cpuTimes() {
  return os.cpus().reduce((summary, cpu) => {
    const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    return { idle: summary.idle + cpu.times.idle, total: summary.total + total };
  }, { idle: 0, total: 0 });
}

function detectCapabilities(tools) {
  const available = tools.map((tool) => tool.id);
  if (os.platform() === "darwin" && !available.includes("metal")) available.push("metal");
  return available;
}

async function refreshDetectedTools({ force = false } = {}) {
  if (toolInventoryRefreshPromise) {
    const current = await toolInventoryRefreshPromise;
    if (!force) return current;
  }
  toolInventoryRefreshPromise = inspectTools().then((tools) => {
    cachedTools = tools;
    toolInventoryUpdatedAt = new Date().toISOString();
    return tools;
  }).finally(() => { toolInventoryRefreshPromise = null; });
  return toolInventoryRefreshPromise;
}

async function inspectTools() {
  const tools = [{ id: "node", name: "Node.js", version: process.versions.node }];
  const definitions = [
    ["npm", "npm", ["--version"], versionOnly],
    ["pnpm", "pnpm", ["--version"], versionOnly],
    ["yarn", "Yarn", ["--version"], versionOnly],
    ["bun", "Bun", ["--version"], versionOnly],
    ["git", "Git", ["--version"], prefixedVersion(/git version\s+([^\s]+)/i)],
    ["ssh", "OpenSSH", ["-V"], prefixedVersion(/OpenSSH_([^,\s]+)/i)],
    ["java", "Java", ["-version"], javaVersion],
    ["javac", "JDK", ["-version"], prefixedVersion(/javac\s+([^\s]+)/i)],
    ["mvn", "Maven", ["--version"], prefixedVersion(/Apache Maven\s+([^\s]+)/i)],
    ["gradle", "Gradle", ["--version"], prefixedVersion(/Gradle\s+([^\s]+)/i)],
    ["python3", "Python", ["--version"], prefixedVersion(/Python\s+([^\s]+)/i)],
    ["go", "Go", ["version"], prefixedVersion(/go version go([^\s]+)/i)],
    ["rustc", "Rust", ["--version"], prefixedVersion(/rustc\s+([^\s]+)/i)],
    ["cargo", "Cargo", ["--version"], prefixedVersion(/cargo\s+([^\s]+)/i)],
    ["ruby", "Ruby", ["--version"], prefixedVersion(/ruby\s+([^\s]+)/i)],
    ["php", "PHP", ["--version"], prefixedVersion(/PHP\s+([^\s]+)/i)],
    ["dotnet", ".NET SDK", ["--version"], versionOnly],
    ["swift", "Swift", ["--version"], prefixedVersion(/Swift version\s+([^\s]+)/i)],
    ["kotlinc", "Kotlin", ["-version"], prefixedVersion(/kotlinc-jvm\s+([^\s]+)/i)],
    ["docker", "Docker", ["--version"], prefixedVersion(/Docker version\s+([^,\s]+)/i)],
    ["xcodebuild", "Xcode", ["-version"], prefixedVersion(/Xcode\s+([^\s]+)/i)],
    ["clang", "Clang", ["--version"], prefixedVersion(/(?:Apple\s+)?clang version\s+([^\s]+)/i)],
  ];
  for (const [id, name, args, parser] of definitions) {
    const output = await commandOutputAsync(id, args);
    const version = output && parser(output);
    if (version) tools.push({ id, name, version: cleanVersion(version) });
  }
  if (!tools.some((tool) => tool.id === "python3")) {
    const output = await commandOutputAsync("python", ["--version"]);
    const version = output && prefixedVersion(/Python\s+([^\s]+)/i)(output);
    if (version) tools.push({ id: "python", name: "Python", version: cleanVersion(version) });
  }
  return tools;
}

async function commandOutputAsync(executable, args) {
  const executablePath = await resolveCommandAsync(executable);
  if (!executablePath) return "";
  try {
    const result = await runProcess(executablePath, args, { env: executionEnvironment, timeout: 3000 });
    return result.output;
  } catch (error) {
    return String(error.output || "").trim();
  }
}

async function resolveCommandAsync(executable, environment = executionEnvironment || process.env) {
  try {
    const result = os.platform() === "win32"
      ? await runProcess("where.exe", [executable], { env: environment, timeout: 1500 })
      : await runProcess("sh", ["-c", `command -v ${executable}`], { env: environment, timeout: 1500 });
    return String(result.output || "").split(/\r?\n/, 1)[0].trim();
  } catch {
    return "";
  }
}

function resolveCommand(executable, environment = executionEnvironment || process.env) {
  const result = os.platform() === "win32"
    ? spawnSync("where.exe", [executable], { env: environment, encoding: "utf8", timeout: 1500, windowsHide: true })
    : spawnSync("sh", ["-c", `command -v ${executable}`], { env: environment, encoding: "utf8", timeout: 1500 });
  return result.status === 0 ? String(result.stdout || "").split(/\r?\n/, 1)[0].trim() : "";
}

function refreshExecutionEnvironment() {
  executionEnvironment = buildExecutionEnvironment(executionEnvironment || process.env);
  process.env.PATH = executionEnvironment.PATH;
  return executionEnvironment;
}

function buildExecutionEnvironment(baseEnvironment) {
  if (os.platform() === "win32") baseEnvironment = normalizeWindowsPath(baseEnvironment, readWindowsPaths(baseEnvironment));
  const shellEnvironment = readLoginShellEnvironment(baseEnvironment);
  const merged = { ...baseEnvironment, ...shellEnvironment };
  for (const [key, value] of Object.entries(baseEnvironment)) {
    if (key.startsWith("MACHORA_") || key.startsWith("RDEV_")) merged[key] = value;
  }
  delete merged.MACHORA_AGENT_ENV_CAPTURE;

  const home = os.homedir();
  const candidates = [
    ...splitPath(merged.PATH),
    path.dirname(process.execPath),
    merged.NVM_BIN,
    merged.PNPM_HOME,
    merged.JAVA_HOME && path.join(merged.JAVA_HOME, "bin"),
    merged.VOLTA_HOME && path.join(merged.VOLTA_HOME, "bin"),
    merged.BUN_INSTALL && path.join(merged.BUN_INSTALL, "bin"),
    merged.CARGO_HOME && path.join(merged.CARGO_HOME, "bin"),
    merged.GOPATH && path.join(merged.GOPATH, "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, "bin"),
    path.join(home, "Library", "pnpm"),
    path.join(home, ".local", "share", "pnpm"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".bun", "bin"),
    os.platform() === "win32" && merged.APPDATA && path.join(merged.APPDATA, "npm"),
  ];
  merged.PATH = uniquePath(candidates).join(path.delimiter);

  const npmPrefix = npmGlobalPrefix(merged);
  if (npmPrefix) {
    const npmBin = os.platform() === "win32" ? npmPrefix : path.join(npmPrefix, "bin");
    merged.PATH = uniquePath([...splitPath(merged.PATH), npmBin]).join(path.delimiter);
  }
  return merged;
}

function normalizeWindowsPath(environment, extraPaths = []) {
  const merged = { ...environment };
  const values = Object.keys(merged).filter((key) => key.toLowerCase() === "path")
    .sort((a, b) => a === "PATH" ? -1 : b === "PATH" ? 1 : 0)
    .map((key) => { const value = merged[key]; delete merged[key]; return value; });
  const variables = Object.fromEntries(Object.entries(environment).map(([key, value]) => [key.toLowerCase(), value]));
  const root = variables.systemroot || variables.windir || "C:\\Windows";
  const defaults = [root, path.win32.join(root, "System32"), path.win32.join(root, "System32", "Wbem"), path.win32.join(root, "System32", "WindowsPowerShell", "v1.0"), path.win32.join(root, "System32", "OpenSSH")];
  const seen = new Set();
  merged.PATH = [...values, ...extraPaths, ...defaults].filter(Boolean).flatMap((value) => String(value).split(";"))
    .map((value) => {
      for (let i = 0; i < 5; i += 1) {
        const expanded = value.replace(/%([^%]+)%/g, (match, name) => variables[name.toLowerCase()] ?? match);
        if (expanded === value) break;
        value = expanded;
      }
      return value.trim().replace(/^"(.*)"$/, "$1");
    })
    .filter((value) => {
      if (!value || /%[^%]+%/.test(value)) return false;
      const key = path.win32.normalize(value).replace(/\\$/, "").toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).join(";");
  return merged;
}

// Capture once: registry access must not block every heartbeat or Job.
function readWindowsPaths(environment) {
  if (cachedWindowsPaths) return cachedWindowsPaths;
  const executable = path.win32.join(environment.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = "@([Environment]::GetEnvironmentVariable('Path','Machine'),[Environment]::GetEnvironmentVariable('Path','User')) | ConvertTo-Json -Compress";
  const result = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env: environment, encoding: "utf8", timeout: 8000, windowsHide: true });
  try { const values = JSON.parse(result.stdout); cachedWindowsPaths = Array.isArray(values) ? values.filter((value) => typeof value === "string") : []; }
  catch { cachedWindowsPaths = []; }
  return cachedWindowsPaths;
}

function readLoginShellEnvironment(baseEnvironment) {
  if (os.platform() === "win32") return {};
  const configuredShell = String(baseEnvironment.SHELL || "").trim();
  const shell = configuredShell.startsWith("/") ? configuredShell : os.platform() === "darwin" ? "/bin/zsh" : "/bin/sh";
  const marker = "__MACHORA_LOGIN_ENV_8E4C2029__";
  const result = spawnSync(shell, ["-lic", `printf '\\0${marker}\\0'; env -0`], {
    env: { ...baseEnvironment, MACHORA_AGENT_ENV_CAPTURE: "1" },
    encoding: "utf8",
    timeout: 8000,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  const output = String(result.stdout || "");
  const boundary = `\0${marker}\0`;
  const markerIndex = output.lastIndexOf(boundary);
  if (markerIndex < 0) return {};
  const environment = {};
  for (const entry of output.slice(markerIndex + boundary.length).split("\0")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const key = entry.slice(0, separator);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) environment[key] = entry.slice(separator + 1);
  }
  return environment;
}

function npmGlobalPrefix(environment) {
  if (os.platform() === "win32") return environment.APPDATA ? path.join(environment.APPDATA, "npm") : "";
  const npm = resolveCommand("npm", environment);
  if (!npm) return "";
  const result = spawnSync(npm, ["prefix", "-g"], { env: environment, encoding: "utf8", timeout: 3000, windowsHide: true });
  return result.status === 0 ? String(result.stdout || "").trim().split(/\r?\n/, 1)[0] : "";
}

function splitPath(value) {
  return String(value || "").split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
}

function uniquePath(entries) {
  const seen = new Set();
  return entries.filter(Boolean).filter((entry) => {
    const normalized = path.resolve(String(entry));
    const key = os.platform() === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((entry) => path.resolve(String(entry)));
}

function versionOnly(output) {
  return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

function prefixedVersion(pattern) {
  return (output) => output.match(pattern)?.[1] || "";
}

function javaVersion(output) {
  return output.match(/(?:java|openjdk) version ["']([^"']+)/i)?.[1]
    || output.match(/(?:openjdk|java)\s+([^\s]+)/i)?.[1]
    || "";
}

function cleanVersion(value) {
  return String(value).replace(/^v(?=\d)/, "").replace(/[;,]$/, "").slice(0, 80);
}

async function readConfig() {
  try {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (!config.controller || !config.agentId || !config.secret) throw new Error("Agent configuration is incomplete");
    return config;
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Agent is not enrolled. Missing ${configPath}`);
    throw error;
  }
}

async function writeConfig(config) {
  await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, configPath);
}

function normalizeController(value) {
  if (!value) throw new Error("Missing --controller");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Controller URL must use http or https");
  return url.origin;
}

function resolveWorkspace(value) {
  const fallback = path.join(os.homedir(), "Code");
  if (!value) return fallback;
  let expanded = String(value).trim();
  expanded = expanded.replace(/^%USERPROFILE%(?=[\\/]|$)/i, os.homedir());
  expanded = expanded.replace(/^\$HOME(?=[\\/]|$)/, os.homedir());
  if (expanded === "~") expanded = os.homedir();
  else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) expanded = path.join(os.homedir(), expanded.slice(2));
  return path.resolve(expanded);
}

function normalizeOs(platform) {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}

function parseOptions(items) {
  const options = {};
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === "--once") { options.once = true; continue; }
    if (!item.startsWith("--")) throw new Error(`Unexpected argument: ${item}`);
    const value = items[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${item}`);
    options[item.slice(2)] = value;
    index += 1;
  }
  return options;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function log(level, message) {
  const output = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
  if (level === "error" || level === "warn") console.error(output);
  else console.log(output);
}

function printHelp(exitCode = 0) {
  console.log(`machora Agent ${VERSION}\n\nCommands:\n  agent.mjs enroll --controller <url> --token <token>\n  agent.mjs run [--once]\n`);
  process.exitCode = exitCode;
}
