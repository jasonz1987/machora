import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, chmod, copyFile, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVICE_LABEL = "dev.machora.controller";
const LEGACY_SERVICE_LABEL = "dev.rdev.controller";

export function controllerPaths(home = os.homedir()) {
  const configDir = path.join(home, ".machora");
  return {
    configDir,
    appDir: path.join(configDir, "app"),
    runtimeCli: path.join(configDir, "app", "bin", "machora.mjs"),
    logsDir: path.join(configDir, "logs"),
    stdoutPath: path.join(configDir, "logs", "controller.log"),
    stderrPath: path.join(configDir, "logs", "controller-error.log"),
    serviceConfigPath: path.join(configDir, "controller.json"),
    plistPath: path.join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
    userCliPath: path.join(home, ".local", "bin", "machora"),
    legacyConfigDir: path.join(home, ".rdev"),
    legacyPlistPath: path.join(home, "Library", "LaunchAgents", `${LEGACY_SERVICE_LABEL}.plist`),
    legacyUserCliPath: path.join(home, ".local", "bin", "rdev"),
  };
}

export async function installControllerService(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "darwin") throw new Error("machora controller install currently supports macOS LaunchAgent controllers");
  const paths = controllerPaths(options.home || os.homedir());
  const port = normalizePort(options.port || 4178);
  const host = normalizeHost(options.host || "0.0.0.0");
  const advertise = normalizeAdvertise(options.advertise);
  const nodePath = path.resolve(options.nodePath || process.execPath);
  const applicationSource = path.resolve(options.sourceRoot || sourceRoot);
  const hasCurrentConfig = Boolean(await stat(path.join(paths.configDir, "config.json")).catch(() => null));
  const migrateFrom = options.migrateFrom
    ? path.resolve(options.migrateFrom)
    : hasCurrentConfig ? null : paths.legacyConfigDir;
  const execute = options.execute || executeFile;
  const uid = options.uid ?? process.getuid?.();
  if (!Number.isInteger(uid)) throw new Error("Could not determine the current macOS user id");

  await migrateControllerConfig(migrateFrom, paths.configDir, { force: Boolean(options.force) });
  await mkdir(paths.logsDir, { recursive: true, mode: 0o700 });
  await installRuntime(applicationSource, paths.appDir);
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
  const serviceConfig = { version: 1, port, host, advertise, installedAt: new Date().toISOString() };
  await writeFile(paths.serviceConfigPath, `${JSON.stringify(serviceConfig, null, 2)}\n`, { mode: 0o600 });
  await mkdir(path.dirname(paths.plistPath), { recursive: true });
  await writeFile(paths.plistPath, renderMacLaunchAgent({ ...paths, nodePath, port, host, advertise }), { mode: 0o600 });

  const domain = `gui/${uid}`;
  await execute("launchctl", ["bootout", domain, paths.plistPath], { allowFailure: true });
  const legacyControllerStopped = await stopLegacyController({ paths, domain, execute });
  await execute("launchctl", ["bootstrap", domain, paths.plistPath]);
  await execute("launchctl", ["enable", `${domain}/${SERVICE_LABEL}`]);
  await execute("launchctl", ["kickstart", "-k", `${domain}/${SERVICE_LABEL}`]);
  if (legacyControllerStopped) await rm(paths.legacyPlistPath, { force: true });
  return { ...paths, commandCliPath, nodePath, port, host, advertise, serviceLabel: SERVICE_LABEL };
}

export async function controllerServiceStatus(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "darwin") return { installed: false, running: false, detail: "Unsupported controller service platform" };
  const paths = controllerPaths(options.home || os.homedir());
  const execute = options.execute || executeFile;
  const uid = options.uid ?? process.getuid?.();
  let plistPath = paths.plistPath;
  let serviceLabel = SERVICE_LABEL;
  let legacy = false;
  if (!await stat(plistPath).catch(() => null) && await stat(paths.legacyPlistPath).catch(() => null)) {
    plistPath = paths.legacyPlistPath;
    serviceLabel = LEGACY_SERVICE_LABEL;
    legacy = true;
  }
  if (!await stat(plistPath).catch(() => null)) return { installed: false, running: false, serviceLabel, ...paths };
  const result = await execute("launchctl", ["print", `gui/${uid}/${serviceLabel}`], { allowFailure: true });
  const configDir = legacy ? paths.legacyConfigDir : paths.configDir;
  return { installed: true, running: result.exitCode === 0, output: result.stdout || result.stderr || "", ...paths, configDir, plistPath, serviceLabel, legacy };
}

export async function restartControllerService(options = {}) {
  const status = await controllerServiceStatus(options);
  if (!status.installed) throw new Error("machora controller service is not installed");
  const execute = options.execute || executeFile;
  const uid = options.uid ?? process.getuid?.();
  await execute("launchctl", ["kickstart", "-k", `gui/${uid}/${status.serviceLabel}`]);
  return controllerServiceStatus(options);
}

export async function stopControllerService(options = {}) {
  const status = await controllerServiceStatus(options);
  if (!status.installed) throw new Error("machora controller service is not installed");
  const execute = options.execute || executeFile;
  const uid = options.uid ?? process.getuid?.();
  await execute("launchctl", ["bootout", `gui/${uid}`, status.plistPath], { allowFailure: true });
  return { ...status, running: false };
}

export async function startControllerService(options = {}) {
  const status = await controllerServiceStatus(options);
  if (!status.installed) throw new Error("machora controller service is not installed");
  const execute = options.execute || executeFile;
  const uid = options.uid ?? process.getuid?.();
  await execute("launchctl", ["bootstrap", `gui/${uid}`, status.plistPath], { allowFailure: true });
  await execute("launchctl", ["enable", `gui/${uid}/${status.serviceLabel}`]);
  await execute("launchctl", ["kickstart", "-k", `gui/${uid}/${status.serviceLabel}`]);
  return controllerServiceStatus(options);
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

async function installRuntime(origin, destination) {
  if (path.resolve(origin) === path.resolve(destination)) return;
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of ["bin", "lib", "server", "agent", "dist"]) {
    const source = path.join(origin, entry);
    if (!await stat(source).catch(() => null)) throw new Error(`Controller runtime is missing ${entry}; run npm run build before installing`);
    await cp(source, path.join(destination, entry), { recursive: true, force: true });
  }
  await copyFile(path.join(origin, "package.json"), path.join(destination, "package.json"));
  await chmod(path.join(destination, "bin", "machora.mjs"), 0o700);
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

function xmlEscape(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}
