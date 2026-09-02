import { execFile, spawnSync } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function chooseProjectDirectory({ platform = os.platform(), run = runCommand, findCommand = resolveCommand } = {}) {
  const command = dialogCommand(platform, findCommand);
  if (!command) throw Object.assign(new Error("No supported native folder picker is available on this controller"), { statusCode: 501 });
  try {
    const result = await run(command.file, command.args);
    return normalizeSelectedPath(result?.stdout);
  } catch (error) {
    if (isCancellation(error, platform)) return null;
    throw Object.assign(new Error(`Could not open the native folder picker: ${cleanMessage(error.stderr || error.message)}`), { statusCode: 500 });
  }
}

function dialogCommand(platform, findCommand) {
  if (platform === "darwin") {
    return {
      file: "osascript",
      args: [
        "-e", 'set chosenFolder to choose folder with prompt "Choose a local Git project"',
        "-e", "POSIX path of chosenFolder",
      ],
    };
  }
  if (platform === "win32") {
    return {
      file: "powershell.exe",
      args: ["-NoProfile", "-STA", "-Command", [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
        "$dialog.Description = 'Choose a local Git project'",
        "$dialog.ShowNewFolderButton = $false",
        "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
      ].join("; ")],
    };
  }
  if (platform === "linux") {
    const zenity = findCommand("zenity");
    if (zenity) return { file: zenity, args: ["--file-selection", "--directory", "--title=Choose a local Git project"] };
    const kdialog = findCommand("kdialog");
    if (kdialog) return { file: kdialog, args: ["--getexistingdirectory", os.homedir(), "--title", "Choose a local Git project"] };
  }
  return null;
}

async function runCommand(file, args) {
  return execFileAsync(file, args, { encoding: "utf8", timeout: 10 * 60 * 1000, maxBuffer: 256 * 1024, windowsHide: false });
}

function resolveCommand(executable) {
  const result = spawnSync("sh", ["-c", `command -v ${executable}`], { encoding: "utf8", timeout: 1500 });
  return result.status === 0 ? String(result.stdout || "").trim() : "";
}

function normalizeSelectedPath(value) {
  const selected = String(value || "").trim();
  if (!selected) return null;
  if (selected === "/" || /^[A-Za-z]:[\\/]$/.test(selected)) return selected;
  return selected.replace(/[\\/]+$/, "");
}

function isCancellation(error, platform) {
  const message = `${error?.message || ""}\n${error?.stderr || ""}`;
  if (platform === "darwin") return /user canceled|-128/i.test(message);
  if (platform === "linux") return error?.code === 1 || error?.code === 255;
  return false;
}

function cleanMessage(value) {
  return String(value || "Unknown error").replace(/\s+/g, " ").trim().slice(0, 240);
}
