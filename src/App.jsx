import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, Apple, Check, CheckCircle2, ChevronDown, CircleX, Clock3, Code2, Copy, ExternalLink, FolderGit2, FolderOpen, GitBranch, GitMerge, Github, Laptop, ListChecks, MoreHorizontal, Play, Plus, RefreshCw, Save, ScanSearch, Server, ShieldAlert, Sparkles, SquareTerminal, Terminal, Trash2, Workflow, X } from "lucide-react";

const EMPTY_FORM = { alias: "", os: "auto", workspace: "~/Code" };
const EMPTY_PROJECT_FORM = { localPath: "~/Code/", host: "" };
const MACHORA_VERSION = typeof __MACHORA_VERSION__ === "string" ? __MACHORA_VERSION__ : "development";
const LATEST_AGENT_VERSION = MACHORA_VERSION;

function initialDashboardLocation() {
  if (typeof window === "undefined") return { view: "hosts", jobId: null };
  const parameters = new URLSearchParams(window.location.search);
  const jobId = parameters.get("job");
  const requestedView = parameters.get("view");
  return {
    view: jobId ? "jobs" : ["hosts", "projects", "jobs"].includes(requestedView) ? requestedView : "hosts",
    jobId,
  };
}

export function App() {
  const initialLocation = useMemo(initialDashboardLocation, []);
  const [hosts, setHosts] = useState([]);
  const [projects, setProjects] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [view, setView] = useState(initialLocation.view);
  const [loading, setLoading] = useState(true);
  const [panelOpen, setPanelOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [enrollment, setEnrollment] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [controller, setController] = useState(null);
  const [projectPanelOpen, setProjectPanelOpen] = useState(false);
  const [projectForm, setProjectForm] = useState(EMPTY_PROJECT_FORM);
  const [projectSetupId, setProjectSetupId] = useState(null);
  const [jobSetupId, setJobSetupId] = useState(initialLocation.jobId);
  const [hostCommandId, setHostCommandId] = useState(null);
  const [jobToast, setJobToast] = useState(null);
  const knownJobStates = useRef(new Map());

  const loadHosts = useCallback(async () => {
    try {
      const response = await fetch("/api/hosts");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load task machines");
      setHosts(data.hosts);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const response = await fetch("/api/projects");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load projects");
      setProjects(data.projects);
    } catch (requestError) {
      setError(requestError.message);
    }
  }, []);

  const loadJobs = useCallback(async () => {
    try {
      const response = await fetch("/api/jobs");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load Jobs");
      const previous = knownJobStates.current;
      if (previous.size) {
        const completed = data.jobs.find((job) => ["succeeded", "failed"].includes(job.status) && previous.get(job.id) && previous.get(job.id) !== job.status);
        if (completed) setJobToast(completed);
      }
      knownJobStates.current = new Map(data.jobs.map((job) => [job.id, job.status]));
      setJobs(data.jobs);
    } catch (requestError) { setError(requestError.message); }
  }, []);

  useEffect(() => { loadHosts(); loadProjects(); loadJobs(); }, [loadHosts, loadProjects, loadJobs]);

  useEffect(() => {
    fetch("/api/health").then((response) => response.json()).then(setController).catch(() => {});
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => { loadHosts(); loadProjects(); loadJobs(); }, 3000);
    return () => window.clearInterval(timer);
  }, [loadHosts, loadProjects, loadJobs]);

  useEffect(() => {
    if (!jobToast) return undefined;
    const timer = window.setTimeout(() => setJobToast(null), 6500);
    return () => window.clearTimeout(timer);
  }, [jobToast]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (view === "hosts") url.searchParams.delete("view");
    else url.searchParams.set("view", view);
    if (jobSetupId) url.searchParams.set("job", jobSetupId);
    else url.searchParams.delete("job");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [view, jobSetupId]);

  useEffect(() => {
    if (!enrollment?.enrollment?.token || enrollment.enrollment.usedAt) return undefined;
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/enrollments/${enrollment.enrollment.token}`);
      if (!response.ok) return;
      const data = await response.json();
      if (data.host) {
        setEnrollment((current) => ({ ...current, enrollment: data.enrollment, connectedHost: data.host }));
        loadHosts();
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [enrollment?.enrollment?.token, enrollment?.enrollment?.usedAt, loadHosts]);

  function openPanel() { setForm(EMPTY_FORM); setEnrollment(null); setError(""); setPanelOpen(true); }

  function openProjectPanel() {
    setProjectForm({ ...EMPTY_PROJECT_FORM, host: hosts.find((host) => host.status === "online")?.id || hosts[0]?.id || "" });
    setError(""); setProjectPanelOpen(true);
  }

  async function createPairing(event) {
    event.preventDefault(); setSubmitting(true); setError("");
    try {
      const response = await fetch("/api/enrollments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not create enrollment");
      setEnrollment(data);
    } catch (requestError) { setError(requestError.message); } finally { setSubmitting(false); }
  }

  async function deleteHost(host) {
    if (!window.confirm(`Remove ${host.alias} from Machora?`)) return;
    const response = await fetch(`/api/hosts/${encodeURIComponent(host.id)}`, { method: "DELETE" });
    if (response.ok) await loadHosts();
  }

  async function assignProject(event) {
    event.preventDefault(); setSubmitting(true); setError("");
    try {
      const response = await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(projectForm) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not assign project");
      await loadProjects(); setProjectPanelOpen(false); setProjectSetupId(data.project.id); setView("projects");
    } catch (requestError) { setError(requestError.message); } finally { setSubmitting(false); }
  }

  async function deleteProject(project) {
    if (!window.confirm(`Remove the assignment for ${project.name}?`)) return;
    const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" });
    if (response.ok) await loadProjects();
  }

  const closePanels = useCallback(() => {
    setPanelOpen(false);
    setProjectPanelOpen(false);
    setProjectSetupId(null);
    setJobSetupId(null);
    setHostCommandId(null);
  }, []);

  const handleJobQueued = useCallback((job) => {
    knownJobStates.current.set(job.id, job.status);
    setProjectSetupId(null);
    setJobToast(job);
    void Promise.all([loadProjects(), loadJobs()]);
  }, [loadJobs, loadProjects]);

  const onlineCount = useMemo(() => hosts.filter((host) => host.status === "online").length, [hosts]);
  const setupProject = projects.find((project) => project.id === projectSetupId);
  const setupJob = jobs.find((job) => job.id === jobSetupId);
  const commandHost = hosts.find((host) => host.id === hostCommandId);
  const activeJobCount = jobs.filter((job) => ["queued", "dispatched", "running"].includes(job.status)).length;
  const drawerOpen = panelOpen || projectPanelOpen || Boolean(setupProject) || Boolean(setupJob);
  const anyOverlayOpen = drawerOpen || Boolean(commandHost);

  useEffect(() => {
    if (!anyOverlayOpen) return undefined;
    const closeOnEscape = (event) => { if (event.key === "Escape") closePanels(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [anyOverlayOpen, closePanels]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <a className="brand" href="/" aria-label="Machora home">machora</a><span className="topbar-divider" aria-hidden="true" />
          <nav className="section-nav" aria-label="Controller sections"><button className={view === "hosts" ? "active" : ""} type="button" onClick={() => setView("hosts")}>Hosts <span>{hosts.length}</span></button><button className={view === "projects" ? "active" : ""} type="button" onClick={() => setView("projects")}>Projects <span>{projects.length}</span></button><button className={view === "jobs" ? "active" : ""} type="button" onClick={() => setView("jobs")}>Jobs <span className={activeJobCount ? "nav-active-count" : ""}>{activeJobCount}</span></button></nav>
          <span className="sr-only">{loading ? "Loading machines" : `${hosts.length} machines, ${onlineCount} online`}</span>
        </div>
        {view === "hosts" ? <button className="primary-button" type="button" onClick={openPanel}><Plus size={18} strokeWidth={2.2} />Add machine</button> : view === "projects" ? <button className="primary-button" type="button" onClick={openProjectPanel} disabled={!hosts.length}><Plus size={18} strokeWidth={2.2} />Assign project</button> : <button className="secondary-button refresh-jobs" type="button" onClick={loadJobs}><RefreshCw size={16} />Refresh</button>}
      </header>

      <main className={`workspace ${drawerOpen ? "with-panel" : ""}`}>
        {view === "hosts" ? <section className="host-region" aria-labelledby="hosts-title">
          <div className="table-heading" id="hosts-title"><span>Host</span><span>OS</span><span>Status</span><span>Address</span><span>Environment</span><span>Jobs</span><span>CPU</span><span>Memory</span><span aria-hidden="true" /></div>
          {error && !anyOverlayOpen ? <div className="notice error-notice" role="alert">{error}</div> : null}
          {!loading && hosts.length === 0 ? <EmptyState onAdd={openPanel} /> : null}
          <div className="host-list">{hosts.map((host) => <HostRow key={host.id} host={host} controller={controller} onRunCommand={() => setHostCommandId(host.id)} onDelete={() => deleteHost(host)} />)}</div>
        </section> : view === "projects" ? <ProjectsRegion projects={projects} onAssign={openProjectPanel} onDelete={deleteProject} onOpen={(project) => { setError(""); setProjectSetupId(project.id); }} /> : <JobsRegion jobs={jobs} onOpen={(job) => setJobSetupId(job.id)} />}
        {panelOpen ? <EnrollmentPanel form={form} setForm={setForm} enrollment={enrollment} error={error} submitting={submitting} onSubmit={createPairing} onClose={() => setPanelOpen(false)} /> : null}
        {projectPanelOpen ? <ProjectAssignmentPanel form={projectForm} setForm={setProjectForm} hosts={hosts} error={error} submitting={submitting} onSubmit={assignProject} onClose={() => setProjectPanelOpen(false)} /> : null}
        {setupProject ? <ProjectSetupPanel project={setupProject} controller={controller} onRefresh={async () => { await loadProjects(); await loadJobs(); }} onQueued={handleJobQueued} onOpenJob={(jobId) => { setProjectSetupId(null); setView("jobs"); setJobSetupId(jobId); }} onClose={() => setProjectSetupId(null)} /> : null}
        {setupJob ? <JobDetailsPanel job={setupJob} onClose={() => setJobSetupId(null)} /> : null}
      </main>
      <footer className="app-footer">
        <span>machora v{MACHORA_VERSION}</span>
        <a className="github-link" href="https://github.com/jasonz1987/machora" target="_blank" rel="noopener noreferrer" aria-label="View Machora on GitHub (opens in a new tab)" title="View Machora on GitHub">
          <Github size={17} strokeWidth={1.8} aria-hidden="true" />
        </a>
      </footer>
      {jobToast ? <JobToast job={jobToast} onOpen={() => { setView("jobs"); setJobSetupId(jobToast.id); setJobToast(null); }} onClose={() => setJobToast(null)} /> : null}
      {anyOverlayOpen ? <button className="panel-scrim" type="button" aria-label="Close dialog or panel" onClick={closePanels} /> : null}
      {commandHost ? <HostCommandDialog host={commandHost} controller={controller} onQueued={() => { setHostCommandId(null); loadHosts(); loadJobs(); }} onClose={() => setHostCommandId(null)} /> : null}
    </div>
  );
}

function HostRow({ host, controller, onRunCommand, onDelete }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const OsIcon = host.os === "macos" ? Apple : host.os === "windows" ? Laptop : Terminal;
  const tools = Array.isArray(host.tools) ? host.tools : [];
  const summary = tools.slice(0, 3);
  const needsAgentUpdate = host.agentVersion && isOlderVersion(host.agentVersion, controller?.agentVersion || LATEST_AGENT_VERSION);
  const updateCommand = needsAgentUpdate ? (host.os === "windows" ? controller?.updateCommands?.windows : controller?.updateCommands?.posix) : "";
  return (
    <article className={`host-row ${environmentOpen ? "expanded" : ""}`}>
      <div className="host-identity"><span className="os-mark"><OsIcon size={22} /></span><div><strong>{host.alias}</strong><small>{host.hostname}</small></div></div>
      <span className="cell-label">OS</span><span className="os-name">{formatOs(host.os)} <small>{host.arch}</small></span>
      <span className="cell-label">Status</span><span className={`status ${host.status}`}><i />{formatStatus(host.status)}</span>
      <span className="cell-label">Address</span><div className="host-location"><code className="address">{host.address}</code><small>{host.workspace || "—"}</small></div>
      <span className="cell-label">Environment</span>
      {tools.length || needsAgentUpdate ? (
        <button className="environment-summary" type="button" aria-expanded={environmentOpen} aria-controls={`environment-${host.id}`} onClick={() => setEnvironmentOpen((value) => !value)}>
          <span className="tags">{summary.map((tool) => <span key={tool.id}><b>{tool.name}</b> {tool.version}</span>)}{tools.length > summary.length ? <span className="more-tag">+{tools.length - summary.length}</span> : null}{needsAgentUpdate ? <span className="update-tag">Update Agent</span> : null}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      ) : <div className="tags">{host.capabilities?.length ? host.capabilities.map((item) => <span key={item}>{item}</span>) : <span className="quiet">—</span>}</div>}
      <span className="cell-label">Jobs</span><JobCount counts={host.jobCounts} />
      <span className="cell-label">CPU</span><span className="metric cpu-metric">{host.cpu == null ? "—" : `${host.cpu}%`}</span>
      <span className="cell-label memory-label">Memory</span><span className="metric memory-metric">{host.memory == null ? "—" : `${host.memory}%`}</span>
      <div className="row-menu"><button className="icon-button" aria-label={`Actions for ${host.alias}`} aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}><MoreHorizontal size={20} /></button>{menuOpen ? <div className="host-actions-menu" role="menu"><button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onRunCommand(); }}><SquareTerminal size={15} /> Run command</button><button className="danger" type="button" role="menuitem" onClick={() => { setMenuOpen(false); onDelete(); }}><Trash2 size={15} /> Remove</button></div> : null}</div>
      {environmentOpen ? <EnvironmentDetails host={host} tools={tools} updateCommand={updateCommand} /> : null}
    </article>
  );
}

function EnvironmentDetails({ host, tools, updateCommand }) {
  return (
    <section className="environment-details" id={`environment-${host.id}`} aria-label={`${host.alias} development environment`}>
      <div className="environment-title"><span><Code2 size={17} aria-hidden="true" /></span><div><strong>Development environment</strong><small>Detected when Agent {host.agentVersion || ""} started</small></div></div>
      <div className="environment-content">
        {tools.length ? <dl>{tools.map((tool) => <div key={tool.id}><dt>{tool.name}</dt><dd>{tool.version}</dd></div>)}</dl> : <p className="environment-empty">This Agent reports installed tools, but not their versions yet.</p>}
        {updateCommand ? <div className="agent-update"><div><strong>Update Agent to {LATEST_AGENT_VERSION}</strong><p>No re-enrollment is needed. Run this command on {host.alias}.</p></div><code>{updateCommand}</code><CopyButton value={updateCommand} /></div> : null}
      </div>
    </section>
  );
}

function HostCommandDialog({ host, controller, onQueued, onClose }) {
  const dialogRef = useRef(null);
  const [command, setCommand] = useState("");
  const [workingDirectory, setWorkingDirectory] = useState(host.workspace || "");
  const [submitting, setSubmitting] = useState(false);
  const [confirmation, setConfirmation] = useState(null);
  const [commandError, setCommandError] = useState("");
  const needsAgentUpdate = host.agentVersion && isOlderVersion(host.agentVersion, controller?.agentVersion || LATEST_AGENT_VERSION);

  async function queueCommand(confirmed = false) {
    setSubmitting(true); setCommandError("");
    try {
      const response = await fetch(`/api/hosts/${encodeURIComponent(host.id)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command, workingDirectory, confirmed }),
      });
      const data = await response.json();
      if (data.requiresConfirmation && !confirmed) { setConfirmation(data.risk); return; }
      if (!response.ok) throw new Error(data.error || "Could not queue the remote command");
      onQueued(data.job);
    } catch (requestError) { setCommandError(requestError.message); } finally { setSubmitting(false); }
  }

  function submitCommand(event) { event.preventDefault(); setConfirmation(null); queueCommand(false); }

  function keepFocusInDialog(event) {
    if (event.key !== "Tab") return;
    const focusable = [...dialogRef.current.querySelectorAll("button:not(:disabled), input:not(:disabled), textarea:not(:disabled)")];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  return (
    <section ref={dialogRef} className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={`host-command-title-${host.id}`} onKeyDown={keepFocusInDialog}>
      <div className="command-dialog-header"><span><SquareTerminal size={17} /></span><div><h2 id={`host-command-title-${host.id}`}>Run command</h2><p>{host.alias} · {host.address}</p></div><button className="icon-button" type="button" aria-label="Close command dialog" onClick={onClose}><X size={19} /></button></div>
      <form onSubmit={submitCommand}>
        <label htmlFor={`host-command-${host.id}`}>Command</label>
        <textarea id={`host-command-${host.id}`} autoFocus rows="4" required maxLength="4000" spellCheck="false" placeholder="npm install -g pnpm@10.23.0" value={command} onChange={(event) => { setCommand(event.target.value); setConfirmation(null); }} />
        <label htmlFor={`host-cwd-${host.id}`}>Working directory</label>
        <input id={`host-cwd-${host.id}`} required maxLength="500" value={workingDirectory} onChange={(event) => { setWorkingDirectory(event.target.value); setConfirmation(null); }} />
        <p className="command-dialog-help"><span className={`status-dot ${host.status}`} aria-hidden="true" />{host.status === "online" ? "Agent online" : "The Job will wait for the Agent"} · Runs as the Agent user and is recorded in Jobs.</p>
        {needsAgentUpdate ? <div className="command-inline-note"><AlertTriangle size={14} /><span>Update this Agent before sending host commands.</span></div> : null}
        {confirmation ? <div className="danger-confirmation" role="alert"><span><ShieldAlert size={17} /></span><div><strong>Confirm elevated-risk command</strong><p>{confirmation.reasons?.join(" · ") || "This command can make broad changes to the task machine."}</p><code>{command}</code><div><button type="button" onClick={() => setConfirmation(null)}>Cancel</button><button className="danger-run" type="button" disabled={submitting} onClick={() => queueCommand(true)}>Run anyway</button></div></div></div> : null}
        {commandError ? <div className="notice error-notice command-feedback" role="alert">{commandError}</div> : null}
        <div className="command-dialog-actions"><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button command-submit" type="submit" disabled={submitting || !command.trim() || needsAgentUpdate || Boolean(confirmation)}>{submitting ? <RefreshCw className="spin-icon" size={14} /> : <Play size={14} />}{submitting ? "Queuing…" : "Run command"}</button></div>
      </form>
    </section>
  );
}

