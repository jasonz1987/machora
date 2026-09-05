const ACTIVE = new Set(["queued", "dispatched", "running"]);

// Poll one exact Job; a successful shell command is not proof that the tool is detectable.
export function monitorInstallation({ job, readJob, recheck, onChange, interval = 3000, verificationTimeout = 120000, now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
  const controller = new AbortController();
  let timer;
  let completedAt;
  let current = job;
  const emit = (phase, error = "") => {
    if (!controller.signal.aborted) onChange({ phase, job: current, error });
  };
  async function poll() {
    try {
      current = await readJob(current.id, controller.signal);
      if (controller.signal.aborted) return;
      if (ACTIVE.has(current.status)) emit("installing");
      else if (current.status === "succeeded") {
        completedAt ??= now();
        emit("verifying");
        const ready = await recheck(controller.signal);
        if (controller.signal.aborted) return;
        if (ready) { emit("succeeded"); return; }
        if (now() - completedAt >= verificationTimeout) { emit("unverified"); return; }
      } else { emit(current.status, current.error || ""); return; }
    } catch (error) {
      if (controller.signal.aborted) return;
      emit("reconnecting", `Status check failed; retrying. ${error.message}`);
      if (completedAt !== undefined && now() - completedAt >= verificationTimeout) { emit("unverified", error.message); return; }
    }
    if (!controller.signal.aborted) timer = schedule(poll, interval);
  }
  emit("installing");
  void poll();
  return () => { controller.abort(); cancel(timer); };
}
