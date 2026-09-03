import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { controllerFirewallStatus, controllerServiceStatus, installControllerFirewall, installControllerService, probeControllerEndpoint, removeControllerFirewall, restartControllerService, startControllerService, stopControllerService } from "../lib/controller-service.mjs";
import { WINDOWS_FIREWALL_RULE, WINDOWS_SERVICE_ID, WINSW_X64_SHA256, renderWindowsServiceDefinition } from "../lib/windows-admin.mjs";

let temporaryDirectory;
before(async () => { temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "machora-controller-service-")); });
after(async () => { await rm(temporaryDirectory, { recursive: true, force: true }); });

test("installs a self-contained macOS controller runtime, CLI, config migration, and valid LaunchAgent", async () => {
  const home = path.join(temporaryDirectory, "home");
  const legacy = path.join(temporaryDirectory, "legacy-controller");
  await mkdir(path.join(legacy, "hooks"), { recursive: true });
  await writeFile(path.join(legacy, "config.json"), JSON.stringify({ version: 5, hosts: [], projects: [], jobs: [] }));
  await writeFile(path.join(legacy, "hooks", "project.log"), "confirmed\n");
  const calls = [];
  const execute = async (command, argumentsList) => {
    calls.push([command, ...argumentsList]);
    return { exitCode: 0, stdout: argumentsList[0] === "print" ? "state = running\n" : "", stderr: "" };
  };
  const installed = await installControllerService({
    platform: "darwin", home, uid: 501, nodePath: process.execPath, sourceRoot: path.resolve("."),
    migrateFrom: legacy, port: 4178, host: "0.0.0.0", advertise: "http://192.168.1.42:4178", execute,
    globalCliPath: path.join(home, "global-bin", "machora"),
  });
  assert.deepEqual(JSON.parse(await readFile(path.join(installed.configDir, "config.json"), "utf8")).hosts, []);
  assert.equal(await readFile(path.join(installed.configDir, "hooks", "project.log"), "utf8"), "confirmed\n");
  await stat(installed.runtimeCli); await stat(path.join(installed.appDir, "dist", "client", "index.html"));
  const wrapper = await readFile(installed.userCliPath, "utf8");
  assert.match(wrapper, /^#!\/bin\/sh/); assert.match(wrapper, new RegExp(installed.runtimeCli.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(installed.commandCliPath, path.join(home, "global-bin", "machora"));
  await stat(installed.commandCliPath);
  const plist = await readFile(installed.plistPath, "utf8");
  assert.match(plist, /dev\.machora\.controller/); assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /MACHORA_CONFIG_DIR/); assert.match(plist, /192\.168\.1\.42:4178/);
  if (process.platform === "darwin") {
    const lint = spawnSync("plutil", ["-lint", installed.plistPath], { encoding: "utf8" });
    assert.equal(lint.status, 0, lint.stderr || lint.stdout);
  }
  assert.ok(calls.some((call) => call[1] === "bootstrap")); assert.ok(calls.some((call) => call[1] === "kickstart"));
  const status = await controllerServiceStatus({ platform: "darwin", home, uid: 501, execute });
  assert.equal(status.installed, true); assert.equal(status.running, true);
});