function ProjectsRegion({ projects, onAssign, onDelete, onOpen }) {
  return (
    <section className="project-region" aria-labelledby="projects-title">
      <div className="project-table-heading" id="projects-title"><span>Project</span><span>Git</span><span>Local path</span><span>Task machine</span><span>Remote path</span><span>Jobs</span><span>State</span><span aria-hidden="true" /></div>
      {!projects.length ? <ProjectEmptyState onAssign={onAssign} /> : <div className="project-list">{projects.map((project) => <ProjectRow key={project.id} project={project} onOpen={() => onOpen(project)} onDelete={() => onDelete(project)} />)}</div>}
    </section>
  );
}

function ProjectRow({ project, onDelete, onOpen }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <article className="project-row">
      <button className="project-identity project-identity-button" type="button" onClick={onOpen}><span className="project-mark"><FolderGit2 size={19} /></span><span><strong>{project.name}</strong><small>{project.projectType}{project.packageManager ? ` · ${project.packageManager}` : ""}</small></span></button>
      <span className="project-cell-label">Git</span><div className="git-state"><span><GitBranch size={12} />{project.branch}</span><small className={project.dirty ? "dirty" : "clean"}>{project.dirty ? `${project.changedFiles} local change${project.changedFiles === 1 ? "" : "s"}` : "Clean"}</small></div>
      <span className="project-cell-label">Local path</span><code className="project-path" title={project.localPath}>{project.localPath}</code>
      <span className="project-cell-label">Task machine</span><div className="assigned-host"><strong>{project.host?.alias || "Unassigned"}</strong><small>{project.host?.address || "Host removed"}</small></div>
      <span className="project-cell-label">Remote path</span><code className="project-path" title={project.remotePath}>{project.remotePath}</code>
      <span className="project-cell-label">Jobs</span><JobCount counts={project.jobCounts} />
      <span className="project-cell-label">State</span><div className={`project-status ${project.remoteStatus || project.status}`}><strong>{formatRemoteStatus(project)}</strong><small>{project.lastSyncedAt ? `${project.remoteAction === "clone" ? "Cloned" : "Pulled"} ${shortDate(project.lastSyncedAt)}` : project.remoteStatus === "error" ? "Needs attention" : "Remote setup"}</small></div>
      <div className="row-menu"><button className="icon-button" aria-label={`Actions for ${project.name}`} aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}><MoreHorizontal size={20} /></button>{menuOpen ? <button className="delete-action" type="button" onClick={onDelete}><Trash2 size={15} /> Remove</button> : null}</div>
    </article>
  );
}

