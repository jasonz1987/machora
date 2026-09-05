import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { assignProject, completeEnrollment, createEnrollment, listJobs, listProjects } from "../lib/store.mjs";

const execFileAsync = promisify(execFile);
let temporaryDirectory; let repository; let environment; let host;

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "machora-cli-runtime-"));
  repository = path.join(temporaryDirectory, "runtime-project");
  process.env.MACHORA_CONFIG_DIR = path.join(temporaryDirectory, "controller");
  environment = { ...process.env, MACHORA_CONFIG_DIR: process.env.MACHORA_CONFIG_DIR };
  const enrollment = await createEnrollment({ alias: "cli-worker", os: "linux", workspace: path.join(temporaryDirectory, "workspace") });
  host = (await completeEnrollment(enrollment.token, {
    hostname: "cli-worker", os: "linux", agentVersion: "0.11.0",
    runtimeManager: { provider: "mise", status: "ready", version: "2026.9.1" },
    runtimes: [{ tool: "node", version: "22.18.0" }],
  })).host;
  await mkdir(repository);
  repository = await realpath(repository);
  await execFileAsync("git", ["init", "-b", "main", repository]);
  await execFileAsync("git", ["-C", repository, "config", "user.email", "machora@example.test"]);
  await execFileAsync("git", ["-C", repository, "config", "user.name", "machora test"]);
  await writeFile(path.join(repository, "package.json"), JSON.stringify({ name: "runtime-project", scripts: { test: "node --test" } }));
  await execFileAsync("git", ["-C", repository, "add", "package.json"]);
  await execFileAsync("git", ["-C", repository, "commit", "-m", "initial"]);
  await execFileAsync("git", ["-C", repository, "remote", "add", "origin", "git@example.test:runtime-project.git"]);
  await assignProject({ name: "runtime-project", localPath: repository, branch: "main", gitRemote: "git@example.test:runtime-project.git", projectType: "Node.js", commands: { test: "node --test" } }, host.id);
});

after(async () => {
  delete process.env.MACHORA_CONFIG_DIR;
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("CLI lists, queues, and assigns isolated runtimes", async () => {
  const cli = path.resolve("bin/machora.mjs");
  const listed = await execFileAsync(process.execPath, [cli, "runtime", "list", host.alias, "--json"], { env: environment });
  const inventory = JSON.parse(listed.stdout);
  assert.equal(inventory.manager.status, "ready"); assert.equal(inventory.runtimes[0].version, "22.18.0");

  const queued = await execFileAsync(process.execPath, [cli, "runtime", "available", host.alias, "python"], { env: environment });
  assert.match(queued.stdout, /Queued python version query/);
  assert.ok((await listJobs()).some((job) => job.type === "runtime" && job.runtime.tool === "python"));

  const configured = await execFileAsync(process.execPath, [cli, "project", "runtime", "set", "node@22.18.0", "python@3.13.7", "--path", repository], { env: environment });
  assert.match(configured.stdout, /node@22\.18\.0/);
  const project = (await listProjects()).find((item) => item.localPath === repository);
  assert.deepEqual(project.toolchain, { node: "22.18.0", java: null, python: "3.13.7" });
});