test("installs and controls a current-user Windows Scheduled Task controller", async () => {
  const home = path.join(temporaryDirectory, "windows-home");
  const localAppData = path.join(home, "AppData", "Local");
  const calls = [];
  let healthy = true;
  await mkdir(path.join(home, ".machora"), { recursive: true });
  await writeFile(path.join(home, ".machora", "config.json"), JSON.stringify({ version: 5, hosts: [{ alias: "legacy-windows" }], projects: [], jobs: [] }));
  const execute = async (command, argumentsList) => {
    calls.push([command, ...argumentsList]);
    if (command === "schtasks.exe" && argumentsList[0] === "/End") healthy = false;
    if (command === "schtasks.exe" && argumentsList[0] === "/Run") healthy = true;
    return { exitCode: 0, stdout: command === "schtasks.exe" && argumentsList[0] === "/Query" ? "TaskName: Machora Controller\n" : "", stderr: "" };
  };
  const probe = async () => ({ portOpen: healthy, healthy });
  const options = {
    platform: "win32", home, env: { LOCALAPPDATA: localAppData }, nodePath: process.execPath,
    sourceRoot: path.resolve("."), execute, probe, advertise: "http://192.168.1.42:4178",
  };
  const installed = await installControllerService(options);

  assert.equal(installed.configDir, path.join(localAppData, "Machora"));
  assert.equal(installed.serviceType, "scheduled-task");
  assert.equal(installed.serviceLabel, "Machora Controller");
  assert.equal(installed.pathUpdated, true);
  assert.equal(JSON.parse(await readFile(path.join(installed.configDir, "config.json"), "utf8")).hosts[0].alias, "legacy-windows");
  assert.match(await readFile(installed.userCliPath, "utf8"), /machora managed controller CLI/);
  const launcher = await readFile(installed.launcherPath, "utf8");
  assert.match(launcher, /MACHORA_CONFIG_DIR/);
  assert.match(launcher, /192\.168\.1\.42:4178/);
  assert.match(launcher, /controller\.log/);
  const task = await readFile(installed.taskDefinitionPath, "utf8");
  assert.match(task, /<LogonTrigger>/);
  assert.match(task, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(task, /<RestartOnFailure>/);
  assert.match(task, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.ok(calls.some((call) => call[0] === "powershell.exe"));
  assert.ok(calls.some((call) => call[0] === "schtasks.exe" && call[1] === "/Create"));
  assert.ok(calls.some((call) => call[0] === "schtasks.exe" && call[1] === "/Run"));

  let status = await controllerServiceStatus(options);
  assert.equal(status.installed, true); assert.equal(status.running, true); assert.equal(status.port, 4178);
  status = await stopControllerService(options);
  assert.equal(status.running, false);
  status = await startControllerService(options);
  assert.equal(status.running, true);
  status = await restartControllerService(options);
  assert.equal(status.running, true);
});

test("reports a Windows controller port conflict before starting", async () => {
  const home = path.join(temporaryDirectory, "windows-conflict-home");
  const localAppData = path.join(home, "AppData", "Local");
  const execute = async (_command, argumentsList) => ({ exitCode: argumentsList[0] === "/Query" ? 0 : 0, stdout: "", stderr: "" });
  await installControllerService({
    platform: "win32", home, env: { LOCALAPPDATA: localAppData }, sourceRoot: path.resolve("."), execute,
    probe: async () => ({ portOpen: false, healthy: false }),
  });
  const options = { platform: "win32", home, env: { LOCALAPPDATA: localAppData }, execute, probe: async () => ({ portOpen: true, healthy: false }) };
  const status = await controllerServiceStatus(options);
  assert.match(status.detail, /occupied/);
  await assert.rejects(() => startControllerService(options), /already in use/);
});

test("installs an optional administrator Windows Service and private-network firewall rule", async () => {
  const home = path.join(temporaryDirectory, "windows-service-home");
  const localAppData = path.join(home, "AppData", "Local");
  const sourceWrapper = path.join(temporaryDirectory, "WinSW-x64.exe");
  await writeFile(sourceWrapper, "test winsw binary");
  const calls = [];
  let serviceInstalled = false;
  let serviceRunning = false;
  let firewallInstalled = false;
  const execute = async (command, argumentsList) => {
    calls.push([command, ...argumentsList]);
    if (command === "sc.exe") return serviceInstalled
      ? { exitCode: 0, stdout: serviceRunning ? "STATE              : 4  RUNNING" : "STATE              : 1  STOPPED", stderr: "" }
      : { exitCode: 1060, stdout: "", stderr: "service does not exist" };
    if (String(command).endsWith("machora-controller-service.exe")) {
      if (argumentsList[0] === "install") serviceInstalled = true;
      if (argumentsList[0] === "start") serviceRunning = true;
      if (argumentsList[0] === "stop") serviceRunning = false;
      if (argumentsList[0] === "uninstall") serviceInstalled = false;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command === "powershell.exe") {
      const script = argumentsList.at(-1);
      if (script.includes("New-NetFirewallRule")) { firewallInstalled = true; return { exitCode: 0, stdout: "", stderr: "" }; }
      if (script.includes("Remove-NetFirewallRule")) { const removed = firewallInstalled; firewallInstalled = false; return { exitCode: 0, stdout: removed ? "removed" : "absent", stderr: "" }; }
      if (script.includes("Get-NetFirewallRule")) return firewallInstalled
        ? { exitCode: 0, stdout: JSON.stringify({ Enabled: "True", Profile: "Private, Domain", Port: "5218", Program: process.execPath }), stderr: "" }
        : { exitCode: 3, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const options = {
    platform: "win32", home, env: { LOCALAPPDATA: localAppData }, sourceRoot: path.resolve("."),
    nodePath: process.execPath, port: 5218, execute, winswPath: sourceWrapper,
    serviceType: "windows-service", firewall: true, probe: async () => ({ portOpen: serviceRunning, healthy: serviceRunning }),
  };
  const installed = await installControllerService(options);
  assert.equal(installed.serviceType, "windows-service");
  assert.equal(installed.serviceLabel, WINDOWS_SERVICE_ID);
  assert.equal(installed.firewall.name, WINDOWS_FIREWALL_RULE);
  assert.equal(installed.firewall.port, 5218);
  assert.equal(installed.firewall.enabled, true);
  const definition = await readFile(installed.serviceDefinitionPath, "utf8");
  assert.match(definition, /<id>MachoraController<\/id>/);
  assert.match(definition, /<onfailure action="restart"/);
  assert.match(definition, /<log mode="roll">/);
  assert.equal((await readFile(installed.serviceWrapperPath, "utf8")), "test winsw binary");
  assert.match(WINSW_X64_SHA256, /^[a-f0-9]{64}$/);
  assert.ok(calls.some((call) => call[0] === "schtasks.exe" && call[1] === "/Delete"));
  assert.ok(calls.some((call) => String(call[0]).endsWith("machora-controller-service.exe") && call[1] === "install"));
  let status = await controllerServiceStatus(options);
  assert.equal(status.installed, true); assert.equal(status.running, true); assert.equal(status.serviceType, "windows-service");
  status = await stopControllerService(options); assert.equal(status.running, false);
  status = await startControllerService(options); assert.equal(status.running, true);
  status = await restartControllerService(options); assert.equal(status.running, true);

  const firewall = await controllerFirewallStatus({ platform: "win32", home, env: { LOCALAPPDATA: localAppData }, execute });
  assert.equal(firewall.installed, true);
  await removeControllerFirewall({ platform: "win32", home, env: { LOCALAPPDATA: localAppData }, execute });
  assert.equal((await controllerFirewallStatus({ platform: "win32", home, env: { LOCALAPPDATA: localAppData }, execute })).installed, false);
  await installControllerFirewall({ platform: "win32", home, env: { LOCALAPPDATA: localAppData }, execute });
  assert.equal(firewallInstalled, true);
});

test("renders a WinSW definition with explicit paths and arguments", () => {
  const definition = renderWindowsServiceDefinition({
    configDir: "C:\\Users\\dev\\AppData\\Local\\Machora",
    appDir: "C:\\Users\\dev\\AppData\\Local\\Machora\\app",
    runtimeCli: "C:\\Users\\dev\\AppData\\Local\\Machora\\app\\bin\\machora.mjs",
    logsDir: "C:\\Users\\dev\\AppData\\Local\\Machora\\logs",
    nodePath: "C:\\Program Files\\nodejs\\node.exe", port: 4178, host: "0.0.0.0",
    advertise: "http://192.168.1.42:4178",
  });
  assert.match(definition, /C:\\Program Files\\nodejs\\node\.exe/);
  assert.match(definition, /--advertise/);
  assert.match(definition, /192\.168\.1\.42:4178/);
});

test("rejects an untrusted downloaded Windows service wrapper", async () => {
  const home = path.join(temporaryDirectory, "windows-service-integrity-home");
  const localAppData = path.join(home, "AppData", "Local");
  await assert.rejects(() => installControllerService({
    platform: "win32", home, env: { LOCALAPPDATA: localAppData }, sourceRoot: path.resolve("."),
    serviceType: "windows-service", execute: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    probe: async () => ({ portOpen: false, healthy: false }),
    fetchImpl: async () => new Response("not winsw", { status: 200 }),
  }), /integrity check failed/);
});

test("reports the Administrator requirement when firewall installation is denied", async () => {
  const home = path.join(temporaryDirectory, "windows-firewall-denied-home");
  const localAppData = path.join(home, "AppData", "Local");
  await assert.rejects(() => installControllerFirewall({
    platform: "win32", home, env: { LOCALAPPDATA: localAppData }, port: 4178,
    execute: async () => ({ exitCode: 1, stdout: "", stderr: "Access is denied" }),
  }), /PowerShell as Administrator.*Access is denied/);
});

test("distinguishes a healthy Machora endpoint from a closed controller port", async () => {
  const server = createServer((request, response) => {
    response.writeHead(request.url === "/api/health" ? 200 : 404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  assert.deepEqual(await probeControllerEndpoint(port), { portOpen: true, healthy: true });
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert.deepEqual(await probeControllerEndpoint(port), { portOpen: false, healthy: false });
});

test("does not overwrite a different persistent controller config without force", async () => {
  const home = path.join(temporaryDirectory, "conflict-home");
  const legacy = path.join(temporaryDirectory, "conflict-legacy");
  await mkdir(path.join(home, ".machora"), { recursive: true }); await mkdir(legacy, { recursive: true });
  await writeFile(path.join(home, ".machora", "config.json"), "{\"version\":5,\"hosts\":[1]}");
  await writeFile(path.join(legacy, "config.json"), "{\"version\":5,\"hosts\":[2]}");
  await assert.rejects(() => installControllerService({ platform: "darwin", home, uid: 501, sourceRoot: path.resolve("."), migrateFrom: legacy, execute: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }), /already exists/);
});

test("migrates the default legacy rdev controller and retires its LaunchAgent", async () => {
  const home = path.join(temporaryDirectory, "legacy-rdev-home");
  const legacyDirectory = path.join(home, ".rdev");
  const launchAgents = path.join(home, "Library", "LaunchAgents");
  const legacyPlist = path.join(launchAgents, "dev.rdev.controller.plist");
  await mkdir(legacyDirectory, { recursive: true });
  await mkdir(launchAgents, { recursive: true });
  await writeFile(path.join(legacyDirectory, "config.json"), JSON.stringify({ version: 5, hosts: [{ alias: "legacy-mac" }], projects: [], jobs: [] }));
  await writeFile(legacyPlist, "legacy service");
  const calls = [];
  const execute = async (command, argumentsList) => {
    calls.push([command, ...argumentsList]);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const installed = await installControllerService({
    platform: "darwin", home, uid: 501, nodePath: process.execPath, sourceRoot: path.resolve("."), execute,
    globalCliPath: path.join(home, "global-bin", "machora"),
  });
  const migrated = JSON.parse(await readFile(path.join(installed.configDir, "config.json"), "utf8"));
  assert.equal(migrated.hosts[0].alias, "legacy-mac");
  await assert.rejects(() => stat(legacyPlist), /ENOENT/);
  assert.ok(calls.some((call) => call.includes(legacyPlist)));
});
