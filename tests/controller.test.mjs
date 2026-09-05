import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "../server/server.mjs";

let temporaryDirectory; let server; let origin;
before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "machora-api-test-")); process.env.MACHORA_CONFIG_DIR = temporaryDirectory;
  const started = await startServer({ port: 0, host: "127.0.0.1", advertise: "http://192.168.50.10:4178" }); server = started.server; origin = `http://127.0.0.1:${started.port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); delete process.env.MACHORA_CONFIG_DIR; await rm(temporaryDirectory, { recursive: true, force: true }); });

test("creates an enrollment and accepts the bootstrap report", async () => {
  const enrollmentResponse = await fetch(`${origin}/api/enrollments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ alias: "win-build", os: "windows", workspace: "%USERPROFILE%\\Builds" }) });
  assert.equal(enrollmentResponse.status, 201); const created = await enrollmentResponse.json(); assert.match(created.commands.windows, /^irm /); assert.match(created.commands.windows, /192\.168\.50\.10/); assert.match(created.commands.windows, /install\.ps1/);
  const completed = await fetch(`${origin}/api/enroll/${created.enrollment.token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ hostname: "WIN-BUILD", os: "windows", arch: "AMD64", agentVersion: "0.8.1" }) });
  assert.equal(completed.status, 201);
  const hosts = await fetch(`${origin}/api/hosts`).then((response) => response.json()); assert.equal(hosts.hosts[0].alias, "win-build"); assert.equal(hosts.hosts[0].status, "online");
});

test("serializes concurrent controller mutations without corrupting or losing host records", async () => {
  const aliases = Array.from({ length: 8 }, (_, index) => `concurrent-${index}`);
  const responses = await Promise.all(aliases.map((alias) => fetch(`${origin}/api/hosts`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ alias, address: `192.0.2.${indexForAlias(alias)}`, os: "linux", workspace: "/tmp/builds" }),
  })));
  assert.ok(responses.every((response) => response.status === 201));
  const hosts = await fetch(`${origin}/api/hosts`).then((response) => response.json());
  const created = hosts.hosts.filter((host) => aliases.includes(host.alias));
  assert.equal(created.length, aliases.length);
  const deleted = await Promise.all(created.map((host) => fetch(`${origin}/api/hosts/${host.id}`, { method: "DELETE" })));
  assert.ok(deleted.every((response) => response.status === 200));
});

function indexForAlias(alias) {
  return Number(alias.split("-").at(-1)) + 10;
}

test("assigns a local Git project through the controller-only API", async () => {
  const repository = path.join(temporaryDirectory, "web-project");
  await mkdir(repository);
  assert.equal(spawnSync("git", ["init", "-b", "main", repository]).status, 0);
  assert.equal(spawnSync("git", ["-C", repository, "config", "user.email", "machora@example.test"]).status, 0);
  assert.equal(spawnSync("git", ["-C", repository, "config", "user.name", "machora test"]).status, 0);
  await writeFile(path.join(repository, "package.json"), JSON.stringify({ packageManager: "pnpm@10.0.0", scripts: { build: "next build" }, dependencies: { next: "16.0.0" } }));
  assert.equal(spawnSync("git", ["-C", repository, "add", "package.json"]).status, 0);
  assert.equal(spawnSync("git", ["-C", repository, "commit", "-m", "initial"]).status, 0);
  assert.equal(spawnSync("git", ["-C", repository, "remote", "add", "origin", "git@example.test:team/web-project.git"]).status, 0);
  const analysisResponse = await fetch(`${origin}/api/projects/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ localPath: repository, host: "win-build" }) });
  const analyzed = await analysisResponse.json();
  assert.equal(analysisResponse.status, 200, analyzed.error);
  assert.equal(analyzed.analysis.project.projectType, "Next.js");
  assert.equal(analyzed.analysis.requirements[0].label, "Node.js");
  assert.equal((await fetch(`${origin}/api/projects`).then((projectResponse) => projectResponse.json())).projects.length, 0, "analysis must not persist an assignment");
  const response = await fetch(`${origin}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ localPath: repository, host: "win-build" }) });
  const result = await response.json();
  assert.equal(response.status, 201, result.error); assert.equal(result.project.name, "web-project"); assert.equal(result.project.host.alias, "win-build");
  assert.equal(result.project.skill.status, "installed"); assert.equal(result.job.status, "queued");
  const projects = await fetch(`${origin}/api/projects`).then((projectResponse) => projectResponse.json());
  assert.equal(projects.projects.length, 1); assert.equal(projects.projects[0].projectType, "Next.js"); assert.equal(projects.projects[0].commands.build, "pnpm run build");
  const updateCommands = await fetch(`${origin}/api/projects/${result.project.id}/commands`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ commands: { test: "pnpm run test:ci" }, devPort: 3400, devPortSource: "custom" }) });
  assert.equal(updateCommands.status, 200);
  const updatedProject = (await updateCommands.json()).project;
  assert.equal(updatedProject.commands.test, "pnpm run test:ci"); assert.equal(updatedProject.devPort, 3400); assert.equal(updatedProject.devPortSource, "custom");
  const resetPort = await fetch(`${origin}/api/projects/${result.project.id}/commands`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ commands: {}, devPortSource: "detected" }) });
  const resetProject = (await resetPort.json()).project;
  assert.equal(resetPort.status, 200); assert.equal(resetProject.devPort, 3000); assert.equal(resetProject.devPortSource, "detected");
  const updateAutomations = await fetch(`${origin}/api/projects/${result.project.id}/automations`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ rules: [{ event: "tag-push", pattern: "v*", operation: "build", enabled: true }] }) });
  const automated = await updateAutomations.json();
  assert.equal(updateAutomations.status, 200, automated.error); assert.equal(automated.project.automations.rules[0].operation, "build");
  const installHook = await fetch(`${origin}/api/projects/${result.project.id}/hooks/install`, { method: "POST" });
  const installed = await installHook.json();
  assert.equal(installHook.status, 200, installed.error); assert.equal(installed.project.hook.status, "installed");
  assert.match(await readFile(installed.project.hook.path, "utf8"), /machora managed pre-push hook/);
  const removed = await fetch(`${origin}/api/projects/${result.project.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
});

