import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { installProjectSkill } from "../lib/project-skill.mjs";

let temporaryDirectory;

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "machora-project-skill-"));
  execFileSync("git", ["init", "-b", "main", temporaryDirectory]);
  execFileSync("git", ["-C", temporaryDirectory, "config", "user.email", "machora@example.test"]);
  execFileSync("git", ["-C", temporaryDirectory, "config", "user.name", "machora test"]);
  await writeFile(path.join(temporaryDirectory, "AGENTS.md"), "# Shared project rules\n\n- Preserve this instruction.\n");
  execFileSync("git", ["-C", temporaryDirectory, "add", "AGENTS.md"]);
  execFileSync("git", ["-C", temporaryDirectory, "commit", "-m", "add project rules"]);
});

after(async () => { await rm(temporaryDirectory, { recursive: true, force: true }); });

test("installs a project-local machora Skill without adding tracked project noise", async () => {
  const installed = await installProjectSkill(temporaryDirectory);
  assert.equal(installed.path, ".agents/skills/machora/SKILL.md");
  assert.equal(installed.ignoredByGit, true);
  assert.equal(installed.policyPath, "AGENTS.override.md");
  assert.equal(installed.policyIgnoredByGit, true);
  const source = await readFile(path.join(temporaryDirectory, installed.path), "utf8");
  assert.match(source, /^---\nname: machora\n/);
  assert.match(source, /machora project run/);
  assert.match(source, /machora job list/);
  assert.match(source, /Git checkout first, prepare detected dependencies next, and then run the requested project command/);
  assert.match(source, /Do not start a dev preview or produce a build\/package merely because source files changed/);
  await stat(path.join(temporaryDirectory, installed.path));
  const policy = await readFile(path.join(temporaryDirectory, installed.policyPath), "utf8");
  assert.match(policy, /# Shared project rules/);
  assert.match(policy, /Never run dependency installation, tests, builds, packaging, deployment, or dev\/preview servers on this controller/);
  assert.match(policy, /Do not automatically start or restart a preview/);
  const exclude = await readFile(path.join(temporaryDirectory, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /^\.agents\/skills\/machora\/$/m); assert.match(exclude, /^AGENTS\.override\.md$/m);
  const status = execFileSync("git", ["-C", temporaryDirectory, "status", "--porcelain=v1"], { encoding: "utf8" });
  assert.equal(status, "");
});

test("replaces a generated legacy rdev Skill and policy", async () => {
  const legacySkill = path.join(temporaryDirectory, ".agents", "skills", "rdev", "SKILL.md");
  await mkdir(path.dirname(legacySkill), { recursive: true });
  await writeFile(legacySkill, "---\nname: rdev\n---\n\nRun `rdev project run build`.\n", "utf8");
  await writeFile(path.join(temporaryDirectory, "AGENTS.override.md"), "<!-- rdev:generated-local-override -->\n\n<!-- rdev:policy:start -->\nlegacy\n<!-- rdev:policy:end -->\n", "utf8");
  await installProjectSkill(temporaryDirectory);
  await assert.rejects(() => stat(legacySkill), /ENOENT/);
  const policy = await readFile(path.join(temporaryDirectory, "AGENTS.override.md"), "utf8");
  assert.match(policy, /<!-- machora:generated-local-override -->/);
  assert.doesNotMatch(policy, /rdev:policy/);
});
