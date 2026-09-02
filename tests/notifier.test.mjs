import assert from "node:assert/strict";
import { test } from "node:test";
import { jobDetailUrl, notifyJobCompletion } from "../lib/notifier.mjs";

const job = {
  id: "job-123",
  type: "command",
  operation: "dev",
  status: "succeeded",
  project: { name: "website" },
  host: { alias: "mac" },
  result: { previewUrl: "http://192.168.1.7:3000" },
};

test("builds a dashboard deep link for a Job detail", () => {
  assert.equal(
    jobDetailUrl("http://192.168.1.42:4178", job.id),
    "http://192.168.1.42:4178/?view=jobs&job=job-123",
  );
});

test("uses an actionable macOS notification when terminal-notifier is available", async () => {
  const calls = [];
  const notified = await notifyJobCompletion(job, {
    platform: "darwin",
    dashboardOrigin: "http://192.168.1.42:4178",
    terminalNotifierPath: "/usr/local/bin/terminal-notifier",
    launch: (command, argumentsList) => calls.push({ command, argumentsList }),
  });

  assert.equal(notified, true);
  assert.equal(calls[0].command, "/usr/local/bin/terminal-notifier");
  assert.deepEqual(calls[0].argumentsList.slice(0, 4), ["-title", "Machora · website", "-message", "dev completed · preview ready"]);
  const openIndex = calls[0].argumentsList.indexOf("-open");
  assert.equal(calls[0].argumentsList[openIndex + 1], "http://192.168.1.42:4178/?view=jobs&job=job-123");
});

test("does not send a misleading Script Editor notification for a linked macOS Job", async () => {
  const calls = [];
  const notified = await notifyJobCompletion(job, {
    platform: "darwin",
    dashboardOrigin: "http://192.168.1.42:4178",
    pathValue: "",
    launch: (command, argumentsList) => calls.push({ command, argumentsList }),
  });

  assert.equal(notified, false);
  assert.deepEqual(calls, []);
});
