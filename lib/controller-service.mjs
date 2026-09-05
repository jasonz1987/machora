import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, chmod, copyFile, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  controlWindowsService,
  installWindowsFirewall as installWindowsFirewallRule,
  installWindowsService,
  removeWindowsFirewall as removeWindowsFirewallRule,
  uninstallWindowsService,
  windowsAdminPaths,
  windowsFirewallStatus,
  windowsServiceStatus,
} from "./windows-admin.mjs";

const execFileAsync = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVICE_LABEL = "dev.machora.controller";
const LEGACY_SERVICE_LABEL = "dev.rdev.controller";
const WINDOWS_TASK_NAME = "Machora Controller";
const CONTROLLER_RUNTIME_DEPENDENCIES = ["ssh2"];

export function controllerPaths(home = os.homedir(), options = {}) {
  const platform = options.platform || process.platform;
  const environment = options.env || process.env;
  const configDir = platform === "win32"
    ? path.join(environment.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Machora")
    : path.join(home, ".machora");
  const adminPaths = windowsAdminPaths(configDir);
  return {
    platform,
    configDir,
    appDir: path.join(configDir, "app"),
    runtimeCli: path.join(configDir, "app", "bin", "machora.mjs"),
    binDir: path.join(configDir, "bin"),
    logsDir: path.join(configDir, "logs"),
    stdoutPath: path.join(configDir, "logs", "controller.log"),
    stderrPath: path.join(configDir, "logs", "controller-error.log"),
    serviceConfigPath: path.join(configDir, "controller.json"),
    plistPath: path.join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
    taskDefinitionPath: path.join(configDir, "controller-task.xml"),
    launcherPath: path.join(configDir, "controller.cmd"),
    scheduledTaskName: WINDOWS_TASK_NAME,
    ...adminPaths,
    userCliPath: platform === "win32" ? path.join(configDir, "bin", "machora.cmd") : path.join(home, ".local", "bin", "machora"),
    legacyMachoraConfigDir: path.join(home, ".machora"),
    legacyConfigDir: path.join(home, ".rdev"),
    legacyPlistPath: path.join(home, "Library", "LaunchAgents", `${LEGACY_SERVICE_LABEL}.plist`),
    legacyUserCliPath: path.join(home, ".local", "bin", "rdev"),
  };
}

export async function installControllerService(options = {}) {
  const platform = options.platform || process.platform;
  if (!["darwin", "win32"].includes(platform)) throw new Error("machora controller install currently supports macOS and Windows controllers");
  const paths = controllerPaths(options.home || os.homedir(), { platform, env: options.env });
  const port = normalizePort(options.port || 4178);
  const host = normalizeHost(options.host || "0.0.0.0");
  const advertise = normalizeAdvertise(options.advertise);
  const nodePath = path.resolve(options.nodePath || process.execPath);
  const applicationSource = path.resolve(options.sourceRoot || sourceRoot);
  const hasCurrentConfig = Boolean(await stat(path.join(paths.configDir, "config.json")).catch(() => null));
  let migrateFrom = options.migrateFrom ? path.resolve(options.migrateFrom) : null;
  if (!migrateFrom && !hasCurrentConfig) {
    const candidates = platform === "win32" ? [paths.legacyMachoraConfigDir, paths.legacyConfigDir] : [paths.legacyConfigDir];
    for (const candidate of candidates) {
      if (await stat(path.join(candidate, "config.json")).catch(() => null)) { migrateFrom = candidate; break; }
    }
  }
  const execute = options.execute || executeFile;

  await migrateControllerConfig(migrateFrom, paths.configDir, { force: Boolean(options.force) });
  await mkdir(paths.logsDir, { recursive: true, mode: 0o700 });
  await installRuntime(applicationSource, paths.appDir);
  const previousSettings = await readControllerSettings(paths.serviceConfigPath);
  const requestedServiceType = platform === "win32" ? normalizeWindowsServiceType(options.serviceType || previousSettings.serviceType) : "launch-agent";
  const serviceConfig = {
    version: 3, platform, port, host, advertise, nodePath, serviceType: requestedServiceType,
    firewall: false, installedAt: new Date().toISOString(),
  };

  if (platform === "win32") {
    const windowsEnvironment = options.env || process.env;
    const userId = options.userId || [windowsEnvironment.USERDOMAIN, windowsEnvironment.USERNAME].filter(Boolean).join("\\") || os.userInfo().username;
    await installWindowsCli(paths.userCliPath, nodePath, paths.runtimeCli);
    const commandCliPath = options.globalCliPath
      ? path.resolve(options.globalCliPath)
      : paths.userCliPath;
    if (commandCliPath !== paths.userCliPath) await installWindowsCli(commandCliPath, nodePath, paths.runtimeCli);
    const pathUpdated = await addWindowsUserPath(path.dirname(commandCliPath), execute);
    await writeFile(paths.launcherPath, renderWindowsLauncher({ ...paths, nodePath, port, host, advertise }), { mode: 0o700 });
    await writeFile(paths.taskDefinitionPath, renderWindowsScheduledTask({ ...paths, userId }), { mode: 0o600 });
    await execute("schtasks.exe", ["/End", "/TN", WINDOWS_TASK_NAME], { allowFailure: true });
    const currentWindowsService = await windowsServiceStatus({ paths, execute });
    if (currentWindowsService.installed) await controlWindowsService({ paths, execute, action: "stop" });
    const released = await waitForPortRelease(port, options.probe || probeControllerEndpoint);
    if (!released) throw new Error(`Controller port ${port} is already in use; stop the conflicting service or choose --port`);
    let installedService;
    if (requestedServiceType === "windows-service") {
      installedService = await installWindowsService({
        paths, nodePath, port, host, advertise, execute, winswPath: options.winswPath,
        architecture: options.architecture, fetchImpl: options.fetchImpl,
      });
    } else {
      if (currentWindowsService.installed) await uninstallWindowsService({ paths, execute });
      await execute("schtasks.exe", ["/Create", "/TN", WINDOWS_TASK_NAME, "/XML", paths.taskDefinitionPath, "/F"]);
      await execute("schtasks.exe", ["/Run", "/TN", WINDOWS_TASK_NAME]);
      installedService = { serviceLabel: WINDOWS_TASK_NAME, serviceType: "scheduled-task" };
    }
    await writeControllerSettings(paths.serviceConfigPath, serviceConfig);
    let firewall = await windowsFirewallStatus({ execute });
    const firewallNeedsRefresh = firewall.installed
      && (firewall.port !== port || normalizeWindowsPath(firewall.program) !== normalizeWindowsPath(nodePath));
    if (options.firewall || firewallNeedsRefresh) firewall = await installWindowsFirewallRule({ port, nodePath, execute });
    serviceConfig.firewall = Boolean(firewall.installed && firewall.enabled);
    await writeControllerSettings(paths.serviceConfigPath, serviceConfig);
    return { ...paths, ...installedService, commandCliPath, nodePath, port, host, advertise, pathUpdated, firewall };
  }

  await writeControllerSettings(paths.serviceConfigPath, serviceConfig);

  const uid = options.uid ?? process.getuid?.();
  if (!Number.isInteger(uid)) throw new Error("Could not determine the current macOS user id");
  await installUserCli(paths.userCliPath, nodePath, paths.runtimeCli);
  await installLegacyCli(paths.legacyUserCliPath, nodePath, paths.runtimeCli);
  const commandCliPath = await installGlobalCli({
    requestedPath: options.globalCliPath,
    userCliPath: paths.userCliPath,
    nodePath,
    runtimeCli: paths.runtimeCli,
    force: Boolean(options.force),
  });
  if (!options.globalCliPath) await installLegacyCli("/usr/local/bin/rdev", nodePath, paths.runtimeCli, { create: false });
  await mkdir(path.dirname(paths.plistPath), { recursive: true });
  await writeFile(paths.plistPath, renderMacLaunchAgent({ ...paths, nodePath, port, host, advertise }), { mode: 0o600 });

  const domain = `gui/${uid}`;
  await execute("launchctl", ["bootout", domain, paths.plistPath], { allowFailure: true });
  const legacyControllerStopped = await stopLegacyController({ paths, domain, execute });
  await execute("launchctl", ["bootstrap", domain, paths.plistPath]);
  await execute("launchctl", ["enable", `${domain}/${SERVICE_LABEL}`]);
  await execute("launchctl", ["kickstart", "-k", `${domain}/${SERVICE_LABEL}`]);
  if (legacyControllerStopped) await rm(paths.legacyPlistPath, { force: true });
  return { ...paths, commandCliPath, nodePath, port, host, advertise, serviceLabel: SERVICE_LABEL, serviceType: "launch-agent" };
}

export async function controllerServiceStatus(options = {}) {
  const platform = options.platform || process.platform;
  if (!["darwin", "win32"].includes(platform)) return { installed: false, running: false, platform, detail: "Unsupported controller service platform" };
  const paths = controllerPaths(options.home || os.homedir(), { platform, env: options.env });
  const execute = options.execute || executeFile;
  const settings = await readControllerSettings(paths.serviceConfigPath);
  const port = normalizePort(settings.port || 4178);
  const endpoint = await (options.probe || probeControllerEndpoint)(port);

  if (platform === "win32") {
    const serviceType = normalizeWindowsServiceType(settings.serviceType);
    const service = serviceType === "windows-service"
      ? await windowsServiceStatus({ paths, execute })
      : await windowsScheduledTaskStatus({ paths, execute });
    const firewall = await windowsFirewallStatus({ execute });
    return {
      ...paths, ...service, running: service.installed && endpoint.healthy, port, portOpen: endpoint.portOpen,
      healthy: endpoint.healthy, firewall, serviceType,
      detail: endpoint.portOpen && !endpoint.healthy ? `Port ${port} is occupied by another service` : null,
    };
  }

  const uid = options.uid ?? process.getuid?.();
  let plistPath = paths.plistPath;
  let serviceLabel = SERVICE_LABEL;
  let legacy = false;
  if (!await stat(plistPath).catch(() => null) && await stat(paths.legacyPlistPath).catch(() => null)) {
    plistPath = paths.legacyPlistPath;
    serviceLabel = LEGACY_SERVICE_LABEL;
    legacy = true;
  }
  if (!await stat(plistPath).catch(() => null)) return { installed: false, running: false, serviceLabel, port, portOpen: endpoint.portOpen, healthy: endpoint.healthy, ...paths };
  const result = await execute("launchctl", ["print", `gui/${uid}/${serviceLabel}`], { allowFailure: true });
  const configDir = legacy ? paths.legacyConfigDir : paths.configDir;
  return { installed: true, running: result.exitCode === 0, port, portOpen: endpoint.portOpen, healthy: endpoint.healthy, output: result.stdout || result.stderr || "", ...paths, configDir, plistPath, serviceLabel, serviceType: "launch-agent", legacy };
}

export async function restartControllerService(options = {}) {
  const status = await controllerServiceStatus(options);
  if (!status.installed) throw new Error("machora controller service is not installed");
  const execute = options.execute || executeFile;
  if (status.platform === "win32") {
    if (status.serviceType === "windows-service") await controlWindowsService({ paths: status, execute, action: "stop" });
    else await execute("schtasks.exe", ["/End", "/TN", status.scheduledTaskName], { allowFailure: true });
    const released = await waitForPortRelease(status.port, options.probe || probeControllerEndpoint);
    if (!released) throw new Error(`Controller port ${status.port} is already in use; cannot restart Machora`);
    if (status.serviceType === "windows-service") await controlWindowsService({ paths: status, execute, action: "start" });
    else await execute("schtasks.exe", ["/Run", "/TN", status.scheduledTaskName]);
    return controllerServiceStatus(options);
  }
  const uid = options.uid ?? process.getuid?.();
  await execute("launchctl", ["kickstart", "-k", `gui/${uid}/${status.serviceLabel}`]);
  return controllerServiceStatus(options);
}

export async function stopControllerService(options = {}) {
  const status = await controllerServiceStatus(options);
  if (!status.installed) throw new Error("machora controller service is not installed");
  const execute = options.execute || executeFile;
  if (status.platform === "win32") {
    if (status.serviceType === "windows-service") await controlWindowsService({ paths: status, execute, action: "stop" });
    else await execute("schtasks.exe", ["/End", "/TN", status.scheduledTaskName], { allowFailure: true });
    return { ...status, running: false, healthy: false };
  }
  const uid = options.uid ?? process.getuid?.();
  await execute("launchctl", ["bootout", `gui/${uid}`, status.plistPath], { allowFailure: true });
  return { ...status, running: false };
}

export async function startControllerService(options = {}) {
  const status = await controllerServiceStatus(options);
  if (!status.installed) throw new Error("machora controller service is not installed");
  const execute = options.execute || executeFile;
  if (status.platform === "win32") {
    if (status.portOpen && !status.healthy) throw new Error(`Controller port ${status.port} is already in use by another service`);
    if (status.serviceType === "windows-service") await controlWindowsService({ paths: status, execute, action: "start" });
    else await execute("schtasks.exe", ["/Run", "/TN", status.scheduledTaskName]);
    return controllerServiceStatus(options);
  }
  const uid = options.uid ?? process.getuid?.();
  await execute("launchctl", ["bootstrap", `gui/${uid}`, status.plistPath], { allowFailure: true });
  await execute("launchctl", ["enable", `gui/${uid}/${status.serviceLabel}`]);
  await execute("launchctl", ["kickstart", "-k", `gui/${uid}/${status.serviceLabel}`]);
  return controllerServiceStatus(options);
}

export async function installControllerFirewall(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") throw new Error("Windows Firewall management is only available on Windows controllers");
  const paths = controllerPaths(options.home || os.homedir(), { platform, env: options.env });
  const settings = await readControllerSettings(paths.serviceConfigPath);
  const port = normalizePort(options.port || settings.port || 4178);
  const nodePath = path.resolve(options.nodePath || settings.nodePath || process.execPath);
  return installWindowsFirewallRule({ port, nodePath, execute: options.execute || executeFile });
}

export async function controllerFirewallStatus(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") return { installed: false, enabled: false, detail: "Windows Firewall management is only available on Windows" };
  return windowsFirewallStatus({ execute: options.execute || executeFile });
}

export async function removeControllerFirewall(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") throw new Error("Windows Firewall management is only available on Windows controllers");
  return removeWindowsFirewallRule({ execute: options.execute || executeFile });
}

export async function migrateControllerConfig(source, target, { force = false } = {}) {
  const destination = path.resolve(target);
  const origin = source ? path.resolve(source) : null;
  await mkdir(destination, { recursive: true, mode: 0o700 });
  if (!origin || origin === destination) return { migrated: false, source: origin, target: destination };
  const sourceConfig = path.join(origin, "config.json");
  const targetConfig = path.join(destination, "config.json");
  if (!await stat(sourceConfig).catch(() => null)) return { migrated: false, source: origin, target: destination };
  if (await stat(targetConfig).catch(() => null)) {
    const [current, incoming] = await Promise.all([readFile(targetConfig), readFile(sourceConfig)]);
    if (!current.equals(incoming) && !force) throw new Error(`Controller config already exists at ${targetConfig}; use --force to replace it`);
  }
  await copyFile(sourceConfig, targetConfig);
  await chmod(targetConfig, 0o600);
  const sourceHooks = path.join(origin, "hooks");
  if (await stat(sourceHooks).catch(() => null)) await cp(sourceHooks, path.join(destination, "hooks"), { recursive: true, force: true });
  return { migrated: true, source: origin, target: destination };
}

export function renderMacLaunchAgent({ configDir, runtimeCli, logsDir, stdoutPath, stderrPath, nodePath, port, host, advertise }) {
  const argumentsList = [nodePath, runtimeCli, "server", "--port", String(port), "--host", host, ...(advertise ? ["--advertise", advertise] : [])];
  const pathValue = [...new Set([path.dirname(nodePath), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array>${argumentsList.map((item) => `<string>${xmlEscape(item)}</string>`).join("")}</array>
  <key>EnvironmentVariables</key><dict><key>MACHORA_CONFIG_DIR</key><string>${xmlEscape(configDir)}</string><key>PATH</key><string>${xmlEscape(pathValue)}</string></dict>
  <key>WorkingDirectory</key><string>${xmlEscape(path.dirname(path.dirname(runtimeCli)))}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(stderrPath)}</string>
</dict></plist>
`;
}

export function renderWindowsLauncher({ configDir, appDir, runtimeCli, stdoutPath, stderrPath, nodePath, port, host, advertise }) {
  const argumentsList = [runtimeCli, "server", "--port", String(port), "--host", host, ...(advertise ? ["--advertise", advertise] : [])];
  return `@echo off\r\nrem machora managed controller launcher\r\nsetlocal\r\nset "MACHORA_CONFIG_DIR=${batchValue(configDir)}"\r\nset "PATH=${batchValue(path.dirname(nodePath))};%PATH%"\r\ncd /d "${batchValue(appDir)}"\r\n"${batchValue(nodePath)}" ${argumentsList.map(batchQuote).join(" ")} 1>>"${batchValue(stdoutPath)}" 2>>"${batchValue(stderrPath)}"\r\n`;
}

export function renderWindowsScheduledTask({ appDir, launcherPath, userId }) {
  const taskArguments = `/d /s /c ""${launcherPath}""`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Machora self-hosted development controller</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xmlEscape(userId)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xmlEscape(userId)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable>
    <RestartOnFailure><Interval>PT1M</Interval><Count>255</Count></RestartOnFailure>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>cmd.exe</Command><Arguments>${xmlEscape(taskArguments)}</Arguments><WorkingDirectory>${xmlEscape(appDir)}</WorkingDirectory></Exec></Actions>
</Task>
`;
}

async function installRuntime(origin, destination) {
  if (path.resolve(origin) === path.resolve(destination)) return;
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of ["bin", "lib", "server", "agent", "dist"]) {
    const source = path.join(origin, entry);
    if (!await stat(source).catch(() => null)) throw new Error(`Controller runtime is missing ${entry}; run npm run build before installing`);
    await cp(source, path.join(destination, entry), { recursive: true, force: true });
  }
  await copyFile(path.join(origin, "package.json"), path.join(destination, "package.json"));
  await rm(path.join(destination, "node_modules"), { recursive: true, force: true });
  const copiedDependencies = new Set();
  for (const dependency of CONTROLLER_RUNTIME_DEPENDENCIES) {
    await copyRuntimeDependency(origin, destination, dependency, copiedDependencies);
  }
  await chmod(path.join(destination, "bin", "machora.mjs"), 0o700);
}

async function copyRuntimeDependency(origin, destination, packageName, copied) {
  if (copied.has(packageName)) return;
  const segments = packageName.split("/");
  const source = path.join(origin, "node_modules", ...segments);
  const manifestPath = path.join(source, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8").catch(() => {
    throw new Error(`Controller runtime dependency is missing: ${packageName}; run npm install before installing`);
  }));
  copied.add(packageName);
  const target = path.join(destination, "node_modules", ...segments);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await cp(source, target, { recursive: true, force: true });
  for (const dependency of Object.keys(manifest.dependencies || {})) {
    await copyRuntimeDependency(origin, destination, dependency, copied);
  }
}

