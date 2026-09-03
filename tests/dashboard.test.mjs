import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { dashboardUrl, openExternal, waitForDashboard } from "../lib/dashboard.mjs";

let temporaryDirectory;
before(async () => { temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "machora-dashboard-test-")); });
after(async () => { await rm(temporaryDirectory, { recursive: true, force: true }); });

test("resolves the installed controller's loopback dashboard URL", async () => {
  await mkdir(temporaryDirectory, { recursive: true });
  await writeFile(path.join(temporaryDirectory, "controller.json"), JSON.stringify({ port: 4312 }));
  assert.equal(await dashboardUrl(temporaryDirectory), "http://127.0.0.1:4312");
});

test("opens the dashboard with the platform browser command", () => {
  const calls = [];
  const launch = (...argumentsList) => { calls.push(argumentsList); return { unref() {} }; };
  openExternal("http://127.0.0.1:4178", { platform: "darwin", spawn: launch });
  assert.equal(calls[0][0], "open");
  assert.deepEqual(calls[0][1], ["http://127.0.0.1:4178/"]);
});

test("opens the dashboard through the Windows shell without showing a console", () => {
  const calls = [];
  const launch = (...argumentsList) => { calls.push(argumentsList); return { unref() {} }; };
  openExternal("http://127.0.0.1:4178", { platform: "win32", spawn: launch });
  assert.equal(calls[0][0], "cmd");
  assert.deepEqual(calls[0][1], ["/c", "start", "", "http://127.0.0.1:4178/"]);
  assert.equal(calls[0][2].windowsHide, true);
});

test("waits for the controller health endpoint", async () => {
  let calls = 0;
  await waitForDashboard("http://127.0.0.1:4178", {
    attempts: 2,
    intervalMs: 1,
    fetch: async () => { calls += 1; return { ok: calls === 2, status: calls === 1 ? 503 : 200 }; },
  });
  assert.equal(calls, 2);
});
