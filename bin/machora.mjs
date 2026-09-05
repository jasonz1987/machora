#!/usr/bin/env node
import { addHost, assignProject, createEnrollment, getJob, listHosts, listJobs, listProjects, queueProjectJob, queueRuntimeJob, removeHost, removeProject, updateProjectSkill, updateProjectToolchain } from "../lib/store.mjs";
import { enrollmentCommands } from "../lib/controller.mjs";
import { inspectLocalProject } from "../lib/project-inspector.mjs";
import { installProjectSkill } from "../lib/project-skill.mjs";
import { confirmGitPush, dispatchGitPushConfirmation, installProjectGitHook, projectGitHookStatus, uninstallProjectGitHook } from "../lib/git-hooks.mjs";
import { findLanAddress, startServer } from "../server/server.mjs";
import {
  controllerFirewallStatus,
  controllerServiceStatus,
  installControllerFirewall,
  installControllerService,
  removeControllerFirewall,
  restartControllerService,
  startControllerService,
  stopControllerService,
} from "../lib/controller-service.mjs";
import { dashboardUrl, openExternal, waitForDashboard } from "../lib/dashboard.mjs";

const [, , ...args] = process.argv;
try { await main(args); } catch (error) { console.error(`Machora: ${error.message}`); process.exitCode = 1; }

