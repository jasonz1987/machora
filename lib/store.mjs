import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const STORE_VERSION = 7;
const EMPTY_DATA = { version: STORE_VERSION, hosts: [], projects: [], jobs: [], notifications: [], enrollments: [], deploymentTargets: [] };
const PROJECT_OPERATIONS = ["install", "test", "build", "dev", "deploy"];
const RUNTIME_TOOLS = ["node", "java", "python"];
const RUNTIME_OPERATIONS = ["query", "install", "uninstall", "verify"];
const ACTIVE_JOB_STATUSES = ["queued", "dispatched", "running"];
const TERMINAL_JOB_STATUSES = ["succeeded", "failed", "cancelled"];
const DEGRADED_HEARTBEAT_AFTER = 30_000;
const OFFLINE_HEARTBEAT_AFTER = 90_000;

export function getConfigDir() {
  if (process.env.MACHORA_CONFIG_DIR) return process.env.MACHORA_CONFIG_DIR;
  if (process.env.RDEV_CONFIG_DIR) return process.env.RDEV_CONFIG_DIR;
  const current = defaultConfigDir();
  if (existsSync(path.join(current, "config.json"))) return current;
  const legacyDirectories = process.platform === "win32"
    ? [path.join(os.homedir(), ".machora"), path.join(os.homedir(), ".rdev")]
    : [path.join(os.homedir(), ".rdev")];
  return legacyDirectories.find((directory) => existsSync(path.join(directory, "config.json"))) || current;
}

