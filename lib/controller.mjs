import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addHost,
  completeEnrollment,
  createEnrollment,
  heartbeatAgent,
  listHosts,
  listProjects,
  listProjectsForHost,
  listJobs,
  listNotifications,
  markNotificationRead,
  getJob,
  acceptAgentJobResults,
  acceptAgentJobUpdates,
  claimJobsForHost,
  queueHostCommand,
  queueProjectJob,
  publicHost,
  readStore,
  assignProject,
  removeHost,
  removeProject,
  updateProjectCommands,
  updateProjectAutomations,
  updateProjectSkill,
} from "./store.mjs";
import { inspectLocalProject } from "./project-inspector.mjs";
import { chooseProjectDirectory } from "./native-dialog.mjs";
import { installProjectSkill } from "./project-skill.mjs";
import { installProjectGitHook } from "./git-hooks.mjs";
import { notifyJobCompletion } from "./notifier.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientRoot = path.join(root, "dist", "client");
const agentPath = path.join(root, "agent", "agent.mjs");
const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
]);

export function createController({ getPublicOrigin, notify = notifyJobCompletion } = {}) {
  return async function controller(request, response) {
    try {
      const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
      const publicOrigin = normalizeOrigin(getPublicOrigin?.(request) || `${url.protocol}//${request.headers.host}`);

      if (url.pathname === "/api/health") {
        return sendJson(response, 200, {
          ok: true,
          controllerUrl: publicOrigin,
          agentVersion: "0.8.1",
          updateCommands: agentUpdateCommands(publicOrigin),
        });
      }
      if (url.pathname === "/api/hosts" && request.method === "GET") {
        return sendJson(response, 200, { hosts: await listHosts() });
      }
      if (url.pathname === "/api/hosts" && request.method === "POST") {
        return sendJson(response, 201, { host: await addHost(await readJson(request)) });
      }
      if (url.pathname === "/api/projects" && request.method === "GET") {
        return sendJson(response, 200, { projects: await listProjects() });
      }
      const hostCommandMatch = url.pathname.match(/^\/api\/hosts\/([^/]+)\/commands$/);
      if (hostCommandMatch && request.method === "POST") {
        requireControllerLocal(request);
        const input = await readJson(request);
        return sendJson(response, 202, { job: await queueHostCommand(decodeURIComponent(hostCommandMatch[1]), input) });
      }
      if (url.pathname === "/api/jobs" && request.method === "GET") {
        requireControllerLocal(request);
        return sendJson(response, 200, { jobs: await listJobs() });
      }
      if (url.pathname === "/api/notifications" && request.method === "GET") {
        requireControllerLocal(request);
        return sendJson(response, 200, { notifications: await listNotifications() });
      }
      const notificationReadMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
      if (notificationReadMatch && request.method === "POST") {
        requireControllerLocal(request);
        const notification = await markNotificationRead(decodeURIComponent(notificationReadMatch[1]));
        return sendJson(response, notification ? 200 : 404, notification ? { notification } : { error: "Notification not found" });
      }
      if (url.pathname === "/api/projects" && request.method === "POST") {
        requireControllerLocal(request);
        const input = await readJson(request);
        const metadata = await inspectLocalProject(input.localPath);
        let project = await assignProject(metadata, input.host);
        try {
          project = await updateProjectSkill(project.id, await installProjectSkill(metadata.localPath));
        } catch (skillError) {
          project = await updateProjectSkill(project.id, { status: "error", error: skillError.message });
        }
        let job = null;
        try { job = await queueProjectJob(project.id, "sync"); } catch (syncError) {
          project = { ...project, remoteStatus: "blocked", remoteError: syncError.message };
        }
        return sendJson(response, 201, { project, job });
      }
      const commandMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/commands$/);
      if (commandMatch && request.method === "PATCH") {
        requireControllerLocal(request);
        return sendJson(response, 200, { project: await updateProjectCommands(decodeURIComponent(commandMatch[1]), (await readJson(request)).commands) });
      }
      const automationMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/automations$/);
      if (automationMatch && request.method === "PATCH") {
        requireControllerLocal(request);
        return sendJson(response, 200, { project: await updateProjectAutomations(decodeURIComponent(automationMatch[1]), (await readJson(request)).rules) });
      }
      const hookMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/hooks\/install$/);
      if (hookMatch && request.method === "POST") {
        requireControllerLocal(request);
        const projectId = decodeURIComponent(hookMatch[1]);
        const project = (await listProjects()).find((item) => item.id === projectId);
        if (!project) return sendJson(response, 404, { error: "Project not found" });
        return sendJson(response, 200, { project: await installProjectGitHook(project) });
      }
      const syncMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/sync$/);
      if (syncMatch && request.method === "POST") {
        requireControllerLocal(request);
        return sendJson(response, 202, { job: await queueProjectJob(decodeURIComponent(syncMatch[1]), "sync") });
      }
      const runMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/run$/);
      if (runMatch && request.method === "POST") {
        requireControllerLocal(request);
        const input = await readJson(request);
        return sendJson(response, 202, { job: await queueProjectJob(decodeURIComponent(runMatch[1]), "command", input.operation) });
      }
      const skillMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/skill$/);
      if (skillMatch && request.method === "POST") {
        requireControllerLocal(request);
        const projectId = decodeURIComponent(skillMatch[1]);
        const projects = await listProjects();
        const project = projects.find((item) => item.id === projectId);
        if (!project) return sendJson(response, 404, { error: "Project not found" });
        return sendJson(response, 200, { project: await updateProjectSkill(projectId, await installProjectSkill(project.localPath)) });
      }
      if (url.pathname.startsWith("/api/projects/") && request.method === "DELETE") {
        requireControllerLocal(request);
        const id = decodeURIComponent(url.pathname.slice("/api/projects/".length));
        const removed = await removeProject(id);
        return sendJson(response, removed ? 200 : 404, removed ? { ok: true } : { error: "Project not found" });
      }
      if (url.pathname === "/api/dialogs/project-directory" && request.method === "POST") {
        requireControllerLocal(request);
        const selectedPath = await chooseProjectDirectory();
        return sendJson(response, 200, selectedPath ? { path: selectedPath } : { cancelled: true });
      }
      if (url.pathname.startsWith("/api/hosts/") && request.method === "DELETE") {
        const id = decodeURIComponent(url.pathname.slice("/api/hosts/".length));
        const removed = await removeHost(id);
        return sendJson(response, removed ? 200 : 404, removed ? { ok: true } : { error: "Host not found" });
      }
      if (url.pathname === "/api/enrollments" && request.method === "POST") {
        const enrollment = await createEnrollment(await readJson(request));
        return sendJson(response, 201, {
          enrollment,
          controllerUrl: publicOrigin,
          commands: enrollmentCommands(publicOrigin, enrollment.token),
        });
      }
      if (url.pathname.startsWith("/api/enrollments/") && request.method === "GET") {
        const token = decodeURIComponent(url.pathname.slice("/api/enrollments/".length));
        const data = await readStore();
        const enrollment = data.enrollments.find((item) => item.token === token);
        if (!enrollment) return sendJson(response, 404, { error: "Enrollment not found" });
        const host = data.hosts.find((item) => item.alias === enrollment.alias);
        return sendJson(response, 200, { enrollment, host: host ? publicHost(host) : null });
      }
      if (url.pathname.startsWith("/api/enroll/") && request.method === "POST") {
        const token = decodeURIComponent(url.pathname.slice("/api/enroll/".length));
        const body = await readBody(request);
        const contentType = request.headers["content-type"] || "";
        const machine = contentType.includes("application/json")
          ? JSON.parse(body || "{}")
          : Object.fromEntries(new URLSearchParams(body));
        machine.address = request.socket.remoteAddress?.replace(/^::ffff:/, "") || machine.hostname;
        return sendJson(response, 201, { ok: true, ...await completeEnrollment(token, machine) });
      }
      if (url.pathname === "/api/agent/heartbeat" && request.method === "POST") {
        const agentId = request.headers["x-machora-agent-id"] || request.headers["x-rdev-agent-id"];
        const secret = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
        const address = request.socket.remoteAddress?.replace(/^::ffff:/, "");
        const input = await readJson(request);
        if (input.jobUpdates?.length) await acceptAgentJobUpdates(agentId, secret, input.jobUpdates);
        if (input.jobResults?.length) {
          const completions = await acceptAgentJobResults(agentId, secret, input.jobResults);
          for (const completion of completions) Promise.resolve(notify(completion.job, { dashboardOrigin: publicOrigin })).catch(() => {});
        }
        const host = await heartbeatAgent(agentId, secret, input, address);
        return sendJson(response, 200, { ok: true, host, projects: await listProjectsForHost(host.id), jobs: await claimJobsForHost(host.id) });
      }
      if (url.pathname.startsWith("/api/jobs/") && request.method === "GET") {
        requireControllerLocal(request);
        const job = await getJob(decodeURIComponent(url.pathname.slice("/api/jobs/".length)));
        return sendJson(response, job ? 200 : 404, job ? { job } : { error: "Job not found" });
      }
      if (url.pathname === "/agent.mjs" && request.method === "GET") {
        return sendText(response, 200, await readFile(agentPath, "utf8"), "text/javascript; charset=utf-8");
      }
      if (["/install.sh", "/enroll.sh"].includes(url.pathname) && request.method === "GET") {
        return sendText(response, 200, posixInstallScript(publicOrigin, url.searchParams.get("token")), "text/x-shellscript; charset=utf-8");
      }
      if (["/install.ps1", "/enroll.ps1"].includes(url.pathname) && request.method === "GET") {
        return sendText(response, 200, windowsInstallScript(publicOrigin, url.searchParams.get("token")), "text/plain; charset=utf-8");
      }
      if (url.pathname === "/update.sh" && request.method === "GET") {
        return sendText(response, 200, posixUpdateScript(publicOrigin), "text/x-shellscript; charset=utf-8");
      }
      if (url.pathname === "/update.ps1" && request.method === "GET") {
        return sendText(response, 200, windowsUpdateScript(publicOrigin), "text/plain; charset=utf-8");
      }
      if (url.pathname.startsWith("/api/")) return sendJson(response, 404, { error: "API endpoint not found" });
      if (request.method === "GET" || request.method === "HEAD") return serveStatic(url.pathname, response, request.method === "HEAD");
      return sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const status = error.statusCode || (error instanceof SyntaxError ? 400 : 500);
      return sendJson(response, status, { error: status === 500 ? "Internal server error" : error.message, ...(status !== 500 && error.details ? error.details : {}) });
    }
  };
}

