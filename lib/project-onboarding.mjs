import path from "node:path";

const MANAGED_RUNTIMES = new Set(["node", "java", "python"]);

export function analyzeProjectAssignment(project, host) {
  if (!host) throw Object.assign(new Error("Task machine not found"), { statusCode: 404 });
  const requirements = (project.requirements || []).map((requirement) => analyzeRequirement(requirement, host));
  const blockers = [];
  const warnings = [];
  if (host.status !== "online") blockers.push(`${host.alias} is offline. Start its Agent before assigning this project.`);
  if (!project.gitRemote) blockers.push("The repository has no origin remote. Add and push an origin before assigning it.");
  if (project.dirty) warnings.push(`${project.changedFiles} local change${project.changedFiles === 1 ? " is" : "s are"} not available to the task machine until committed and pushed.`);
  for (const item of requirements) {
    if (item.status === "missing") blockers.push(`${item.label} is not available on ${host.alias}.`);
    if (item.status === "mismatch") blockers.push(`${item.label} ${item.requiredVersion} is required, but ${item.detectedVersion} is active on ${host.alias}.`);
  }
  const toolchain = Object.fromEntries(["node", "java", "python"].map((tool) => {
    const requirement = requirements.find((item) => item.tool === tool);
    return [tool, requirement?.managedVersion || null];
  }));
  return {
    project,
    host,
    remotePath: remoteProjectPath(host.workspace, project.name, host.os),
    requirements,
    commands: project.commands,
    toolchain,
    blockers,
    warnings,
    ready: blockers.length === 0,
  };
}

function analyzeRequirement(requirement, host) {
  const tools = Array.isArray(host.tools) ? host.tools : [];
  const runtimes = Array.isArray(host.runtimes) ? host.runtimes : [];
  const executableIds = requirement.executable === "python3" ? ["python3", "python"] : [requirement.executable];
  const systemTool = tools.find((tool) => executableIds.includes(tool.id));
  const managed = requirement.tool ? runtimes.filter((item) => item.tool === requirement.tool && item.installed !== false) : [];
  const matchingManaged = managed.find((item) => versionSatisfies(item.version, requirement.version, requirement.tool));
  const systemMatches = systemTool && versionSatisfies(systemTool.version, requirement.version, requirement.tool);
  const detectedVersion = matchingManaged?.version || systemTool?.version || managed[0]?.version || null;
  let status = matchingManaged || systemMatches ? "ready" : detectedVersion ? "mismatch" : "missing";
  if (!requirement.version && detectedVersion) status = "ready";
  return {
    ...requirement,
    status,
    requiredVersion: requirement.version || "any supported version",
    detectedVersion,
    source: requirement.source || "project files",
    managedVersion: matchingManaged?.version || null,
    suggestedVersion: suggestedVersion(requirement.tool, requirement.version),
    canInstall: requirement.kind === "runtime" && MANAGED_RUNTIMES.has(requirement.tool) && Boolean(requirement.version) && host.status === "online",
    commandAction: status === "ready" ? null : suggestedCommandAction(requirement, host),
  };
}

function suggestedCommandAction(requirement, host) {
  if (requirement.executable !== "mvn") return null;
  return {
    label: "Install Maven",
    title: "Install Maven",
    command: mavenInstallCommand(host.os),
    workingDirectory: host.workspace,
  };
}