export function defaultConfigDir(options = {}) {
  const platform = options.platform || process.platform;
  const home = options.home || os.homedir();
  const environment = options.env || process.env;
  return platform === "win32"
    ? path.join(environment.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Machora")
    : path.join(home, ".machora");
}

export function getStorePath() {
  return path.join(getConfigDir(), "config.json");
}

export async function readStore() {
  try {
    const raw = await readFile(getStorePath(), "utf8");
    const data = JSON.parse(raw);
    return {
      ...EMPTY_DATA,
      ...data,
      version: Math.max(Number(data.version) || 0, EMPTY_DATA.version),
      hosts: Array.isArray(data.hosts) ? data.hosts : [],
      projects: Array.isArray(data.projects) ? data.projects : [],
      jobs: Array.isArray(data.jobs) ? data.jobs : [],
      notifications: Array.isArray(data.notifications) ? data.notifications : [],
      enrollments: Array.isArray(data.enrollments) ? data.enrollments : [],
      deploymentTargets: Array.isArray(data.deploymentTargets) ? data.deploymentTargets : [],
    };
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(EMPTY_DATA);
    throw error;
  }
}

export async function writeStore(data) {
  const directory = getConfigDir();
  const target = getStorePath();
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

export async function listHosts() {
  const data = await readStore();
  return data.hosts.map((host) => publicHost(host, data.jobs)).toSorted((a, b) => a.alias.localeCompare(b.alias));
}

export async function addHost(input) {
  const data = await readStore();
  const alias = normalizeAlias(input.alias);
  if (data.hosts.some((host) => host.alias === alias)) throw Object.assign(new Error(`Host alias already exists: ${alias}`), { statusCode: 409 });
  const now = new Date().toISOString();
  const hostOs = normalizeOs(input.os);
  const host = {
    id: randomUUID(), alias, hostname: cleanText(input.hostname || alias, 120), address: cleanText(input.address || "Pending enrollment", 200),
    os: hostOs, arch: cleanText(input.arch || "unknown", 40), status: input.status === "online" ? "online" : "pending",
    capabilities: normalizeCapabilities(input.capabilities), cpu: Number.isFinite(input.cpu) ? input.cpu : null,
    memory: Number.isFinite(input.memory) ? input.memory : null, createdAt: now, lastSeenAt: input.status === "online" ? now : null,
    workspace: normalizeWorkspace(input.workspace, hostOs), tools: normalizeTools(input.tools),
    runtimeManager: normalizeRuntimeManager(input.runtimeManager), runtimes: normalizeRuntimes(input.runtimes), runtimeCatalog: normalizeRuntimeCatalog(input.runtimeCatalog),
    agentVersion: null, agentSecretHash: null,
  };
  data.hosts.push(host);
  await writeStore(data);
  return host;
}

export async function removeHost(idOrAlias) {
  const data = await readStore();
  const index = data.hosts.findIndex((host) => host.id === idOrAlias || host.alias === idOrAlias);
  if (index === -1) return false;
  const [removedHost] = data.hosts.splice(index, 1);
  for (const project of data.projects) {
    if (project.hostId !== removedHost.id) continue;
    project.hostId = null;
    project.status = "unassigned";
    project.remoteStatus = "blocked";
    project.remoteError = "Task machine was removed";
    project.updatedAt = new Date().toISOString();
  }
  for (const job of data.jobs) {
    if (job.hostId === removedHost.id && ["queued", "dispatched", "running"].includes(job.status)) {
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
      job.error = "Task machine was removed";
    }
  }
  for (const target of data.deploymentTargets) {
    const authorization = target.authorizations?.find((item) => item.hostId === removedHost.id);
    if (authorization) {
      authorization.status = "orphaned";
      authorization.error = "Task machine was removed; revoke this credential from the deployment target";
      authorization.updatedAt = new Date().toISOString();
    }
  }
  await writeStore(data);
  return true;
}

export async function listDeploymentTargets() {
  const data = await readStore();
  return data.deploymentTargets.map((target) => publicDeploymentTarget(target, data)).toSorted((a, b) => a.name.localeCompare(b.name));
}

export async function getDeploymentTargetRecord(idOrName) {
  const data = await readStore();
  const target = requireDeploymentTarget(data, idOrName);
  return structuredClone(target);
}

export async function addDeploymentTargetRecord(record) {
  const data = await readStore();
  const name = cleanText(record?.name, 80);
  if (!name) throw Object.assign(new Error("Deployment target name is required"), { statusCode: 400 });
  if (data.deploymentTargets.some((target) => target.name.toLowerCase() === name.toLowerCase())) {
    throw Object.assign(new Error(`Deployment target already exists: ${name}`), { statusCode: 409 });
  }
  data.deploymentTargets.push({ ...record, name, authorizations: Array.isArray(record.authorizations) ? record.authorizations : [] });
  data.version = STORE_VERSION;
  await writeStore(data);
  return publicDeploymentTarget(data.deploymentTargets.at(-1), data);
}

export async function removeDeploymentTargetRecord(idOrName) {
  const data = await readStore();
  const index = data.deploymentTargets.findIndex((target) => target.id === idOrName || target.name === idOrName);
  if (index === -1) return false;
  const [removed] = data.deploymentTargets.splice(index, 1);
  data.jobs = data.jobs.filter((job) => job.deploymentTargetId !== removed.id);
  for (const project of data.projects) if (project.deploymentTargetId === removed.id) project.deploymentTargetId = null;
  await writeStore(data);
  return true;
}

export async function updateDeploymentAuthorization(targetId, hostId, patch) {
  const data = await readStore();
  const target = requireDeploymentTarget(data, targetId);
  const host = data.hosts.find((item) => item.id === hostId || item.alias === hostId);
  if (!host) throw Object.assign(new Error(`Host not found: ${hostId}`), { statusCode: 404 });
  target.authorizations ||= [];
  let authorization = target.authorizations.find((item) => item.hostId === host.id);
  if (!authorization) {
    authorization = { hostId: host.id, status: "requested", createdAt: new Date().toISOString() };
    target.authorizations.push(authorization);
  }
  const allowed = ["status", "jobId", "publicKey", "fingerprint", "marker", "alias", "configPath", "error", "authorizedAt", "revokedAt", "updatedAt"];
  for (const key of allowed) if (Object.hasOwn(patch, key)) authorization[key] = patch[key];
  authorization.updatedAt = new Date().toISOString();
  target.updatedAt = authorization.updatedAt;
  await writeStore(data);
  return publicDeploymentTarget(target, data);
}

export async function deleteDeploymentAuthorization(targetId, hostId) {
  const data = await readStore();
  const target = requireDeploymentTarget(data, targetId);
  const initialLength = target.authorizations?.length || 0;
  target.authorizations = (target.authorizations || []).filter((item) => item.hostId !== hostId);
  if (target.authorizations.length === initialLength) return false;
  target.updatedAt = new Date().toISOString();
  await writeStore(data);
  return true;
}

export async function queueDeploymentAccessJob(targetId, hostId, operation) {
  const data = await readStore();
  const target = requireDeploymentTarget(data, targetId);
  const host = data.hosts.find((item) => item.id === hostId || item.alias === hostId);
  if (!host) throw Object.assign(new Error(`Host not found: ${hostId}`), { statusCode: 404 });
  if (!host.agentSecretHash) throw Object.assign(new Error("This task machine does not have an enrolled Agent"), { statusCode: 409 });
  if (!["prepare", "verify", "revoke"].includes(operation)) throw Object.assign(new Error(`Unknown deployment access operation: ${operation}`), { statusCode: 400 });
  const duplicate = data.jobs.find((job) => job.type === "deployment-access" && job.deploymentTargetId === target.id && job.hostId === host.id && job.operation === operation && ACTIVE_JOB_STATUSES.includes(job.status));
  if (duplicate) return publicJob(duplicate, data);
  const now = new Date().toISOString();
  const job = {
    id: randomUUID(), projectId: null, deploymentTargetId: target.id, hostId: host.id,
    type: "deployment-access", operation, command: null, prepareCommand: null,
    status: "queued", attempts: 0, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
    currentStep: null, steps: createJobSteps("deployment-access", operation), output: null, error: null, result: null,
  };
  data.jobs.push(job);
  await writeStore(data);
  return publicJob(job, data);
}

export async function listProjects() {
  const data = await readStore();
  return data.projects.map((project) => publicProject(project, data.hosts, data.jobs)).toSorted((a, b) => a.name.localeCompare(b.name));
}

export async function listProjectsForHost(hostId) {
  const data = await readStore();
  return data.projects.filter((project) => project.hostId === hostId).map((project) => publicProject(project, data.hosts, data.jobs));
}

export async function assignProject(metadata, hostTarget) {
  const data = await readStore();
  const target = cleanText(hostTarget, 200).toLowerCase();
  const host = data.hosts.find((item) => [item.id, item.alias, item.address, item.hostname].some((value) => String(value || "").toLowerCase() === target));
  if (!host) throw Object.assign(new Error(`Host not found: ${hostTarget}`), { statusCode: 404 });
  const localPath = cleanText(metadata.localPath, 500);
  if (!localPath) throw Object.assign(new Error("Local project path is required"), { statusCode: 400 });
  const now = new Date().toISOString();
  const existing = data.projects.find((project) => project.localPath === localPath);
  const project = {
    id: existing?.id || randomUUID(),
    name: cleanText(metadata.name, 120),
    localPath,
    gitRemote: cleanOptionalText(metadata.gitRemote, 500),
    branch: cleanText(metadata.branch || "detached", 160),
    commit: cleanOptionalText(metadata.commit, 80),
    dirty: Boolean(metadata.dirty),
    changedFiles: Math.max(0, Math.min(10000, Number(metadata.changedFiles) || 0)),
    projectType: cleanText(metadata.projectType || "Git", 80),
    packageManager: cleanOptionalText(metadata.packageManager, 40),
    detectedDevPort: normalizePort(metadata.devPort),
    devPort: existing?.devPortSource === "custom" ? normalizePort(existing.devPort) : normalizePort(metadata.devPort),
    devPortSource: existing?.devPortSource === "custom" ? "custom" : "detected",
    frameworks: normalizeStringList(metadata.frameworks, 12, 80),
    languages: normalizeStringList(metadata.languages, 12, 40),
    commands: normalizeProjectCommands(metadata.commands),
    toolchain: normalizeToolchain(metadata.toolchain ?? existing?.toolchain),
    hostId: host.id,
    remotePath: remoteProjectPath(host.workspace, metadata.name, host.os),
    status: "assigned",
    skill: existing?.skill || { status: "pending", path: ".agents/skills/machora/SKILL.md", ignoredByGit: true, policyPath: "AGENTS.override.md", policyIgnoredByGit: true, installedAt: null },
    automations: metadata.automations ? { rules: normalizeAutomationRules(metadata.automations.rules, metadata.commands) } : existing?.automations || { rules: [] },
    hook: existing?.hook || { status: "not-installed", path: null, installedAt: null, originalPreserved: false },
    remoteStatus: "pending",
    remoteAction: null,
    remoteError: null,
    remoteCommit: existing?.remoteCommit || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastSyncedAt: existing?.lastSyncedAt || null,
  };
  if (existing) Object.assign(existing, project);
  else data.projects.push(project);
  data.version = STORE_VERSION;
  await writeStore(data);
  return publicProject(project, data.hosts, data.jobs);
}

export async function removeProject(idOrPathOrName) {
  const data = await readStore();
  const target = String(idOrPathOrName || "");
  const index = data.projects.findIndex((project) => [project.id, project.localPath, project.name].includes(target));
  if (index === -1) return false;
  const [removed] = data.projects.splice(index, 1);
  data.jobs = data.jobs.filter((job) => job.projectId !== removed.id);
  await writeStore(data);
  return true;
}

export async function updateProjectSkill(projectId, skill) {
  const data = await readStore();
  const project = requireProject(data, projectId);
  project.skill = {
    status: skill?.status === "installed" ? "installed" : "error",
    path: cleanText(skill?.path || ".agents/skills/machora/SKILL.md", 240),
    ignoredByGit: Boolean(skill?.ignoredByGit),
    policyPath: cleanText(skill?.policyPath || "AGENTS.override.md", 240),
    policyIgnoredByGit: Boolean(skill?.policyIgnoredByGit),
    installedAt: cleanOptionalText(skill?.installedAt, 60),
    error: cleanOptionalText(skill?.error, 500),
  };
  project.updatedAt = new Date().toISOString();
  await writeStore(data);
  return publicProject(project, data.hosts, data.jobs);
}

export async function updateProjectCommands(projectId, commands, settings = {}) {
  const data = await readStore();
  const project = requireProject(data, projectId);
  project.commands = normalizeProjectCommands({ ...project.commands, ...commands });
  if (Object.hasOwn(settings, "devPort") || Object.hasOwn(settings, "devPortSource")) {
    const source = settings.devPortSource === "custom" ? "custom" : "detected";
    if (source === "custom") {
      const port = normalizePort(settings.devPort);
      if (!port) throw Object.assign(new Error("Preview port must be an integer from 1 to 65535"), { statusCode: 400 });
      project.devPort = port;
    } else {
      project.devPort = normalizePort(project.detectedDevPort);
    }
    project.devPortSource = source;
  }
  project.updatedAt = new Date().toISOString();
  await writeStore(data);
  return publicProject(project, data.hosts, data.jobs);
}

export async function updateProjectToolchain(projectId, value) {
  const data = await readStore();
  const project = requireProject(data, projectId);
  project.toolchain = normalizeToolchain(value);
  project.updatedAt = new Date().toISOString();
  data.version = STORE_VERSION;
  await writeStore(data);
  return publicProject(project, data.hosts, data.jobs);
}

export async function updateProjectAutomations(projectId, rules) {
  const data = await readStore();
  const project = requireProject(data, projectId);
  project.automations = { rules: normalizeAutomationRules(rules, project.commands) };
  project.updatedAt = new Date().toISOString();
  data.version = STORE_VERSION;
  await writeStore(data);
  return publicProject(project, data.hosts, data.jobs);
}

export async function updateProjectHook(projectId, hook) {
  const data = await readStore();
  const project = requireProject(data, projectId);
  const status = ["installed", "not-installed", "error"].includes(hook?.status) ? hook.status : "error";
  project.hook = {
    status,
    path: cleanOptionalText(hook?.path, 500),
    installedAt: cleanOptionalText(hook?.installedAt, 60),
    originalPreserved: Boolean(hook?.originalPreserved),
    error: cleanOptionalText(hook?.error, 500),
  };
  project.updatedAt = new Date().toISOString();
  await writeStore(data);
  return publicProject(project, data.hosts, data.jobs);
}

export async function triggerProjectAutomations(projectId, eventInput) {
  const data = await readStore();
  const project = requireProject(data, projectId);
  const event = normalizeGitEvent(eventInput);
  const rules = normalizeAutomationRules(project.automations?.rules, project.commands);
  const matchingRules = rules.filter((rule) => rule.enabled && rule.event === event.event && globMatches(rule.pattern, event.name));
  const jobs = [];
  for (const rule of matchingRules) {
    const fingerprint = createHash("sha256").update(`${project.id}\0${event.event}\0${event.ref}\0${event.sha}\0${rule.operation}`).digest("hex").slice(0, 32);
    const duplicate = data.jobs.find((job) => job.trigger?.fingerprint === fingerprint);
    if (duplicate) { jobs.push(publicJob(duplicate, data)); continue; }
    jobs.push(publicJob(createProjectJob(data, project, "command", rule.operation, {
      source: "git-hook", event: event.event, ref: event.ref, name: event.name, sha: event.sha,
      remote: event.remote, ruleId: rule.id, fingerprint,
    }), data));
  }
  if (jobs.length) await writeStore(data);
  return jobs;
}

export async function queueProjectJob(projectId, type, operation = null) {
  const data = await readStore();
  const project = requireProject(data, projectId);
  const duplicate = data.jobs.find((job) => job.projectId === project.id && job.type === type && job.operation === operation && ACTIVE_JOB_STATUSES.includes(job.status));
  if (duplicate) return publicJob(duplicate, data);
  const job = createProjectJob(data, project, type, operation);
  await writeStore(data);
  return publicJob(job, data);
}

function createProjectJob(data, project, type, operation = null, trigger = null) {
  if (!project.hostId) throw Object.assign(new Error("Project has no task machine"), { statusCode: 409 });
  if (type === "sync" && !project.gitRemote) throw Object.assign(new Error("Project has no origin Git remote"), { statusCode: 409 });
  if (type === "command" && !PROJECT_OPERATIONS.includes(operation)) throw Object.assign(new Error(`Unknown project operation: ${operation}`), { statusCode: 400 });
  const command = type === "command" ? cleanText(project.commands?.[operation], 2000) : null;
  if (type === "command" && !command) throw Object.assign(new Error(`No ${operation} command is configured for ${project.name}`), { statusCode: 409 });
  const now = new Date().toISOString();
  const prepareCommand = type === "command" && operation !== "install" ? cleanOptionalText(project.commands?.install, 2000) : null;
  const job = {
    id: randomUUID(), projectId: project.id, hostId: project.hostId, type, operation, command, prepareCommand,
    trigger,
    status: "queued", attempts: 0, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
    currentStep: null, steps: createJobSteps(type, operation, prepareCommand), output: null, error: null, result: null,
  };
  data.jobs.push(job);
  project.remoteStatus = type === "sync" ? "queued" : project.remoteStatus;
  project.remoteAction = type === "sync" ? null : operation;
  project.remoteError = null;
  project.updatedAt = now;
  return job;
}

export async function queueHostCommand(hostId, input = {}) {
  const data = await readStore();
  const host = data.hosts.find((item) => item.id === hostId || item.alias === hostId);
  if (!host) throw Object.assign(new Error(`Host not found: ${hostId}`), { statusCode: 404 });
  if (!host.agentSecretHash) throw Object.assign(new Error("This task machine does not have an enrolled Agent"), { statusCode: 409 });
  const command = cleanCommand(input.command, 4000);
  if (!command) throw Object.assign(new Error("Remote command is required"), { statusCode: 400 });
  const workingDirectory = cleanText(input.workingDirectory || host.workspace, 500);
  const risk = classifyHostCommand(command);
  if (risk.requiresConfirmation && input.confirmed !== true) {
    throw Object.assign(new Error("This command needs confirmation before it can run"), {
      statusCode: 409,
      details: { requiresConfirmation: true, risk },
    });
  }
  const duplicate = data.jobs.find((job) => job.type === "host-command" && job.hostId === host.id && job.command === command && job.workingDirectory === workingDirectory && ACTIVE_JOB_STATUSES.includes(job.status));
  if (duplicate) return publicJob(duplicate, data);
  const now = new Date().toISOString();
  const job = {
    id: randomUUID(), projectId: null, hostId: host.id, type: "host-command", operation: "shell",
    command, workingDirectory, risk: risk.level, prepareCommand: null,
    status: "queued", attempts: 0, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
    currentStep: null, steps: createJobSteps("host-command"), output: null, error: null, result: null,
  };
  data.jobs.push(job);
  await writeStore(data);
  return publicJob(job, data);
}

export async function queueRuntimeJob(hostId, input = {}) {
  const data = await readStore();
  const host = data.hosts.find((item) => item.id === hostId || item.alias === hostId);
  if (!host) throw Object.assign(new Error(`Host not found: ${hostId}`), { statusCode: 404 });
  if (!host.agentSecretHash) throw Object.assign(new Error("This task machine does not have an enrolled Agent"), { statusCode: 409 });
  if (isOlderVersion(host.agentVersion, "0.11.0")) throw Object.assign(new Error("Update this task machine to Agent 0.11.0 before managing runtimes"), { statusCode: 409 });
  const operation = cleanText(input.operation, 20).toLowerCase();
  const tool = cleanText(input.tool, 20).toLowerCase();
  const version = cleanOptionalText(input.version, 100);
  if (!RUNTIME_OPERATIONS.includes(operation)) throw Object.assign(new Error(`Unknown runtime operation: ${operation || "missing"}`), { statusCode: 400 });
  if (!RUNTIME_TOOLS.includes(tool)) throw Object.assign(new Error("Runtime must be node, java, or python"), { statusCode: 400 });
  if (operation !== "query" && !version) throw Object.assign(new Error(`A ${tool} version is required`), { statusCode: 400 });
  if (version && !/^[A-Za-z0-9][A-Za-z0-9._+:-]{0,99}$/.test(version)) throw Object.assign(new Error("Runtime version contains unsupported characters"), { statusCode: 400 });
  const duplicate = data.jobs.find((job) => job.type === "runtime" && job.hostId === host.id && job.operation === operation && job.runtime?.tool === tool && job.runtime?.version === version && ACTIVE_JOB_STATUSES.includes(job.status));
  if (duplicate) return publicJob(duplicate, data);
  const now = new Date().toISOString();
  const job = {
    id: randomUUID(), projectId: null, hostId: host.id, type: "runtime", operation,
    command: null, prepareCommand: null, runtime: { tool, version },
    status: "queued", attempts: 0, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
    currentStep: null, steps: createJobSteps("runtime", operation, null, tool), output: null, error: null, result: null,
  };
  data.jobs.push(job);
  await writeStore(data);
  return publicJob(job, data);
}

export async function queueAgentUpdate(hostId, input = {}) {
  const data = await readStore();
  const host = data.hosts.find((item) => item.id === hostId || item.alias === hostId);
  if (!host) throw Object.assign(new Error(`Host not found: ${hostId}`), { statusCode: 404 });
  if (!host.agentSecretHash) throw Object.assign(new Error("This task machine does not have an enrolled Agent"), { statusCode: 409 });
  if (isOlderVersion(host.agentVersion, "0.6.0")) {
    throw Object.assign(new Error("Agents older than 0.6.0 must be updated once from the task machine"), { statusCode: 409 });
  }
  const targetAgentVersion = cleanText(input.targetVersion, 30);
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(targetAgentVersion)) {
    throw Object.assign(new Error("A valid target Agent version is required"), { statusCode: 400 });
  }
  if (!isOlderVersion(host.agentVersion, targetAgentVersion)) {
    throw Object.assign(new Error(`${host.alias} already runs Agent ${host.agentVersion}`), { statusCode: 409 });
  }
  const command = cleanCommand(input.command, 4000);
  if (!command) throw Object.assign(new Error("Agent update command is required"), { statusCode: 400 });
  const duplicate = data.jobs.find((job) => job.type === "host-command" && job.operation === "agent-update" && job.hostId === host.id && (
    ACTIVE_JOB_STATUSES.includes(job.status)
    || (job.status === "succeeded" && Date.now() - Date.parse(job.finishedAt || job.updatedAt) < 2 * 60_000)
  ));
  if (duplicate) return publicJob(duplicate, data);
  const now = new Date().toISOString();
  const job = {
    id: randomUUID(), projectId: null, hostId: host.id, type: "host-command", operation: "agent-update",
    command, workingDirectory: host.workspace, risk: "system", targetAgentVersion, prepareCommand: null,
    status: "queued", attempts: 0, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
    currentStep: null, steps: createJobSteps("host-command", "agent-update"), output: null, error: null, result: null,
  };
  data.jobs.push(job);
  await writeStore(data);
  return publicJob(job, data);
}

export function classifyHostCommand(command) {
  const value = String(command || "").trim();
  const reasons = [];
  const rules = [
    [/\bsudo\b|\brunas\b|Start-Process\s+[^\r\n]*-Verb\s+RunAs/i, "Requests elevated privileges"],
    [/(?:^|[;&|]\s*)rm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\b|\b(?:del|erase)\s+\/s\b|Remove-Item\s+[^\r\n]*-Recurse/i, "Recursively deletes files"],
    [/\b(?:mkfs(?:\.[a-z0-9]+)?|diskutil\s+erase|format\s+[a-z]:|dd\s+[^\r\n]*\bof=\/dev\/|shutdown|reboot|halt|poweroff)\b/i, "Can alter disks or stop the machine"],
    [/\b(?:npm|pnpm|yarn)\s+(?:install|add)\s+(?:--global|-g)\b|\bnpm\s+(?:--global|-g)\s+install\b/i, "Changes shared development tooling"],
    [/\b(?:curl|wget|irm|Invoke-WebRequest)\b[^\r\n|;&]*(?:\||\|\s*(?:sh|bash|zsh|iex|Invoke-Expression)\b)/i, "Downloads and immediately executes remote code"],
  ];
  for (const [pattern, reason] of rules) if (pattern.test(value) && !reasons.includes(reason)) reasons.push(reason);
  return { level: reasons.length ? "dangerous" : "standard", requiresConfirmation: reasons.length > 0, reasons };
}

export async function listJobs() {
  const data = await readStore();
  return data.jobs.map((job) => publicJob(job, data)).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getJob(id) {
  const data = await readStore();
  const job = data.jobs.find((item) => item.id === id);
  return job ? publicJob(job, data) : null;
}

export async function listNotifications() {
  const data = await readStore();
  return data.notifications.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
}

export async function markNotificationRead(id) {
  const data = await readStore();
  const notification = data.notifications.find((item) => item.id === id);
  if (!notification) return null;
  notification.readAt ||= new Date().toISOString();
  await writeStore(data);
  return notification;
}

export async function acceptAgentJobUpdates(agentId, secret, updates) {
  const data = await readStore();
  const host = requireAgent(data, agentId, secret);
  const now = new Date().toISOString();
  let changed = false;
  for (const update of Array.isArray(updates) ? updates.slice(0, 10) : []) {
    const job = data.jobs.find((item) => item.id === update?.id && item.hostId === host.id);
    if (!job || TERMINAL_JOB_STATUSES.includes(job.status)) continue;
    job.status = "running";
    job.startedAt ||= cleanOptionalText(update.startedAt, 60) || now;
    job.updatedAt = now;
    job.currentStep = cleanOptionalText(update.currentStep, 40);
    job.steps = normalizeJobSteps(update.steps, job.steps);
    if (update.output != null) job.output = cleanOptionalText(update.output, 32 * 1024);
    const project = data.projects.find((item) => item.id === job.projectId);
    if (project && job.currentStep === "sync") project.remoteStatus = "syncing";
    changed = true;
  }
  if (changed) await writeStore(data);
}

export async function acceptAgentJobResults(agentId, secret, results) {
  const data = await readStore();
  const host = requireAgent(data, agentId, secret);
  const now = new Date().toISOString();
  const completed = [];
  for (const result of Array.isArray(results) ? results.slice(0, 20) : []) {
    const job = data.jobs.find((item) => item.id === result?.id && item.hostId === host.id);
    if (!job || TERMINAL_JOB_STATUSES.includes(job.status)) continue;
    job.status = result.ok ? "succeeded" : "failed";
    job.startedAt ||= cleanOptionalText(result.startedAt, 60) || now;
    job.finishedAt = now;
    job.updatedAt = now;
    job.currentStep = null;
    job.steps = normalizeJobSteps(result.steps, job.steps, job.status);
    job.output = cleanOptionalText(result.output, 32 * 1024);
    job.error = cleanOptionalText(result.error, 2000);
    job.result = normalizeJobResult(result.result);
    if (job.type === "runtime" && result.ok) {
      if (job.result?.runtimeManager) host.runtimeManager = normalizeRuntimeManager(job.result.runtimeManager);
      if (job.result?.runtimes) host.runtimes = normalizeRuntimes(job.result.runtimes);
      if (job.operation === "query" && job.runtime?.tool) {
        host.runtimeCatalog ||= {};
        host.runtimeCatalog[job.runtime.tool] = {
          versions: normalizeRuntimeVersions(job.result?.versions),
          updatedAt: now,
        };
      }
    }
    const project = data.projects.find((item) => item.id === job.projectId);
    if (job.type === "sync" && project) {
      project.remoteStatus = result.ok ? "ready" : "error";
      project.remoteAction = cleanOptionalText(result.result?.action, 20);
      project.remoteError = result.ok ? null : job.error || "Remote Git sync failed";
      project.remoteCommit = cleanOptionalText(result.result?.commit, 80) || project.remoteCommit;
      if (result.ok) project.lastSyncedAt = now;
    } else if (job.type === "command" && project) {
      const syncAction = cleanOptionalText(result.result?.syncAction, 20);
      const commit = cleanOptionalText(result.result?.commit, 80);
      if (syncAction) project.remoteAction = syncAction;
      if (commit) project.remoteCommit = commit;
      if (result.ok) {
        project.remoteStatus = "ready";
        project.lastSyncedAt = now;
      }
    }
    if (project) project.updatedAt = now;
    const notification = createJobNotification(job, project, host, now, data.deploymentTargets.find((item) => item.id === job.deploymentTargetId));
    data.notifications.unshift(notification);
    completed.push({ job: publicJob(job, data), notification });
  }
  data.notifications = data.notifications.slice(0, 200);
  await writeStore(data);
  return completed;
}

export async function claimJobsForHost(hostId) {
  const data = await readStore();
  const host = data.hosts.find((item) => item.id === hostId);
  if (!host) return [];
  if (isOlderVersion(host.agentVersion, "0.5.0")) {
    let changed = false;
    for (const job of data.jobs.filter((item) => item.hostId === hostId && ["dispatched", "running"].includes(item.status))) {
      job.status = "queued";
      job.updatedAt = new Date().toISOString();
      const project = data.projects.find((item) => item.id === job.projectId);
      if (project && job.type === "sync") project.remoteStatus = "queued";
      changed = true;
    }
    if (changed) await writeStore(data);
    return [];
  }
  const now = new Date().toISOString();
  const jobs = data.jobs.filter((job) => (
    job.hostId === hostId
    && ACTIVE_JOB_STATUSES.includes(job.status)
    && (job.type !== "host-command" || !isOlderVersion(host.agentVersion, "0.6.0"))
    && (job.type !== "deployment-access" || !isOlderVersion(host.agentVersion, "0.10.0"))
    && (job.type !== "runtime" || !isOlderVersion(host.agentVersion, "0.11.0"))
    && (!job.trigger || !isOlderVersion(host.agentVersion, "0.7.0"))
  )).slice(0, 1);
  for (const job of jobs) {
    if (job.status === "queued") {
      job.status = "dispatched";
      job.attempts += 1;
      job.updatedAt = now;
      const project = data.projects.find((item) => item.id === job.projectId);
      if (project && job.type === "sync") project.remoteStatus = "syncing";
    }
  }
  if (jobs.length) await writeStore(data);
  return jobs.map((job) => agentJob(job, data)).filter(Boolean);
}

function isOlderVersion(current, target) {
  if (!current) return true;
  const currentParts = String(current).split(".").map(Number);
  const targetParts = String(target).split(".").map(Number);
  for (let index = 0; index < Math.max(currentParts.length, targetParts.length); index += 1) {
    const difference = (currentParts[index] || 0) - (targetParts[index] || 0);
    if (difference) return difference < 0;
  }
  return false;
}

export async function createEnrollment(input) {
  const data = await readStore();
  const alias = normalizeAlias(input.alias);
  const existingHost = data.hosts.find((host) => host.alias === alias);
  if (existingHost?.agentSecretHash) throw Object.assign(new Error(`Host already has an Agent: ${alias}`), { statusCode: 409 });
  if (data.enrollments.some((item) => item.alias === alias && !item.usedAt && Date.parse(item.expiresAt) > Date.now())) {
    throw Object.assign(new Error(`An active enrollment already exists for: ${alias}`), { statusCode: 409 });
  }
  const token = randomUUID();
  const createdAt = new Date();
  const enrollmentOs = normalizeOs(input.os);
  const enrollment = {
    token,
    alias,
    os: enrollmentOs,
    workspace: normalizeWorkspace(input.workspace, enrollmentOs),
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + 15 * 60 * 1000).toISOString(),
    usedAt: null,
  };
  data.enrollments = data.enrollments.filter((item) => Date.parse(item.expiresAt) > Date.now() && !item.usedAt);
  data.enrollments.push(enrollment);
  await writeStore(data);
  return enrollment;
}

export async function completeEnrollment(token, machine) {
  const data = await readStore();
  const enrollment = data.enrollments.find((item) => item.token === token);
  if (!enrollment) throw Object.assign(new Error("Enrollment token not found"), { statusCode: 404 });
  if (enrollment.usedAt) throw Object.assign(new Error("Enrollment token was already used"), { statusCode: 409 });
  if (Date.parse(enrollment.expiresAt) <= Date.now()) throw Object.assign(new Error("Enrollment token has expired"), { statusCode: 410 });
  const existingHost = data.hosts.find((host) => host.alias === enrollment.alias);
  if (existingHost?.agentSecretHash) throw Object.assign(new Error(`Host already has an Agent: ${enrollment.alias}`), { statusCode: 409 });
  const now = new Date().toISOString();
  const reportedOs = normalizeOs(machine.os || enrollment.os);
  const agentSecret = randomBytes(32).toString("base64url");
  const host = {
    id: existingHost?.id || randomUUID(), alias: enrollment.alias, hostname: cleanText(machine.hostname || enrollment.alias, 120),
    address: cleanText(machine.address || machine.hostname || enrollment.alias, 200), os: reportedOs, arch: cleanText(machine.arch || "unknown", 40),
    status: "online", capabilities: normalizeCapabilities(machine.capabilities || (reportedOs === "macos" ? ["metal"] : [])),
    cpu: normalizeMetric(machine.cpu), memory: normalizeMetric(machine.memory), createdAt: existingHost?.createdAt || now, lastSeenAt: now,
    workspace: normalizeWorkspace(machine.workspace || enrollment.workspace, reportedOs), tools: normalizeTools(machine.tools),
    runtimeManager: normalizeRuntimeManager(machine.runtimeManager), runtimes: normalizeRuntimes(machine.runtimes), runtimeCatalog: {},
    health: normalizeAgentHealth(machine.health),
    agentVersion: cleanText(machine.agentVersion || "0.3.0", 30), agentSecretHash: hashSecret(agentSecret),
  };
  enrollment.usedAt = now;
  if (existingHost) Object.assign(existingHost, host);
  else data.hosts.push(host);
  await writeStore(data);
  return { host: publicHost(host), credentials: { agentId: host.id, secret: agentSecret } };
}

export async function heartbeatAgent(agentId, secret, input, address) {
  const data = await readStore();
  const host = data.hosts.find((item) => item.id === agentId && item.agentSecretHash);
  if (!host || !verifySecret(secret, host.agentSecretHash)) {
    throw Object.assign(new Error("Invalid agent credentials"), { statusCode: 401 });
  }
  host.hostname = cleanText(input.hostname || host.hostname, 120);
  host.address = cleanText(address || host.address, 200);
  host.os = normalizeOs(input.os || host.os);
  host.arch = cleanText(input.arch || host.arch, 40);
  host.capabilities = normalizeCapabilities(input.capabilities || host.capabilities);
  if (Array.isArray(input.tools)) host.tools = normalizeTools(input.tools);
  if (input.runtimeManager) host.runtimeManager = normalizeRuntimeManager(input.runtimeManager);
  if (Array.isArray(input.runtimes)) host.runtimes = normalizeRuntimes(input.runtimes);
  if (input.health) host.health = normalizeAgentHealth(input.health);
  host.cpu = normalizeMetric(input.cpu);
  host.memory = normalizeMetric(input.memory);
  if (input.workspace) host.workspace = normalizeWorkspace(input.workspace, host.os);
  host.agentVersion = cleanText(input.agentVersion || host.agentVersion, 30);
  host.lastSeenAt = new Date().toISOString();
  host.status = "online";
  await writeStore(data);
  // Activation can stop the old process before it reports completion. The
  // authenticated target-version heartbeat is evidence that the update worked;
  // otherwise the restarted Agent would claim its own update again forever.
  const activated = data.jobs.filter((job) => job.hostId === host.id
    && job.operation === "agent-update" && job.type === "host-command"
    && ["dispatched", "running"].includes(job.status) && job.targetAgentVersion
    && !isOlderVersion(host.agentVersion, job.targetAgentVersion));
  if (activated.length) await acceptAgentJobResults(agentId, secret, activated.map((job) => ({
    id: job.id, ok: true,
    output: `Agent ${host.agentVersion} activated; confirmed by authenticated heartbeat.`,
    result: { exitCode: 0 },
  })));
  return publicHost(host);
}

export function publicHost(host, jobs = []) {
  const { agentSecretHash: _secret, ...safeHost } = host;
  if (safeHost.agentVersion && safeHost.lastSeenAt) {
    const age = Math.max(0, Date.now() - Date.parse(safeHost.lastSeenAt));
    safeHost.lastSeenAgeMs = age;
    if (age <= DEGRADED_HEARTBEAT_AFTER) {
      safeHost.status = "online";
      safeHost.statusReason = `Heartbeat ${formatHeartbeatAge(age)} ago`;
    } else if (age <= OFFLINE_HEARTBEAT_AFTER) {
      safeHost.status = "degraded";
      safeHost.statusReason = `Heartbeat delayed by ${formatHeartbeatAge(age)}`;
    } else {
      safeHost.status = "offline";
      safeHost.statusReason = `No heartbeat for ${formatHeartbeatAge(age)}`;
    }
  }
  safeHost.health = normalizeAgentHealth(safeHost.health);
  safeHost.runtimeManager = normalizeRuntimeManager(safeHost.runtimeManager);
  safeHost.runtimes = normalizeRuntimes(safeHost.runtimes);
  safeHost.runtimeCatalog = normalizeRuntimeCatalog(safeHost.runtimeCatalog);
  safeHost.jobCounts = jobCounts(jobs.filter((job) => job.hostId === host.id));
  return safeHost;
}

function publicProject(project, hosts, jobs = []) {
  const host = hosts.find((item) => item.id === project.hostId);
  return {
    ...project,
    frameworks: Array.isArray(project.frameworks) ? project.frameworks : [project.projectType || "Git"],
    languages: Array.isArray(project.languages) ? project.languages : [],
    commands: normalizeProjectCommands(project.commands),
    toolchain: normalizeToolchain(project.toolchain),
    automations: { rules: normalizeAutomationRules(project.automations?.rules, project.commands) },
    hook: project.hook || { status: "not-installed", path: null, installedAt: null, originalPreserved: false },
    skill: project.skill || { status: "pending", path: ".agents/skills/machora/SKILL.md", ignoredByGit: true, policyPath: "AGENTS.override.md", policyIgnoredByGit: true, installedAt: null },
    remoteStatus: project.remoteStatus || (project.lastSyncedAt ? "ready" : "pending"),
    remoteAction: project.remoteAction || null,
    remoteError: project.remoteError || null,
    remoteCommit: project.remoteCommit || null,
    detectedDevPort: normalizePort(project.detectedDevPort ?? project.devPort),
    devPort: normalizePort(project.devPort),
    devPortSource: project.devPortSource === "custom" ? "custom" : "detected",
    jobCounts: jobCounts(jobs.filter((job) => job.projectId === project.id)),
    host: host ? { id: host.id, alias: host.alias, address: host.address, status: publicHost(host, jobs).status, workspace: host.workspace, os: host.os, agentVersion: host.agentVersion || null, runtimeManager: normalizeRuntimeManager(host.runtimeManager), runtimes: normalizeRuntimes(host.runtimes) } : null,
  };
}

function publicDeploymentTarget(target, data) {
  const { controllerCredential, ...safeTarget } = target;
  const authorizations = (target.authorizations || []).map((authorization) => {
    const host = data.hosts.find((item) => item.id === authorization.hostId);
    return {
      ...authorization,
      publicKey: undefined,
      host: host ? { id: host.id, alias: host.alias, address: host.address, status: publicHost(host, data.jobs).status, os: host.os, agentVersion: host.agentVersion || null } : null,
    };
  });
  return {
    ...safeTarget,
    controllerFingerprint: controllerCredential?.fingerprint || null,
    controllerTrusted: target.status === "ready" && Boolean(controllerCredential?.privateKeyPath),
    authorizations,
    authorizedHostCount: authorizations.filter((item) => item.status === "ready").length,
  };
}

function publicJob(job, data) {
  const project = data.projects.find((item) => item.id === job.projectId);
  const host = data.hosts.find((item) => item.id === job.hostId);
  const deploymentTarget = data.deploymentTargets.find((item) => item.id === job.deploymentTargetId);
  const hasStoredSteps = Array.isArray(job.steps) && job.steps.length > 0;
  return {
    ...job,
    trigger: normalizeJobTrigger(job.trigger),
    durationMs: job.startedAt && job.finishedAt ? Math.max(0, Date.parse(job.finishedAt) - Date.parse(job.startedAt)) : job.startedAt ? Math.max(0, Date.now() - Date.parse(job.startedAt)) : null,
    steps: normalizeJobSteps(hasStoredSteps ? job.steps : createJobSteps(job.type, job.operation, job.prepareCommand, job.runtime?.tool), [], hasStoredSteps ? null : job.status),
    project: project ? { id: project.id, name: project.name, localPath: project.localPath, remotePath: project.remotePath } : null,
    deploymentTarget: deploymentTarget ? { id: deploymentTarget.id, name: deploymentTarget.name, provider: deploymentTarget.provider } : null,
    host: host ? { id: host.id, alias: host.alias, address: host.address, status: publicHost(host, data.jobs).status } : null,
  };
}

function agentJob(job, data) {
  const project = data.projects.find((item) => item.id === job.projectId);
  const deploymentTarget = data.deploymentTargets.find((item) => item.id === job.deploymentTargetId);
  if (!project && !["host-command", "runtime"].includes(job.type) && !(job.type === "deployment-access" && deploymentTarget)) return null;
  return {
    id: job.id,
    type: job.type,
    operation: job.operation,
    command: job.command,
    workingDirectory: job.workingDirectory || null,
    prepareCommand: job.prepareCommand,
    trigger: normalizeJobTrigger(job.trigger),
    runtime: normalizeRuntimeRequest(job.runtime),
    steps: normalizeJobSteps(job.steps, createJobSteps(job.type, job.operation, job.prepareCommand, job.runtime?.tool)),
    deployment: deploymentTarget ? {
      id: deploymentTarget.id,
      name: deploymentTarget.name,
      provider: deploymentTarget.provider,
      host: deploymentTarget.config.host,
      port: deploymentTarget.config.port,
      username: deploymentTarget.config.username,
      hostFingerprint: deploymentTarget.hostKey.fingerprint,
      alias: deploymentAlias(deploymentTarget),
      marker: deploymentAuthorizationMarker(deploymentTarget.id, job.hostId),
    } : null,
    project: project ? {
      id: project.id,
      name: project.name,
      gitRemote: project.gitRemote,
      branch: project.branch,
      remotePath: project.remotePath,
      projectType: project.projectType,
      packageManager: project.packageManager,
      devPort: normalizePort(project.devPort),
      toolchain: normalizeToolchain(project.toolchain),
      hostAddress: data.hosts.find((item) => item.id === job.hostId)?.address || null,
    } : null,
  };
}

function requireProject(data, projectId) {
  const target = String(projectId || "");
  const project = data.projects.find((item) => [item.id, item.localPath, item.name].includes(target));
  if (!project) throw Object.assign(new Error(`Project not found: ${projectId}`), { statusCode: 404 });
  return project;
}

function requireDeploymentTarget(data, targetId) {
  const target = data.deploymentTargets.find((item) => item.id === targetId || item.name === targetId);
  if (!target) throw Object.assign(new Error(`Deployment target not found: ${targetId}`), { statusCode: 404 });
  return target;
}

function deploymentAlias(target) {
  const slug = String(target.name || "target").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "target";
  return `machora-${slug}-${String(target.id).slice(0, 6)}`;
}

function deploymentAuthorizationMarker(targetId, hostId) {
  return `machora:target:${targetId}:host:${hostId}`;
}

function normalizeAlias(value) {
  const alias = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,39}$/.test(alias)) throw Object.assign(new Error("Alias must be 2–40 characters: letters, numbers, dot, dash, or underscore"), { statusCode: 400 });
  return alias;
}

