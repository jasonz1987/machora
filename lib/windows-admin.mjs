import { createHash } from "node:crypto";
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const WINDOWS_FIREWALL_RULE = "Machora.Controller";
export const WINDOWS_SERVICE_ID = "MachoraController";
export const WINSW_VERSION = "2.12.0";
export const WINSW_X64_URL = `https://github.com/winsw/winsw/releases/download/v${WINSW_VERSION}/WinSW-x64.exe`;
export const WINSW_X64_SHA256 = "05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da";

export function windowsAdminPaths(configDir) {
  return {
    serviceWrapperPath: path.join(configDir, "machora-controller-service.exe"),
    serviceDefinitionPath: path.join(configDir, "machora-controller-service.xml"),
  };
}

export async function installWindowsFirewall({ port, nodePath, execute }) {
  const script = [
    `$name='${powershellSingleQuote(WINDOWS_FIREWALL_RULE)}'`,
    "$existing=Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue",
    "if($existing){$existing | Remove-NetFirewallRule}",
    `New-NetFirewallRule -Name $name -DisplayName 'Machora Controller (TCP ${Number(port)})' -Description 'Allows trusted private networks to reach the self-hosted Machora controller.' -Group 'Machora' -Direction Inbound -Action Allow -Enabled True -Profile Private,Domain -Protocol TCP -LocalPort ${Number(port)} -Program '${powershellSingleQuote(nodePath)}' -PolicyStore PersistentStore | Out-Null`,
  ].join(";");
  const result = await executePowerShell(execute, script, { allowFailure: true });
  if (result.exitCode !== 0) throw windowsAdminError("install the Windows Firewall rule", result);
  return windowsFirewallStatus({ execute });
}

export async function removeWindowsFirewall({ execute }) {
  const script = `$rule=Get-NetFirewallRule -Name '${powershellSingleQuote(WINDOWS_FIREWALL_RULE)}' -ErrorAction SilentlyContinue;if($rule){$rule | Remove-NetFirewallRule;[Console]::Out.Write('removed')}else{[Console]::Out.Write('absent')}`;
  const result = await executePowerShell(execute, script, { allowFailure: true });
  if (result.exitCode !== 0) throw windowsAdminError("remove the Windows Firewall rule", result);
  return { installed: false, removed: String(result.stdout).trim() === "removed", name: WINDOWS_FIREWALL_RULE };
}

export async function windowsFirewallStatus({ execute }) {
  const script = [
    `$rule=Get-NetFirewallRule -Name '${powershellSingleQuote(WINDOWS_FIREWALL_RULE)}' -ErrorAction SilentlyContinue`,
    "if(!$rule){exit 3}",
    "$port=$rule | Get-NetFirewallPortFilter | Select-Object -First 1",
    "$app=$rule | Get-NetFirewallApplicationFilter | Select-Object -First 1",
    "$value=[ordered]@{Enabled=$rule.Enabled.ToString();Profile=$rule.Profile.ToString();Port=$port.LocalPort.ToString();Program=$app.Program.ToString()}",
    "$value | ConvertTo-Json -Compress",
  ].join(";");
  const result = await executePowerShell(execute, script, { allowFailure: true });
  if (result.exitCode === 3) return { installed: false, enabled: false, name: WINDOWS_FIREWALL_RULE };
  if (result.exitCode !== 0) return { installed: false, enabled: false, name: WINDOWS_FIREWALL_RULE, error: String(result.stderr || result.stdout).trim() };
  try {
    const value = JSON.parse(String(result.stdout).trim());
    return {
      installed: true,
      enabled: String(value.Enabled).toLowerCase() === "true",
      profile: value.Profile,
      port: Number(value.Port),
      program: value.Program,
      name: WINDOWS_FIREWALL_RULE,
    };
  } catch {
    return { installed: true, enabled: true, name: WINDOWS_FIREWALL_RULE };
  }
}

export async function installWindowsService({
  paths, nodePath, port, host, advertise, execute, winswPath, architecture = process.arch,
  fetchImpl = fetch,
}) {
  const adminPaths = windowsAdminPaths(paths.configDir);
  await mkdir(paths.logsDir, { recursive: true });
  await provisionWinSW({ target: adminPaths.serviceWrapperPath, source: winswPath, architecture, fetchImpl });
  await writeFile(adminPaths.serviceDefinitionPath, renderWindowsServiceDefinition({
    ...paths, ...adminPaths, nodePath, port, host, advertise,
  }), { mode: 0o600 });
  await execute("schtasks.exe", ["/End", "/TN", paths.scheduledTaskName], { allowFailure: true });
  await execute("schtasks.exe", ["/Delete", "/TN", paths.scheduledTaskName, "/F"], { allowFailure: true });
  await execute(adminPaths.serviceWrapperPath, ["stop"], { allowFailure: true });
  await execute(adminPaths.serviceWrapperPath, ["uninstall"], { allowFailure: true });
  const installed = await execute(adminPaths.serviceWrapperPath, ["install"], { allowFailure: true });
  if (installed.exitCode !== 0) throw windowsAdminError("install the Windows Service", installed);
  const started = await execute(adminPaths.serviceWrapperPath, ["start"], { allowFailure: true });
  if (started.exitCode !== 0) throw windowsAdminError("start the Windows Service", started);
  return { ...adminPaths, serviceType: "windows-service", serviceLabel: WINDOWS_SERVICE_ID };
}