function JobCount({ counts }) {
  const active = counts?.active || 0;
  return <span className={`job-count ${active ? "active" : ""}`}><Activity size={13} />{active ? `${active} active` : "Idle"}</span>;
}

function JobsRegion({ jobs, onOpen }) {
  const [filter, setFilter] = useState("all");
  const visibleJobs = jobs.filter((job) => {
    if (filter === "active") return ["queued", "dispatched", "running"].includes(job.status);
    if (filter === "failed") return job.status === "failed";
    if (filter === "completed") return ["succeeded", "cancelled"].includes(job.status);
    return true;
  });
  const filters = [
    ["all", "All", jobs.length],
    ["active", "Active", jobs.filter((job) => ["queued", "dispatched", "running"].includes(job.status)).length],
    ["failed", "Failed", jobs.filter((job) => job.status === "failed").length],
    ["completed", "Completed", jobs.filter((job) => ["succeeded", "cancelled"].includes(job.status)).length],
  ];
  return (
    <section className="jobs-region" aria-labelledby="jobs-title">
      <div className="jobs-toolbar"><div><h2 id="jobs-title">Job history</h2><p>Project pipelines and direct host commands share one audited execution history.</p></div><div className="job-filters" role="group" aria-label="Filter Jobs">{filters.map(([id, label, count]) => <button key={id} className={filter === id ? "active" : ""} type="button" onClick={() => setFilter(id)}>{label}<span>{count}</span></button>)}</div></div>
      <div className="jobs-table-heading"><span>Job</span><span>Status</span><span>Pipeline</span><span>Task machine</span><span>Created</span><span>Duration</span></div>
      {!visibleJobs.length ? <div className="jobs-empty"><Workflow size={24} /><strong>{jobs.length ? "No Jobs match this filter" : "No Jobs yet"}</strong><p>Run a project operation or send a command from a task machine.</p></div> : <div className="jobs-list">{visibleJobs.map((job) => <JobRow key={job.id} job={job} onOpen={() => onOpen(job)} />)}</div>}
    </section>
  );
}