function normalizeOs(value) {
  const normalized = String(value || "auto").trim().toLowerCase();
  if (["mac", "darwin", "macos"].includes(normalized)) return "macos";
  if (["win", "win32", "windows"].includes(normalized)) return "windows";
  if (["linux", "ubuntu"].includes(normalized)) return "linux";
  if (normalized === "auto") return "auto";
  throw Object.assign(new Error("OS must be auto, macos, linux, or windows"), { statusCode: 400 });
}

function normalizeCapabilities(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(values.map((item) => cleanText(item, 30).toLowerCase()).filter(Boolean))].slice(0, 8);
}

function normalizeTools(value) {
  if (!Array.isArray(value)) return [];
  const tools = [];
  const identifiers = new Set();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const id = cleanText(item.id, 30).toLowerCase();
    const name = cleanText(item.name, 40);
    const version = cleanText(item.version, 80);
    if (!/^[a-z0-9][a-z0-9._+-]{0,29}$/.test(id) || !name || !version || identifiers.has(id)) continue;
    identifiers.add(id);
    tools.push({ id, name, version });
    if (tools.length >= 24) break;
  }
  return tools;
}

function normalizeRuntimeManager(value) {
  if (!value || typeof value !== "object") return { provider: "mise", status: "not-installed", version: null, managedRoot: null };
  return {
    provider: "mise",
    status: ["ready", "not-installed", "checking", "error"].includes(value.status) ? value.status : "not-installed",
    version: cleanOptionalText(value.version, 80),
    managedRoot: cleanOptionalText(value.managedRoot, 500),
    error: cleanOptionalText(value.error, 500),
  };
}

