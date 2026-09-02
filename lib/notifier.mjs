import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export async function notifyJobCompletion(job, options = {}) {
  if (process.env.MACHORA_DISABLE_NOTIFICATIONS === "1" || process.env.RDEV_DISABLE_NOTIFICATIONS === "1" || !job) return false;
  const platform = options.platform || os.platform();
  const { title, body } = notificationContent(job);
  const detailUrl = jobDetailUrl(options.dashboardOrigin, job.id);
  try {
    if (platform === "darwin") {
      const terminalNotifier = options.terminalNotifierPath || findExecutable("terminal-notifier", options.pathValue);
      if (terminalNotifier && detailUrl) {
        (options.launch || launch)(terminalNotifier, [
          "-title", title,
          "-message", body,
          "-group", `machora-job-${job.id}`,
          "-open", detailUrl,
        ]);
        return true;
      }
      if (detailUrl) return false;
      (options.launch || launch)("osascript", [
        "-e", "on run argv",
        "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e", "end run",
        "--", title, body,
      ]);
      return true;
    }
    if (platform === "win32") {
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$n = New-Object System.Windows.Forms.NotifyIcon",
        "$n.Icon = [System.Drawing.SystemIcons]::Information",
        `$n.BalloonTipTitle = ${powershellQuote(title)}`,
        `$n.BalloonTipText = ${powershellQuote(body)}`,
        "$n.Visible = $true",
        "$n.ShowBalloonTip(5000)",
        "Start-Sleep -Seconds 6",
        "$n.Dispose()",
      ].join("; ");
      (options.launch || launch)("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script]);
      return true;
    }
    (options.launch || launch)("notify-send", [title, body]);
    return true;
  } catch {
    return false;
  }
}

export function jobDetailUrl(origin, jobId) {
  if (!origin || !jobId) return null;
  try {
    const url = new URL(origin);
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    url.searchParams.set("view", "jobs");
    url.searchParams.set("job", jobId);
    return url.toString();
  } catch {
    return null;
  }
}

function notificationContent(job) {
  const operation = job.type === "host-command" ? "Remote command" : job.type === "sync" ? "Git sync" : job.operation || "Job";
  const success = job.status === "succeeded";
  return {
    title: `Machora · ${job.project?.name || job.host?.alias || "Task machine"}`,
    body: success && job.result?.previewUrl
      ? `${operation} completed · preview ready`
      : `${operation} ${success ? "completed" : "failed"} on ${job.host?.alias || "task machine"}`,
  };
}

function findExecutable(name, pathValue = process.env.PATH || "") {
  for (const directory of String(pathValue).split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function launch(command, args) {
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

function powershellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
