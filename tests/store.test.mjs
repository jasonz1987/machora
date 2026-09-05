import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acceptAgentJobResults, addDeploymentTargetRecord, addHost, assignProject, claimJobsForHost, completeEnrollment, createEnrollment, defaultConfigDir, heartbeatAgent, listDeploymentTargets, listHosts, listJobs, listProjects, publicHost, queueAgentUpdate, queueDeploymentAccessJob, queueProjectJob, queueRuntimeJob, removeDeploymentTargetRecord, removeHost, removeProject, triggerProjectAutomations, updateDeploymentAuthorization, updateProjectAutomations, updateProjectCommands, updateProjectToolchain } from "../lib/store.mjs";

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

test("marks delayed Agent heartbeats as degraded before the 90 second offline threshold", () => {
  const base = { id: "health-test", alias: "health-test", agentVersion: "0.11.3", agentSecretHash: "hidden" };
  const healthy = publicHost({ ...base, lastSeenAt: new Date(Date.now() - 10_000).toISOString() });
  const degraded = publicHost({ ...base, lastSeenAt: new Date(Date.now() - 50_000).toISOString() });
  const offline = publicHost({ ...base, lastSeenAt: new Date(Date.now() - 100_000).toISOString() });
  assert.equal(healthy.status, "online"); assert.match(healthy.statusReason, /Heartbeat .* ago/);
  assert.equal(degraded.status, "degraded"); assert.match(degraded.statusReason, /delayed/);
  assert.equal(offline.status, "offline"); assert.match(offline.statusReason, /No heartbeat/);
  assert.equal("agentSecretHash" in offline, false);
});

test("upgrades a legacy host to an Agent without creating a duplicate", async () => {
  const legacy = await addHost({ alias: "legacy-mac", address: "192.168.1.7", os: "macos", workspace: "~/Code" });
  const enrollment = await createEnrollment({ alias: "legacy-mac", os: "macos", workspace: "~/Projects" });
  const completed = await completeEnrollment(enrollment.token, { hostname: "legacy-mac.local", os: "macos", agentVersion: "0.3.0" });
  const matches = (await listHosts()).filter((host) => host.alias === "legacy-mac");
  assert.equal(matches.length, 1); assert.equal(completed.host.id, legacy.id); assert.equal(completed.host.workspace, "~/Projects");
});

test("queues backward-compatible Agent updates as host command Jobs", async () => {
  const enrollment = await createEnrollment({ alias: "old-windows-agent", os: "windows", workspace: "C:\\Builds" });
  const enrolled = await completeEnrollment(enrollment.token, { hostname: "OLD-WINDOWS", os: "windows", agentVersion: "0.8.1" });
  const job = await queueAgentUpdate(enrolled.host.id, {
    targetVersion: "0.10.0",
    command: '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "update"',
  });
  assert.equal(job.type, "host-command");
  assert.equal(job.operation, "agent-update");
  assert.equal(job.targetAgentVersion, "0.10.0");
  assert.equal(job.steps[0].label, "Schedule Agent update");
  const claimed = await claimJobsForHost(enrolled.host.id);
  assert.equal(claimed[0].type, "host-command");
  assert.equal(claimed[0].operation, "agent-update");
  const duplicate = await queueAgentUpdate(enrolled.host.id, { targetVersion: "0.10.0", command: "ignored" });
  assert.equal(duplicate.id, job.id);
  await heartbeatAgent(enrolled.host.id, enrolled.credentials.secret, { agentVersion: "0.8.1" }, "192.168.1.20");
  assert.equal((await claimJobsForHost(enrolled.host.id))[0].id, job.id);
  await heartbeatAgent(enrolled.host.id, enrolled.credentials.secret, { agentVersion: "0.10.0" }, "192.168.1.20");
  assert.deepEqual(await claimJobsForHost(enrolled.host.id), []);
  const activated = (await listJobs()).find((item) => item.id === job.id);
  assert.equal(activated.status, "succeeded");
  assert.match(activated.output, /authenticated heartbeat/);
});