function normalizeAgentHealth(value) {
  if (!value || typeof value !== "object") return { toolInventoryUpdatedAt: null, toolInventoryStatus: null, runtimeInventoryUpdatedAt: null, runtimeInventoryStatus: null };
  const toolInventoryUpdatedAt = cleanOptionalText(value.toolInventoryUpdatedAt, 40);
  const runtimeInventoryUpdatedAt = cleanOptionalText(value.runtimeInventoryUpdatedAt, 40);
  return {
    toolInventoryUpdatedAt: toolInventoryUpdatedAt && Number.isFinite(Date.parse(toolInventoryUpdatedAt)) ? new Date(toolInventoryUpdatedAt).toISOString() : null,
    toolInventoryStatus: cleanOptionalText(value.toolInventoryStatus, 40),
    runtimeInventoryUpdatedAt: runtimeInventoryUpdatedAt && Number.isFinite(Date.parse(runtimeInventoryUpdatedAt)) ? new Date(runtimeInventoryUpdatedAt).toISOString() : null,
    runtimeInventoryStatus: cleanOptionalText(value.runtimeInventoryStatus, 40),
  };
}

function formatHeartbeatAge(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

function normalizeRuntimes(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, 200).map((item) => {
    const tool = cleanText(item?.tool, 20).toLowerCase();
    const version = cleanText(item?.version, 100);
    const key = `${tool}@${version}`;
    if (!RUNTIME_TOOLS.includes(tool) || !version || seen.has(key)) return null;
    seen.add(key);
    return { tool, version, installed: item?.installed !== false, provider: "mise" };
  }).filter(Boolean);
}

