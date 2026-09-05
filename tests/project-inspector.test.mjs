import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { inspectLocalProject } from "../lib/project-inspector.mjs";

let temporaryDirectory; let repository;

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "machora-project-inspector-"));
  repository = path.join(temporaryDirectory, "sample-next-app");
  await mkdir(repository);
  execFileSync("git", ["init", "-b", "main", repository]);
  execFileSync("git", ["-C", repository, "config", "user.email", "machora@example.test"]);
  execFileSync("git", ["-C", repository, "config", "user.name", "machora test"]);
  await writeFile(path.join(repository, "package.json"), JSON.stringify({ packageManager: "pnpm@10.0.0", scripts: { test: "vitest run", build: "next build" }, dependencies: { next: "16.0.0", typescript: "5.9.0" } }));
  await writeFile(path.join(repository, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  execFileSync("git", ["-C", repository, "add", "package.json", "pnpm-lock.yaml"]);
  execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);
  execFileSync("git", ["-C", repository, "remote", "add", "origin", "git@example.test:team/sample.git"]);
  await writeFile(path.join(repository, "README.md"), "local change\n");
});

after(async () => { await rm(temporaryDirectory, { recursive: true, force: true }); });

test("inspects Git and project metadata without modifying the repository", async () => {
  const project = await inspectLocalProject(repository);
  assert.equal(project.name, "sample-next-app"); assert.equal(project.branch, "main");
  assert.equal(project.gitRemote, "git@example.test:team/sample.git"); assert.equal(project.projectType, "Next.js");
  assert.equal(project.packageManager, "pnpm"); assert.equal(project.dirty, true); assert.equal(project.changedFiles, 1);
  assert.deepEqual(project.frameworks, ["Next.js", "TypeScript"]);
  assert.equal(project.commands.install, "pnpm install --frozen-lockfile");
  assert.equal(project.commands.test, "pnpm run test"); assert.equal(project.commands.build, "pnpm run build");
});

test("detects a Flutter project and proposes safe starter commands", async () => {
  const flutterRepository = path.join(temporaryDirectory, "sample-flutter-app");
  await mkdir(flutterRepository);
  execFileSync("git", ["init", "-b", "main", flutterRepository]);
  execFileSync("git", ["-C", flutterRepository, "config", "user.email", "machora@example.test"]);
  execFileSync("git", ["-C", flutterRepository, "config", "user.name", "machora test"]);
  await writeFile(path.join(flutterRepository, "pubspec.yaml"), "name: sample_flutter_app\n");
  execFileSync("git", ["-C", flutterRepository, "add", "pubspec.yaml"]);
  execFileSync("git", ["-C", flutterRepository, "commit", "-m", "initial"]);
  const project = await inspectLocalProject(flutterRepository);
  assert.equal(project.projectType, "Flutter"); assert.equal(project.packageManager, "flutter");
  assert.equal(project.commands.install, "flutter pub get"); assert.equal(project.commands.test, "flutter test");
  assert.equal(project.commands.build, "");
  assert.match(project.commands.dev, /web-server/); assert.equal(project.devPort, 3000);
});

test("detects Umi separately from generic React and uses its framework default port", async () => {
  const umiRepository = path.join(temporaryDirectory, "sample-umi-app");
  await mkdir(umiRepository);
  execFileSync("git", ["init", "-b", "main", umiRepository]);
  execFileSync("git", ["-C", umiRepository, "config", "user.email", "machora@example.test"]);
  execFileSync("git", ["-C", umiRepository, "config", "user.name", "machora test"]);
  await writeFile(path.join(umiRepository, "package.json"), JSON.stringify({ scripts: { dev: "max dev" }, dependencies: { "@umijs/max": "4.3.6", react: "18.3.1" } }));
  await writeFile(path.join(umiRepository, "pnpm-workspace.yaml"), "onlyBuiltDependencies:\n  - esbuild\n");
  execFileSync("git", ["-C", umiRepository, "add", "package.json", "pnpm-workspace.yaml"]);
  execFileSync("git", ["-C", umiRepository, "commit", "-m", "initial"]);
  const project = await inspectLocalProject(umiRepository);
  assert.equal(project.projectType, "Umi");
  assert.equal(project.devPort, 8000);
  assert.deepEqual(project.frameworks, ["Umi"]);
});

test("does not force a port for an unrecognized React setup", async () => {
  const reactRepository = path.join(temporaryDirectory, "sample-react-app");
  await mkdir(reactRepository);
  execFileSync("git", ["init", "-b", "main", reactRepository]);
  execFileSync("git", ["-C", reactRepository, "config", "user.email", "machora@example.test"]);
  execFileSync("git", ["-C", reactRepository, "config", "user.name", "machora test"]);
  await writeFile(path.join(reactRepository, "package.json"), JSON.stringify({ scripts: { dev: "custom-dev-server" }, dependencies: { react: "19.0.0" } }));
  execFileSync("git", ["-C", reactRepository, "add", "package.json"]);
  execFileSync("git", ["-C", reactRepository, "commit", "-m", "initial"]);
  const project = await inspectLocalProject(reactRepository);
  assert.equal(project.projectType, "React");
  assert.equal(project.devPort, null);
});

test("detects declared Node and Java build requirements", async () => {
  const nodeProject = await inspectLocalProject(repository);
  assert.deepEqual(nodeProject.requirements.map((item) => item.id), ["node", "pnpm"]);

  const javaRepository = path.join(temporaryDirectory, "sample-java-app");
  await mkdir(javaRepository);
  execFileSync("git", ["init", "-b", "main", javaRepository]);
  execFileSync("git", ["-C", javaRepository, "config", "user.email", "machora@example.test"]);
  execFileSync("git", ["-C", javaRepository, "config", "user.name", "machora test"]);
  await writeFile(path.join(javaRepository, "pom.xml"), "<project><properties><java.version>17</java.version><maven.compiler.source>17</maven.compiler.source></properties></project>\n");
  execFileSync("git", ["-C", javaRepository, "add", "pom.xml"]);
  execFileSync("git", ["-C", javaRepository, "commit", "-m", "initial"]);
  execFileSync("git", ["-C", javaRepository, "remote", "add", "origin", "git@example.test:team/java.git"]);
  const javaProject = await inspectLocalProject(javaRepository);
  assert.equal(javaProject.projectType, "Java / Maven");
  assert.deepEqual(javaProject.requirements.map((item) => [item.id, item.version]), [["java", "17"], ["mvn", null]]);
});
