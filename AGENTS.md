# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Durable product direction

- Use the simplified dark "Operations Deck" direction: graphite surfaces, off-white text, lime connection accents, flat one-pixel borders, compact technical details, and generous empty space.
- Keep the current release focused on host enrollment, Agent health, project onboarding, and the Jobs workflow. Avoid unrelated dashboards, global search, and dense metric cards.
- Project assignment stays read-only toward tracked source files and Git history. It may create `.agents/skills/machora/SKILL.md` plus a local `AGENTS.override.md`, and add both paths to the repository-local `.git/info/exclude`. The generated override must preserve the root `AGENTS.md` instructions before appending Machora's execution policy. Never modify the project's tracked `AGENTS.md`, commit, or push.
- Remote Git sync is an explicit asynchronous Agent job. Clone from the configured origin when missing; otherwise require a clean task-machine checkout and fast-forward only. Never imply that local uncommitted or unpushed work is transferred.
- Detected install/test/build/dev/deploy commands are editable controller configuration. Only run a configured operation after an explicit user or Machora Skill request. Every operation Job must sync Git, prepare detected dependencies, then run the chosen command. Dev starts as a detached preview and returns a reachable URL when possible.
- Show standalone Git sync as the first read-only action in the project's Commands list. It queues the existing sync Job directly and is not an editable shell command or a dependency-installing operation.
- Jobs are first-class controller history. Preserve pipeline stages, bounded logs, task-machine/project associations, active counts, completion toasts, and best-effort native controller notifications.
- Native completion notifications should deep-link to the matching Job detail. On macOS, use an actionable notification sender when available; do not emit a clickable `osascript` notification that opens Script Editor instead of Machora.
- Host commands are explicit asynchronous Jobs executed by the enrolled Agent in a controller-selected directory beneath the configured host workspace. Preserve live bounded output, command history, completion notifications, and a second confirmation for elevated, destructive, machine-control, remote-script, or global-tooling commands.
- Local project paths may be typed or chosen through a controller-native folder picker. Keep picker APIs controller-local, treat cancellation as a normal no-op, and never use browser directory uploads to discover a path.
- The local CLI and management UI must share one host store. Enrollment should be understandable as one command copied to a task machine.
- Enrollment commands must use the controller's advertised LAN/VPN URL rather than the browser's loopback URL. Agent installation stays in the current user account and must not require sudo.
- Treat exact development environment versions as important host metadata. Detect them once per Agent process, cache them, and expose the complete list without making the main host table visually dense.
- Agent Jobs must merge the persistent service environment with the current user's login-shell environment and common developer-tool locations. Use the same deterministic environment for tool detection, dependency preparation, host commands, project commands, and detached previews.
- Dev-preview argument forwarding must follow the selected package manager: npm scripts require the `--` separator, while pnpm, Yarn, and Bun receive preview flags directly so the application does not see a stray standalone `--`.
- Every right-side drawer must close from its explicit close button, a click on the outside backdrop, or the Escape key on both desktop and narrow screens.
- Launch host commands from the host row overflow menu in a centered modal. Keep environment expansion focused on detected tool metadata, retain elevated-risk confirmation inside the modal, and close the modal immediately after a Job is queued successfully.
- Git push automations use a controller-local managed `pre-push` hook, preserve any existing hook, confirm the remote ref SHA after a successful push, and map branch/tag patterns to user-selected configured project operations. Triggered Jobs checkout the exact ref/SHA and record their trigger context.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