function normalizeRuntimeVersions(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanText(typeof item === "object" ? item?.version : item, 100)).filter((item) => /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,99}$/.test(item)))].slice(-200).reverse();
}

function normalizeRuntimeCatalog(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(RUNTIME_TOOLS.flatMap((tool) => value[tool] ? [[tool, {
    versions: normalizeRuntimeVersions(value[tool].versions),
    updatedAt: cleanOptionalText(value[tool].updatedAt, 60),
  }]] : []));
}

function normalizeRuntimeRequest(value) {
  if (!value || typeof value !== "object") return null;
  const tool = cleanText(value.tool, 20).toLowerCase();
  const version = cleanOptionalText(value.version, 100);
  return RUNTIME_TOOLS.includes(tool) ? { tool, version } : null;
}

function normalizeToolchain(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(RUNTIME_TOOLS.map((tool) => {
    const version = cleanOptionalText(source[tool], 100);
    return [tool, version && /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,99}$/.test(version) ? version : null];
  }));
}

function normalizeProjectCommands(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(PROJECT_OPERATIONS.map((operation) => [operation, cleanText(source[operation], 2000)]));
}

function normalizeAutomationRules(value, commands) {
  const source = Array.isArray(value) ? value : [];
  const normalizedCommands = normalizeProjectCommands(commands);
  const rules = [];
  for (const item of source.slice(0, 20)) {
    const event = ["branch-push", "tag-push"].includes(item?.event) ? item.event : "";
    const pattern = cleanText(item?.pattern, 160);
    const operation = cleanText(item?.operation, 40).toLowerCase();
    if (!event || !pattern || !PROJECT_OPERATIONS.includes(operation) || !normalizedCommands[operation]) continue;
    rules.push({
      id: /^[a-zA-Z0-9_-]{6,80}$/.test(String(item?.id || "")) ? String(item.id) : randomUUID(),
      event, pattern, operation, enabled: item?.enabled !== false,
    });
  }
  return rules;
}

