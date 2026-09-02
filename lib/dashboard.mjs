import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getConfigDir } from "./store.mjs";

export async function dashboardUrl(configDir = getConfigDir()) {
  const configPath = path.join(configDir, "controller.json");
  const config = await readFile(configPath, "utf8")
    .then((source) => JSON.parse(source))
    .catch((error) => {
      if (error.code === "ENOENT") return {};
      throw new Error(`Could not read controller settings: ${error.message}`);
    });
  const port = Number(config.port || 4178);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Installed controller port is invalid");
  return `http://127.0.0.1:${port}`;
}

export function openExternal(url, options = {}) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Dashboard URL must use http or https");
  const platform = options.platform || process.platform;
  const launch = options.spawn || spawn;
  let command;
  let argumentsList;
  if (platform === "darwin") {
    command = "open";
    argumentsList = [parsed.href];
  } else if (platform === "win32") {
    command = "cmd";
    argumentsList = ["/c", "start", "", parsed.href];
  } else {
    command = "xdg-open";
    argumentsList = [parsed.href];
  }
  const child = launch(command, argumentsList, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref?.();
  return { command, arguments: argumentsList };
}

export async function waitForDashboard(url, options = {}) {
  const attempts = options.attempts || 20;
  const intervalMs = options.intervalMs || 250;
  const request = options.fetch || fetch;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await request(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return true;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Controller is not reachable at ${url}: ${lastError?.message || "connection failed"}`);
}
