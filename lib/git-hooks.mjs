import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getConfigDir, triggerProjectAutomations, updateProjectHook } from "./store.mjs";

const execFileAsync = promisify(execFile);
const marker = "# machora managed pre-push hook";
const legacyMarker = "# rdev managed pre-push hook";
const defaultCliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "machora.mjs");

export async function installProjectGitHook(project) {
  if (!project?.id || !project.localPath) throw new Error("Project is required to install Git hooks");
  const hooksDirectory = await gitOutput(project.localPath, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
  await mkdir(hooksDirectory, { recursive: true });
  const hookPath = path.join(hooksDirectory, "pre-push");
  const originalPath = path.join(hooksDirectory, "pre-push.machora-original");
  const legacyOriginalPath = path.join(hooksDirectory, "pre-push.rdev-original");
  const existing = await readFile(hookPath, "utf8").catch(() => "");
  let originalPreserved = Boolean(await stat(originalPath).catch(() => null));
  if (!originalPreserved && await stat(legacyOriginalPath).catch(() => null)) {
    await rename(legacyOriginalPath, originalPath);
    originalPreserved = true;
  }
  if (existing && !existing.includes(marker) && !existing.includes(legacyMarker)) {
    if (originalPreserved) throw new Error("Cannot install Machora hook because pre-push and its Machora backup both exist");
    await rename(hookPath, originalPath);
    originalPreserved = true;
  }
  const logDirectory = path.join(getConfigDir(), "hooks");
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  const source = renderPrePushHook({
    projectId: project.id,
    repository: project.localPath,
    node: process.execPath,
    cli: path.resolve(process.env.MACHORA_CLI_PATH || process.env.RDEV_CLI_PATH || defaultCliPath),
    configDirectory: getConfigDir(),
    originalPath,
    logPath: path.join(logDirectory, `${project.id}.log`),
  });
  await writeFile(hookPath, source, { mode: 0o700 });
  await chmod(hookPath, 0o700);
  return updateProjectHook(project.id, { status: "installed", path: hookPath, installedAt: new Date().toISOString(), originalPreserved });
}

export async function projectGitHookStatus(project) {
  if (!project?.id || !project.localPath) throw new Error("Project is required to inspect Git hooks");
  const hooksDirectory = await gitOutput(project.localPath, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
  const hookPath = path.join(hooksDirectory, "pre-push");
  const originalPath = path.join(hooksDirectory, "pre-push.machora-original");
  const source = await readFile(hookPath, "utf8").catch(() => "");
  if (!source) return { status: "not-installed", path: hookPath, detail: "no pre-push hook" };
  if (!source.includes(marker) && !source.includes(legacyMarker)) return { status: "not-installed", path: hookPath, detail: "another pre-push hook is present" };
  const current = source.includes(marker)
    && source.includes("hook dispatch-push")
    && source.includes(shellQuote(project.id))
    && source.includes(shellQuote(getConfigDir()));
  return {
    status: current ? "installed" : "stale",
    path: hookPath,
    originalPreserved: Boolean(await stat(originalPath).catch(() => null)),
    detail: current ? "managed cross-platform dispatcher is current" : "run machora hooks install to refresh it",
  };
}

export async function uninstallProjectGitHook(project) {
  if (!project?.id || !project.localPath) throw new Error("Project is required to uninstall Git hooks");
  const hooksDirectory = await gitOutput(project.localPath, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
  const hookPath = path.join(hooksDirectory, "pre-push");
  const originalPath = path.join(hooksDirectory, "pre-push.machora-original");
  const source = await readFile(hookPath, "utf8").catch(() => "");
  if (source && !source.includes(marker) && !source.includes(legacyMarker)) throw new Error("Refusing to remove a pre-push hook that is not managed by Machora");
  if (source) await rm(hookPath, { force: true });
  const restoredOriginal = Boolean(await stat(originalPath).catch(() => null));
  if (restoredOriginal) await rename(originalPath, hookPath);
  const updated = await updateProjectHook(project.id, { status: "not-installed", path: null, installedAt: null, originalPreserved: false });
  return { ...updated, restoredOriginal };
}

export async function dispatchGitPushConfirmation({
  projectId, repository, remote, inputPath, logPath,
  node = process.execPath,
  cli = path.resolve(process.env.MACHORA_CLI_PATH || process.env.RDEV_CLI_PATH || defaultCliPath),
  configDirectory = getConfigDir(),
  spawnImpl = spawn,
}) {
  await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
  const log = openSync(logPath, "a");
  try {
    const child = spawnImpl(node, [
      cli, "hook", "confirm-push",
      "--project", projectId,
      "--repository", repository,
      "--remote", remote,
      "--input", inputPath,
    ], {
      detached: true,
      stdio: ["ignore", log, log],
      windowsHide: true,
      env: { ...process.env, MACHORA_CONFIG_DIR: configDirectory },
    });
    child.on?.("error", () => { rm(inputPath, { force: true }).catch(() => {}); });
    child.unref?.();
    return { dispatched: true, pid: child.pid || null };
  } catch (error) {
    await rm(inputPath, { force: true });
    throw error;
  } finally {
    closeSync(log);
  }
}

export async function confirmGitPush({ projectId, repository, remote, inputPath, timeoutMs = 90_000 }) {
  const input = await readFile(inputPath, "utf8");
  await rm(inputPath, { force: true });
  const updates = parsePrePushInput(input);
  const triggeredJobs = [];
  const deadline = Date.now() + timeoutMs;
  const pending = [...updates];
  while (pending.length && Date.now() < deadline) {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const update = pending[index];
      const remoteSha = await remoteRefSha(repository, remote, update.ref);
      if (remoteSha !== update.sha) continue;
      triggeredJobs.push(...await triggerProjectAutomations(projectId, { ...update, remote }));
      pending.splice(index, 1);
    }
    if (pending.length) await delay(2000);
  }
  return { confirmed: updates.length - pending.length, timedOut: pending.length, jobs: triggeredJobs };
}

export function parsePrePushInput(input) {
  const zero = /^0+$/;
  const updates = [];
  for (const line of String(input || "").split(/\r?\n/)) {
    const [localRef, localSha, remoteRef] = line.trim().split(/\s+/);
    if (!localRef || !localSha || !remoteRef || zero.test(localSha)) continue;
    const event = remoteRef.startsWith("refs/heads/") ? "branch-push" : remoteRef.startsWith("refs/tags/") ? "tag-push" : null;
    if (!event) continue;
    updates.push({ event, ref: remoteRef, sha: localSha.toLowerCase(), remote: null });
  }
  return updates;
}

function renderPrePushHook({ projectId, repository, node, cli, configDirectory, originalPath, logPath }) {
  return `#!/bin/sh
${marker}
set -u
MACHORA_HOOK_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 0
MACHORA_INPUT=$(mktemp "$MACHORA_HOOK_DIR/.machora-push.XXXXXX") || exit 0
cat > "$MACHORA_INPUT"
if [ -x ${shellQuote(originalPath)} ]; then
  ${shellQuote(originalPath)} "$@" < "$MACHORA_INPUT" || { MACHORA_STATUS=$?; rm -f "$MACHORA_INPUT"; exit "$MACHORA_STATUS"; }
fi
MACHORA_CONFIG_DIR=${shellQuote(configDirectory)} ${shellQuote(node)} ${shellQuote(cli)} hook dispatch-push --project ${shellQuote(projectId)} --repository ${shellQuote(repository)} --remote "$1" --input "$MACHORA_INPUT" --log ${shellQuote(logPath)} || { MACHORA_STATUS=$?; rm -f "$MACHORA_INPUT"; exit "$MACHORA_STATUS"; }
exit 0
`;
}

async function remoteRefSha(repository, remote, ref) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repository, "ls-remote", "--refs", remote, ref], { encoding: "utf8", timeout: 15_000, maxBuffer: 256 * 1024 });
    return String(stdout || "").trim().split(/\s+/, 1)[0]?.toLowerCase() || "";
  } catch { return ""; }
}

async function gitOutput(repository, args) {
  const { stdout } = await execFileAsync("git", ["-C", repository, ...args], { encoding: "utf8", timeout: 10_000, maxBuffer: 256 * 1024 });
  return stdout.trim();
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