function JobRow({ job, onOpen }) {
  const isHostCommand = job.type === "host-command";
  const title = isHostCommand ? "remote command" : job.operation || "sync";
  const subject = job.project?.name || job.host?.alias || "Removed task machine";
  return (
    <button className="job-row" type="button" onClick={onOpen} aria-label={`Open ${subject} ${title} Job`}>
      <div className="job-identity"><span className="job-mark">{isHostCommand ? <SquareTerminal size={17} /> : <Workflow size={17} />}</span><span><strong>{title}</strong><small>{job.trigger ? `${job.trigger.event === "tag-push" ? "Tag" : "Branch"} ${job.trigger.name} · ${job.trigger.sha.slice(0, 7)}` : `${subject} · ${job.id.slice(0, 8)}`}</small></span></div>
      <JobStatus status={job.status} />
      <div className="job-pipeline" aria-label={`Pipeline ${completedStepCount(job)} of ${job.steps?.length || 0}`}><div>{(job.steps || []).map((step) => <i key={step.id} className={step.status} title={`${step.label}: ${step.status}`} />)}</div><small>{job.currentStep ? stepLabel(job, job.currentStep) : terminalJobCopy(job.status)}</small></div>
      <div className="job-host"><strong>{job.host?.alias || "Removed"}</strong><small>{job.host?.address || "—"}</small></div>
      <time dateTime={job.createdAt}>{shortDate(job.createdAt)}</time>
      <span className="job-duration">{formatDuration(job.durationMs)}</span>
    </button>
  );
}

function JobStatus({ status }) {
  const Icon = status === "succeeded" ? CheckCircle2 : status === "failed" || status === "cancelled" ? CircleX : status === "running" || status === "dispatched" ? RefreshCw : Clock3;
  return <span className={`job-status ${status}`}><Icon className={["running", "dispatched"].includes(status) ? "spin-icon" : ""} size={14} />{status === "dispatched" ? "Starting" : status}</span>;
}

