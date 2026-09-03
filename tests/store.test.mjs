import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addHost, assignProject, claimJobsForHost, completeEnrollment, createEnrollment, defaultConfigDir, heartbeatAgent, listHosts, listJobs, listProjects, queueProjectJob, removeHost, removeProject, triggerProjectAutomations, updateProjectAutomations, updateProjectCommands } from "../lib/store.mjs";

let temporaryDirectory;
before(async () => { temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "machora-test-")); process.env.MACHORA_CONFIG_DIR = temporaryDirectory; });
after(async () => { delete process.env.MACHORA_CONFIG_DIR; await rm(temporaryDirectory, { recursive: true, force: true }); });

test("uses LOCALAPPDATA for the native Windows controller configuration", () => {
  const localAppData = path.join(temporaryDirectory, "LocalAppData");
  assert.equal(defaultConfigDir({ platform: "win32", home: temporaryDirectory, env: { LOCALAPPDATA: localAppData } }), path.join(localAppData, "Machora"));
  assert.equal(defaultConfigDir({ platform: "win32", home: temporaryDirectory, env: {} }), path.join(temporaryDirectory, "AppData", "Local", "Machora"));
});

test("adds, lists, and removes a manual host", async () => {
  const created = await addHost({ alias: "build-mac", address: "192.168.1.50", os: "macos" });
  assert.equal(created.alias, "build-mac"); assert.equal((await listHosts()).length, 1);
  assert.equal(await removeHost("build-mac"), true); assert.equal((await listHosts()).length, 0);
});

test("completes a one-time enrollment", async () => {
  const enrollment = await createEnrollment({ alias: "ubuntu-01", os: "linux", workspace: "~/Builds" });
  const completed = await completeEnrollment(enrollment.token, { hostname: "worker-01", os: "linux", arch: "x86_64", address: "192.168.1.60", capabilities: ["node", "git"] });
  assert.equal(completed.host.status, "online"); assert.equal(completed.host.hostname, "worker-01"); assert.equal(completed.host.workspace, "~/Builds");
  assert.ok(completed.credentials.secret);
  await assert.rejects(() => heartbeatAgent(completed.credentials.agentId, "wrong-secret", {}, "192.168.1.60"), /Invalid agent credentials/);
  const heartbeat = await heartbeatAgent(completed.credentials.agentId, completed.credentials.secret, {
    cpu: 23, memory: 48, agentVersion: "0.3.0",
    tools: [{ id: "node", name: "Node.js", version: "22.18.0" }, { id: "javac", name: "JDK", version: "21.0.4" }],
  }, "192.168.1.61");
  assert.equal(heartbeat.cpu, 23); assert.equal(heartbeat.memory, 48); assert.equal(heartbeat.address, "192.168.1.61");
  assert.deepEqual(heartbeat.tools, [{ id: "node", name: "Node.js", version: "22.18.0" }, { id: "javac", name: "JDK", version: "21.0.4" }]);
  await assert.rejects(() => completeEnrollment(enrollment.token, {}), /already used/);
});

test("upgrades a legacy host to an Agent without creating a duplicate", async () => {
  const legacy = await addHost({ alias: "legacy-mac", address: "192.168.1.7", os: "macos", workspace: "~/Code" });
  const enrollment = await createEnrollment({ alias: "legacy-mac", os: "macos", workspace: "~/Projects" });
  const completed = await completeEnrollment(enrollment.token, { hostname: "legacy-mac.local", os: "macos", agentVersion: "0.3.0" });
  const matches = (await listHosts()).filter((host) => host.alias === "legacy-mac");
  assert.equal(matches.length, 1); assert.equal(completed.host.id, legacy.id); assert.equal(completed.host.workspace, "~/Projects");
});