async function stopLegacyController({ paths, domain, execute }) {
  if (!await stat(paths.legacyPlistPath).catch(() => null)) return false;
  await execute("launchctl", ["bootout", domain, paths.legacyPlistPath], { allowFailure: true });
  return true;
}

async function installUserCli(target, nodePath, runtimeCli, { legacy = false } = {}) {
  await mkdir(path.dirname(target), { recursive: true });
  const wrapper = cliWrapper(nodePath, runtimeCli, { legacy });
  await writeFile(target, wrapper, { mode: 0o755 });
  await chmod(target, 0o755);
}

async function installWindowsCli(target, nodePath, runtimeCli) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `@echo off\r\nrem machora managed controller CLI\r\n"${batchValue(nodePath)}" "${batchValue(runtimeCli)}" %*\r\n`, { mode: 0o700 });
}

async function addWindowsUserPath(directory, execute) {
  const escapedDirectory = powershellSingleQuote(directory);
  const script = `$target='${escapedDirectory}';$current=[Environment]::GetEnvironmentVariable('Path','User');$items=@($current -split ';' | Where-Object { $_ });if($items -notcontains $target){$next=(@($items)+$target)-join ';';[Environment]::SetEnvironmentVariable('Path',$next,'User')}`;
  const result = await execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { allowFailure: true });
  return result.exitCode === 0;
}

