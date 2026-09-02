import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SKILL_DIRECTORY = ".agents/skills/machora";
const SKILL_PATH = `${SKILL_DIRECTORY}/SKILL.md`;
const LEGACY_SKILL_DIRECTORY = ".agents/skills/rdev";
const LEGACY_SKILL_PATH = `${LEGACY_SKILL_DIRECTORY}/SKILL.md`;
const POLICY_PATH = "AGENTS.override.md";
const POLICY_HEADER = "<!-- machora:generated-local-override -->";
const POLICY_START = "<!-- machora:policy:start -->";
const POLICY_END = "<!-- machora:policy:end -->";
const LEGACY_POLICY_HEADER = "<!-- rdev:generated-local-override -->";
const LEGACY_POLICY_START = "<!-- rdev:policy:start -->";
const LEGACY_POLICY_END = "<!-- rdev:policy:end -->";

export async function installProjectSkill(projectRoot) {
  const root = path.resolve(projectRoot);
  const skillDirectory = path.join(root, ...SKILL_DIRECTORY.split("/"));
  const skillPath = path.join(root, ...SKILL_PATH.split("/"));
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(skillPath, skillSource(), "utf8");
  await removeLegacySkill(root);
  await installProjectPolicy(root, path.join(root, POLICY_PATH));

  const excludePath = await gitExcludePath(root);
  await mkdir(path.dirname(excludePath), { recursive: true });
  const previous = await readFile(excludePath, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
  const ignoredEntries = [`${SKILL_DIRECTORY}/`, POLICY_PATH];
  const entries = previous.split(/\r?\n/).map((entry) => entry.trim());
  const missing = ignoredEntries.filter((entry) => !entries.includes(entry));
  if (missing.length) {
    const prefix = previous && !previous.endsWith("\n") ? "\n" : "";
    await writeFile(excludePath, `${previous}${prefix}${missing.join("\n")}\n`, "utf8");
  }
  return {
    status: "installed",
    path: SKILL_PATH,
    ignoredByGit: true,
    policyPath: POLICY_PATH,
    policyIgnoredByGit: true,
    installedAt: new Date().toISOString(),
  };
}

async function installProjectPolicy(root, policyPath) {
  if (await isTracked(root, POLICY_PATH)) throw new Error(`${POLICY_PATH} is tracked by Git; Machora will not replace a shared project policy`);
  const existing = await readFile(policyPath, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
  const baseInstructions = await readFile(path.join(root, "AGENTS.md"), "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
  const block = policyBlock();
  let output;
  if (!existing || existing.startsWith(POLICY_HEADER) || existing.startsWith(LEGACY_POLICY_HEADER)) {
    output = [POLICY_HEADER, baseInstructions.trim(), block].filter(Boolean).join("\n\n");
  } else if ((existing.includes(POLICY_START) && existing.includes(POLICY_END)) || (existing.includes(LEGACY_POLICY_START) && existing.includes(LEGACY_POLICY_END))) {
    const startMarker = existing.includes(POLICY_START) ? POLICY_START : LEGACY_POLICY_START;
    const endMarker = startMarker === POLICY_START ? POLICY_END : LEGACY_POLICY_END;
    const start = existing.indexOf(startMarker);
    const end = existing.indexOf(endMarker) + endMarker.length;
    output = `${existing.slice(0, start).trimEnd()}\n\n${block}${existing.slice(end)}`.trim();
  } else {
    output = `${existing.trimEnd()}\n\n${block}`;
  }
  await writeFile(policyPath, `${output.trim()}\n`, { mode: 0o600 });
}

async function removeLegacySkill(root) {
  const legacyPath = path.join(root, ...LEGACY_SKILL_PATH.split("/"));
  const source = await readFile(legacyPath, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
  if (!source.includes("name: rdev") || !source.includes("rdev project run")) return;
  await rm(path.join(root, ...LEGACY_SKILL_DIRECTORY.split("/")), { recursive: true, force: true });
}

async function gitExcludePath(root) {
  const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8", timeout: 5000 });
  const candidate = stdout.trim();
  return path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate);
}

async function isTracked(root, relativePath) {
  try {
    await execFileAsync("git", ["-C", root, "ls-files", "--error-unmatch", "--", relativePath], { encoding: "utf8", timeout: 5000 });
    return true;
  } catch (error) {
    if ([1, 128].includes(error.code)) return false;
    throw error;
  }
}

function skillSource() {
  return `---
name: machora
description: Route this repository's dependency installation, tests, builds, packaging, dev previews, and deployments through its assigned Machora task machine. Use whenever a task would run a resource-consuming project command; keep source editing and Git authoring local.
---

# Machora remote project

Keep source editing on the controller machine and run resource-heavy project operations through the configured Machora task machine. The repository's local execution policy in \`AGENTS.override.md\` is authoritative.

- Inspect the association first with \`machora project status --path . --json\`.
- Update only the task-machine checkout with \`machora project sync --path .\`.
- Queue a configured operation with \`machora project run <install|test|build|dev|deploy> --path .\` only when the user explicitly requests that outcome or it is required by their stated acceptance criteria.
- Operation Jobs automatically fast-forward the remote Git checkout first, prepare detected dependencies next, and then run the requested project command. Do not repeat those stages locally.
- A queued operation returns immediately. Use \`machora job status <job-id> --json\` when the user asks for its result.
- Use \`machora job list --json\` when the user asks about active or recent remote work.
- Do not start a dev preview or produce a build/package merely because source files changed. For an explicitly requested dev Job, return its \`result.previewUrl\` when present.
- Never replace a failed remote operation by installing dependencies, testing, building, packaging, or starting a preview locally unless the user explicitly asks to run it locally.
- Git sync uses the configured origin and branch. Local uncommitted or unpushed changes are not transferred.
- Do not commit, push, rewrite Git history, or edit shared \`AGENTS.md\` as part of a Machora operation.
`;
}

function policyBlock() {
  return `${POLICY_START}
## Machora controller-local execution policy

This repository is assigned to a Machora task machine. Source editing, review, and Git authoring stay on this controller; resource-consuming project operations do not.

- Never run dependency installation, tests, builds, packaging, deployment, or dev/preview servers on this controller unless the user explicitly says to run that operation locally.
- Do not automatically start or restart a preview after editing frontend files. Start a preview only when the user explicitly requests one, and queue the configured remote \`dev\` operation through Machora.
- Do not automatically build or package as a generic verification step. Queue the configured remote \`test\`, \`build\`, or \`deploy\` operation only when the user requests it or their acceptance criteria require it.
- Before any such operation, run \`machora project status --path . --json\`. Queue work with \`machora project run <operation> --path .\`, then inspect it with \`machora job status <job-id> --json\`.
- If Machora is unavailable or the remote Job fails, report the blocker. Do not silently fall back to the equivalent local command.
- Do not run package-manager install/test/build/dev commands, framework dev servers, Flutter/CocoaPods builds, native packaging tools, or equivalent resource-heavy commands directly on this controller under the exceptions above.
${POLICY_END}`;
}
