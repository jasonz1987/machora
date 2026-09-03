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
  const completed = await fetch(`${origin}/api/enroll/${created.enrollment.token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ hostname: "WIN-BUILD", os: "windows", arch: "AMD64" }) });
  assert.equal(completed.status, 201);
  const hosts = await fetch(`${origin}/api/hosts`).then((response) => response.json()); assert.equal(hosts.hosts[0].alias, "win-build"); assert.equal(hosts.hosts[0].status, "online");
});

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
  assert.equal(health.agentVersion, "0.9.0");
  assert.match(health.updateCommands.posix, /192\.168\.50\.10:4178\/update\.sh/);
  const response = await fetch(`${origin}/update.sh`);
  const script = await response.text();
  assert.equal(response.status, 200);
  assert.match(script, /kickstart -k/);
  assert.match(script, /systemctl --user restart/);
  const syntax = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const windowsScript = await fetch(`${origin}/update.ps1`).then((updateResponse) => updateResponse.text());
  assert.match(windowsScript, /Agent updated and restarted/);
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