function JobDetailsPanel({ job, onClose }) {
  const isHostCommand = job.type === "host-command";
  const title = isHostCommand ? "Remote command" : job.operation || "Git sync";
  const subject = job.project?.name || job.host?.alias || "Removed task machine";
  return (
    <aside className="enrollment-panel job-details-panel" aria-label={`${subject} Job details`}>
      <div className="panel-header"><div><h2>{title}</h2><p>{subject} · {job.id.slice(0, 8)}</p></div><button className="icon-button" type="button" aria-label="Close Job details" onClick={onClose}><X size={21} /></button></div>
      <div className="job-detail-summary"><JobStatus status={job.status} /><span>{job.host?.alias || "Removed host"}</span><span>{formatDuration(job.durationMs)}</span></div>
      {isHostCommand ? <section className="job-detail-section"><div className="section-kicker">Command</div><pre className="job-command-line">{job.command}</pre></section> : null}
      <section className="job-detail-section"><div className="section-kicker">Pipeline</div><ol className="job-steps">{(job.steps || []).map((step) => <li key={step.id} className={step.status}><span>{step.status === "succeeded" ? <Check size={13} /> : step.status === "failed" ? <X size={13} /> : step.status === "running" ? <RefreshCw className="spin-icon" size={13} /> : <span />}</span><div><strong>{step.label}</strong><small>{step.status}{step.startedAt ? ` · ${shortTime(step.startedAt)}` : ""}</small></div></li>)}</ol></section>
      <section className="job-detail-section"><div className="section-kicker">Context</div><dl className="job-context"><div><dt>{isHostCommand ? "Scope" : "Project"}</dt><dd>{isHostCommand ? "Host command" : job.project?.name || "—"}</dd></div><div><dt>Machine</dt><dd>{job.host?.alias || "—"}</dd></div>{isHostCommand ? <div className="wide"><dt>Working directory</dt><dd title={job.workingDirectory}>{job.workingDirectory || "—"}</dd></div> : null}{job.trigger ? <><div><dt>Trigger</dt><dd>{job.trigger.event === "tag-push" ? "Tag pushed" : "Branch pushed"}</dd></div><div><dt>Git ref</dt><dd title={job.trigger.ref}>{job.trigger.name}</dd></div><div className="wide"><dt>Commit</dt><dd>{job.trigger.sha}</dd></div></> : null}<div><dt>Created</dt><dd>{shortDate(job.createdAt)}</dd></div><div><dt>Duration</dt><dd>{formatDuration(job.durationMs)}</dd></div>{isHostCommand ? <div><dt>Exit code</dt><dd>{job.result?.exitCode ?? (job.status === "running" ? "Running" : "—")}</dd></div> : null}</dl></section>
      {job.result?.previewUrl ? <a className="preview-link" href={job.result.previewUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />Open preview<span>{job.result.previewUrl}</span></a> : null}
      {job.error ? <div className="notice error-notice job-detail-error" role="alert">{job.error}</div> : null}
      <section className="job-detail-section job-log-section"><div className="section-kicker">Output</div><pre className={`job-output ${job.status}`}>{job.output || (job.status === "queued" ? "Waiting for the task machine…" : job.status === "running" || job.status === "dispatched" ? "The Agent is still working…" : "No output was returned.")}</pre></section>
      <p className="panel-tip">The controller receives completion results and triggers a native system notification when available.</p>
    </aside>
  );
}

function JobToast({ job, onOpen, onClose }) {
  const success = job.status === "succeeded";
  const queued = ["queued", "dispatched", "running"].includes(job.status);
  const subject = job.project?.name || job.host?.alias || "Task machine";
  const operation = job.type === "host-command" ? "remote command" : job.operation || "sync";
  const detail = queued
    ? `Job ${job.id.slice(0, 8)} submitted to ${job.host?.alias || "the task machine"}`
    : success
      ? job.result?.previewUrl ? "Preview is ready" : "Job completed"
      : job.error || "Job failed";
  return <div className={`job-toast ${queued ? "queued" : success ? "success" : "failed"}`} role="status" aria-live="polite"><span>{queued || success ? <CheckCircle2 size={18} /> : <CircleX size={18} />}</span><div><strong>{subject} · {operation}{queued ? " queued" : ""}</strong><small>{detail}</small></div><button type="button" onClick={onOpen}>View Job</button><button className="toast-close" type="button" aria-label="Dismiss notification" onClick={onClose}><X size={14} /></button></div>;
}

function ProjectEmptyState({ onAssign }) {
  return <div className="empty-state"><span className="empty-icon"><FolderGit2 size={24} /></span><h2>No projects assigned</h2><p>Connect a local Git repository, review the detected stack and commands, then let the task machine prepare its checkout.</p><button className="secondary-button" type="button" onClick={onAssign}><Plus size={17} /> Assign your first project</button></div>;
}

function ProjectAssignmentPanel({ form, setForm, hosts, error, submitting, onSubmit, onClose }) {
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState("");
  const selectedHost = hosts.find((host) => host.id === form.host);
  const hasProjectFolder = Boolean(form.localPath) && !/[\\/]$/.test(form.localPath);
  const folderName = hasProjectFolder ? form.localPath.split(/[\\/]/).pop() : "<project>";
  const separator = selectedHost?.os === "windows" ? "\\" : "/";
  const remotePath = selectedHost ? `${String(selectedHost.workspace).replace(/[\\/]+$/, "")}${separator}${folderName}` : "—";
  async function browseForProject() {
    setBrowsing(true); setBrowseError("");
    try {
      const response = await fetch("/api/dialogs/project-directory", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not open the folder picker");
      if (data.path) setForm({ ...form, localPath: data.path });
    } catch (requestError) { setBrowseError(requestError.message); } finally { setBrowsing(false); }
  }
  return (
    <aside className="enrollment-panel" aria-label="Assign project">
      <div className="panel-header"><div><h2>Assign project</h2><p>Connect a local Git repository to a task machine.</p></div><button className="icon-button" type="button" aria-label="Close panel" onClick={onClose}><X size={21} /></button></div>
      <form onSubmit={onSubmit}>
        <label className="field-label" htmlFor="project-path">Local Git project</label>
        <div className="path-picker"><input id="project-path" autoFocus required maxLength={500} placeholder="~/Code/my-project" value={form.localPath} onChange={(event) => setForm({ ...form, localPath: event.target.value })} /><button type="button" onClick={browseForProject} disabled={browsing} aria-label="Choose local Git project folder"><FolderOpen size={16} />{browsing ? "Choosing…" : "Browse"}</button></div>
        <p className="field-help">Machora reads Git metadata only. It will not commit, push, or modify this directory.</p>
        <label className="field-label" htmlFor="project-host">Task machine</label>
        <select id="project-host" required value={form.host} onChange={(event) => setForm({ ...form, host: event.target.value })}>
          <option value="" disabled>Select a machine</option>
          {hosts.map((host) => <option key={host.id} value={host.id}>{host.alias} · {host.address} · {formatStatus(host.status)}</option>)}
        </select>
        {selectedHost ? <div className="assignment-preview"><span>Destination</span><code>{remotePath}</code><small>Machora will detect the stack, install its local-only Skill, and queue Clone/Pull.</small></div> : null}
        {browseError || error ? <div className="notice error-notice" role="alert">{browseError || error}</div> : null}
        <button className="primary-button full-width" type="submit" disabled={submitting || !form.host}>{submitting ? "Preparing project…" : "Assign & prepare"}</button>
        <p className="panel-tip">Project configuration is accepted only from this controller machine.</p>
      </form>
    </aside>
  );
}

function ProjectSetupPanel({ project, controller, onRefresh, onQueued, onOpenJob, onClose }) {
  const [commands, setCommands] = useState(project.commands || {});
  const [devPort, setDevPort] = useState(project.devPort ? String(project.devPort) : "");
  const [devPortSource, setDevPortSource] = useState(project.devPortSource === "custom" ? "custom" : "detected");
  const [portTouched, setPortTouched] = useState(false);
  const [automationRules, setAutomationRules] = useState(project.automations?.rules || []);
  const [saving, setSaving] = useState(false);
  const [savingAutomations, setSavingAutomations] = useState(false);
  const [runningOperation, setRunningOperation] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState("");
  const [panelError, setPanelError] = useState("");
  const [activeJobId, setActiveJobId] = useState("");
  const [jobResult, setJobResult] = useState(null);
  useEffect(() => {
    setCommands(project.commands || {});
    setDevPort(project.devPort ? String(project.devPort) : "");
    setDevPortSource(project.devPortSource === "custom" ? "custom" : "detected");
    setPortTouched(false);
  }, [project.id, project.commands, project.devPort, project.devPortSource]);
  useEffect(() => { setAutomationRules(project.automations?.rules || []); }, [project.id]);
  useEffect(() => {
    if (!activeJobId) return undefined;
    const check = async () => {
      const response = await fetch(`/api/jobs/${encodeURIComponent(activeJobId)}`);
      if (!response.ok) return;
      const data = await response.json();
      if (["succeeded", "failed", "cancelled"].includes(data.job.status)) {
        setJobResult(data.job); setActiveJobId(""); setMessage(`${data.job.operation || "Git sync"} ${data.job.status}`); await onRefresh();
      }
    };
    check(); const timer = window.setInterval(check, 2000);
    return () => window.clearInterval(timer);
  }, [activeJobId, onRefresh]);
  const needsAgentUpdate = project.host?.agentVersion && isOlderVersion(project.host.agentVersion, controller?.agentVersion || LATEST_AGENT_VERSION);
  const agentUpdateCommand = needsAgentUpdate
    ? (project.host?.os === "windows" ? controller?.updateCommands?.windows : controller?.updateCommands?.posix)
    : "";

  async function saveCommands(event) {
    event.preventDefault(); setPortTouched(true); setSaving(true); setMessage(""); setPanelError("");
    try {
      await persistCommands();
      setMessage("Commands saved"); await onRefresh();
    } catch (requestError) { setPanelError(requestError.message); } finally { setSaving(false); }
  }

  async function persistCommands() {
    if (portError) throw new Error(portError);
    const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/commands`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands, devPort: devPortSource === "custom" ? Number(devPort) : null, devPortSource }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not save commands");
    return data.project;
  }

  async function runOperation(operation) {
    setPortTouched(true); setRunningOperation(operation); setMessage(""); setPanelError("");
    try {
      await persistCommands();
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Could not queue ${operation}`);
      onQueued(data.job);
    } catch (requestError) { setPanelError(requestError.message); } finally { setRunningOperation(""); }
  }

  async function queueSync() {
    setSyncing(true); setMessage(""); setPanelError("");
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/sync`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not queue remote sync");
      onQueued(data.job);
    } catch (requestError) { setPanelError(requestError.message); } finally { setSyncing(false); }
  }

  function addAutomationRule(event) {
    setAutomationRules((current) => [...current, { id: crypto.randomUUID(), event, pattern: event === "branch-push" ? project.branch : "v*", operation: "", enabled: true }]);
  }

  function updateAutomationRule(id, changes) {
    setAutomationRules((current) => current.map((rule) => rule.id === id ? { ...rule, ...changes } : rule));
  }

  async function saveAutomations(event) {
    event.preventDefault(); setSavingAutomations(true); setMessage(""); setPanelError("");
    try {
      await persistCommands();
      const automationResponse = await fetch(`/api/projects/${encodeURIComponent(project.id)}/automations`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ rules: automationRules }) });
      const automationData = await automationResponse.json();
      if (!automationResponse.ok) throw new Error(automationData.error || "Could not save Git triggers");
      const hookResponse = await fetch(`/api/projects/${encodeURIComponent(project.id)}/hooks/install`, { method: "POST" });
      const hookData = await hookResponse.json();
      if (!hookResponse.ok) throw new Error(hookData.error || "Could not install the Git hook");
      setAutomationRules(hookData.project.automations?.rules || []);
      setMessage(`${hookData.project.automations?.rules?.length || 0} Git trigger${hookData.project.automations?.rules?.length === 1 ? "" : "s"} active`);
      await onRefresh();
    } catch (requestError) { setPanelError(requestError.message); } finally { setSavingAutomations(false); }
  }

  const operationOptions = ["install", "test", "build", "dev", "deploy"].filter((operation) => Boolean(commands[operation]?.trim()));
  const hookReady = project.hook?.status === "installed" && automationRules.length > 0;
  const parsedPort = Number(devPort);
  const portError = devPortSource === "custom" && (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535)
    ? "Enter a port from 1 to 65535, or switch back to Auto."
    : "";

  function useDetectedPort() {
    setDevPort(project.detectedDevPort ? String(project.detectedDevPort) : "");
    setDevPortSource("detected");
    setPortTouched(false);
  }

  return (
    <aside className="enrollment-panel project-setup-panel" aria-label={`${project.name} setup`}>
      <div className="panel-header"><div><h2>{project.name}</h2><p>Project onboarding · {project.host?.alias || "No task machine"}</p></div><button className="icon-button" type="button" aria-label="Close panel" onClick={onClose}><X size={21} /></button></div>
      <div className="setup-progress" aria-label="Project setup progress">
        <SetupStep icon={ScanSearch} number="01" title="Detected" state="complete"><div className="setup-tags">{(project.frameworks || [project.projectType]).map((item) => <span key={item}>{item}</span>)}</div><p>{project.languages?.length ? project.languages.join(" · ") : "Git repository"}{project.packageManager ? ` · ${project.packageManager}` : ""}</p></SetupStep>
        <SetupStep icon={ListChecks} number="02" title="Commands" state="active">
          <form className="command-form" onSubmit={saveCommands}>
            <div className="command-row command-sync-row">
              <span className="command-label">sync</span>
              <div className="command-readonly">Git clone / fast-forward pull</div>
              <button
                className="command-run"
                type="button"
                aria-label="Sync project on task machine"
                title="Queue Git sync only: clone or fast-forward pull"
                disabled={syncing || Boolean(runningOperation) || !project.host || ["queued", "syncing"].includes(project.remoteStatus)}
                onClick={queueSync}
              >
                {syncing || project.remoteStatus === "syncing" ? <RefreshCw className="spin-icon" size={13} /> : <GitMerge size={13} />}
              </button>
            </div>
            {["install", "test", "build", "dev", "deploy"].map((operation) => <div className="command-row" key={operation}><label htmlFor={`project-command-${operation}`}>{operation}</label><input id={`project-command-${operation}`} value={commands[operation] || ""} placeholder={`No ${operation} command detected`} onChange={(event) => setCommands({ ...commands, [operation]: event.target.value })} /><button className="command-run" type="button" aria-label={`Run ${operation} on task machine`} title={`Queue ${operation}: Git sync → dependencies → command`} disabled={!commands[operation] || Boolean(runningOperation) || syncing || Boolean(portError)} onClick={() => runOperation(operation)}>{runningOperation === operation ? <RefreshCw className="spin-icon" size={13} /> : <Play size={13} />}</button></div>)}
            <div className="preview-port-setting">
              <div className="preview-port-heading"><label htmlFor="project-dev-port">Preview port</label><span className={devPortSource}>{devPortSource === "custom" ? "Custom" : "Auto"}</span></div>
              <div className="preview-port-control">
                <input
                  id="project-dev-port"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="65535"
                  value={devPort}
                  placeholder={project.detectedDevPort ? String(project.detectedDevPort) : "Project default"}
                  aria-invalid={Boolean(portTouched && portError)}
                  aria-describedby="project-dev-port-help"
                  onBlur={() => setPortTouched(true)}
                  onChange={(event) => { setDevPort(event.target.value); setDevPortSource("custom"); }}
                />
                <button type="button" disabled={devPortSource === "detected"} onClick={useDetectedPort}>Use auto</button>
              </div>
              <p id="project-dev-port-help" className={portTouched && portError ? "port-error" : ""}>{portTouched && portError ? portError : project.detectedDevPort ? `${project.projectType} default: ${project.detectedDevPort}. Change it only when this project needs another port.` : "Machora will not inject PORT unless you set one."}</p>
            </div>
            <div className="pipeline-hint"><Workflow size={13} /><span>Sync only updates Git. Every other operation runs Git sync → dependencies → command.</span></div>
            <button className="secondary-button setup-action" type="submit" disabled={saving || Boolean(portError)}><Save size={15} />{saving ? "Saving…" : "Save commands"}</button>
          </form>
        </SetupStep>
        <SetupStep icon={GitBranch} number="03" title="Git triggers" state={hookReady ? "complete" : "active"}>
          <form className="automation-form" onSubmit={saveAutomations}>
            {automationRules.length ? <div className="automation-rules">{automationRules.map((rule, index) => <div className="automation-rule" key={rule.id}>
              <div className="automation-rule-heading"><strong>Trigger {String(index + 1).padStart(2, "0")}</strong><label className="automation-enabled"><input type="checkbox" checked={rule.enabled} onChange={(event) => updateAutomationRule(rule.id, { enabled: event.target.checked })} /><span>Enabled</span></label><button type="button" aria-label={`Remove trigger ${index + 1}`} onClick={() => setAutomationRules((current) => current.filter((item) => item.id !== rule.id))}><X size={14} /></button></div>
              <div className="automation-rule-fields"><label>Event<select value={rule.event} onChange={(event) => updateAutomationRule(rule.id, { event: event.target.value, pattern: event.target.value === "branch-push" ? project.branch : "v*" })}><option value="branch-push">Branch pushed</option><option value="tag-push">Tag pushed</option></select></label><label>Match<input required value={rule.pattern} placeholder={rule.event === "branch-push" ? project.branch : "v*"} onChange={(event) => updateAutomationRule(rule.id, { pattern: event.target.value })} /></label><label className="automation-operation">Operation<select required value={rule.operation} onChange={(event) => updateAutomationRule(rule.id, { operation: event.target.value })}><option value="" disabled>Choose a configured operation</option>{operationOptions.map((operation) => <option key={operation} value={operation}>{operation}</option>)}</select></label></div>
            </div>)}</div> : <p className="automation-empty">No automatic Jobs yet. Add a branch or tag trigger, then choose one of this project's configured operations.</p>}
            <div className="automation-add"><button type="button" onClick={() => addAutomationRule("branch-push")}><Plus size={13} />Branch trigger</button><button type="button" onClick={() => addAutomationRule("tag-push")}><Plus size={13} />Tag trigger</button></div>
            <div className="pipeline-hint"><Workflow size={13} /><span>After a successful push: confirm remote ref → queue Git sync → dependencies → selected operation.</span></div>
            <button className="secondary-button setup-action" type="submit" disabled={savingAutomations || !automationRules.length || automationRules.some((rule) => !rule.operation || !rule.pattern)}><Save size={15} />{savingAutomations ? "Saving & installing…" : project.hook?.status === "installed" ? "Save triggers" : "Save & install hook"}</button>
            {project.hook?.status === "installed" ? <p className="automation-hook-status"><Check size={12} />Hook installed{project.hook.originalPreserved ? " · existing pre-push hook preserved" : ""}</p> : null}
          </form>
        </SetupStep>
        <SetupStep icon={Sparkles} number="04" title="Machora Skill" state={project.skill?.status === "installed" ? "complete" : "error"}><strong>{project.skill?.status === "installed" ? "Installed locally" : "Installation needs attention"}</strong><code>{project.skill?.path || ".agents/skills/machora/SKILL.md"}</code><p>{project.skill?.ignoredByGit ? "Excluded through .git/info/exclude — it will not enter commits." : project.skill?.error || "Not installed yet."}</p></SetupStep>
        <SetupStep icon={GitMerge} number="05" title="Task machine" state={remoteStepState(project.remoteStatus)}><strong>{formatRemoteStatus(project)}</strong><code>{project.remotePath}</code><p>{project.remoteError || remoteStatusCopy(project.remoteStatus, needsAgentUpdate)}</p>{needsAgentUpdate ? <div className="agent-requirement"><span>Update Agent {project.host?.agentVersion || "unknown"} → {controller?.agentVersion || LATEST_AGENT_VERSION} to start queued jobs.</span>{agentUpdateCommand ? <div className="agent-update-command"><code>{agentUpdateCommand}</code><InlineCopyButton value={agentUpdateCommand} /></div> : null}</div> : null}<button className="secondary-button setup-action" type="button" onClick={queueSync} disabled={syncing || !project.host || ["queued", "syncing"].includes(project.remoteStatus)}>{syncing || project.remoteStatus === "syncing" ? <RefreshCw className="spin-icon" size={15} /> : <GitMerge size={15} />}{syncing ? "Queuing…" : project.remoteStatus === "queued" ? "Queued for Agent" : project.remoteStatus === "syncing" ? "Clone / Pull running" : project.remoteStatus === "error" ? "Retry Clone / Pull" : "Queue Clone / Pull"}</button></SetupStep>
      </div>
      {message ? <div className={`notice panel-job-message ${jobResult?.status === "failed" ? "error-notice" : "success-notice"}`} role="status"><span>{message}</span>{activeJobId || jobResult?.id ? <button type="button" onClick={() => onOpenJob(activeJobId || jobResult.id)}>Open Job</button> : null}</div> : null}
      {panelError ? <div className="notice error-notice" role="alert">{panelError}</div> : null}
      {jobResult?.output || jobResult?.error ? <pre className={`job-output ${jobResult.status}`}>{jobResult.output || jobResult.error}</pre> : null}
      <p className="panel-tip">Commands are controller-owned configuration. Editing them does not run anything until you explicitly queue an operation.</p>
    </aside>
  );
}

function SetupStep({ icon: Icon, number, title, state, children }) {
  return <section className={`setup-step ${state}`}><div className="setup-step-heading"><span className="setup-step-icon"><Icon size={16} /></span><span className="setup-number">{number}</span><strong>{title}</strong><span className="setup-state">{state === "complete" ? "Ready" : state === "error" ? "Error" : state === "running" ? "Working" : state === "waiting" ? "Waiting" : "Review"}</span></div><div className="setup-step-body">{children}</div></section>;
}

function InlineCopyButton({ value }) {
  const [copied, setCopied] = useState(false);
  async function copyValue() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }
  return <button className="agent-update-copy" type="button" onClick={copyValue} aria-label="Copy Agent update command">{copied ? <Check size={14} /> : <Copy size={14} />}<span>{copied ? "Copied" : "Copy"}</span></button>;
}

function EmptyState({ onAdd }) {
  return <div className="empty-state"><span className="empty-icon"><Server size={24} /></span><h2>No task machines yet</h2><p>Add a Mac, Windows PC, or Linux server. Machora will generate one command to pair it with this controller.</p><button className="secondary-button" type="button" onClick={onAdd}><Plus size={17} /> Add your first machine</button></div>;
}

function EnrollmentPanel({ form, setForm, enrollment, error, submitting, onSubmit, onClose }) {
  const command = enrollment ? (form.os === "windows" ? enrollment.commands.windows : enrollment.commands.posix) : "";
  const connected = enrollment?.connectedHost;
  return (
    <aside className="enrollment-panel" aria-label="Add machine">
      <div className="panel-header"><div><h2>Add machine</h2><p>Pair a task machine with this controller.</p></div><button className="icon-button" type="button" aria-label="Close panel" onClick={onClose}><X size={21} /></button></div>
      {!enrollment ? (
        <form onSubmit={onSubmit}>
          <label className="field-label" htmlFor="host-alias">Machine alias</label>
          <input id="host-alias" autoFocus required minLength={2} maxLength={40} pattern="[A-Za-z0-9][A-Za-z0-9._-]{1,39}" placeholder="mac-mini-m2" value={form.alias} onChange={(event) => setForm({ ...form, alias: event.target.value })} />
          <fieldset><legend>Operating system</legend><div className="os-tabs">{[{ id: "auto", label: "Auto" }, { id: "macos", label: "macOS" }, { id: "linux", label: "Linux" }, { id: "windows", label: "Windows" }].map((item) => <button key={item.id} className={form.os === item.id ? "active" : ""} type="button" onClick={() => setForm(changeOperatingSystem(form, item.id))}>{item.label}</button>)}</div></fieldset>
          <label className="field-label" htmlFor="host-workspace">Remote code workspace</label>
          <input id="host-workspace" required maxLength={240} placeholder="~/Code" value={form.workspace} onChange={(event) => setForm({ ...form, workspace: event.target.value })} />
          <p className="field-help">Agent installation creates this folder. Projects will be cloned and built beneath it.</p>
          {error ? <div className="notice error-notice" role="alert">{error}</div> : null}
          <button className="primary-button full-width" type="submit" disabled={submitting}>{submitting ? "Generating…" : "Generate install command"}</button>
          <p className="panel-tip">Requires Node.js 20+. Installs a current-user background service; no sudo is used.</p>
        </form>
      ) : (
        <div className="pairing-result">
          <div className="os-tabs result-tabs" aria-label="Command platform"><button className={form.os !== "windows" ? "active" : ""} type="button" onClick={() => setForm({ ...form, os: "linux" })}>macOS / Linux</button><button className={form.os === "windows" ? "active" : ""} type="button" onClick={() => setForm({ ...form, os: "windows" })}>Windows</button></div>
          <p className="instruction">Run this install command on <strong>{form.alias}</strong>:</p>
          <div className="command-box"><code>{command}</code><CopyButton value={command} /></div>
          <p className="expiry">One-time token. Expires <Countdown expiresAt={enrollment.enrollment.expiresAt} />.</p>
          <div className={`connection-state ${connected ? "connected" : ""}`} aria-live="polite">{connected ? <span className="connected-icon"><Check size={19} /></span> : <span className="waiting-ring" />}<div><strong>{connected ? `${connected.alias} Agent online` : "Waiting for Agent…"}</strong><p>{connected ? `${connected.hostname} is reporting from ${connected.workspace}.` : "The installer creates the workspace, registers the service, and reports back automatically."}</p></div></div>
          <p className="panel-tip result-tip">Controller: {enrollment.controllerUrl}</p>
        </div>
      )}
    </aside>
  );
}

function CopyButton({ value }) {
  const [copied, setCopied] = useState(false);
  async function copy() { await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1600); }
  return <button className="copy-button" type="button" onClick={copy}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? "Copied" : "Copy"}</button>;
}

function Countdown({ expiresAt }) {
  const [remaining, setRemaining] = useState(() => Date.parse(expiresAt) - Date.now());
  useEffect(() => { const timer = window.setInterval(() => setRemaining(Date.parse(expiresAt) - Date.now()), 1000); return () => window.clearInterval(timer); }, [expiresAt]);
  const seconds = Math.max(0, Math.floor(remaining / 1000));
  return <strong>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</strong>;
}

function formatOs(os) { if (os === "macos") return "macOS"; if (os === "windows") return "Windows"; if (os === "linux") return "Linux"; return "Auto"; }

function formatStatus(status) { if (status === "online") return "Online"; if (status === "offline") return "Offline"; return "Pending"; }

function formatRemoteStatus(project) {
  if (!project.host) return "Unassigned";
  if (project.remoteStatus === "ready") return "Remote ready";
  if (project.remoteStatus === "syncing") return "Cloning / pulling";
  if (project.remoteStatus === "queued") return "Sync queued";
  if (project.remoteStatus === "error") return "Sync failed";
  if (project.remoteStatus === "blocked") return "Blocked";
  return "Assigned";
}

function remoteStepState(status) { if (status === "ready") return "complete"; if (status === "error" || status === "blocked") return "error"; if (status === "syncing") return "running"; if (status === "queued") return "waiting"; return "active"; }

function remoteStatusCopy(status, needsAgentUpdate) {
  if (needsAgentUpdate && status === "queued") return "The job is queued; update the Agent to start it.";
  if (needsAgentUpdate && status === "ready") return "The checkout is ready; update the Agent before starting a new Job.";
  if (status === "ready") return "The task-machine checkout matches the configured origin branch.";
  if (status === "syncing") return "The Agent is cloning or fast-forwarding the checkout.";
  if (status === "queued") return "Waiting for the assigned Agent to accept this job.";
  return "Clone when missing; otherwise fetch and fast-forward only.";
}

function shortDate(value) { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }

function shortTime(value) { return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)); }

function formatDuration(milliseconds) {
  if (milliseconds == null) return "—";
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function completedStepCount(job) { return (job.steps || []).filter((step) => ["succeeded", "skipped"].includes(step.status)).length; }

function stepLabel(job, id) { return (job.steps || []).find((step) => step.id === id)?.label || id; }

function terminalJobCopy(status) {
  if (status === "succeeded") return "Completed";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  if (status === "dispatched") return "Starting Agent";
  return "Waiting for Agent";
}

function isOlderVersion(current, target) {
  const currentParts = String(current).split(".").map(Number);
  const targetParts = String(target).split(".").map(Number);
  for (let index = 0; index < Math.max(currentParts.length, targetParts.length); index += 1) {
    const difference = (currentParts[index] || 0) - (targetParts[index] || 0);
    if (difference) return difference < 0;
  }
  return false;
}

function defaultWorkspace(os) { return os === "windows" ? "%USERPROFILE%\\Code" : "~/Code"; }

function changeOperatingSystem(form, os) {
  const workspace = !form.workspace || form.workspace === defaultWorkspace(form.os) ? defaultWorkspace(os) : form.workspace;
  return { ...form, os, workspace };
}
