import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { startServer } from "../server/server.mjs";
import { confirmGitPush } from "../lib/git-hooks.mjs";

const execFileAsync = promisify(execFile);
let temporaryDirectory; let controllerDirectory; let agentDirectory; let workspace; let server; let origin;

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "machora-agent-test-"));
  controllerDirectory = path.join(temporaryDirectory, "controller");
  agentDirectory = path.join(temporaryDirectory, "agent");
  workspace = path.join(temporaryDirectory, "workspace");
  process.env.MACHORA_CONFIG_DIR = controllerDirectory;
  process.env.MACHORA_DISABLE_NOTIFICATIONS = "1";
  const started = await startServer({ port: 0, host: "127.0.0.1" });
  server = started.server; origin = `http://127.0.0.1:${started.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.MACHORA_CONFIG_DIR;
  delete process.env.MACHORA_DISABLE_NOTIFICATIONS;
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("Agent enrolls, creates its workspace, saves credentials, and heartbeats", async () => {
  const enrollmentResponse = await fetch(`${origin}/api/enrollments`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ alias: "agent-e2e", os: "linux", workspace }),
  });
  const enrollment = await enrollmentResponse.json();
  assert.equal(enrollmentResponse.status, 201);
  const loginBin = path.join(temporaryDirectory, "login-bin");
  const loginShell = path.join(temporaryDirectory, "login-shell");
  const fakePnpmArguments = path.join(temporaryDirectory, "fake-pnpm-arguments.txt");
  await mkdir(loginBin);
  await writeFile(path.join(loginBin, "pnpm"), "#!/bin/sh\nif [ \"${1:-}\" = \"--version\" ]; then echo 10.23.0; exit 0; fi\nif [ \"${1:-}\" = \"run\" ] && [ \"${2:-}\" = \"dev\" ]; then printf '%s\\n' \"$@\" > \"$MACHORA_FAKE_PNPM_ARGUMENTS\"; sleep 15; exit 0; fi\necho \"unexpected fake pnpm invocation: $*\" >&2\nexit 2\n");
  await writeFile(loginShell, "#!/bin/sh\nprintf '\\0__MACHORA_LOGIN_ENV_8E4C2029__\\0'\nprintf 'PATH=%s:%s\\0' \"$MACHORA_AGENT_LOGIN_PATH\" \"$PATH\"\n");
  await chmod(path.join(loginBin, "pnpm"), 0o700); await chmod(loginShell, 0o700);
  const environment = { ...process.env, MACHORA_AGENT_DIR: agentDirectory, MACHORA_AGENT_LOGIN_PATH: loginBin, MACHORA_FAKE_PNPM_ARGUMENTS: fakePnpmArguments, SHELL: loginShell };
  const agentFile = path.resolve("agent/agent.mjs");
  await execFileAsync(process.execPath, [agentFile, "enroll", "--controller", origin, "--token", enrollment.enrollment.token], { env: environment });
  await stat(workspace);
  const config = JSON.parse(await readFile(path.join(agentDirectory, "config.json"), "utf8"));
  assert.equal(config.alias, "agent-e2e"); assert.ok(config.secret);
  await execFileAsync(process.execPath, [agentFile, "run", "--once"], { env: environment });
  const hosts = await fetch(`${origin}/api/hosts`).then((response) => response.json());
  const host = hosts.hosts.find((item) => item.alias === "agent-e2e");
  assert.equal(host.status, "online"); assert.equal(host.workspace, workspace); assert.ok(host.capabilities.includes("node")); assert.equal(host.agentVersion, "0.8.1");
  const node = host.tools.find((tool) => tool.id === "node");
  assert.equal(node.name, "Node.js"); assert.match(node.version, /^\d+\.\d+\.\d+/);
  assert.equal(host.tools.find((tool) => tool.id === "pnpm")?.version, "10.23.0");

  const source = path.join(temporaryDirectory, "source-project");
  const remote = path.join(temporaryDirectory, "source-project.git");
  await mkdir(source);
  await execFileAsync("git", ["init", "-b", "main", source]);
  await execFileAsync("git", ["-C", source, "config", "user.email", "machora@example.test"]);
  await execFileAsync("git", ["-C", source, "config", "user.name", "machora test"]);
  await writeFile(path.join(source, "README.md"), "remote checkout\n");
  await writeFile(path.join(source, "package.json"), JSON.stringify({ scripts: { dev: "next dev" }, dependencies: { next: "16.0.0" } }));
  await execFileAsync("git", ["-C", source, "add", "README.md", "package.json"]);
  await execFileAsync("git", ["-C", source, "commit", "-m", "initial"]);
  await execFileAsync("git", ["clone", "--bare", source, remote]);
  await execFileAsync("git", ["-C", source, "remote", "add", "origin", remote]);
  const projectResponse = await fetch(`${origin}/api/projects`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ localPath: source, host: host.id }),
  });
  const assigned = await projectResponse.json();
  assert.equal(projectResponse.status, 201, assigned.error); assert.equal(assigned.job.status, "queued");
  await execFileAsync(process.execPath, [agentFile, "run", "--once"], { env: environment, timeout: 30_000 });
  assert.equal(await readFile(path.join(workspace, "source-project", "README.md"), "utf8"), "remote checkout\n");
  const projects = await fetch(`${origin}/api/projects`).then((response) => response.json());
  assert.equal(projects.projects[0].remoteStatus, "ready"); assert.equal(projects.projects[0].remoteAction, "clone");
  assert.match(projects.projects[0].remoteCommit, /^[0-9a-f]{12}$/);

  await writeFile(path.join(source, "README.md"), "remote checkout updated\n");
  await execFileAsync("git", ["-C", source, "add", "README.md"]);
  await execFileAsync("git", ["-C", source, "commit", "-m", "update"]);
  await execFileAsync("git", ["-C", source, "push", "origin", "main"]);
  const syncResponse = await fetch(`${origin}/api/projects/${assigned.project.id}/sync`, { method: "POST" });
  assert.equal(syncResponse.status, 202);
  await execFileAsync(process.execPath, [agentFile, "run", "--once"], { env: environment, timeout: 30_000 });
  assert.equal(await readFile(path.join(workspace, "source-project", "README.md"), "utf8"), "remote checkout updated\n");
  const pulled = await fetch(`${origin}/api/projects`).then((response) => response.json());
  assert.equal(pulled.projects[0].remoteAction, "pull");

  const commandsResponse = await fetch(`${origin}/api/projects/${assigned.project.id}/commands`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ commands: { install: "node -e \"require('fs').writeFileSync('dependencies-ready.txt','ok')\"", test: "node -e \"require('fs').writeFileSync('remote-test.txt','ok')\"" } }),
  });
  assert.equal(commandsResponse.status, 200);
  const runResponse = await fetch(`${origin}/api/projects/${assigned.project.id}/run`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "test" }),
  });
  const queuedCommand = await runResponse.json();
  assert.equal(runResponse.status, 202, queuedCommand.error);
  await execFileAsync(process.execPath, [agentFile, "run", "--once"], { env: environment, timeout: 30_000 });
  assert.equal(await readFile(path.join(workspace, "source-project", "dependencies-ready.txt"), "utf8"), "ok");
  assert.equal(await readFile(path.join(workspace, "source-project", "remote-test.txt"), "utf8"), "ok");
  const commandJob = await fetch(`${origin}/api/jobs/${queuedCommand.job.id}`).then((response) => response.json());
  assert.equal(commandJob.job.status, "succeeded"); assert.equal(commandJob.job.result.action, "test");
  assert.deepEqual(commandJob.job.steps.map((step) => step.status), ["succeeded", "succeeded", "succeeded"]);
  const jobs = await fetch(`${origin}/api/jobs`).then((response) => response.json());
  assert.ok(jobs.jobs.length >= 3); assert.equal(jobs.jobs[0].project.name, "source-project");
  const notifications = await fetch(`${origin}/api/notifications`).then((response) => response.json());
  assert.ok(notifications.notifications.some((item) => item.jobId === queuedCommand.job.id && item.kind === "success"));

  const hostCommandResponse = await fetch(`${origin}/api/hosts/${host.id}/commands`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "pnpm --version && node -e \"console.log('live output'); require('fs').writeFileSync('host-command-ready.txt','ok')\"", workingDirectory: workspace }),
  });
  const queuedHostCommand = await hostCommandResponse.json();
  assert.equal(hostCommandResponse.status, 202, queuedHostCommand.error);
  assert.equal(queuedHostCommand.job.project, null); assert.equal(queuedHostCommand.job.type, "host-command");
  await execFileAsync(process.execPath, [agentFile, "run", "--once"], { env: environment, timeout: 30_000 });
  assert.equal(await readFile(path.join(workspace, "host-command-ready.txt"), "utf8"), "ok");
  const hostCommandJob = await fetch(`${origin}/api/jobs/${queuedHostCommand.job.id}`).then((response) => response.json());
  assert.equal(hostCommandJob.job.status, "succeeded"); assert.match(hostCommandJob.job.output, /10\.23\.0/); assert.match(hostCommandJob.job.output, /live output/);
  assert.deepEqual(hostCommandJob.job.steps.map((step) => step.status), ["succeeded"]);
  const updatedNotifications = await fetch(`${origin}/api/notifications`).then((response) => response.json());
  assert.ok(updatedNotifications.notifications.some((item) => item.jobId === queuedHostCommand.job.id && item.title.includes("agent-e2e")));
  await rm(path.join(workspace, "source-project", "dependencies-ready.txt"), { force: true });
  await rm(path.join(workspace, "source-project", "remote-test.txt"), { force: true });

  const devCommandsResponse = await fetch(`${origin}/api/projects/${assigned.project.id}/commands`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ commands: { install: "node -e \"console.log('dependencies ready')\"", dev: "pnpm run dev" } }),
  });
  assert.equal(devCommandsResponse.status, 200);
  const devResponse = await fetch(`${origin}/api/projects/${assigned.project.id}/run`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "dev" }),
  });
  const queuedDev = await devResponse.json();
  assert.equal(devResponse.status, 202, queuedDev.error);
  await execFileAsync(process.execPath, [agentFile, "run", "--once"], { env: environment, timeout: 30_000 });
  const devJob = await fetch(`${origin}/api/jobs/${queuedDev.job.id}`).then((response) => response.json());
  assert.equal(devJob.job.status, "succeeded", devJob.job.output || devJob.job.error);
  assert.match(devJob.job.result.previewUrl, /:3000\/$/);
  assert.deepEqual((await readFile(fakePnpmArguments, "utf8")).trim().split("\n"), ["run", "dev", "--hostname", "0.0.0.0", "--port", "3000"]);

  const taggedSha = (await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  await execFileAsync("git", ["-C", source, "tag", "v1.0.0", taggedSha]);
  await execFileAsync("git", ["-C", source, "push", "origin", "refs/tags/v1.0.0"]);
  const buildCommandsResponse = await fetch(`${origin}/api/projects/${assigned.project.id}/commands`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ commands: { install: "node -e \"console.log('tag dependencies ready')\"", build: "node -e \"require('fs').writeFileSync('tagged-build.txt','v1.0.0')\"" } }),
  });
  assert.equal(buildCommandsResponse.status, 200);
  const automationResponse = await fetch(`${origin}/api/projects/${assigned.project.id}/automations`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ rules: [{ id: "release-build", event: "tag-push", pattern: "v*", operation: "build", enabled: true }] }),
  });
  assert.equal(automationResponse.status, 200);
  const pushInput = path.join(temporaryDirectory, "tag-pre-push.txt");
  await writeFile(pushInput, `refs/tags/v1.0.0 ${taggedSha} refs/tags/v1.0.0 ${"0".repeat(40)}\n`);
  const triggered = await confirmGitPush({ projectId: assigned.project.id, repository: source, remote: "origin", inputPath: pushInput, timeoutMs: 1000 });
  assert.equal(triggered.jobs.length, 1); assert.equal(triggered.jobs[0].operation, "build");
  await execFileAsync(process.execPath, [agentFile, "run", "--once"], { env: environment, timeout: 30_000 });
  assert.equal(await readFile(path.join(workspace, "source-project", "tagged-build.txt"), "utf8"), "v1.0.0");
  const triggeredJob = await fetch(`${origin}/api/jobs/${triggered.jobs[0].id}`).then((response) => response.json());
  assert.equal(triggeredJob.job.status, "succeeded", triggeredJob.job.output || triggeredJob.job.error);
  assert.equal(triggeredJob.job.result.syncAction, "tag-push"); assert.equal(triggeredJob.job.trigger.name, "v1.0.0");
});