function normalizeGitEvent(value) {
  const event = ["branch-push", "tag-push"].includes(value?.event) ? value.event : "";
  const expectedPrefix = event === "branch-push" ? "refs/heads/" : event === "tag-push" ? "refs/tags/" : "";
  const ref = cleanText(value?.ref, 300);
  const sha = cleanText(value?.sha, 80).toLowerCase();
  if (!event || !expectedPrefix || !ref.startsWith(expectedPrefix) || !/^[0-9a-f]{40,64}$/.test(sha)) throw Object.assign(new Error("Invalid Git push event"), { statusCode: 400 });
  return { event, ref, name: ref.slice(expectedPrefix.length), sha, remote: cleanOptionalText(value?.remote, 300) };
}

function normalizeJobTrigger(value) {
  if (!value || value.source !== "git-hook") return null;
  try {
    const event = normalizeGitEvent(value);
    return { source: "git-hook", ...event, ruleId: cleanOptionalText(value.ruleId, 80), fingerprint: cleanOptionalText(value.fingerprint, 80) };
  } catch { return null; }
}

function globMatches(pattern, value) {
  const expression = String(pattern).split("").map((character) => character === "*" ? ".*" : character === "?" ? "." : /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character).join("");
  return new RegExp(`^${expression}$`).test(String(value));
}

