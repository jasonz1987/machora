import assert from "node:assert/strict";
import { test } from "node:test";
import { findLanAddress, startServer } from "../server/server.mjs";

test("prefers routable private LAN addresses over link-local interfaces", () => {
  const address = findLanAddress({
    en5: [{ family: "IPv4", internal: false, address: "169.254.207.43" }],
    feth0: [{ family: "IPv4", internal: false, address: "172.22.0.3" }],
    en0: [{ family: "IPv4", internal: false, address: "192.168.1.42" }],
  });
  assert.equal(address, "192.168.1.42");
});

test("keeps Agent heartbeat connections alive across polling intervals", async () => {
  const started = await startServer({ port: 0, host: "127.0.0.1", advertise: "http://127.0.0.1" });
  try {
    assert.equal(started.server.keepAliveTimeout, 30_000);
    assert.equal(started.server.headersTimeout, 35_000);
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
  }
});
