import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const EMPTY_DATA = { version: 5, hosts: [], projects: [], jobs: [], notifications: [], enrollments: [] };
const PROJECT_OPERATIONS = ["install", "test", "build", "dev", "deploy"];
const ACTIVE_JOB_STATUSES = ["queued", "dispatched", "running"];
const TERMINAL_JOB_STATUSES = ["succeeded", "failed", "cancelled"];

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
      hosts: Array.isArray(data.hosts) ? data.hosts : [],
      projects: Array.isArray(data.projects) ? data.projects : [],
      jobs: Array.isArray(data.jobs) ? data.jobs : [],
      notifications: Array.isArray(data.notifications) ? data.notifications : [],
      enrollments: Array.isArray(data.enrollments) ? data.enrollments : [],
    };
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(EMPTY_DATA);
    throw error;
  }
}

export async function writeStore(data) {
  const directory = getConfigDir();
  const target = getStorePath();
  const temporary = `${target}.${process.pid}.tmp`;
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
    workspace: normalizeWorkspace(input.workspace, hostOs), tools: normalizeTools(input.tools), agentVersion: null, agentSecretHash: null,
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
  await writeStore(data);
  return true;
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
    hostId: host.id,
    remotePath: remoteProjectPath(host.workspace, metadata.name, host.os),
    status: "assigned",
    skill: existing?.skill || { status: "pending", path: ".agents/skills/machora/SKILL.md", ignoredByGit: true, policyPath: "AGENTS.override.md", policyIgnoredByGit: true, installedAt: null },
    automations: existing?.automations || { rules: [] },
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
  data.version = 5;
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

export async function updateProjectAutomations(projectId, rules) {
  const data = await readStore();
  const project = requireProject(data, projectId);
  project.automations = { rules: normalizeAutomationRules(rules, project.commands) };
  project.updatedAt = new Date().toISOString();
  data.version = 5;
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
    const notification = createJobNotification(job, project, host, now);
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
  host.cpu = normalizeMetric(input.cpu);
  host.memory = normalizeMetric(input.memory);
  if (input.workspace) host.workspace = normalizeWorkspace(input.workspace, host.os);
  host.agentVersion = cleanText(input.agentVersion || host.agentVersion, 30);
  host.lastSeenAt = new Date().toISOString();
  host.status = "online";
  await writeStore(data);
  return publicHost(host);
}

export function publicHost(host, jobs = []) {
  const { agentSecretHash: _secret, ...safeHost } = host;
  if (safeHost.agentVersion && safeHost.lastSeenAt) {
    safeHost.status = Date.now() - Date.parse(safeHost.lastSeenAt) <= 45_000 ? "online" : "offline";
  }
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
    host: host ? { id: host.id, alias: host.alias, address: host.address, status: publicHost(host, jobs).status, workspace: host.workspace, os: host.os, agentVersion: host.agentVersion || null } : null,
  };
}

function publicJob(job, data) {
  const project = data.projects.find((item) => item.id === job.projectId);
  const host = data.hosts.find((item) => item.id === job.hostId);
  const hasStoredSteps = Array.isArray(job.steps) && job.steps.length > 0;
  return {
    ...job,
    trigger: normalizeJobTrigger(job.trigger),
    durationMs: job.startedAt && job.finishedAt ? Math.max(0, Date.parse(job.finishedAt) - Date.parse(job.startedAt)) : job.startedAt ? Math.max(0, Date.now() - Date.parse(job.startedAt)) : null,
    steps: normalizeJobSteps(hasStoredSteps ? job.steps : createJobSteps(job.type, job.operation, job.prepareCommand), [], hasStoredSteps ? null : job.status),
    project: project ? { id: project.id, name: project.name, localPath: project.localPath, remotePath: project.remotePath } : null,
    host: host ? { id: host.id, alias: host.alias, address: host.address, status: publicHost(host, data.jobs).status } : null,
  };
}

function agentJob(job, data) {
  const project = data.projects.find((item) => item.id === job.projectId);
  if (!project && job.type !== "host-command") return null;
  return {
    id: job.id,
    type: job.type,
    operation: job.operation,
    command: job.command,
    workingDirectory: job.workingDirectory || null,
    prepareCommand: job.prepareCommand,
    trigger: normalizeJobTrigger(job.trigger),
    steps: normalizeJobSteps(job.steps, createJobSteps(job.type, job.operation, job.prepareCommand)),
    project: project ? {
      id: project.id,
      name: project.name,
      gitRemote: project.gitRemote,
      branch: project.branch,
      remotePath: project.remotePath,
      projectType: project.projectType,
      packageManager: project.packageManager,
      devPort: normalizePort(project.devPort),
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
  };
}

function createJobSteps(type, operation, prepareCommand) {
  const names = type === "host-command" ? [["command", "Run remote command"]] : type === "sync" ? [["sync", "Git sync"]] : [
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

function createJobNotification(job, project, host, now) {
  const operation = job.type === "host-command" ? "remote command" : job.type === "sync" ? "Git sync" : String(job.operation || "job");
  const success = job.status === "succeeded";
  const subject = project?.name || host.alias;
  return {
    id: randomUUID(), jobId: job.id, projectId: project?.id || null, hostId: host.id,
    kind: success ? "success" : "error",
    title: `${subject} · ${operation} ${success ? "completed" : "failed"}`,
    body: success && job.result?.previewUrl ? `Preview ready: ${job.result.previewUrl}` : success ? `Finished on ${host.alias}` : job.error || `Failed on ${host.alias}`,
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