test("serves the Agent and a valid POSIX installer", async () => {
  const response = await fetch(`${origin}/install.sh?token=test-token`);
  const script = await response.text();
  assert.equal(response.status, 200);
  assert.match(script, /^#!\/bin\/sh/);
  assert.match(script, /192\.168\.50\.10/);
  assert.match(script, /LaunchAgents/);
  assert.match(script, /systemd\/user/);
  assert.match(script, /agent\.mjs/);
  const syntax = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const agentSource = await fetch(`${origin}/agent.mjs`).then((agentResponse) => agentResponse.text());
  assert.match(agentSource, /api\/agent\/heartbeat/);
});

test("serves Agent update commands and a valid POSIX updater", async () => {
  const health = await fetch(`${origin}/api/health`).then((response) => response.json());
  assert.equal(health.agentVersion, "0.11.5");
  assert.match(health.updateCommands.posix, /192\.168\.50\.10:4178\/update\.sh/);
  const response = await fetch(`${origin}/update.sh`);
  const script = await response.text();
  assert.equal(response.status, 200);
  assert.match(script, /kickstart -k/);
  assert.match(script, /systemctl --user restart/);
  const syntax = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const windowsScript = await fetch(`${origin}/update.ps1`).then((updateResponse) => updateResponse.text());
  assert.match(windowsScript, /Agent updated and Scheduled Task restarted/);
  const scheduledResponse = await fetch(`${origin}/agent-update.sh`);
  const scheduledScript = await scheduledResponse.text();
  assert.equal(scheduledResponse.status, 200);
  assert.match(scheduledScript, /sleep 6/);
  assert.match(scheduledScript, /update-agent\.log/);
  assert.equal(spawnSync("sh", ["-n"], { input: scheduledScript, encoding: "utf8" }).status, 0);
  const scheduledWindowsScript = await fetch(`${origin}/agent-update.ps1`).then((updateResponse) => updateResponse.text());
  assert.match(scheduledWindowsScript, /Machora Agent Update/);
  assert.match(scheduledWindowsScript, /independent activation task scheduled/);
  assert.match(scheduledWindowsScript, /local supervisor activation scheduled/);
  assert.match(scheduledWindowsScript, /installedAgentTask/);
  assert.match(scheduledWindowsScript, /New-ScheduledTaskTrigger -Once/);
  assert.match(scheduledWindowsScript, /Start-Sleep -Seconds 8/);
  assert.match(scheduledWindowsScript, /agent\.mjs\.new/);
  assert.match(scheduledWindowsScript, /MACHORA_AGENT_UPDATE_SOURCE/);
  assert.match(scheduledWindowsScript, /finalize-agent-update\.ps1/);
  assert.match(scheduledWindowsScript, /Start-Process -WindowStyle Hidden/);
  assert.match(scheduledWindowsScript, /install-agent-service\.ps1/);
  assert.match(scheduledWindowsScript, /FromBase64String/);
  assert.match(scheduledWindowsScript, /Where-Object \{ Test-Path \(Join-Path \$_ 'config\.json'\) \}/);
  assert.ok(scheduledWindowsScript.indexOf("Set-Content -Path $finalizerPath") < scheduledWindowsScript.indexOf("Start-ScheduledTask -TaskName $updateTaskName"));
  assert.match(scheduledWindowsScript, /\.machora-agent/);
  assert.match(scheduledWindowsScript, /LOCALAPPDATA/);
  const directWindowsScript = await fetch(`${origin}/update.ps1`).then((updateResponse) => updateResponse.text());
  assert.match(directWindowsScript, /Where-Object \{ Test-Path \(Join-Path \$_ 'config\.json'\) \}/);
  assert.match(directWindowsScript, /homeMachoraDir/);
  assert.match(directWindowsScript, /localMachoraDir/);
  assert.match(directWindowsScript, /install-agent-service\.ps1/);
  assert.match(directWindowsScript, /FromBase64String/);
  const windowsService = await fetch(`${origin}/agent-service.ps1`).then((serviceResponse) => serviceResponse.text());
  assert.match(windowsService, /Register-ScheduledTask/);
  assert.match(windowsService, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(windowsService, /RestartCount 999/);
  assert.match(windowsService, /AllowStartIfOnBatteries/);
  assert.match(windowsService, /MACHORA_NODE_COMMAND/);
  assert.match(windowsService, /Startup supervisor installed and started/);
  assert.ok(windowsService.indexOf("Register-ScheduledTask -TaskName $taskName") < windowsService.indexOf("Stop-Process -Id $agentProcess.ProcessId"));
  assert.match(windowsService, /while \(`\$true\)/);
  assert.match(windowsService, /Remove-Item -Force \$startupFile/);
  const windowsInstaller = await fetch(`${origin}/install.ps1?token=test-token`).then((installResponse) => installResponse.text());
  assert.match(windowsInstaller, /\$env:MACHORA_AGENT_DIR = \$agentDir/);
});

test("queues a controller-managed Agent update for an enrolled host", async () => {
  const enrollmentResponse = await fetch(`${origin}/api/enrollments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ alias: "update-win", os: "windows", workspace: "C:\\Builds" }) });
  const enrollment = await enrollmentResponse.json();
  const enrolledResponse = await fetch(`${origin}/api/enroll/${enrollment.enrollment.token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostname: "UPDATE-WIN", os: "windows", agentVersion: "0.8.1" }) });
  assert.equal(enrolledResponse.status, 201);
  const hosts = await fetch(`${origin}/api/hosts`).then((response) => response.json());
  const host = hosts.hosts.find((item) => item.alias === "update-win");
  const response = await fetch(`${origin}/api/hosts/${host.id}/agent-update`, { method: "POST" });
  const result = await response.json();
  assert.equal(response.status, 202, result.error);
  assert.equal(result.job.type, "host-command");
  assert.equal(result.job.operation, "agent-update");
  assert.equal(result.job.targetAgentVersion, "0.11.5");
  assert.equal(result.job.steps[0].label, "Schedule Agent update");
  assert.match(result.job.command, /^node -e eval\^\(Buffer\.from\^\(/);
  assert.match(result.job.command, / [A-Za-z0-9+/]+=*$/);
  const encodedProgram = result.job.command.match(/ ([A-Za-z0-9+/]+=*)$/)[1];
  const decodedProgram = Buffer.from(encodedProgram, "base64").toString("utf8");
  assert.match(decodedProgram, /http:\/\/192\.168\.50\.10:4178/);
  assert.match(decodedProgram, /download\("agent-update\.ps1"\)/);
  assert.match(decodedProgram, /download\("agent\.mjs"\)/);
  assert.match(decodedProgram, /MACHORA_AGENT_UPDATE_SOURCE/);
  assert.match(decodedProgram, /AbortSignal\.timeout\(10000\)/);
  assert.match(decodedProgram, /waits=\[2000,5000,10000\]/);
  assert.match(decodedProgram, /spawnSync\(powershell/);
  const duplicateResponse = await fetch(`${origin}/api/hosts/${host.id}/agent-update`, { method: "POST" });
  const duplicate = await duplicateResponse.json();
  assert.equal(duplicateResponse.status, 202);
  assert.equal(duplicate.job.id, result.job.id);
});

test("lists deployment providers without exposing controller credentials", async () => {
  const response = await fetch(`${origin}/api/deployment-targets`);
  const catalog = await response.json();
  assert.equal(response.status, 200, catalog.error);
  assert.ok(catalog.providers.some((provider) => provider.type === "ssh"));
  assert.ok(Array.isArray(catalog.targets));
});

test("queues host commands and requires confirmation for risky commands", async () => {
  const hosts = await fetch(`${origin}/api/hosts`).then((response) => response.json());
  const host = hosts.hosts.find((item) => item.alias === "win-build");
  const risky = await fetch(`${origin}/api/hosts/${host.id}/commands`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "npm install -g pnpm", workingDirectory: host.workspace }),
  });
  const warning = await risky.json();
  assert.equal(risky.status, 409); assert.equal(warning.requiresConfirmation, true); assert.equal(warning.risk.level, "dangerous");
  const confirmed = await fetch(`${origin}/api/hosts/${host.id}/commands`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "npm install -g pnpm", workingDirectory: host.workspace, confirmed: true }),
  });
  const queued = await confirmed.json();
  assert.equal(confirmed.status, 202, queued.error); assert.equal(queued.job.type, "host-command");
  assert.equal(queued.job.steps[0].label, "Run remote command");
});

test("queues runtime management Jobs and updates project toolchains", async () => {
  const enrollmentResponse = await fetch(`${origin}/api/enrollments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ alias: "runtime-win", os: "windows", workspace: "C:\\Builds" }) });
  const enrollment = await enrollmentResponse.json();
  const enrolledResponse = await fetch(`${origin}/api/enroll/${enrollment.enrollment.token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostname: "RUNTIME-WIN", os: "windows", agentVersion: "0.11.0" }) });
  const enrolled = await enrolledResponse.json();
  assert.equal(enrolledResponse.status, 201, enrolled.error);
  const runtimeResponse = await fetch(`${origin}/api/hosts/${enrolled.host.id}/runtimes`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "install", tool: "java", version: "temurin-21" }),
  });
  const runtime = await runtimeResponse.json();
  assert.equal(runtimeResponse.status, 202, runtime.error);
  assert.equal(runtime.job.type, "runtime"); assert.deepEqual(runtime.job.runtime, { tool: "java", version: "temurin-21" });
  const invalidResponse = await fetch(`${origin}/api/hosts/${enrolled.host.id}/runtimes`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "install", tool: "php", version: "8.4" }),
  });
  assert.equal(invalidResponse.status, 400);
});