function normalizeStringList(value, limit, maxLength) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanText(item, maxLength)).filter(Boolean))].slice(0, limit);
}

function normalizeJobResult(value) {
  if (!value || typeof value !== "object") return null;
  return {
    action: cleanOptionalText(value.action, 20),
    syncAction: cleanOptionalText(value.syncAction, 20),
    commit: cleanOptionalText(value.commit, 80),
    exitCode: Number.isInteger(value.exitCode) ? value.exitCode : null,
    previewUrl: cleanOptionalUrl(value.previewUrl),
    processId: Number.isInteger(value.processId) && value.processId > 0 ? value.processId : null,
    logPath: cleanOptionalText(value.logPath, 500),
    publicKey: cleanOptionalText(value.publicKey, 2000),
    fingerprint: cleanOptionalText(value.fingerprint, 160),
    alias: cleanOptionalText(value.alias, 80),
    configPath: cleanOptionalText(value.configPath, 500),
    runtimeManager: value.runtimeManager ? normalizeRuntimeManager(value.runtimeManager) : null,
    runtimes: Array.isArray(value.runtimes) ? normalizeRuntimes(value.runtimes) : null,
    versions: Array.isArray(value.versions) ? normalizeRuntimeVersions(value.versions) : null,
    tool: RUNTIME_TOOLS.includes(String(value.tool || "").toLowerCase()) ? String(value.tool).toLowerCase() : null,
    version: cleanOptionalText(value.version, 100),
  };
}

