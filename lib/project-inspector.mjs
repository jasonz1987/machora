import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function inspectLocalProject(inputPath = process.cwd()) {
  const requestedPath = expandHome(String(inputPath || ".").trim());
  const absolutePath = path.resolve(requestedPath);
  const information = await stat(absolutePath).catch(() => null);
  if (!information?.isDirectory()) throw Object.assign(new Error(`Project directory not found: ${absolutePath}`), { statusCode: 400 });

  let root;
  try {
    root = (await runGit(absolutePath, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    throw Object.assign(new Error(`Not a Git repository: ${absolutePath}`), { statusCode: 400 });
  }

  const [branchResult, commitResult, remoteResult, statusResult, projectType] = await Promise.all([
    runGit(root, ["branch", "--show-current"], true),
    runGit(root, ["rev-parse", "--short=12", "HEAD"], true),
    runGit(root, ["remote", "get-url", "origin"], true),
    runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"], true),
    detectProjectType(root),
  ]);
  const statusLines = statusResult.split(/\r?\n/).filter(Boolean);

  return {
    name: path.basename(root),
    localPath: path.resolve(root),
    branch: branchResult.trim() || "detached",
    commit: commitResult.trim() || null,
    gitRemote: remoteResult.trim() || null,
    dirty: statusLines.length > 0,
    changedFiles: statusLines.length,
    projectType: projectType.name,
    packageManager: projectType.packageManager,
    frameworks: projectType.frameworks,
    languages: projectType.languages,
    commands: projectType.commands,
    devPort: projectType.devPort,
  };
}

async function detectProjectType(root) {
  const packageJson = await readFile(path.join(root, "package.json"), "utf8").then(JSON.parse).catch(() => null);
  if (packageJson) {
    const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
    const name = dependencies.next ? "Next.js" : dependencies.vite ? "Vite" : dependencies.react ? "React" : "Node.js";
    const declared = String(packageJson.packageManager || "").split("@")[0];
    const lockManager = await firstExisting(root, [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"], ["package-lock.json", "npm"]]);
    const packageManager = declared || lockManager;
    const manager = packageManager || "npm";
    const scripts = packageJson.scripts || {};
    const frameworks = [name];
    if (dependencies.typescript || await exists(path.join(root, "tsconfig.json"))) frameworks.push("TypeScript");
    if (dependencies.tailwindcss || dependencies["@tailwindcss/postcss"]) frameworks.push("Tailwind CSS");
    if (await exists(path.join(root, "pnpm-workspace.yaml")) || packageJson.workspaces) frameworks.push("Monorepo");
    return {
      name,
      packageManager: manager,
      frameworks: unique(frameworks),
      languages: dependencies.typescript || await exists(path.join(root, "tsconfig.json")) ? ["TypeScript", "JavaScript"] : ["JavaScript"],
      commands: packageCommands(manager, scripts, lockManager === manager),
      devPort: name === "Vite" ? 5173 : 3000,
    };
  }
  if (await exists(path.join(root, "pubspec.yaml"))) return { name: "Flutter", packageManager: "flutter", frameworks: ["Flutter", "Dart"], languages: ["Dart"], commands: { install: "flutter pub get", test: "flutter test", build: "", dev: "flutter run -d web-server --web-hostname 0.0.0.0 --web-port 3000", deploy: "" }, devPort: 3000 };
  if (await exists(path.join(root, "pom.xml"))) return { name: "Java / Maven", packageManager: "maven", frameworks: ["Maven"], languages: ["Java"], commands: { install: "mvn dependency:go-offline", test: "mvn test", build: "mvn package", dev: "", deploy: "" } };
  if (await exists(path.join(root, "build.gradle")) || await exists(path.join(root, "build.gradle.kts"))) return { name: "Java / Gradle", packageManager: "gradle", frameworks: ["Gradle"], languages: ["Java", "Kotlin"], commands: { install: "./gradlew dependencies", test: "./gradlew test", build: "./gradlew build", dev: "", deploy: "" } };
  if (await exists(path.join(root, "Package.swift"))) return { name: "Swift", packageManager: "swiftpm", frameworks: ["Swift Package"], languages: ["Swift"], commands: { install: "swift package resolve", test: "swift test", build: "swift build -c release", dev: "", deploy: "" } };
  if (await exists(path.join(root, "go.mod"))) return { name: "Go", packageManager: "go", frameworks: ["Go modules"], languages: ["Go"], commands: { install: "go mod download", test: "go test ./...", build: "go build ./...", dev: "", deploy: "" } };
  if (await exists(path.join(root, "Cargo.toml"))) return { name: "Rust", packageManager: "cargo", frameworks: ["Cargo"], languages: ["Rust"], commands: { install: "cargo fetch", test: "cargo test", build: "cargo build --release", dev: "", deploy: "" } };
  return { name: "Git", packageManager: null, frameworks: ["Git"], languages: [], commands: emptyCommands() };
}

function packageCommands(manager, scripts, hasLock) {
  const run = (name) => scripts[name] ? `${manager} run ${name}` : "";
  const install = manager === "pnpm"
    ? `pnpm install${hasLock ? " --frozen-lockfile" : ""}`
    : manager === "yarn"
      ? `yarn install${hasLock ? " --frozen-lockfile" : ""}`
      : manager === "bun"
        ? `bun install${hasLock ? " --frozen-lockfile" : ""}`
        : hasLock ? "npm ci" : "npm install";
  return {
    install,
    test: run("test") || run("check"),
    build: run("build"),
    dev: run("dev") || run("start"),
    deploy: run("deploy"),
  };
}

function emptyCommands() { return { install: "", test: "", build: "", dev: "", deploy: "" }; }

function unique(values) { return [...new Set(values.filter(Boolean))]; }

async function runGit(directory, args, allowFailure = false) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", directory, ...args], { encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

async function firstExisting(root, candidates) {
  for (const [filename, result] of candidates) if (await exists(path.join(root, filename))) return result;
  return null;
}

async function exists(target) {
  return stat(target).then(() => true).catch(() => false);
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return value;
}