export function enrollmentCommands(origin, token) {
  const safeOrigin = normalizeOrigin(origin);
  return {
    posix: `curl -fsSL '${safeOrigin}/install.sh?token=${token}' | sh`,
    windows: `irm '${safeOrigin}/install.ps1?token=${token}' | iex`,
  };
}

export function agentUpdateCommands(origin) {
  const safeOrigin = normalizeOrigin(origin);
  return {
    posix: `curl -fsSL '${safeOrigin}/update.sh' | sh`,
    windows: `irm '${safeOrigin}/update.ps1' | iex`,
  };
}

function posixUpdateScript(origin) {
  return [
    "#!/bin/sh",
    "set -eu",
    `MACHORA_CONTROLLER=${shellQuote(origin)}`,
    'MACHORA_DIR="${MACHORA_AGENT_DIR:-${RDEV_AGENT_DIR:-$HOME/.machora-agent}}"',
    'if [ ! -f "$MACHORA_DIR/config.json" ] && [ -f "$HOME/.rdev-agent/config.json" ]; then MACHORA_DIR="$HOME/.rdev-agent"; fi',
    'MACHORA_AGENT="$MACHORA_DIR/agent.mjs"',
    'MACHORA_CONFIG="$MACHORA_DIR/config.json"',
    'if [ ! -f "$MACHORA_CONFIG" ]; then echo "machora: Agent is not installed on this machine" >&2; exit 1; fi',
    'if ! command -v node >/dev/null 2>&1; then echo "machora: Node.js 20+ is required" >&2; exit 1; fi',
    'MACHORA_NODE=$(command -v node)',
    'curl -fsSL "$MACHORA_CONTROLLER/agent.mjs" -o "$MACHORA_AGENT.new"',
    'chmod 700 "$MACHORA_AGENT.new"',
    'mv "$MACHORA_AGENT.new" "$MACHORA_AGENT"',
    'MACHORA_SYSTEM=$(uname -s)',
    'if [ "$MACHORA_SYSTEM" = "Darwin" ] && [ -f "$HOME/Library/LaunchAgents/dev.machora.agent.plist" ]; then',
    '  launchctl kickstart -k "gui/$(id -u)/dev.machora.agent"',
    'elif [ "$MACHORA_SYSTEM" = "Darwin" ] && [ -f "$HOME/Library/LaunchAgents/dev.rdev.agent.plist" ]; then',
    '  launchctl kickstart -k "gui/$(id -u)/dev.rdev.agent"',
    'elif command -v systemctl >/dev/null 2>&1 && systemctl --user is-enabled machora-agent.service >/dev/null 2>&1; then',
    '  systemctl --user restart machora-agent.service',
    'elif command -v systemctl >/dev/null 2>&1 && systemctl --user is-enabled rdev-agent.service >/dev/null 2>&1; then',
    '  systemctl --user restart rdev-agent.service',
    'elif [ -f "$MACHORA_DIR/agent.pid" ]; then',
    '  MACHORA_PID=$(cat "$MACHORA_DIR/agent.pid")',
    '  kill "$MACHORA_PID" >/dev/null 2>&1 || true',
    '  nohup "$MACHORA_NODE" "$MACHORA_AGENT" run >> "$MACHORA_DIR/agent.log" 2>&1 &',
    '  echo $! > "$MACHORA_DIR/agent.pid"',
    'else',
    '  echo "machora: Agent updated; restart its process or sign in again to activate it"',
    '  exit 0',
    'fi',
    'echo "machora: Agent updated and restarted"',
  ].join("\n") + "\n";
}

