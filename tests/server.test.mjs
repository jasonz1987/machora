import assert from "node:assert/strict";
import { test } from "node:test";
import { findLanAddress } from "../server/server.mjs";

test("prefers routable private LAN addresses over link-local interfaces", () => {
  const address = findLanAddress({
    en5: [{ family: "IPv4", internal: false, address: "169.254.207.43" }],
    feth0: [{ family: "IPv4", internal: false, address: "172.22.0.3" }],
    en0: [{ family: "IPv4", internal: false, address: "192.168.1.42" }],
  });
  assert.equal(address, "192.168.1.42");
});
