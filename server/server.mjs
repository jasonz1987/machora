import http from "node:http";
import os from "node:os";
import { createController } from "../lib/controller.mjs";

export function startServer({ port = 4178, host = "0.0.0.0", advertise } = {}) {
  const lanAddress = findLanAddress();
  let controllerUrl = advertise ? normalizeAdvertise(advertise) : null;
  let server;
  const controller = createController({
    getPublicOrigin: () => controllerUrl || `http://${lanAddress}:${server?.address()?.port || port}`,
  });
  server = http.createServer(controller);
  // Agents heartbeat every ten seconds. Node's five-second default closes the
  // socket between every heartbeat, which can create enough TIME_WAIT churn to
  // exhaust ephemeral ports on busy Windows task machines. Keep each
  // connection alive across several heartbeats instead.
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 35_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const actualPort = server.address().port;
      controllerUrl ||= `http://${lanAddress}:${actualPort}`;
      resolve({ server, port: actualPort, host, lanAddress, controllerUrl });
    });
  });
}

export function findLanAddress(interfaces = os.networkInterfaces()) {
  const candidates = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses || []) {
      if (address.family !== "IPv4" || address.internal) continue;
      candidates.push({ address: address.address, score: addressScore(address.address, name) });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
  return candidates[0]?.address || "127.0.0.1";
}

function addressScore(address, interfaceName) {
  let score = 100;
  if (address.startsWith("192.168.")) score = 500;
  else if (address.startsWith("10.")) score = 450;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score = 400;
  else if (address.startsWith("169.254.")) score = 0;
  if (/^(en0|eth0|wlan0|wi-fi)$/i.test(interfaceName)) score += 25;
  if (/^(utun|docker|bridge|veth|feth)/i.test(interfaceName)) score -= 25;
  return score;
}

function normalizeAdvertise(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("--advertise must use http or https");
  return url.origin;
}
