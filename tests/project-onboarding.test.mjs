import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { analyzeProjectAssignment } from "../lib/project-onboarding.mjs";
import { monitorInstallation } from "../src/installation-monitor.mjs";

function installationHarness(options = {}) {
  const updates = [];
  const timers = [];
  const stop = monitorInstallation({
    job: { id: "maven-install", status: "queued" },
    onChange: (value) => updates.push(value),
    schedule: (callback) => { timers.push(callback); return callback; },
    cancel: (callback) => { const index = timers.indexOf(callback); if (index >= 0) timers.splice(index, 1); },
    ...options,
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { updates, timers, stop, flush, tick: async () => { await timers.shift()?.(); await flush(); } };
}

test("installation follows its exact Job and verifies delayed environment inventory", async () => {
  const states = ["queued", "dispatched", "running", "succeeded", "succeeded"];
  let checks = 0;
  const monitor = installationHarness({
    readJob: async (id) => { assert.equal(id, "maven-install"); return { id, status: states.shift(), output: "install log" }; },
    recheck: async () => ++checks === 2,
  });
  await monitor.flush();
  await monitor.tick(); await monitor.tick(); await monitor.tick();
  assert.equal(monitor.updates.at(-1).phase, "verifying");
  await monitor.tick();
  assert.equal(monitor.updates.at(-1).phase, "succeeded");
  assert.equal(monitor.updates.at(-1).job.output, "install log");
  assert.equal(monitor.timers.length, 0);
  monitor.stop();
});

test("failed and cancelled installations retain output and stop polling", async () => {
  for (const status of ["failed", "cancelled"]) {
    const monitor = installationHarness({
      readJob: async (id) => ({ id, status, error: "Installer failed", result: { exitCode: 1 }, output: "Download failed" }),
      recheck: async () => assert.fail("Must not verify failed installation"),
    });
    await monitor.flush();
    assert.equal(monitor.updates.at(-1).phase, status);
    assert.equal(monitor.updates.at(-1).job.result.exitCode, 1);
    assert.equal(monitor.timers.length, 0);
    monitor.stop();
  }
});

test("temporary monitoring errors retry without treating the Job as failed", async () => {
  let calls = 0;
  const monitor = installationHarness({
    readJob: async (id) => { if (!calls++) throw new Error("Network unavailable"); return { id, status: "succeeded" }; },
    recheck: async () => true,
  });
  await monitor.flush();
  assert.equal(monitor.updates.at(-1).phase, "reconnecting");
  await monitor.tick();
  assert.equal(monitor.updates.at(-1).phase, "succeeded");
  monitor.stop();
});

test("successful commands that do not provide the required tool are not marked installed", async () => {
  let time = 0;
  const monitor = installationHarness({
    now: () => time,
    readJob: async (id) => ({ id, status: "succeeded" }),
    recheck: async () => false,
  });
  await monitor.flush();
  time = 120000;
  await monitor.tick();
  assert.equal(monitor.updates.at(-1).phase, "unverified");
  assert.equal(monitor.timers.length, 0);
  monitor.stop();
});

test("leaving the panel aborts polling and ignores late results", async () => {
  let resolve;
  let signal;
  const monitor = installationHarness({
    readJob: async (id, requestSignal) => { signal = requestSignal; return new Promise((done) => { resolve = done; }); },
    recheck: async () => assert.fail("Must not recheck after leaving"),
  });
  monitor.stop();
  assert.equal(signal.aborted, true);
  resolve({ id: "maven-install", status: "succeeded" });
  await monitor.flush();
  assert.equal(monitor.updates.length, 1);
  assert.equal(monitor.timers.length, 0);
});

const project = {
  name: "toolkk-api", gitRemote: "git@example.test:team/toolkk-api.git", branch: "main", dirty: false, changedFiles: 0,
  commands: { install: "mvn dependency:go-offline", test: "mvn test", build: "mvn package", dev: "", deploy: "./deploy-main.sh" },
  requirements: [
    { id: "java", kind: "runtime", tool: "java", executable: "javac", label: "JDK", version: "17", source: "pom.xml", required: true },
    { id: "mvn", kind: "command", tool: null, executable: "mvn", label: "Maven", version: null, source: "pom.xml", required: true },
  ],
};

test("blocks assignment when a required project runtime or command is incompatible", () => {
  const result = analyzeProjectAssignment(project, { id: "host-1", alias: "builder", address: "192.168.1.7", os: "macos", workspace: "/Users/builder/Code", status: "online", tools: [{ id: "javac", version: "21.0.8" }], runtimes: [] });
  assert.equal(result.ready, false);
  assert.equal(result.requirements[0].status, "mismatch");
  assert.equal(result.requirements[0].suggestedVersion, "temurin-17");
  assert.equal(result.requirements[1].status, "missing");
  assert.equal(result.requirements[1].commandAction.label, "Install Maven");
  assert.equal(result.requirements[1].commandAction.command, "brew install maven");
  assert.match(result.remotePath, /toolkk-api$/);
});

test("suggests a self-contained Maven installation command for Windows", () => {
  const result = analyzeProjectAssignment(project, { id: "host-1", alias: "windows", address: "192.168.1.105", os: "windows", workspace: "C:\\Users\\Administrator\\Code", status: "online", tools: [], runtimes: [] });
  const action = result.requirements.find((item) => item.id === "mvn").commandAction;
  assert.equal(action.title, "Install Maven");
  assert.equal(action.workingDirectory, "C:\\Users\\Administrator\\Code");
  assert.match(action.command, /\$version='3\.9\.16'/);
  assert.match(action.command, /apache-maven-'\+\$version\+'-bin\.zip/);
  assert.match(action.command, /mvn\.cmd/);
  assert.doesNotMatch(action.command, /\$home\b/i, "PowerShell HOME is read-only, including lowercase aliases");
  assert.match(action.command, /\$mavenInstallDir=Join-Path \$root/);
  assert.match(action.command, /SetEnvironmentVariable\('MAVEN_HOME',\$mavenInstallDir,'User'\)/);
  assert.match(action.command, /\$bin=Join-Path \$mavenInstallDir 'bin'/);
  assert.match(action.command, /\$mavenTempDir=Join-Path \$env:TEMP \('machora-maven-'\+\[Guid\]::NewGuid\(\)/);
  assert.match(action.command, /\$archive=Join-Path \$mavenTempDir/);
  assert.doesNotMatch(action.command, /\$archive=Join-Path \$env:TEMP/);
  assert.match(action.command, /\[IO.FileShare\]::None/);
  assert.match(action.command, /finally \{ \$mavenLock.Dispose\(\)/);
  assert.match(action.command, /Remove-Item -LiteralPath \$mavenTempDir -Recurse/);
  assert.match(action.command, /if \(\$LASTEXITCODE -ne 0\)/);
  assert.match(action.command, /\[char\]34/);
  assert.equal((action.command.match(/"/g) || []).length, 2, "Only outer Command quotes cross cmd.exe");
});

test("uses a matching managed runtime as the project toolchain pin", () => {
  const result = analyzeProjectAssignment(project, { id: "host-1", alias: "builder", address: "192.168.1.7", os: "macos", workspace: "/Users/builder/Code", status: "online", tools: [{ id: "javac", version: "21.0.8" }, { id: "mvn", version: "3.9.9" }], runtimes: [{ tool: "java", version: "temurin-17.0.20+8", installed: true }] });
  assert.equal(result.ready, true);
  assert.equal(result.toolchain.java, "temurin-17.0.20+8");
  assert.equal(result.requirements[0].status, "ready");
});

test("Windows PowerShell parses the generated Maven installer without executing it", { skip: process.platform !== "win32" }, () => {
  const result = analyzeProjectAssignment(project, { id: "host-1", alias: "windows", os: "windows", workspace: "C:\\Code", status: "online", tools: [], runtimes: [] });
  const command = result.requirements.find((item) => item.id === "mvn").commandAction.command;
  const script = command.slice(command.indexOf('-Command "') + 10, -1);
  const encodedScript = Buffer.from(script, "utf8").toString("base64");
  const parser = `$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedScript}')); $tokens=$null; $parseErrors=$null; [Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$parseErrors) | Out-Null; if ($parseErrors.Count) { $parseErrors | Out-String | Write-Output; exit 1 }`;
  const checked = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(parser, "utf16le").toString("base64")], { encoding: "utf8", timeout: 30000, windowsHide: true });
  assert.equal(checked.status, 0, checked.error?.message || checked.stdout || checked.stderr);
});
