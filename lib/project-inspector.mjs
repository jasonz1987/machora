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
    requirements: projectType.requirements || [],
  };
}

async function detectProjectType(root) {
  const packageJson = await readFile(path.join(root, "package.json"), "utf8").then(JSON.parse).catch(() => null);
  if (packageJson) {
    const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
    const name = detectJavaScriptFramework(dependencies);
    const declared = String(packageJson.packageManager || "").split("@")[0];
    const lockManager = await firstExisting(root, [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"], ["package-lock.json", "npm"]]);
    const packageManager = declared || lockManager;
    const manager = packageManager || "npm";
    const scripts = packageJson.scripts || {};
    const nodeVersion = await declaredNodeVersion(root, packageJson);
    const frameworks = [name];
    if (dependencies.typescript || await exists(path.join(root, "tsconfig.json"))) frameworks.push("TypeScript");
    if (dependencies.tailwindcss || dependencies["@tailwindcss/postcss"]) frameworks.push("Tailwind CSS");
    if (packageJson.workspaces || await hasPnpmWorkspacePackages(root)) frameworks.push("Monorepo");
    return {
      name,
      packageManager: manager,
      frameworks: unique(frameworks),
      languages: dependencies.typescript || await exists(path.join(root, "tsconfig.json")) ? ["TypeScript", "JavaScript"] : ["JavaScript"],
      commands: packageCommands(manager, scripts, lockManager === manager),
      devPort: defaultDevPort(name),
      requirements: [
        runtimeRequirement("node", "Node.js", nodeVersion, nodeVersion ? "project version declaration" : "package.json"),
        commandRequirement(manager, packageManagerLabel(manager), packageManager ? `packageManager / ${lockManager ? `${lockManager} lockfile` : "package.json"}` : "package.json"),
      ],
    };
  }
  if (await exists(path.join(root, "pubspec.yaml"))) return { name: "Flutter", packageManager: "flutter", frameworks: ["Flutter", "Dart"], languages: ["Dart"], commands: { install: "flutter pub get", test: "flutter test", build: "", dev: "flutter run -d web-server --web-hostname 0.0.0.0 --web-port 3000", deploy: "" }, devPort: 3000, requirements: [commandRequirement("flutter", "Flutter SDK", "pubspec.yaml")] };
  if (await exists(path.join(root, "pom.xml"))) {
    const javaVersion = await declaredJavaVersion(root, "pom.xml");
    return { name: "Java / Maven", packageManager: "maven", frameworks: ["Maven"], languages: ["Java"], commands: { install: "mvn dependency:go-offline", test: "mvn test", build: "mvn package", dev: "", deploy: "" }, requirements: [runtimeRequirement("java", "JDK", javaVersion, "pom.xml", "javac"), commandRequirement("mvn", "Maven", "pom.xml")] };
  }
  if (await exists(path.join(root, "build.gradle")) || await exists(path.join(root, "build.gradle.kts"))) {
    const filename = await exists(path.join(root, "build.gradle.kts")) ? "build.gradle.kts" : "build.gradle";
    const javaVersion = await declaredJavaVersion(root, filename);
    const wrapper = await exists(path.join(root, "gradlew"));
    return { name: "Java / Gradle", packageManager: "gradle", frameworks: ["Gradle"], languages: ["Java", "Kotlin"], commands: { install: "./gradlew dependencies", test: "./gradlew test", build: "./gradlew build", dev: "", deploy: "" }, requirements: [runtimeRequirement("java", "JDK", javaVersion, filename, "javac"), ...(wrapper ? [] : [commandRequirement("gradle", "Gradle", filename)])] };
  }
  if (await exists(path.join(root, "pyproject.toml")) || await exists(path.join(root, "requirements.txt"))) {
    const version = await readFile(path.join(root, ".python-version"), "utf8").then((value) => value.trim()).catch(() => null);
    return { name: "Python", packageManager: "pip", frameworks: ["Python"], languages: ["Python"], commands: { install: "python -m pip install -r requirements.txt", test: "python -m pytest", build: "", dev: "", deploy: "" }, requirements: [runtimeRequirement("python", "Python", version, version ? ".python-version" : "Python project", "python3")] };
  }
  if (await exists(path.join(root, "Package.swift"))) return { name: "Swift", packageManager: "swiftpm", frameworks: ["Swift Package"], languages: ["Swift"], commands: { install: "swift package resolve", test: "swift test", build: "swift build -c release", dev: "", deploy: "" } };
  if (await exists(path.join(root, "go.mod"))) return { name: "Go", packageManager: "go", frameworks: ["Go modules"], languages: ["Go"], commands: { install: "go mod download", test: "go test ./...", build: "go build ./...", dev: "", deploy: "" } };
  if (await exists(path.join(root, "Cargo.toml"))) return { name: "Rust", packageManager: "cargo", frameworks: ["Cargo"], languages: ["Rust"], commands: { install: "cargo fetch", test: "cargo test", build: "cargo build --release", dev: "", deploy: "" } };
  return { name: "Git", packageManager: null, frameworks: ["Git"], languages: [], commands: emptyCommands(), requirements: [commandRequirement("git", "Git", "Git repository")] };
}

async function declaredNodeVersion(root, packageJson) {
  for (const filename of [".nvmrc", ".node-version"]) {
    const value = await readFile(path.join(root, filename), "utf8").then((source) => source.trim()).catch(() => "");
    if (value) return value.replace(/^v/, "");
  }
  return String(packageJson.engines?.node || "").trim() || null;
}

async function declaredJavaVersion(root, filename) {
  const source = await readFile(path.join(root, filename), "utf8").catch(() => "");
  const patterns = filename === "pom.xml"
    ? [/<java\.version>\s*([^<]+)\s*<\/java\.version>/i, /<maven\.compiler\.release>\s*([^<]+)\s*<\/maven\.compiler\.release>/i, /<maven\.compiler\.source>\s*([^<]+)\s*<\/maven\.compiler\.source>/i]
    : [/languageVersion\s*=\s*JavaLanguageVersion\.of\((\d+)\)/i, /sourceCompatibility\s*=\s*(?:JavaVersion\.VERSION_)?([\d_]+)/i];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1] && !match[1].includes("${")) return match[1].replace(/^1\./, "").replace(/_/g, ".").trim();
  }
  return null;
}

