import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { controllerServiceStatus, installControllerService } from "../lib/controller-service.mjs";

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
  const lint = spawnSync("plutil", ["-lint", installed.plistPath], { encoding: "utf8" });
  assert.equal(lint.status, 0, lint.stderr || lint.stdout);
  assert.ok(calls.some((call) => call[1] === "bootstrap")); assert.ok(calls.some((call) => call[1] === "kickstart"));
  const status = await controllerServiceStatus({ platform: "darwin", home, uid: 501, execute });
  assert.equal(status.installed, true); assert.equal(status.running, true);
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