function createJobSteps(type, operation, prepareCommand, runtimeTool = null) {
  const names = type === "runtime"
    ? [["runtime", operation === "query" ? `Query ${runtimeTool || "runtime"} versions` : operation === "install" ? `Install ${runtimeTool || "runtime"}` : operation === "uninstall" ? `Uninstall ${runtimeTool || "runtime"}` : `Verify ${runtimeTool || "runtime"}`]]
    : type === "deployment-access"
    ? [["deployment", operation === "prepare" ? "Prepare SSH credential" : operation === "verify" ? "Verify SSH access" : "Remove SSH credential"]]
    : type === "host-command" ? [["command", operation === "agent-update" ? "Schedule Agent update" : "Run remote command"]] : type === "sync" ? [["sync", "Git sync"]] : [
    ["sync", "Git sync"],
    ...(prepareCommand ? [["prepare", "Dependencies"]] : []),
    ["operation", operation === "dev" ? "Start preview" : `Run ${operation || "command"}`],
  ];
  return names.map(([id, label]) => ({ id, label, status: "pending", startedAt: null, finishedAt: null }));
}

function normalizeJobSteps(value, fallback = [], finalStatus = null) {
  const source = Array.isArray(value) ? value : fallback;
  return source.slice(0, 8).map((step) => {
    let status = ["pending", "running", "succeeded", "failed", "skipped"].includes(step?.status) ? step.status : "pending";
    if (finalStatus === "succeeded" && ["pending", "running"].includes(status)) status = "succeeded";
    if (finalStatus === "failed" && status === "running") status = "failed";
    return {
      id: cleanText(step?.id, 40), label: cleanText(step?.label, 80), status,
      startedAt: cleanOptionalText(step?.startedAt, 60), finishedAt: cleanOptionalText(step?.finishedAt, 60),
    };
  }).filter((step) => step.id && step.label);
}

function jobCounts(jobs) {
  return {
    active: jobs.filter((job) => ACTIVE_JOB_STATUSES.includes(job.status)).length,
    queued: jobs.filter((job) => job.status === "queued").length,
    running: jobs.filter((job) => ["dispatched", "running"].includes(job.status)).length,
    failed: jobs.filter((job) => job.status === "failed").length,
    succeeded: jobs.filter((job) => job.status === "succeeded").length,
  };
}

function createJobNotification(job, project, host, now, deploymentTarget = null) {
  const operation = job.type === "runtime" ? `${job.runtime?.tool || "runtime"} ${job.operation}` : job.type === "deployment-access" ? `SSH ${job.operation}` : job.type === "host-command" ? job.operation === "agent-update" ? "Agent update" : "remote command" : job.type === "sync" ? "Git sync" : String(job.operation || "job");
  const success = job.status === "succeeded";
  const subject = deploymentTarget?.name || project?.name || host.alias;
  const updateScheduled = success && job.type === "host-command" && job.operation === "agent-update";
  return {
    id: randomUUID(), jobId: job.id, projectId: project?.id || null, hostId: host.id,
    kind: success ? "success" : "error",
    title: `${subject} · ${operation} ${updateScheduled ? "scheduled" : success ? "completed" : "failed"}`,
    body: success && job.result?.previewUrl ? `Preview ready: ${job.result.previewUrl}` : updateScheduled ? `Restart scheduled on ${host.alias}; the new version will appear after its next heartbeat` : success ? `Finished on ${host.alias}` : job.error || `Failed on ${host.alias}`,
    createdAt: now, readAt: null,
  };
}

function requireAgent(data, agentId, secret) {
  const host = data.hosts.find((item) => item.id === agentId && item.agentSecretHash);
  if (!host || !verifySecret(secret, host.agentSecretHash)) throw Object.assign(new Error("Invalid agent credentials"), { statusCode: 401 });
  return host;
}

function normalizePort(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 65535 ? number : null;
}

function cleanOptionalUrl(value) {
  const cleaned = cleanOptionalText(value, 1000);
  if (!cleaned) return null;
  try {
    const parsed = new URL(cleaned);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : null;
  } catch { return null; }
}

function normalizeWorkspace(value, operatingSystem) {
  const fallback = operatingSystem === "windows" ? "%USERPROFILE%\\Code" : "~/Code";
  const workspace = cleanText(value || fallback, 240);
  if (!workspace) throw Object.assign(new Error("Workspace path is required"), { statusCode: 400 });
  return workspace;
}

function normalizeMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : null;
}

function hashSecret(secret) {
  return createHash("sha256").update(secret).digest("hex");
}

function verifySecret(secret, expectedHash) {
  if (!secret || !expectedHash) return false;
  const actual = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function cleanText(value, maxLength) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maxLength);
}

function cleanCommand(value, maxLength) {
  return String(value || "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, maxLength);
}

function cleanOptionalText(value, maxLength) {
  const cleaned = cleanText(value, maxLength);
  return cleaned || null;
}

function remoteProjectPath(workspace, name, operatingSystem) {
  const cleanName = cleanText(name, 120).replace(/[\\/:*?"<>|]/g, "-");
  const separator = operatingSystem === "windows" || String(workspace).includes("\\") ? "\\" : "/";
  return `${String(workspace || "").replace(/[\\/]+$/, "")}${separator}${cleanName}`;
}
