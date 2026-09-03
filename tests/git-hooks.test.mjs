import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { confirmGitPush, dispatchGitPushConfirmation, installProjectGitHook, parsePrePushInput, projectGitHookStatus, uninstallProjectGitHook } from "../lib/git-hooks.mjs";
import { assignProject, completeEnrollment, createEnrollment, listJobs, updateProjectAutomations } from "../lib/store.mjs";

const execFileAsync = promisify(execFile);
let temporaryDirectory;

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "machora-hooks-test-"));
  process.env.MACHORA_CONFIG_DIR = path.join(temporaryDirectory, "controller");
});

after(async () => {
  delete process.env.MACHORA_CONFIG_DIR;
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("installs a managed pre-push hook, preserves an existing hook, and confirms remote refs", async () => {
  const repository = path.join(temporaryDirectory, "project");
  const remote = path.join(temporaryDirectory, "project.git");
  await mkdir(repository);
  await execFileAsync("git", ["init", "-b", "main", repository]);
  await execFileAsync("git", ["-C", repository, "config", "user.email", "machora@example.test"]);
  await execFileAsync("git", ["-C", repository, "config", "user.name", "machora test"]);
  await writeFile(path.join(repository, "README.md"), "hook test\n");
  await execFileAsync("git", ["-C", repository, "add", "README.md"]);
  await execFileAsync("git", ["-C", repository, "commit", "-m", "initial"]);
  await execFileAsync("git", ["clone", "--bare", repository, remote]);
  await execFileAsync("git", ["-C", repository, "remote", "add", "origin", remote]);

  const enrollment = await createEnrollment({ alias: "hook-mac", os: "macos", workspace: path.join(temporaryDirectory, "workspace") });
  const completed = await completeEnrollment(enrollment.token, { hostname: "hook-mac.local", os: "macos", agentVersion: "0.7.0" });
  const sha = (await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
  const project = await assignProject({
    name: "project", localPath: repository, gitRemote: remote, branch: "main", commit: sha,
    projectType: "Node.js", packageManager: "npm", commands: { build: "npm run build" },
  }, completed.host.id);
  await updateProjectAutomations(project.id, [{ id: "main-build", event: "branch-push", pattern: "main", operation: "build", enabled: true }]);

  const hooksDirectory = path.join(repository, ".git", "hooks");
  const hookPath = path.join(hooksDirectory, "pre-push");
  await writeFile(hookPath, "#!/bin/sh\necho existing-hook\n");
  await chmod(hookPath, 0o700);
  const installed = await installProjectGitHook(project);
  const source = await readFile(hookPath, "utf8");
  assert.equal(installed.hook.status, "installed"); assert.equal(installed.hook.originalPreserved, true);
  assert.match(source, /machora managed pre-push hook/);
  assert.match(source, /hook dispatch-push/);
  assert.match(source, /MACHORA_HOOK_DIR/);
  assert.doesNotMatch(source, /\bnohup\b/);
  assert.equal(await readFile(path.join(hooksDirectory, "pre-push.machora-original"), "utf8"), "#!/bin/sh\necho existing-hook\n");
  assert.ok(((await stat(hookPath)).mode & 0o100) !== 0);
  const syntax = spawnSync("sh", ["-n", hookPath], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);

  const inputPath = path.join(temporaryDirectory, "pre-push-input.txt");
  await writeFile(inputPath, `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`);
  const confirmed = await confirmGitPush({ projectId: project.id, repository, remote: "origin", inputPath, timeoutMs: 1000 });
  assert.equal(confirmed.confirmed, 1); assert.equal(confirmed.jobs.length, 1);
  assert.equal(confirmed.jobs[0].trigger.remote, "origin"); assert.equal(confirmed.jobs[0].trigger.sha, sha);

  await writeFile(path.join(repository, "README.md"), "hook test\nactual push\n");
  await execFileAsync("git", ["-C", repository, "add", "README.md"]);
  await execFileAsync("git", ["-C", repository, "commit", "-m", "exercise managed hook"]);
  const pushedSha = (await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
  await execFileAsync("git", ["-C", repository, "push", "origin", "main"]);
  let dispatchedJob;
  for (let attempt = 0; attempt < 30 && !dispatchedJob; attempt += 1) {
    dispatchedJob = (await listJobs()).find((job) => job.trigger?.sha === pushedSha);
    if (!dispatchedJob) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(dispatchedJob, "the managed hook should confirm the real push and queue its Job");

  const status = await projectGitHookStatus(project);
  assert.equal(status.status, "installed");
  const removed = await uninstallProjectGitHook(project);
  assert.equal(removed.restoredOriginal, true);
  assert.equal(await readFile(hookPath, "utf8"), "#!/bin/sh\necho existing-hook\n");
});

test("dispatches push confirmation as a detached cross-platform Node process", async () => {
  const inputPath = path.join(temporaryDirectory, "dispatch-input.txt");
  const logPath = path.join(temporaryDirectory, "hooks", "dispatch.log");
  await writeFile(inputPath, "push input\n");
  const calls = [];
  const child = { pid: 1234, on() {}, unrefCalled: false, unref() { this.unrefCalled = true; } };
  const result = await dispatchGitPushConfirmation({
    projectId: "project-id", repository: "C:\\Code\\project", remote: "origin",
    inputPath, logPath, node: "C:\\Program Files\\nodejs\\node.exe", cli: "C:\\Machora\\machora.mjs",
    configDirectory: "C:\\Machora", spawnImpl: (...args) => { calls.push(args); return child; },
  });
  assert.equal(result.pid, 1234);
  assert.equal(child.unrefCalled, true);
  assert.equal(calls[0][0], "C:\\Program Files\\nodejs\\node.exe");
  assert.ok(calls[0][1].includes("confirm-push"));
  assert.equal(calls[0][2].detached, true);
  assert.equal(calls[0][2].windowsHide, true);
  assert.equal(calls[0][2].env.MACHORA_CONFIG_DIR, "C:\\Machora");
});

test("parses branch and tag updates while ignoring deletes and unsupported refs", () => {
  const branchSha = "a".repeat(40); const tagSha = "b".repeat(40); const zero = "0".repeat(40);
  const events = parsePrePushInput([
    `refs/heads/main ${branchSha} refs/heads/main ${zero}`,
    `refs/tags/v1.2.3 ${tagSha} refs/tags/v1.2.3 ${zero}`,
    `delete ${zero} refs/tags/v1.0.0 ${tagSha}`,
    `refs/notes/test ${branchSha} refs/notes/test ${zero}`,
  ].join("\n"));
  assert.deepEqual(events.map(({ event, ref, sha }) => ({ event, ref, sha })), [
    { event: "branch-push", ref: "refs/heads/main", sha: branchSha },
    { event: "tag-push", ref: "refs/tags/v1.2.3", sha: tagSha },
  ]);
});

test("upgrades a managed legacy rdev hook without nesting it as a user hook", async () => {
  const repository = path.join(temporaryDirectory, "legacy-project");
  await mkdir(repository);
  await execFileAsync("git", ["init", "-b", "main", repository]);
  const enrollment = await createEnrollment({ alias: "legacy-hook-mac", os: "macos", workspace: path.join(temporaryDirectory, "legacy-workspace") });
  const completed = await completeEnrollment(enrollment.token, { hostname: "legacy.local", os: "macos", agentVersion: "0.7.0" });
  const project = await assignProject({
    name: "legacy-project", localPath: repository, gitRemote: "https://example.test/legacy.git", branch: "main",
    projectType: "Node.js", packageManager: "npm", commands: {},
  }, completed.host.id);
  const hooksDirectory = path.join(repository, ".git", "hooks");
  await writeFile(path.join(hooksDirectory, "pre-push"), "#!/bin/sh\n# rdev managed pre-push hook\nexit 0\n");
  await writeFile(path.join(hooksDirectory, "pre-push.rdev-original"), "#!/bin/sh\necho user-hook\n");
  await installProjectGitHook(project);
  assert.match(await readFile(path.join(hooksDirectory, "pre-push"), "utf8"), /machora managed pre-push hook/);
  assert.equal(await readFile(path.join(hooksDirectory, "pre-push.machora-original"), "utf8"), "#!/bin/sh\necho user-hook\n");
});
