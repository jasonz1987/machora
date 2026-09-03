#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const VERSION = "0.9.0";
let cachedTools;
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
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });
  do {
    try {
      const result = await sendHeartbeat(config, completedJobs, activeJob?.progress ? [activeJob.progress] : []);
      completedJobs = [];
      log("info", `heartbeat accepted for ${result.host.alias}`);
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
}

async function sendHeartbeat(config, jobResults = [], jobUpdates = []) {
  const response = await fetch(`${config.controller}/api/agent/heartbeat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.secret}`,
      "x-machora-agent-id": config.agentId,
    },
    body: JSON.stringify({ ...await machineReport(config.workspace), jobResults, jobUpdates }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Heartbeat failed with HTTP ${response.status}`);
  return result;
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
      cachedTools = undefined;
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
  if (job.operation === "dev") return startDevPreview(config, job, target);
  return runShell(job.command, target, 30 * 60_000);
}

async function runHostCommand(config, job, onOutput) {
  if (!job.command) throw new Error("Remote command is empty");
  const target = await safeWorkingDirectory(config.workspace, job.workingDirectory || config.workspace);
  return runShell(job.command, target, 60 * 60_000, onOutput);
}

async function prepareProject(config, job) {
  const target = safeProjectPath(config.workspace, job.project?.remotePath);
  const outputs = [];
  if (job.prepareCommand) {
    const installed = await runShell(job.prepareCommand, target, 30 * 60_000);
    if (installed.output) outputs.push(installed.output);
  }
  if (job.project?.projectType === "Flutter" && os.platform() === "darwin" && await stat(path.join(target, "ios", "Podfile")).catch(() => null)) {
    const pod = resolveCommand("pod");
    if (!pod) throw new Error("Flutter iOS dependencies require CocoaPods, but pod is not installed on this task machine");
    const installedPods = await runProcess(pod, ["install"], { cwd: path.join(target, "ios"), timeout: 30 * 60_000 });
    if (installedPods.output) outputs.push(installedPods.output);
  }
  return { output: outputs.join("\n"), result: { action: "prepare", exitCode: 0 } };
}

async function runShell(command, target, timeout, onOutput) {
  const shell = os.platform() === "win32" ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
  const args = os.platform() === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
  const completed = await runProcess(shell, args, { cwd: target, timeout, env: { ...executionEnvironment, CI: "1" }, onOutput });
  return { output: completed.output, result: { exitCode: 0 } };
}

async function startDevPreview(config, job, target) {
  const port = commandPort(job.command) || normalizePreviewPort(job.project?.devPort);
  const command = devCommand(job.command, job.project?.projectType, port);
  const logsDirectory = path.join(agentDirectory, "jobs");
  await mkdir(logsDirectory, { recursive: true, mode: 0o700 });
  const logPath = path.join(logsDirectory, `${job.id}.log`);
  const descriptor = openSync(logPath, "a");
  const shell = os.platform() === "win32" ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
  const args = os.platform() === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
  const previewEnvironment = { ...executionEnvironment, CI: "0", HOST: "0.0.0.0", HOSTNAME: "0.0.0.0" };
  if (port) previewEnvironment.PORT = String(port);
  const child = spawn(shell, args, {
    cwd: target,
    env: previewEnvironment,
    windowsHide: true,
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
    const child = spawn(command, args, { cwd: options.cwd, env: options.env || executionEnvironment, windowsHide: true });
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
  const tools = detectTools();
  const [cpu] = await Promise.all([sampleCpu()]);
  return {
    hostname: os.hostname(),
    os: normalizeOs(os.platform()),
    arch: os.arch(),
    cpu,
    memory: Math.round((1 - os.freemem() / os.totalmem()) * 100),
    capabilities: detectCapabilities(tools),
    tools,
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

function detectTools() {
  if (cachedTools) return cachedTools;
  const tools = [{ id: "node", name: "Node.js", version: process.versions.node }];
  const definitions = [
    ["npm", "npm", ["--version"], versionOnly],
    ["pnpm", "pnpm", ["--version"], versionOnly],
    ["yarn", "Yarn", ["--version"], versionOnly],
    ["bun", "Bun", ["--version"], versionOnly],
    ["git", "Git", ["--version"], prefixedVersion(/git version\s+([^\s]+)/i)],
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
    const output = commandOutput(id, args);
    const version = output && parser(output);
    if (version) tools.push({ id, name, version: cleanVersion(version) });
  }
  if (!tools.some((tool) => tool.id === "python3")) {
    const output = commandOutput("python", ["--version"]);
    const version = output && prefixedVersion(/Python\s+([^\s]+)/i)(output);
    if (version) tools.push({ id: "python", name: "Python", version: cleanVersion(version) });
  }
  cachedTools = tools;
  return cachedTools;
}

function commandOutput(executable, args) {
  const executablePath = resolveCommand(executable);
  if (!executablePath) return "";
  const result = spawnSync(executablePath, args, { env: executionEnvironment, encoding: "utf8", timeout: 3000, windowsHide: true, maxBuffer: 256 * 1024 });
  return `${result.stdout || ""}\n${result.stderr || ""}`.trim();
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