function runtimeRequirement(tool, label, version, source, executable = tool) {
  return { id: tool, kind: "runtime", tool, executable, label, version: version || null, source, required: true };
}

function commandRequirement(executable, label, source) {
  return { id: executable, kind: "command", tool: null, executable, label, version: null, source, required: true };
}

function packageManagerLabel(manager) {
  return manager === "pnpm" ? "pnpm" : manager === "npm" ? "npm" : manager === "yarn" ? "Yarn" : manager === "bun" ? "Bun" : manager;
}

function detectJavaScriptFramework(dependencies) {
  if (dependencies.next) return "Next.js";
  if (dependencies["@umijs/max"] || dependencies.umi || dependencies["@umijs/preset-umi"] || dependencies["umi-presets-pro"]) return "Umi";
  if (dependencies.astro) return "Astro";
  if (dependencies["@sveltejs/kit"]) return "SvelteKit";
  if (dependencies.vite) return "Vite";
  if (dependencies["@angular/core"]) return "Angular";
  if (dependencies["react-scripts"]) return "Create React App";
  if (dependencies.react) return "React";
  return "Node.js";
}

function defaultDevPort(name) {
  if (["Next.js", "Create React App"].includes(name)) return 3000;
  if (name === "Umi") return 8000;
  if (["Vite", "SvelteKit"].includes(name)) return 5173;
  if (name === "Astro") return 4321;
  if (name === "Angular") return 4200;
  return null;
}

async function hasPnpmWorkspacePackages(root) {
  const source = await readFile(path.join(root, "pnpm-workspace.yaml"), "utf8").catch(() => "");
  return /^\s*packages\s*:/m.test(source);
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