function mavenInstallCommand(osName) {
  if (osName === "windows") {
    // Allocate scratch space at execution time, not when the UI suggests the command.
    // Keep an exclusive handle until completion to guard the shared install/shim paths.
    const script = [
      "$ErrorActionPreference='Stop'",
      "$version='3.9.16'",
      "$root=Join-Path $env:USERPROFILE '.machora-tools'",
      "New-Item -ItemType Directory -Force -Path $root | Out-Null",
      "$mavenLockPath=Join-Path $root '.maven-install.lock'",
      "try { $mavenLock=[IO.File]::Open($mavenLockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) } catch { throw ('Cannot acquire Maven installation lock; another installation may still be running. '+$_.Exception.Message) }",
      "$mavenTempDir=$null",
      "try {",
      "$mavenTempDir=Join-Path $env:TEMP ('machora-maven-'+[Guid]::NewGuid().ToString('N'))",
      "New-Item -ItemType Directory -Path $mavenTempDir | Out-Null",
      "$archive=Join-Path $mavenTempDir ('apache-maven-'+$version+'-bin.zip')",
      "Write-Output 'Downloading Maven…'",
      "Invoke-WebRequest -UseBasicParsing -TimeoutSec 300 ('https://dlcdn.apache.org/maven/maven-3/'+$version+'/binaries/apache-maven-'+$version+'-bin.zip') -OutFile $archive",
      "Write-Output 'Extracting Maven…'",
      "Expand-Archive -LiteralPath $archive -DestinationPath $root -Force",
      "$mavenInstallDir=Join-Path $root ('apache-maven-'+$version)",
      "[Environment]::SetEnvironmentVariable('MAVEN_HOME',$mavenInstallDir,'User')",
      "$env:MAVEN_HOME=$mavenInstallDir",
      "$bin=Join-Path $mavenInstallDir 'bin'",
      "$shimDir=Join-Path $env:APPDATA 'npm'",
      "New-Item -ItemType Directory -Force -Path $shimDir | Out-Null",
      // Avoid embedded double quotes passing through both cmd.exe and PowerShell.
      "Set-Content -Path (Join-Path $shimDir 'mvn.cmd') -Value ('@echo off'+[Environment]::NewLine+'call '+[char]34+(Join-Path $bin 'mvn.cmd')+[char]34+' %*') -Encoding ASCII",
      "Write-Output 'Verifying Maven…'",
      "& (Join-Path $bin 'mvn.cmd') --version",
      "if ($LASTEXITCODE -ne 0) { throw ('Maven verification failed with exit code '+$LASTEXITCODE) }",
      "} finally { try { if ($mavenTempDir -and (Test-Path -LiteralPath $mavenTempDir)) { Remove-Item -LiteralPath $mavenTempDir -Recurse -Force -ErrorAction SilentlyContinue } } finally { $mavenLock.Dispose() } }",
    ].join("; ");
    return `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${script}"`;
  }
  if (osName === "macos") return "brew install maven";
  return "if command -v apt-get >/dev/null 2>&1; then sudo apt-get update && sudo apt-get install -y maven; elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y maven; elif command -v yum >/dev/null 2>&1; then sudo yum install -y maven; elif command -v pacman >/dev/null 2>&1; then sudo pacman -S --needed maven; else echo 'No supported package manager found; edit this command for the task machine.' >&2; exit 1; fi";
}

function versionSatisfies(actual, expected, tool) {
  if (!actual) return false;
  if (!expected) return true;
  const actualMajor = versionMajor(actual);
  const expectedMajor = versionMajor(expected);
  if (!actualMajor || !expectedMajor) return String(actual).toLowerCase() === String(expected).toLowerCase();
  const source = String(expected).trim();
  if (/^\s*>\s*/.test(source) && !/^\s*>=/.test(source)) return actualMajor > expectedMajor;
  if (/^\s*>=/.test(source)) return actualMajor >= expectedMajor;
  if (/^\s*<=/.test(source)) return actualMajor <= expectedMajor;
  if (/^\s*</.test(source)) return actualMajor < expectedMajor;
  if (tool === "java") return actualMajor === expectedMajor;
  return actualMajor === expectedMajor;
}

function versionMajor(value) {
  const match = String(value || "").match(/(?:^|[^\d])(\d{1,3})(?:[._+-]|$)/);
  return match ? Number(match[1]) : null;
}

function suggestedVersion(tool, expected) {
  const major = versionMajor(expected);
  if (!tool || !major) return null;
  return tool === "java" ? `temurin-${major}` : String(major);
}

function remoteProjectPath(workspace, name, osName) {
  const separator = osName === "windows" ? "\\" : "/";
  return `${String(workspace || "~/Code").replace(/[\\/]+$/, "")}${separator}${path.basename(String(name || "project"))}`;
}