test("stores runtime inventory, queues runtime Jobs, and pins project toolchains", async () => {
  const enrollment = await createEnrollment({ alias: "runtime-linux", os: "linux", workspace: "/srv/builds" });
  const enrolled = await completeEnrollment(enrollment.token, {
    hostname: "runtime-linux", os: "linux", agentVersion: "0.11.0",
    runtimeManager: { provider: "mise", status: "not-installed", managedRoot: "/home/worker/.machora-agent/runtimes" }, runtimes: [],
  });
  const query = await queueRuntimeJob(enrolled.host.id, { operation: "query", tool: "node" });
  assert.equal(query.type, "runtime"); assert.equal(query.runtime.tool, "node"); assert.match(query.steps[0].label, /Query node/);
  const claimed = await claimJobsForHost(enrolled.host.id);
  assert.equal(claimed[0].type, "runtime"); assert.deepEqual(claimed[0].runtime, { tool: "node", version: null });
  await acceptAgentJobResults(enrolled.credentials.agentId, enrolled.credentials.secret, [{
    id: query.id, ok: true, result: {
      tool: "node", versions: ["20.19.0", "22.18.0"],
      runtimeManager: { provider: "mise", status: "ready", version: "2026.9.1", managedRoot: "/home/worker/.machora-agent/runtimes" },
      runtimes: [{ tool: "node", version: "22.18.0", installed: true, provider: "mise" }],
    },
  }]);
  const host = (await listHosts()).find((item) => item.id === enrolled.host.id);
  assert.equal(host.runtimeManager.status, "ready"); assert.equal(host.runtimes[0].version, "22.18.0");
  assert.deepEqual(host.runtimeCatalog.node.versions, ["22.18.0", "20.19.0"]);
  const project = await assignProject({ name: "runtime-app", localPath: "/tmp/runtime-app", branch: "main", gitRemote: "git@example.test:runtime-app.git", commands: {} }, host.id);
  const updated = await updateProjectToolchain(project.id, { node: "22.18.0", python: "3.13.7" });
  assert.deepEqual(updated.toolchain, { node: "22.18.0", java: null, python: "3.13.7" });
  await removeHost(host.id); await removeProject(project.id);
});

test("stores deployment targets safely and queues per-machine authorization Jobs", async () => {
  const enrollment = await createEnrollment({ alias: "deploy-worker", os: "linux", workspace: "/srv/builds" });
  const enrolled = await completeEnrollment(enrollment.token, { hostname: "deploy-worker", os: "linux", agentVersion: "0.10.0" });
  const target = await addDeploymentTargetRecord({
    id: "target-test", name: "production-api", provider: "ssh", status: "ready",
    config: { host: "203.0.113.10", port: 2222, username: "deploy" },
    hostKey: { algorithm: "ssh-ed25519", fingerprint: "SHA256:server" },
    controllerCredential: { privateKeyPath: "/private/controller-key", fingerprint: "SHA256:controller", marker: "machora:controller:target-test" },
    authorizations: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  assert.equal(target.controllerFingerprint, "SHA256:controller");
  assert.equal(Object.hasOwn(target, "controllerCredential"), false);
  const job = await queueDeploymentAccessJob(target.id, enrolled.host.id, "prepare");
  assert.equal(job.type, "deployment-access"); assert.equal(job.deploymentTarget.name, "production-api");
  const updated = await updateDeploymentAuthorization(target.id, enrolled.host.id, { status: "preparing", publicKey: "secret-public-key", fingerprint: "SHA256:worker" });
  assert.equal(updated.authorizations[0].status, "preparing");
  assert.equal(updated.authorizations[0].publicKey, undefined);
  assert.equal((await listDeploymentTargets())[0].authorizedHostCount, 0);
  assert.equal(await removeDeploymentTargetRecord(target.id), true);
  await removeHost(enrolled.host.id);
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
  assert.equal(syncJob.status, "queued"); assert.equal((await listJobs()).find((job) => job.id === syncJob.id)?.status, "queued");
  assert.equal((await listHosts()).find((item) => item.id === host.id).jobCounts.active, 1);
  assert.equal((await listProjects())[0].jobCounts.active, 1);
  await removeHost(host.id);
  const unassigned = (await listProjects())[0];
  assert.equal(unassigned.status, "unassigned"); assert.equal(unassigned.host, null);
  assert.equal((await listJobs()).find((job) => job.id === syncJob.id)?.status, "cancelled");
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
