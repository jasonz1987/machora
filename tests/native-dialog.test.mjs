import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseProjectDirectory } from "../lib/native-dialog.mjs";

test("uses the macOS native folder picker and normalizes its path", async () => {
  let invocation;
  const selected = await chooseProjectDirectory({
    platform: "darwin",
    run: async (file, args) => { invocation = { file, args }; return { stdout: "/Users/developer/Code/randomaddress-web/\n" }; },
  });
  assert.equal(invocation.file, "osascript"); assert.ok(invocation.args.includes("POSIX path of chosenFolder"));
  assert.equal(selected, "/Users/developer/Code/randomaddress-web");
});

test("treats closing the macOS picker as cancellation", async () => {
  const cancellation = Object.assign(new Error("execution error: User canceled. (-128)"), { code: 1, stderr: "User canceled. (-128)" });
  const selected = await chooseProjectDirectory({ platform: "darwin", run: async () => { throw cancellation; } });
  assert.equal(selected, null);
});

test("uses an STA PowerShell folder browser on Windows", async () => {
  let invocation;
  const selected = await chooseProjectDirectory({
    platform: "win32",
    run: async (file, args) => { invocation = { file, args }; return { stdout: "C:\\Code\\web" }; },
  });
  assert.equal(invocation.file, "powershell.exe"); assert.ok(invocation.args.includes("-STA"));
  assert.equal(selected, "C:\\Code\\web");
});

test("uses an available Linux folder picker", async () => {
  let invocation;
  const selected = await chooseProjectDirectory({
    platform: "linux",
    findCommand: (name) => name === "zenity" ? "/usr/bin/zenity" : "",
    run: async (file, args) => { invocation = { file, args }; return { stdout: "/srv/code/app\n" }; },
  });
  assert.equal(invocation.file, "/usr/bin/zenity"); assert.ok(invocation.args.includes("--directory")); assert.equal(selected, "/srv/code/app");
});

test("reports an unsupported controller without a native picker", async () => {
  await assert.rejects(() => chooseProjectDirectory({ platform: "freebsd", run: async () => ({ stdout: "" }) }), (error) => error.statusCode === 501);
});
