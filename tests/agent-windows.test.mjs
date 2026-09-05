import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

// The Agent is shipped as a single executable file. Exercise its pure helpers
// without starting an enrolled Agent or depending on the test runner's OS.
const source = await readFile(new URL("../agent/agent.mjs", import.meta.url), "utf8");
function helper(name, next, platform = "win32") {
  const code = source.slice(source.indexOf(`function ${name}(`), source.indexOf(`\n${next}`, source.indexOf(`function ${name}(`)));
  return vm.runInNewContext(`(${code.trim()})`, { os: { platform: () => platform }, path });
}
const normalizeWindowsPath = helper("normalizeWindowsPath", "// Capture once");
const shellInvocation = helper("shellInvocation", "async function startDevPreview");

test("Windows preserves mixed-case Path, expands registry paths, and recovers system tools", () => {
  const original = { Path: 'C:\\Windows\\System32;"C:\\Program Files\\Java\\bin"', PATH: "C:\\managed\\node;C:\\WINDOWS\\system32", SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\Tester", KEEP: "yes" };
  const result = normalizeWindowsPath(original, ["%SystemRoot%\\System32;%USERPROFILE%\\tools;%MISSING%\\bin"]);
  assert.deepEqual(Object.keys(result).filter((key) => key.toLowerCase() === "path"), ["PATH"]);
  assert.equal(result.PATH.split(";")[0], "C:\\managed\\node");
  assert.equal(result.PATH.toLowerCase().split(";").filter((value) => value === "c:\\windows\\system32").length, 1);
  assert.ok(result.PATH.includes("C:\\Program Files\\Java\\bin"));
  assert.ok(result.PATH.includes("C:\\Users\\Tester\\tools"));
  assert.ok(result.PATH.includes("C:\\Windows\\System32\\WindowsPowerShell\\v1.0"));
  assert.ok(!result.PATH.includes("%MISSING%"));
  assert.equal(result.KEEP, "yes");
  assert.ok(original.Path);
  assert.ok(normalizeWindowsPath({}).PATH.includes("C:\\Windows\\System32"));
});

test("POSIX shell command text is unchanged", () => {
  const invoke = helper("shellInvocation", "async function startDevPreview", "linux");
  const result = invoke('printf "%s" "two words"', {});
  assert.equal(result.shell, "/bin/sh");
  assert.equal(result.args[1], 'printf "%s" "two words"');
  assert.equal(result.windowsVerbatimArguments, false);
});

test("Windows executes quoted executables, arguments, operators, and batch files", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "machora quoted command "));
  try {
    const script = path.join(directory, "capture args.cjs");
    const batch = path.join(directory, "tool shim.cmd");
    await writeFile(script, "console.log(JSON.stringify(process.argv.slice(2)))");
    await writeFile(batch, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    const env = normalizeWindowsPath({ ...process.env, MACHORA_QUOTE_TEST: "expanded value" });
    const run = (command) => {
      const invocation = shellInvocation(command, env);
      return spawnSync(invocation.shell, invocation.args, { env, encoding: "utf8", windowsVerbatimArguments: invocation.windowsVerbatimArguments, timeout: 10000 });
    };
    for (const executable of [`"${process.execPath}" "${script}"`, `"${batch}"`]) {
      const result = run(`${executable} "two words" "a&b|c" "%MACHORA_QUOTE_TEST%" && echo finished`);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/)[0]), ["two words", "a&b|c", "expanded value"]);
      assert.match(result.stdout, /finished/);
    }
    const evaluated = run('node -e "console.log(1 + 2)"');
    assert.equal(evaluated.stdout.trim(), "3", evaluated.stderr);
    const registry = run('reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"');
    assert.equal(registry.status, 0, registry.stderr);
    assert.equal(run("exit /b 7").status, 7);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