async function main(argv) {
  const [command, action] = argv;
  if (!command || ["help", "--help", "-h"].includes(command)) return printHelp();
  if (["--version", "-v"].includes(command)) return console.log("0.11.5");
  if (["dashboard", "console"].includes(command)) {
    const options = parseOptions(argv.slice(1));
    let status = await controllerServiceStatus();
    if (status.installed && !status.running) status = await startControllerService();
    const url = await dashboardUrl();
    await waitForDashboard(url);
    if (!options["no-open"]) openExternal(url);
    console.log(`${options["no-open"] ? "Dashboard" : "Opened Machora dashboard"}: ${url}`);
    return;
  }
  if (command === "controller" && action === "install") {
    const options = parseOptions(argv.slice(2));
    const migrateFrom = options["migrate-from"]
      || process.env.MACHORA_CONFIG_DIR
      || process.env.RDEV_CONFIG_DIR;
    const installed = await installControllerService({
      port: options.port, host: options.host, advertise: options.advertise,
      migrateFrom, force: Boolean(options.force), serviceType: options.service,
      winswPath: options.winsw, firewall: Boolean(options.firewall),
    });
    process.env.MACHORA_CONFIG_DIR = installed.configDir;
    delete process.env.RDEV_CONFIG_DIR;
    process.env.MACHORA_CLI_PATH = installed.runtimeCli;
    let configuredProjects = 0;
    for (const project of await listProjects()) {
      await updateProjectSkill(project.id, await installProjectSkill(project.localPath));
      if (project.hook?.status === "installed" || project.automations?.rules?.length) await installProjectGitHook(project);
      configuredProjects += 1;
    }
    console.log(`Installed Machora controller service (${installed.serviceLabel})`);
    console.log(`Service: ${controllerServiceDescription(installed)}`);
    console.log(`CLI: ${installed.commandCliPath}`);
    if (installed.commandCliPath !== installed.userCliPath) console.log(`User CLI copy: ${installed.userCliPath}`);
    if (installed.serviceType === "scheduled-task" && !installed.pathUpdated) console.log(`PATH warning: add ${installed.binDir} to your user PATH manually`);
    if (installed.firewall?.installed) console.log(`Firewall: ${installed.firewall.name} · TCP ${installed.firewall.port} · ${installed.firewall.profile || "Private,Domain"}`);
    console.log(`Config: ${installed.configDir}`);
    console.log(`Logs: ${installed.logsDir}`);
    console.log(`Configured ${configuredProjects} project${configuredProjects === 1 ? "" : "s"} with local-only Machora policy`);
    console.log(`Open: http://127.0.0.1:${installed.port}`);
    return;
  }
  if (command === "controller" && action === "status") {
    const status = await controllerServiceStatus();
    console.log(status.installed ? `Machora controller is ${status.running ? "running" : "installed but stopped"}` : "Machora controller is not installed");
    if (status.installed) {
      console.log(`Service: ${controllerServiceDescription(status)}`);
      console.log(`Port: ${status.port} · ${status.portOpen ? (status.healthy ? "Machora is responding" : "occupied by another service") : "not listening"}`);
      if (status.platform === "win32") console.log(`Firewall: ${status.firewall?.installed ? `${status.firewall.enabled ? "enabled" : "disabled"} · ${status.firewall.name} · TCP ${status.firewall.port || status.port}` : "not configured"}`);
      console.log(`Logs: ${status.logsDir}`);
      if (status.detail) console.log(`Detail: ${status.detail}`);
    }
    return;
  }
  if (command === "controller" && action === "restart") {
    const status = await restartControllerService();
    console.log(`Machora controller restarted · ${status.running ? "running" : "starting"}`);
    return;
  }
  if (command === "controller" && action === "start") {
    const status = await startControllerService();
    console.log(`Machora controller started · ${status.running ? "running" : "starting"}`);
    return;
  }
  if (command === "controller" && action === "stop") {
    await stopControllerService();
    console.log("Machora controller stopped");
    return;
  }
  if (command === "controller" && action === "firewall") {
    const firewallAction = argv[2] || "status";
    const options = parseOptions(argv.slice(3));
    if (firewallAction === "install") {
      const status = await installControllerFirewall({ port: options.port });
      console.log(`Installed Windows Firewall rule ${status.name} · TCP ${status.port} · ${status.profile || "Private,Domain"}`);
      return;
    }
    if (firewallAction === "remove") {
      const status = await removeControllerFirewall();
      console.log(status.removed ? `Removed Windows Firewall rule ${status.name}` : `Windows Firewall rule ${status.name} was not installed`);
      return;
    }
    if (firewallAction === "status") {
      const status = await controllerFirewallStatus();
      console.log(status.installed ? `Windows Firewall rule ${status.name} is ${status.enabled ? "enabled" : "disabled"} · TCP ${status.port || "—"} · ${status.profile || "—"}` : "Machora Windows Firewall rule is not installed");
      if (status.error) console.log(`Detail: ${status.error}`);
      return;
    }
    throw new Error("Usage: machora controller firewall <install|status|remove> [--port 4178]");
  }
  if (command === "host" && action === "list") {
    const hosts = await listHosts();
    if (!hosts.length) return console.log("No task machines yet. Run: machora host add <alias>");
    console.table(hosts.map(({ alias, status, os, address, arch }) => ({ alias, status, os, address, arch })));
    return;
  }
  if (command === "host" && action === "add") {
    const alias = argv[2];
    if (!alias) throw new Error("Usage: machora host add <alias> [--workspace ~/Code] [--os macos|linux|windows]");
    const options = parseOptions(argv.slice(3));
    if (options.address) {
      const host = await addHost({ alias, address: options.address, os: options.os || "auto", workspace: options.workspace, status: "pending", capabilities: options.capabilities });
      return console.log(`Added ${host.alias} (${host.address})`);
    }
    const enrollment = await createEnrollment({ alias, os: options.os || "auto", workspace: options.workspace });
    const port = Number(options.port || 4178);
    const commands = enrollmentCommands(options.controller || `http://${findLanAddress()}:${port}`, enrollment.token);
    console.log(`Enrollment created for ${enrollment.alias}. Start the controller with: machora server --port ${port}\n`);
    console.log(enrollment.os === "windows" ? commands.windows : commands.posix);
    console.log(`\nToken expires at ${enrollment.expiresAt}`);
    return;
  }
  if (command === "host" && ["remove", "rm", "delete"].includes(action)) {
    const target = argv[2];
    if (!target) throw new Error("Usage: machora host remove <alias>");
    if (!(await removeHost(target))) throw new Error(`Host not found: ${target}`);
    return console.log(`Removed ${target}`);
  }
  if (command === "runtime" && action === "list") {
    const target = argv[2];
    if (!target) throw new Error("Usage: machora runtime list <host> [--json]");
    const options = parseOptions(argv.slice(3));
    const host = await findHost(target);
    if (options.json) return console.log(JSON.stringify({ manager: host.runtimeManager, runtimes: host.runtimes }, null, 2));
    console.log(`mise: ${host.runtimeManager?.status || "not-installed"}${host.runtimeManager?.version ? ` · ${host.runtimeManager.version}` : ""}`);
    if (!host.runtimes?.length) return console.log("No managed runtimes installed.");
    console.table(host.runtimes.map(({ tool, version, provider }) => ({ runtime: tool, version, provider })));
    return;
  }
  if (command === "runtime" && ["available", "query"].includes(action)) {
    const host = argv[2];
    const tool = argv[3];
    if (!host || !tool) throw new Error("Usage: machora runtime available <host> <node|java|python>");
    const job = await queueRuntimeJob(host, { operation: "query", tool });
    console.log(`Queued ${tool} version query on ${host}: ${job.id}`);
    return;
  }
  if (command === "runtime" && ["install", "uninstall", "remove", "verify"].includes(action)) {
    const host = argv[2];
    const spec = parseRuntimeSpec(argv[3]);
    if (!host || !spec) throw new Error(`Usage: machora runtime ${action} <host> <node|java|python>@<version>`);
    const operation = ["uninstall", "remove"].includes(action) ? "uninstall" : action;
    const job = await queueRuntimeJob(host, { operation, ...spec });
    console.log(`Queued ${operation} ${spec.tool}@${spec.version} on ${host}: ${job.id}`);
    return;
  }
  if (command === "project" && action === "list") {
    const projects = await listProjects();
    if (!projects.length) return console.log("No projects assigned yet. Run from a Git project: machora project set <host>");
    console.table(projects.map((project) => ({
      project: project.name,
      branch: project.branch,
      changes: project.changedFiles,
      host: project.host?.alias || "unassigned",
      remotePath: project.remotePath,
      status: project.status,
    })));
    return;
  }
  if (command === "project" && ["set", "assign"].includes(action)) {
    const setStyle = action === "set";
    const positional = argv[2];
    const options = parseOptions(argv.slice(3));
    const host = setStyle ? positional : options.host;
    const localPath = setStyle ? (options.path || process.cwd()) : positional;
    if (!host || !localPath) throw new Error(setStyle ? "Usage: machora project set <host> [--path .]" : "Usage: machora project assign <path> --host <host>");
    const metadata = await inspectLocalProject(localPath);
    let project = await assignProject(metadata, host);
    project = await updateProjectSkill(project.id, await installProjectSkill(project.localPath));
    const job = await queueProjectJob(project.id, "sync");
    console.log(`Assigned ${project.name} (${project.branch}) to ${project.host.alias}`);
    console.log(`Remote path: ${project.remotePath}`);
    console.log(`Detected: ${project.frameworks.join(", ") || project.projectType}`);
    console.log(`Installed local-only Skill: ${project.skill.path}`);
    console.log(`Queued remote Git sync: ${job.id}`);
    if (project.dirty) console.log(`Local working tree has ${project.changedFiles} uncommitted change${project.changedFiles === 1 ? "" : "s"}; Git sync uses the pushed origin branch only.`);
    return;
  }
  if (command === "project" && action === "status") {
    const options = parseOptions(argv.slice(2));
    const project = await findProject(options.path || process.cwd());
    if (options.json) return console.log(JSON.stringify(project, null, 2));
    console.log(`${project.name} · ${project.projectType} · ${project.host?.alias || "unassigned"}`);
    console.log(`Remote: ${project.remoteStatus}${project.remoteError ? ` · ${project.remoteError}` : ""}`);
    console.log(`Skill: ${project.skill?.status || "pending"} · ${project.skill?.path || "—"}`);
    return;
  }
  if (command === "project" && action === "sync") {
    const options = parseOptions(argv.slice(2));
    const project = await findProject(options.path || process.cwd());
    const job = await queueProjectJob(project.id, "sync");
    console.log(`Queued Git sync for ${project.name}: ${job.id}`);
    return;
  }
  if (command === "project" && action === "run") {
    const operation = argv[2];
    if (!operation) throw new Error("Usage: machora project run <install|test|build|dev|deploy> [--path .]");
    const options = parseOptions(argv.slice(3));
    const project = await findProject(options.path || process.cwd());
    const job = await queueProjectJob(project.id, "command", operation);
    console.log(`Queued ${operation} for ${project.name}: ${job.id}`);
    return;
  }
  if (command === "project" && action === "runtime") {
    const runtimeAction = argv[2];
    const optionStart = argv.findIndex((item, index) => index >= 3 && item.startsWith("--"));
    const specs = argv.slice(3, optionStart === -1 ? undefined : optionStart);
    const options = parseOptions(optionStart === -1 ? [] : argv.slice(optionStart));
    const project = await findProject(options.path || process.cwd());
    if (runtimeAction === "set") {
      if (!specs.length) throw new Error("Usage: machora project runtime set <node@version> [java@version] [python@version] [--path .]");
      const toolchain = { ...project.toolchain };
      for (const value of specs) {
        const spec = parseRuntimeSpec(value);
        if (!spec) throw new Error(`Invalid runtime: ${value}`);
        toolchain[spec.tool] = spec.version;
      }
      const updated = await updateProjectToolchain(project.id, toolchain);
      console.log(`Updated runtimes for ${updated.name}: ${formatToolchain(updated.toolchain) || "system defaults"}`);
      return;
    }
    if (runtimeAction === "clear") {
      const toolchain = { ...project.toolchain };
      for (const tool of specs.length ? specs : ["node", "java", "python"]) {
        if (!Object.hasOwn(toolchain, tool)) throw new Error(`Runtime must be node, java, or python: ${tool}`);
        toolchain[tool] = null;
      }
      const updated = await updateProjectToolchain(project.id, toolchain);
      console.log(`Updated runtimes for ${updated.name}: ${formatToolchain(updated.toolchain) || "system defaults"}`);
      return;
    }
    throw new Error("Usage: machora project runtime <set|clear> ... [--path .]");
  }
  if (command === "project" && ["policy", "configure"].includes(action)) {
    const options = parseOptions(argv.slice(2));
    const project = await findProject(options.path || process.cwd());
    const updated = await updateProjectSkill(project.id, await installProjectSkill(project.localPath));
    if (project.hook?.status === "installed" || project.automations?.rules?.length) await installProjectGitHook(project);
    console.log(`Installed local-only Machora Skill and policy for ${project.name}`);
    console.log(`Skill: ${updated.skill.path}`);
    console.log(`Policy: ${updated.skill.policyPath}`);
    return;
  }
  if (command === "hooks" && action === "install") {
    const options = parseOptions(argv.slice(2));
    const project = await findProject(options.path || process.cwd());
    const updated = await installProjectGitHook(project);
    console.log(`Installed Git push hook for ${project.name}`);
    console.log(`Hook: ${updated.hook.path}`);
    return;
  }
  if (command === "hooks" && action === "status") {
    const options = parseOptions(argv.slice(2));
    const project = await findProject(options.path || process.cwd());
    const status = await projectGitHookStatus(project);
    console.log(`Git push hook for ${project.name}: ${status.status}${status.detail ? ` · ${status.detail}` : ""}`);
    if (status.path) console.log(`Hook: ${status.path}`);
    return;
  }
  if (command === "hooks" && ["uninstall", "remove"].includes(action)) {
    const options = parseOptions(argv.slice(2));
    const project = await findProject(options.path || process.cwd());
    const updated = await uninstallProjectGitHook(project);
    console.log(`Removed Machora Git push hook for ${project.name}${updated.restoredOriginal ? "; restored the original hook" : ""}`);
    return;
  }
  if (command === "hook" && action === "dispatch-push") {
    const options = parseOptions(argv.slice(2));
    if (!options.project || !options.repository || !options.remote || !options.input || !options.log) throw new Error("Incomplete internal Git hook dispatch");
    await dispatchGitPushConfirmation({
      projectId: options.project, repository: options.repository, remote: options.remote,
      inputPath: options.input, logPath: options.log,
    });
    return;
  }
  if (command === "hook" && action === "confirm-push") {
    const options = parseOptions(argv.slice(2));
    if (!options.project || !options.repository || !options.remote || !options.input) throw new Error("Incomplete internal Git hook invocation");
    const result = await confirmGitPush({ projectId: options.project, repository: options.repository, remote: options.remote, inputPath: options.input });
    console.log(`Confirmed ${result.confirmed} pushed ref(s); queued ${result.jobs.length} Job(s)`);
    return;
  }
  if (command === "project" && ["remove", "rm", "delete"].includes(action)) {
    const target = argv[2] || process.cwd();
    if (!(await removeProject(target))) throw new Error(`Project not found: ${target}`);
    return console.log(`Removed project assignment: ${target}`);
  }
  if (["server", "serve", "ui"].includes(command)) {
    const options = parseOptions(argv.slice(1));
    const port = Number(options.port || 4178);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be between 1 and 65535");
    const started = await startServer({ port, host: options.host || "0.0.0.0", advertise: options.advertise });
    console.log(`Machora controller is ready:\n  Local:      http://127.0.0.1:${started.port}\n  Controller: ${started.controllerUrl}`);
    return;
  }
  if (command === "job" && action === "status") {
    const id = argv[2];
    if (!id) throw new Error("Usage: machora job status <job-id> [--json]");
    const options = parseOptions(argv.slice(3));
    const job = await getJob(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    if (options.json) return console.log(JSON.stringify(job, null, 2));
    console.log(`${job.id} · ${job.status} · ${job.project?.name || "removed project"}`);
    if (job.output) console.log(job.output);
    if (job.error) console.error(job.error);
    return;
  }
  if (command === "job" && action === "list") {
    const options = parseOptions(argv.slice(2));
    let jobs = await listJobs();
    if (options.status) jobs = jobs.filter((job) => job.status === options.status);
    if (options.json) return console.log(JSON.stringify(jobs, null, 2));
    if (!jobs.length) return console.log("No Jobs found.");
    console.table(jobs.map((job) => ({ id: job.id.slice(0, 8), project: job.project?.name || "removed", operation: job.operation || "sync", status: job.status, host: job.host?.alias || "removed" })));
    return;
  }
  throw new Error(`Unknown command: ${argv.join(" ")}`);
}

function parseOptions(items) {
  const options = {};
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item.startsWith("--")) throw new Error(`Unexpected argument: ${item}`);
    if (["--json", "--force", "--no-open", "--firewall"].includes(item)) { options[item.slice(2)] = true; continue; }
    const value = items[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${item}`);
    options[item.slice(2)] = value; index += 1;
  }
  return options;
}

async function findProject(inputPath) {
  const metadata = await inspectLocalProject(inputPath);
  const project = (await listProjects()).find((item) => item.localPath === metadata.localPath);
  if (!project) throw new Error(`Project is not assigned in Machora: ${metadata.localPath}`);
  return project;
}

async function findHost(target) {
  const normalized = String(target || "").toLowerCase();
  const host = (await listHosts()).find((item) => [item.id, item.alias, item.address, item.hostname].some((value) => String(value || "").toLowerCase() === normalized));
  if (!host) throw new Error(`Host not found: ${target}`);
  return host;
}

function parseRuntimeSpec(value) {
  const match = String(value || "").match(/^(node|java|python)@([A-Za-z0-9][A-Za-z0-9._+:-]{0,99})$/i);
  return match ? { tool: match[1].toLowerCase(), version: match[2] } : null;
}

function formatToolchain(toolchain) {
  return Object.entries(toolchain || {}).filter(([, version]) => version).map(([tool, version]) => `${tool}@${version}`).join(", ");
}

function controllerServiceDescription(status) {
  if (status.serviceType === "windows-service") return `Windows Service · ${status.serviceLabel} · ${status.serviceDefinitionPath}`;
  if (status.serviceType === "scheduled-task") return `Windows Scheduled Task · ${status.scheduledTaskName || status.serviceLabel} · ${status.taskDefinitionPath}`;
  return `macOS LaunchAgent · ${status.plistPath}`;
}

function printHelp() {
  console.log(`Machora — orchestrate development across your machines

Commands:
  machora dashboard [--no-open]
  machora controller install [--migrate-from <path>] [--port 4178] [--advertise http://192.168.1.42:4178]
                             [--firewall] [--service scheduled-task|windows-service] [--winsw <path>]
  machora controller status|start|stop|restart
  machora controller firewall <install|status|remove> [--port 4178]
  machora host add <alias> [--workspace ~/Code] [--os auto|macos|linux|windows]
  machora host add <alias> --address <hostname-or-ip> [--workspace ...] [--os ...]
  machora host list
  machora host remove <alias>
  machora runtime list <host> [--json]
  machora runtime available <host> <node|java|python>
  machora runtime install|uninstall|verify <host> <node|java|python>@<version>
  machora project set <host> [--path .]
  machora project assign <path> --host <alias|address>
  machora project status [--path .] [--json]
  machora project sync [--path .]
  machora project run <install|test|build|dev|deploy> [--path .]
  machora project runtime set <node@version> [java@version] [python@version] [--path .]
  machora project runtime clear [node|java|python] [--path .]
  machora project policy [--path .]
  machora hooks install|status|uninstall [--path .]
  machora project list
  machora project remove [<name|path>]
  machora job status <job-id> [--json]
  machora job list [--status queued|running|succeeded|failed] [--json]
  machora server [--port 4178] [--host 0.0.0.0] [--advertise http://192.168.1.42:4178]

Configuration is stored in ${process.platform === "win32" ? "%LOCALAPPDATA%\\Machora\\config.json" : "~/.machora/config.json"}.`);
}