test("assigns a project to a host and preserves it as unassigned when the host is removed", async () => {
  const host = await addHost({ alias: "project-mac", address: "192.168.1.7", os: "macos", workspace: "/Users/builder/Code" });
  const assigned = await assignProject({
    name: "randomaddress-web", localPath: "/Users/developer/Code/randomaddress-web", branch: "main", commit: "abc123",
    gitRemote: "git@example.com:team/randomaddress-web.git", dirty: true, changedFiles: 3, projectType: "Next.js", packageManager: "pnpm",
    devPort: 3000, frameworks: ["Next.js", "TypeScript"], languages: ["TypeScript"], commands: { install: "pnpm install", test: "pnpm test", build: "pnpm build" },
  }, "192.168.1.7");
  assert.equal(assigned.host.id, host.id); assert.equal(assigned.remotePath, "/Users/builder/Code/randomaddress-web");
  assert.equal((await listProjects())[0].changedFiles, 3); assert.deepEqual(assigned.frameworks, ["Next.js", "TypeScript"]);
  const updated = await updateProjectCommands(assigned.id, { build: "pnpm run check" });
  assert.equal(updated.commands.build, "pnpm run check");
  assert.equal(updated.devPort, 3000); assert.equal(updated.devPortSource, "detected");
  const customPort = await updateProjectCommands(assigned.id, {}, { devPort: 4310, devPortSource: "custom" });
  assert.equal(customPort.devPort, 4310); assert.equal(customPort.devPortSource, "custom");
  const reassigned = await assignProject({ ...assigned, devPort: 3100 }, host.id);
  assert.equal(reassigned.devPort, 4310); assert.equal(reassigned.detectedDevPort, 3100);
  const automaticPort = await updateProjectCommands(assigned.id, {}, { devPortSource: "detected" });
  assert.equal(automaticPort.devPort, 3100); assert.equal(automaticPort.devPortSource, "detected");
  await assert.rejects(() => updateProjectCommands(assigned.id, {}, { devPort: 70000, devPortSource: "custom" }), /1 to 65535/);
  const syncJob = await queueProjectJob(assigned.id, "sync");
  assert.equal(syncJob.status, "queued"); assert.equal((await listJobs()).length, 1);
  assert.equal((await listHosts()).find((item) => item.id === host.id).jobCounts.active, 1);
  assert.equal((await listProjects())[0].jobCounts.active, 1);
  await removeHost(host.id);
  const unassigned = (await listProjects())[0];
  assert.equal(unassigned.status, "unassigned"); assert.equal(unassigned.host, null);
  assert.equal((await listJobs())[0].status, "cancelled");
  assert.equal(await removeProject(unassigned.id), true);
});

test("maps Git push events to user-selected operations and waits for Agent 0.7", async () => {
  const enrollment = await createEnrollment({ alias: "automation-mac", os: "macos", workspace: "/Users/builder/Code" });
  const completed = await completeEnrollment(enrollment.token, { hostname: "automation-mac.local", os: "macos", agentVersion: "0.6.1" });
  const project = await assignProject({
    name: "automation-web", localPath: "/Users/developer/Code/automation-web", branch: "main", commit: "abc123",
    gitRemote: "git@example.com:team/automation-web.git", projectType: "Next.js", packageManager: "pnpm",
    commands: { install: "pnpm install", test: "pnpm test", build: "pnpm build" },
  }, completed.host.id);
  const configured = await updateProjectAutomations(project.id, [
    { id: "main-build", event: "branch-push", pattern: "main", operation: "build", enabled: true },
    { id: "release-test", event: "tag-push", pattern: "v*", operation: "test", enabled: true },
  ]);
  assert.deepEqual(configured.automations.rules.map(({ event, pattern, operation }) => ({ event, pattern, operation })), [
    { event: "branch-push", pattern: "main", operation: "build" },
    { event: "tag-push", pattern: "v*", operation: "test" },
  ]);

  const sha = "a".repeat(40);
  const first = await triggerProjectAutomations(project.id, { event: "branch-push", ref: "refs/heads/main", sha, remote: "origin" });
  assert.equal(first.length, 1); assert.equal(first[0].operation, "build"); assert.equal(first[0].trigger.name, "main");
  const duplicate = await triggerProjectAutomations(project.id, { event: "branch-push", ref: "refs/heads/main", sha, remote: "origin" });
  assert.equal(duplicate[0].id, first[0].id);
  assert.deepEqual(await triggerProjectAutomations(project.id, { event: "branch-push", ref: "refs/heads/feature/docs", sha: "b".repeat(40), remote: "origin" }), []);
  assert.deepEqual(await claimJobsForHost(completed.host.id), []);

  await heartbeatAgent(completed.credentials.agentId, completed.credentials.secret, { agentVersion: "0.7.0" }, "192.168.1.77");
  const claimed = await claimJobsForHost(completed.host.id);
  assert.equal(claimed.length, 1); assert.equal(claimed[0].operation, "build"); assert.equal(claimed[0].trigger.sha, sha);
  await removeHost(completed.host.id);
  assert.equal(await removeProject(project.id), true);
});