export async function windowsServiceStatus({ paths, execute }) {
  const adminPaths = windowsAdminPaths(paths.configDir);
  const exists = Boolean(await stat(adminPaths.serviceWrapperPath).catch(() => null))
    && Boolean(await stat(adminPaths.serviceDefinitionPath).catch(() => null));
  if (!exists) return { installed: false, running: false, ...adminPaths };
  const result = await execute("sc.exe", ["query", WINDOWS_SERVICE_ID], { allowFailure: true });
  const output = String(result.stdout || result.stderr || "").trim();
  return {
    installed: result.exitCode === 0,
    running: result.exitCode === 0 && /STATE\s*:\s*4\s+RUNNING/i.test(output),
    output,
    ...adminPaths,
  };
}

export async function controlWindowsService({ paths, execute, action }) {
  const status = await windowsServiceStatus({ paths, execute });
  if (!status.installed) throw new Error("Machora Windows Service is not installed");
  const result = await execute(status.serviceWrapperPath, [action], { allowFailure: true });
  if (result.exitCode !== 0) throw windowsAdminError(`${action} the Windows Service`, result);
  return windowsServiceStatus({ paths, execute });
}

export async function uninstallWindowsService({ paths, execute }) {
  const status = await windowsServiceStatus({ paths, execute });
  if (!status.installed) return { installed: false, removed: false, ...status };
  await execute(status.serviceWrapperPath, ["stop"], { allowFailure: true });
  const result = await execute(status.serviceWrapperPath, ["uninstall"], { allowFailure: true });
  if (result.exitCode !== 0) throw windowsAdminError("uninstall the Windows Service", result);
  await rm(status.serviceWrapperPath, { force: true });
  await rm(status.serviceDefinitionPath, { force: true });
  return { installed: false, removed: true, ...status };
}

export function renderWindowsServiceDefinition({ configDir, appDir, runtimeCli, logsDir, nodePath, port, host, advertise }) {
  const argumentsList = [runtimeCli, "server", "--port", String(port), "--host", host, ...(advertise ? ["--advertise", advertise] : [])];
  return `<?xml version="1.0" encoding="UTF-8"?>
<service>
  <id>${WINDOWS_SERVICE_ID}</id>
  <name>Machora Controller</name>
  <description>Self-hosted controller for Git-native remote development Jobs.</description>
  <executable>${xmlEscape(nodePath)}</executable>
  <arguments>${xmlEscape(argumentsList.map(windowsArgument).join(" "))}</arguments>
  <workingdirectory>${xmlEscape(appDir)}</workingdirectory>
  <env name="MACHORA_CONFIG_DIR" value="${xmlEscape(configDir)}"/>
  <env name="PATH" value="${xmlEscape(`${path.dirname(nodePath)};%PATH%`)}"/>
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
  <onfailure action="restart" delay="5 sec"/>
  <onfailure action="restart" delay="15 sec"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>15 sec</stoptimeout>
  <hidewindow>true</hidewindow>
  <logpath>${xmlEscape(logsDir)}</logpath>
  <log mode="roll"></log>
</service>
`;
}

async function provisionWinSW({ target, source, architecture, fetchImpl }) {
  if (source) {
    const resolved = path.resolve(source);
    if (!await stat(resolved).catch(() => null)) throw new Error(`WinSW executable not found: ${resolved}`);
    if (resolved !== path.resolve(target)) await copyFile(resolved, target);
    return target;
  }
  if (!['x64', 'arm64'].includes(architecture)) throw new Error(`Automatic WinSW installation does not support ${architecture}; pass --winsw <path>`);
  const response = await fetchImpl(WINSW_X64_URL, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Could not download WinSW ${WINSW_VERSION}: HTTP ${response.status}`);
  const binary = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(binary).digest("hex");
  if (digest !== WINSW_X64_SHA256) throw new Error(`WinSW integrity check failed: expected ${WINSW_X64_SHA256}, received ${digest}`);
  await writeFile(target, binary, { mode: 0o700 });
  return target;
}

async function executePowerShell(execute, script, options) {
  return execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], options);
}

function windowsAdminError(action, result) {
  const detail = String(result.stderr || result.stdout || "").trim();
  const error = new Error(`Could not ${action}. Open PowerShell as Administrator and run the command again${detail ? `: ${detail}` : "."}`);
  error.code = "WINDOWS_ADMIN_REQUIRED";
  return error;
}

function windowsArgument(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function powershellSingleQuote(value) {
  return String(value).replace(/'/g, "''");
}

function xmlEscape(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