async function installGlobalCli({ requestedPath, userCliPath, nodePath, runtimeCli, force }) {
  if (requestedPath === false) return userCliPath;
  const target = path.resolve(requestedPath || "/usr/local/bin/machora");
  if (requestedPath) await mkdir(path.dirname(target), { recursive: true });
  try { await access(path.dirname(target), fsConstants.W_OK); } catch { return userCliPath; }
  const existing = await readFile(target, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
  if (existing && !existing.includes("# machora managed controller CLI") && !force) return userCliPath;
  await writeFile(target, cliWrapper(nodePath, runtimeCli), { mode: 0o755 });
  await chmod(target, 0o755);
  return target;
}

async function installLegacyCli(target, nodePath, runtimeCli, { create = true } = {}) {
  try { await access(path.dirname(target), fsConstants.W_OK); } catch { return false; }
  const existing = await readFile(target, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
  if (!existing && !create) return false;
  if (existing && !existing.includes("# rdev managed controller CLI") && !existing.includes("# machora legacy controller CLI")) return false;
  await writeFile(target, cliWrapper(nodePath, runtimeCli, { legacy: true }), { mode: 0o755 });
  await chmod(target, 0o755);
  return true;
}

function cliWrapper(nodePath, runtimeCli, { legacy = false } = {}) {
  const marker = legacy ? "# machora legacy controller CLI" : "# machora managed controller CLI";
  const notice = legacy ? "echo 'rdev has been renamed to machora; use the machora command instead.' >&2\n" : "";
  return `#!/bin/sh\n${marker}\n${notice}exec ${shellQuote(nodePath)} ${shellQuote(runtimeCli)} "$@"\n`;
}

async function executeFile(command, argumentsList, { allowFailure = false } = {}) {
  try {
    const result = await execFileAsync(command, argumentsList, { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 });
    return { exitCode: 0, stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (error) {
    if (allowFailure) return { exitCode: Number.isInteger(error.code) ? error.code : 1, stdout: error.stdout || "", stderr: error.stderr || error.message };
    throw new Error(`${command} ${argumentsList[0] || ""} failed: ${String(error.stderr || error.message).trim()}`);
  }
}

async function readControllerSettings(configPath) {
  try { return JSON.parse(await readFile(configPath, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`Could not read controller settings: ${error.message}`);
  }
}

async function writeControllerSettings(configPath, settings) {
  await writeFile(configPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

async function windowsScheduledTaskStatus({ paths, execute }) {
  const result = await execute("schtasks.exe", ["/Query", "/TN", WINDOWS_TASK_NAME, "/FO", "LIST", "/V"], { allowFailure: true });
  return {
    installed: result.exitCode === 0,
    running: result.exitCode === 0 && /running/i.test(String(result.stdout || "")),
    output: result.stdout || result.stderr || "",
    serviceLabel: WINDOWS_TASK_NAME,
  };
}

export async function probeControllerEndpoint(port, options = {}) {
  const host = options.host || "127.0.0.1";
  const timeoutMs = options.timeoutMs || 750;
  const portOpen = await probeTcpPort(host, port, timeoutMs);
  if (!portOpen) return { portOpen: false, healthy: false };
  try {
    const response = await (options.fetch || fetch)(`http://${host}:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return { portOpen: true, healthy: response.ok };
  } catch { return { portOpen: true, healthy: false }; }
}

function probeTcpPort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function waitForPortRelease(port, probe) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const endpoint = await probe(port);
    if (!endpoint.portOpen) return true;
    if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be between 1 and 65535");
  return port;
}

function normalizeHost(value) {
  const host = String(value || "").trim();
  if (!host || /[\s/]/.test(host)) throw new Error("Controller host is invalid");
  return host;
}

function normalizeAdvertise(value) {
  if (!value) return null;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("--advertise must use http or https");
  return url.origin;
}

function normalizeWindowsServiceType(value) {
  const normalized = String(value || "scheduled-task").trim().toLowerCase();
  if (["scheduled-task", "task", "scheduled"].includes(normalized)) return "scheduled-task";
  if (["windows-service", "service", "scm"].includes(normalized)) return "windows-service";
  throw new Error("--service must be scheduled-task or windows-service");
}

function normalizeWindowsPath(value) {
  return String(value || "").replace(/\//g, "\\").toLowerCase();
}

function xmlEscape(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function batchValue(value) {
  return String(value).replace(/%/g, "%%").replace(/"/g, '""');
}

function batchQuote(value) {
  return `"${batchValue(value)}"`;
}

function powershellSingleQuote(value) {
  return String(value).replace(/'/g, "''");
}