function windowsUpdateScript(origin) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$controller = ${powershellQuote(origin)}`,
    "$agentDir = if ($env:MACHORA_AGENT_DIR) { $env:MACHORA_AGENT_DIR } elseif ($env:RDEV_AGENT_DIR) { $env:RDEV_AGENT_DIR } elseif (Test-Path (Join-Path $env:LOCALAPPDATA 'rdev-agent\\config.json')) { Join-Path $env:LOCALAPPDATA 'rdev-agent' } else { Join-Path $env:LOCALAPPDATA 'machora-agent' }",
    "$agentPath = Join-Path $agentDir 'agent.mjs'",
    "$configPath = Join-Path $agentDir 'config.json'",
    "if (-not (Test-Path $configPath)) { throw 'machora Agent is not installed on this machine' }",
    "$nodeCommand = (Get-Command node -ErrorAction Stop).Source",
    "$newAgentPath = Join-Path $agentDir 'agent.mjs.new'",
    "Invoke-WebRequest -UseBasicParsing -Uri \"$controller/agent.mjs\" -OutFile $newAgentPath",
    "Move-Item -Force $newAgentPath $agentPath",
    "$escapedAgentPath = [Regex]::Escape($agentPath)",
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match $escapedAgentPath -and $_.CommandLine -match '\\brun\\b' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    "Start-Process -WindowStyle Hidden -FilePath $nodeCommand -ArgumentList @($agentPath, 'run')",
    "Write-Host 'machora: Agent updated and restarted'",
  ].join("\r\n") + "\r\n";
}

function posixInstallScript(origin, token) {
  if (!token) return "#!/bin/sh\necho 'Missing enrollment token' >&2\nexit 1\n";
  return [
    "#!/bin/sh",
    "set -eu",
    `MACHORA_CONTROLLER=${shellQuote(origin)}`,
    `MACHORA_TOKEN=${shellQuote(token)}`,
    'MACHORA_DIR="${MACHORA_AGENT_DIR:-$HOME/.machora-agent}"',
    'if ! command -v node >/dev/null 2>&1; then echo "machora: Node.js 20+ is required" >&2; exit 1; fi',
    'MACHORA_NODE=$(command -v node)',
    'MACHORA_NODE_MAJOR=$("$MACHORA_NODE" -p "Number(process.versions.node.split(\'.\')[0])")',
    'if [ "$MACHORA_NODE_MAJOR" -lt 20 ]; then echo "machora: Node.js 20+ is required (found $(node --version))" >&2; exit 1; fi',
    'mkdir -p "$MACHORA_DIR"',
    'chmod 700 "$MACHORA_DIR"',
    'curl -fsSL "$MACHORA_CONTROLLER/agent.mjs" -o "$MACHORA_DIR/agent.mjs"',
    'chmod 700 "$MACHORA_DIR/agent.mjs"',
    '"$MACHORA_NODE" "$MACHORA_DIR/agent.mjs" enroll --controller "$MACHORA_CONTROLLER" --token "$MACHORA_TOKEN"',
    'if [ "${MACHORA_SKIP_SERVICE:-0}" = "1" ]; then "$MACHORA_NODE" "$MACHORA_DIR/agent.mjs" run --once; echo "machora: Agent installed without a background service"; exit 0; fi',
    'MACHORA_SYSTEM=$(uname -s)',
    'if [ "$MACHORA_SYSTEM" = "Darwin" ]; then',
    '  MACHORA_SERVICE_DIR="$HOME/Library/LaunchAgents"',
    '  MACHORA_PLIST="$MACHORA_SERVICE_DIR/dev.machora.agent.plist"',
    '  mkdir -p "$MACHORA_SERVICE_DIR"',
    '  cat > "$MACHORA_PLIST" <<EOF',
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '  <key>Label</key><string>dev.machora.agent</string>',
    '  <key>ProgramArguments</key><array><string>$MACHORA_NODE</string><string>$MACHORA_DIR/agent.mjs</string><string>run</string></array>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    '  <key>ThrottleInterval</key><integer>5</integer>',
    '  <key>StandardOutPath</key><string>$MACHORA_DIR/agent.log</string>',
    '  <key>StandardErrorPath</key><string>$MACHORA_DIR/agent-error.log</string>',
    '</dict></plist>',
    'EOF',
    '  launchctl bootout "gui/$(id -u)" "$MACHORA_PLIST" >/dev/null 2>&1 || true',
    '  launchctl bootstrap "gui/$(id -u)" "$MACHORA_PLIST"',
    '  launchctl enable "gui/$(id -u)/dev.machora.agent"',
    '  echo "machora: Agent installed as macOS LaunchAgent"',
    'elif command -v systemctl >/dev/null 2>&1; then',
    '  MACHORA_SERVICE_DIR="$HOME/.config/systemd/user"',
    '  MACHORA_SERVICE="$MACHORA_SERVICE_DIR/machora-agent.service"',
    '  mkdir -p "$MACHORA_SERVICE_DIR"',
    '  cat > "$MACHORA_SERVICE" <<EOF',
    '[Unit]',
    'Description=machora task machine Agent',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    'ExecStart="$MACHORA_NODE" "$MACHORA_DIR/agent.mjs" run',
    'Restart=always',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    'EOF',
    '  if systemctl --user daemon-reload && systemctl --user enable --now machora-agent.service; then',
    '    echo "machora: Agent installed as systemd user service"',
    '  else',
    '    echo "machora: systemd user service unavailable; starting fallback process"',
    '    nohup "$MACHORA_NODE" "$MACHORA_DIR/agent.mjs" run >> "$MACHORA_DIR/agent.log" 2>&1 &',
    '    echo $! > "$MACHORA_DIR/agent.pid"',
    '  fi',
    'else',
    '  nohup "$MACHORA_NODE" "$MACHORA_DIR/agent.mjs" run >> "$MACHORA_DIR/agent.log" 2>&1 &',
    '  echo $! > "$MACHORA_DIR/agent.pid"',
    '  echo "machora: Agent started as a background process"',
    'fi',
    'echo "machora: installation complete"',
  ].join("\n") + "\n";
}

function windowsInstallScript(origin, token) {
  if (!token) return "throw 'Missing enrollment token'\r\n";
  return [
    "$ErrorActionPreference = 'Stop'",
    `$controller = ${powershellQuote(origin)}`,
    `$token = ${powershellQuote(token)}`,
    "$nodeCommand = (Get-Command node -ErrorAction Stop).Source",
    "$nodeMajor = [int](& $nodeCommand -p \"Number(process.versions.node.split('.')[0])\")",
    "if ($nodeMajor -lt 20) { throw 'machora requires Node.js 20 or newer' }",
    "$agentDir = if ($env:MACHORA_AGENT_DIR) { $env:MACHORA_AGENT_DIR } else { Join-Path $env:LOCALAPPDATA 'machora-agent' }",
    "New-Item -ItemType Directory -Force -Path $agentDir | Out-Null",
    "$agentPath = Join-Path $agentDir 'agent.mjs'",
    "Invoke-WebRequest -UseBasicParsing -Uri \"$controller/agent.mjs\" -OutFile $agentPath",
    "& $nodeCommand $agentPath enroll --controller $controller --token $token",
    "if ($env:MACHORA_SKIP_SERVICE -eq '1') { & $nodeCommand $agentPath run --once; Write-Host 'machora: Agent installed without a background service'; return }",
    "$startupDir = [Environment]::GetFolderPath('Startup')",
    "$startupFile = Join-Path $startupDir 'machora-agent.cmd'",
    "$logPath = Join-Path $agentDir 'agent.log'",
    "$startupCommand = \"@echo off`r`nstart `\"`\" /min `\"$nodeCommand`\" `\"$agentPath`\" run >> `\"$logPath`\" 2>&1`r`n\"",
    "Set-Content -Path $startupFile -Value $startupCommand -Encoding Ascii",
    "Start-Process -WindowStyle Hidden -FilePath $nodeCommand -ArgumentList @($agentPath, 'run')",
    "Write-Host 'machora: Agent installed in the current user Startup folder'",
  ].join("\r\n") + "\r\n";
}

function normalizeOrigin(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Controller URL must use http or https");
  return url.origin;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function powershellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function serveStatic(pathname, response, headOnly) {
  const decoded = decodeURIComponent(pathname);
  const requested = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  let file = path.resolve(clientRoot, requested);
  if (!file.startsWith(`${clientRoot}${path.sep}`) && file !== clientRoot) return sendJson(response, 403, { error: "Forbidden" });
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
  } catch {
    file = path.join(clientRoot, "index.html");
  }
  const content = await readFile(file);
  response.writeHead(200, {
    "content-type": mimeTypes.get(path.extname(file)) || "application/octet-stream",
    "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
  });
  response.end(headOnly ? undefined : content);
}

async function readJson(request) {
  return JSON.parse((await readBody(request)) || "{}");
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 128 * 1024) throw Object.assign(new Error("Request body too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

function sendText(response, status, value, contentType) {
  response.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  response.end(value);
}

function requireControllerLocal(request) {
  const address = String(request.socket.remoteAddress || "").replace(/^::ffff:/, "");
  if (!["127.0.0.1", "::1"].includes(address)) {
    throw Object.assign(new Error("Project configuration is allowed only from the controller machine"), { statusCode: 403 });
  }
}
