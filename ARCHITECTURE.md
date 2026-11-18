# persona-swarm architecture (v1.1)

The README says what persona-swarm is for. This document fixes the contracts every package is built
against. When code and this document disagree, one of them is a bug.

## 1. Packages

| Package | Role | Depends on |
| --- | --- | --- |
| `@persona-swarm/core` | Schemas (zod) for every file and record, config loading (`${env:NAME}` placeholders), device presets, the `Device`, `TargetHooks` and `Exporter` interfaces, the event and run stores, file and run locks, running a command with a timeout, memory sampling, text and problem similarity | `zod`, `yaml` |
| `@persona-swarm/driver-kit` | The driver protocol: message schemas, `serveDriver()` for driver authors, `DriverProcess` for the host, `connectPersonaTools()` (MCP client) | `zod`, MCP SDK |
| `@persona-swarm/device-web` | `WebDeviceFarm`: one Chromium, one isolated context per persona, every device action | `core`, `playwright-core` |
| `@persona-swarm/tool-server` | The MCP tool server: one endpoint per persona, bound to its device, tool sets by profile, evidence capture, the run's shared findings (`RunFindings`) | `core`, MCP SDK |
| `@persona-swarm/dep-proxy` | Dependency proxy for slow or costly services: real, cached, stub, record; coalescing, admission control, latency | `core` |
| `@persona-swarm/findings` | Post-run pipeline: log check, environment attribution, clustering, known issues, grouping requests and answers (model-free), registry across runs, metrics, HTML report, exporters | `core` |
| `@persona-swarm/server` | Local HTTP API (JSON + server-sent events) and the web UI (static, no build step) | `core`, `findings` |
| `@persona-swarm/engine` | Orchestrator: plan, preflight, scheduler, governor, budgets, watchdog, gate verdicts, resume | `core`, `driver-kit`, `device-web`, `tool-server`, `dep-proxy`, `findings` |
| `@persona-swarm/fixture-app` | A small web app with planted bugs and a server-side truth log, for conformance and tests | none |
| `persona-swarm` (cli) | The `persona-swarm` command; runs a grouping with a model, a command or an agent's brief | `core`, `engine`, `server`, `findings`, `dep-proxy`, `fixture-app`, `driver-kit`, `device-web` (for `doctor`), `yaml`, the drivers (located for the registry; `driver-external` for `act`; `driver-ai-sdk` loaded only to group with a model) |
| `@persona-swarm/driver-ai-sdk` | Generic driver on the Vercel AI SDK: OpenAI, Anthropic, Google, any OpenAI-compatible endpoint (local models included); `answerWithTool` for one structured answer (grouping) | `driver-kit`, `ai` |
| `@persona-swarm/driver-claude-code` | Claude Code CLI in headless mode, sandboxed to the persona's MCP tools | `driver-kit` |
| `@persona-swarm/driver-external` | Hands a session to any agent that can run a shell command (or to a person) through `persona-swarm act` | `driver-kit`, `core` |
| `@persona-swarm/driver-mock` | Model-free drivers: `script` (deterministic steps) and `monkey` (seeded random exploration) | `driver-kit` |
| `drivers/python-reference` | A standard-library Python driver: proof that drivers are language-neutral | Python 3 |

Rules: nothing below `engine` knows about any model provider. Nothing in `core` knows about
Playwright. Packages export `@persona-swarm/source` (TypeScript sources, used by the tests) next to
`types` and `default` (the built `dist`, used by spawned driver processes).

## 2. Workspace and run folder

A workspace is any folder with a `persona-swarm.yaml` (optional) plus targets, personas and cohorts.
Runs go to `<workspace>/runs/<runId>/` unless configured.

```text
runs/<runId>/
  run.json                    manifest + live state (atomic, coalesced rewrites, retried on failure),
                              including the command-line overrides the run was started with
  run.lock                    held by the process executing the run (pid, host, machine, process identity)
  events/<sessionId>.jsonl    one line per event, UTC, append-only
  shots/<sessionId>/<p><n>.jpg  screenshots; prefix a (after an action), s (screenshot), g (with grid),
                              r (at a report), v (at a confirmation); numbered per session
  downloads/<sessionId>/      files the persona downloaded (numbered, never overwritten)
  findings.jsonl              reports and confirmations as captured (append-only)
  known-issues.json           the target's known issues when the run started (if any)
  media.json                  each session's files (path, description, tags, type, truth, notes), kept
                              so a resume gives each session the same files
  review.json                 review decisions (approved, rejected, duplicate, needs-info, severity),
                              and the reports a reviewer split from each one (`apartFrom`)
  triage.json                 pipeline output (flags, clusters, known issues, fingerprints, metrics)
  grouping.json               a model's or an agent's grouping of the reports (optional; §8)
  grouping/brief.md, request.json, answer.json
                              a grouping done by an outside agent: its task, the reports it was shown
                              (its answer is checked against those), its answer
  gate.json                   gate mode only: the verdict per persona
  exports.json                external ids per exporter and finding, so nothing is filed twice
                              ("pending:<time>" while one is being sent; §10)
  export.json, export.md      the json and markdown exporters' files, unless they name another
  diaries/<sessionId>.json    the persona's closing account (from the finish tool)
  bridge/<sessionId>.*        external driver only: session file and brief (created mode 0600: the
                              endpoint token, the account), call log (.calls), end marker (.done,
                              written however the session ended), messages waiting for the agent
                              (.notices), screenshots (<sessionId>-<ms>-<n>.jpg)
  logs/orchestrator.jsonl, logs/driver-<sessionId>.log, logs/driver-probe-<driver>.log,
  logs/target-up-<n>.log, logs/target-down-<n>.log, logs/cli.log (detached runs)
  report.html                 self-contained report
```

`runId` = `YYYYMMDD-HHMMSS-xxxx` (UTC + 4 random hex). `sessionId` = persona id; `-2`, `-3` when a
cohort lists a persona more than once; `<persona>--a<n>` for gate attempts;
`<persona>--<device>-<locale>` for coverage cells.

The workspace keeps `.persona-swarm/registry.json` (problem fingerprints across runs, with their
review status) and `.persona-swarm/conformance.json` (driver and model qualification results).

Files that several processes update (the run, the UI server, the CLI) are changed under a lock file
(`<file>.lock`): `review.json`, `exports.json` (for a whole export), a json exporter's file, the
registry and an external agent's session (one action at a time). A lock records its owner's pid, its
machine (macOS's hardware UUID or Linux's machine-id; the host name where neither exists, since a
host name can change), the process's identity as the system records its start (Linux: boot id and
start ticks; elsewhere `ps`'s start time in UTC: a clock change does not move it, and a later process
reusing the pid does not match) and a token. On the same machine a live owner keeps its lock however
long it works; a dead owner's lock is taken over after reading it again, one taker at a time (a
`.takeover` marker), so two processes that found the same dead owner never remove each other's new
lock; only the holder of a token removes its lock. A lock from another machine (a shared folder)
cannot be checked from here: a run lock is trusted (the error says which host holds it, and how to
clear it if nothing runs there), a file lock for ten minutes after it was taken (an external agent's
session lock for about seven), after which it is taken over. Logs append from one process each, and a log line torn by a crash is closed
before the next record. A record that cannot be written (a full disk) is kept and written, in order,
once the file can be written again; a file written atomically never leaves a temp file behind.

## 3. Configuration files (YAML, validated by `core`)

- `target.yaml`: `id`, `name`, `baseUrl`, `brief` (what personas may know), `glossary`, `health`
  (`url`, `timeoutSec`), `lifecycle` (`up`, `down`, `reset` commands), `accounts` (`id`, `username`,
  `password`, `shared`), `signIn` (`mode: persona | scripted`, scripted `steps`), `media`
  (the files personas can upload: `dir`, `pattern`, `id`, `description`, `tags`, `type`, and a
  `manifest` describing files one by one with `description`, `tags`, `type`, `truth` and `notes`;
  `fixtures` is the older name, read as media; see `docs/media.md`), `dependencies`
  (dep-proxy definitions: `match`, `cache` with `key` and `vary` headers, `concurrency`, `maxWaitMs`,
  `upstreamTimeoutMs`, `latencyMs`, `stub`), `journeys` (named paths with checks), `knownIssues`
  (file), `hooks` (module path, see `TargetHooks`) and `hookTimeoutSec` (default 300: how long one
  hook call may take), `extraOrigins` (other origins personas may open, such as a sign-in provider).
  `baseUrl` must be an http(s) address.
- `persona.yaml`: `id`, `name`, `proficiency` (1–5), `traits` (mind, in the brief: `patience` 1–5,
  `reading` `skims|reads|studies`, `recovery` `back|reload|retry|asks`, `domain` 1–5, `risk`
  `cautious|normal|bold`, `focus` `task|wanders`, `priorTools` text, `language` `{ native, fluency }`,
  `helpSeeking` `never|tooltips|docs|support`, `vocal` `stoic|normal|vocal`; body, also enforced:
  `vision` (a shorthand or `{ zoom, deficiency, highContrast }`, turned into device overrides),
  `precision` 1–5, `pace` `rushes|normal|slow`, `typing` `careful|typos|pastes`, `interruptions`
  `none|some|many`, `multitab`; see §5 and `docs/personas.md`), `background`, `mission` (`goal`, `kind`
  `open|scripted`, `steps`, `success`), `device` (preset name or full profile), `deviceOverrides`
  (only the fields given change; a preset keeps the rest; they win over what `vision` sets), `account`,
  `budget` (`{ minutes, turns, scale }`: this person's own time and actions), `media` (which of the
  target's files this person has: `tags`, `exclude`, `files`, `count`, `spread`, `cached`), `requires` (`vision`: true or
  false overrides what the tool profile needs; `minContext`), `toolProfile` (override), `notes`.
- `cohort.yaml`: `id`, `description`, `target` (path), `mode` (`explore|gate|research|coverage`),
  `personas` (paths, globs or inline), `missions` (persona id or `*` → goal, replacing the persona's),
  `media` (persona id or `*` → a media selection, replacing the persona's),
  `roles` (`persona`: `{ driver, model, options }`), `assign` (per-persona role
  overrides), `schedule` (`waveSize`, `waveIntervalSec`, `staggerSec`), `budgets`
  (`minutesPerPersona` and `turnsPerPersona`, the baseline each persona's own budget is worked out
  from; `scaleByTraits`, default true; `personas`, per persona id `{ minutes, turns, scale }`; and
  `usdPerRun`), `limits` (`maxBrowsers`, `maxAgents`,
  `minFreeMemoryPercent`, `stopBelowFreeMemoryPercent`, `maxDeviceScaleFactor`), `memory` (session
  memory policy), `exporters` (a known `type`, unique ids), `grouping` (`model` or `command`, and
  `timeoutSec`: see §8), `gate` (`attempts`, `mustPass`), `matrix` (`devices`, `locales`). `limits`,
  `memory` and `assign` set only the fields they name.
- `persona-swarm.yaml` (workspace): `runsDir`, `drivers` (name → command), `providers` (named model
  endpoints: `type`, `baseURL`, `apiKeyEnv`, `headers`, `vision`, `contextWindow`,
  `imagesInToolResults`), `prices` (USD per million tokens by model: `input`, `output`, and
  `cachedInput` for input read from a prompt cache, which otherwise costs the full input price),
  default `limits`, `registry`, `browser` (`executablePath`, `headless`, `screenshotQuality`,
  `settleMs`, and `connect: { url, protocol: cdp|playwright, headers }` for a browser running
  elsewhere).

Relative paths are resolved against the file that contains them: a target's media folders and manifests (a manifest's truth paths against the manifest), caches,
lifecycle folders, known issues and hooks; a cohort's targets, personas, exporter files and modules;
the workspace's runs folder, registry and browser path (a bare program name is left to the system), and
a workspace driver's command parts that start with `./` or `../`. Any string may use `${env:NAME}`: it
is replaced with the environment variable when the file is loaded, and a missing variable is a
configuration error. Commands that only read runs (`status`, `stop`, `ui`, `triage`, `report`,
`review`) fill in the placeholders whose variables are set and drop settings that still hold one
(they never use them), but the runs folder and the registry must resolve; `export` fills in only the
cohort's `exporters`, and `group` only the cohort's `grouping` (and the workspace's, when it calls a
model), so a secret a command never uses cannot stop it. `run` finds the workspace from the cohort's
folder upwards; every other command from the current folder upwards, so they are run from the
workspace. API keys are only ever read from the environment (`apiKeyEnv`). Run folders
hold no provider keys; persona briefs contain the target's test-account credentials, and the bridge
session file (owner-readable only) holds the session's endpoint token.

## 4. Devices

`Device` is the only thing tools talk to:

```ts
interface Device {
  readonly id: string
  readonly kind: 'web' | 'ios' | 'android' | 'desktop'
  capabilities(): DeviceCapabilities        // touch, keyboard, pointer, outline, rotate, network, files, tabs
  perform(action: DeviceAction): Promise<ActionOutcome>   // one discriminated union for every action
  screenshot(o?: { grid?: boolean; maxWidth?: number }): Promise<Screenshot>
  outline(o?: { maxChars?: number; query?: string }): Promise<Outline>
  status(): Promise<DeviceStatus>           // url, title, tabs, toasts and alerts, open dialog, open file picker
  drainSignals(): DeviceSignal[]            // console errors, page errors, failed and 4xx/5xx requests, downloads
  close(): Promise<void>
}
```

`DeviceAction` covers `open`, `click` (ref or point, button, count), `tap`, `long_press`, `type`,
`fill` (ref), `press` (key chord), `select`, `scroll`, `drag`, `swipe`, `pinch`, `back`, `forward`,
`reload`, `rotate`, `set_network` (`online|offline`), `pick_file`, `drop_file`, `dialog`
(`accept|dismiss`), `wait` (seconds, or until a text shows), `new_tab`, `switch_tab`, `close_tab`.

An `ActionOutcome` is `ok`, a message in the persona's terms, the status after the action,
`matched` for a wait for text (whether it showed), and `harnessError` when the action failed because
of how it was asked (a stale ref, a point off screen, an unknown key, a missing file, a capability the
device lacks), never because of the app. A page stuck in a loop never answers some calls (a click, a
script): an action that has not come back after its limit (30 s for most, a wait's own seconds plus
10, a navigation 30 s, typing longer for long text) is "The page stopped responding" (`ok: false`,
the app's doing), and the status never waits on such a page (an empty title, no notices). A wait for
text always has a limit of at least a second (Playwright reads 0 as "forever"). A ref that
resolved to an element which was disabled, covered, hidden or read-only is the app's doing (Playwright's
call log tells the two apart). An action that reached the app with no visible effect ("No file picker
opened.") is `ok: false` without `harnessError`. Key chords accept common aliases (`ctrl`, `cmd`,
`esc`), and edit shortcuts (select all, copy, paste, cut, undo, redo) work with Control or Meta on
every persona device, whatever the host's own convention (redo, Ctrl+Y on Windows, is sent as
Control-or-Meta+Shift+Z, which is redo on every host). Gestures follow the persona's input, not the
hardware: a mouse persona on a touch laptop clicks and drags with the mouse. A native drop-down list never shows in a
screenshot, so a click on one says what it holds, and arrow keys on a focused list change the choice
on every device (as on Windows and Linux). `select` works on native lists and on custom ones (a
combobox or button that opens options): it opens the list the control names (`aria-controls`) and
picks the option by its exact name before trying a partial one. `pick_file` with no target uses an
open picker, or the focused control only if it is a file chooser: it never presses Enter on whatever
has focus. A screenshot while a native dialog is open says so at once (the page is frozen behind it).
Looking never changes the app: screenshots let animations run (finishing them would fire their end
events, closing a toast) and show the text caret. Closing a pop-up returns the persona to the page
that opened it. A resumed session numbers its downloads after the ones already there.

`WebDeviceFarm` launches one Chromium (headless shell) for the run, or connects to one running
elsewhere (a VM, a cloud browser service: over CDP or Playwright's own protocol; uploads are then sent
as data, since that browser cannot read this machine's disk), and creates a context per persona:
viewport (divided by the profile's `zoom`: browser zoom lays a page out in a smaller viewport on the
same screen), device scale (clamped, default max 1), touch, user agent, locale, time zone, colour scheme,
reduced motion, forced colours and `prefers-contrast`, network throttling of matching URLs only (CDP
rules), CPU throttling, a vision deficiency rendered into the page (CDP
`Emulation.setEmulatedVisionDeficiency`, so screenshots show it), downloads. A device created with
`rush` returns from an action without waiting for the page to settle. `type` with `paste` inserts the
text at once instead of key by key. One
CDP session per page carries touch sequences. Native dialogs are surfaced in the status and must be
answered before anything else. File pickers are always intercepted (a listener added just before a
click races the click): a picker opened by a click waits in the status until `pick_file` gives it a
file, and any other action cancels it. An offline profile is set once, when the device is created.
A throttled device sends its online state and its throttling together through its own CDP session,
so turning Wi-Fi off and on keeps it slow, and a tab opened offline stays offline.

Personas stay in the app. A main-frame navigation to an origin that is not allowed (a link, a form,
a redirect) is answered "204 No Content" over CDP, which leaves the current page as it is; frames and
subresources are not touched. A pop-up that opens elsewhere is closed (its history says where it
went, even when it arrived already failed). Each block is a `blocked` signal and a one-off notice in
the next status.

## 5. The tool server (MCP)

One HTTP server per run on 127.0.0.1, an endpoint per session: `POST /mcp/<sessionId>` with
`Authorization: Bearer <token>`. The token is minted per session and given only to that session's
driver, so a driver can only ever reach its own device. JSON responses (no SSE needed by clients).
Every call is logged as an event before and after.

Each MCP connection gets its own server instance, but all state belongs to the session (screenshot
numbering continues across connections and after a resume; the action count; recent signals; a held
report). Drivers that connect once per action should end their MCP session (`DELETE`); at most four
connections per session stay open, and the least recently used is closed beyond that.

The action budget is enforced here, the same for every driver: every step in the app is one action,
while looking (`screenshot`, `outline`, `find_text`) and speaking up (`note`, `report_problem`,
`confirm_problem`, `finish`) are free (`FREE_TOOLS` in core), so a persona never has to choose
between reporting and acting. The status line counts down the time and the actions left. Once the
last action has run, only the free tools answer (refused calls are logged as `refused`: neither an
action nor an error), the persona is told to report what it has not and finish, and two minutes later
the session ends as out of budget (outcome `ran_out_of_time`, unless it finished). Drivers get three
times the budget plus twenty turns as their own backstop. A long outline comes in parts of about
12,000 characters (`outline { part }`).

Tool profiles decide what exists for a persona; the profile wins over the hardware (a keyboard-only
persona on a laptop has no pointer tools):

| Tool | `sight` (prof. 1–2, touch) | `reader` (prof. 3) | `power` (prof. 4–5) | `keyboard` | `screenreader` |
| --- | --- | --- | --- | --- | --- |
| `screenshot` (optional grid) | ✓ | ✓ | ✓ | ✓ | – |
| `outline` | – | ✓ | ✓ | – | ✓ |
| `find_text` (search the outline) | – | – | ✓ | – | ✓ |
| `click_at` / `tap_at` (x, y) | ✓ | ✓ | ✓ | – | – |
| `click` / `tap` (ref) | – | ✓ | ✓ | – | – |
| `type`, `press` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `fill` (ref), `select` (ref) | – | ✓ | ✓ | – | ✓ |
| `scroll`, `drag`, `swipe`, `pinch`, `long_press_at` | by input | by input | by input | – | – |
| `back`, `forward`, `reload`, `go_to` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `pick_file` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `drop_file` | mouse | mouse | mouse | – | – |
| `answer_dialog`, `wait` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `rotate` (phones, tablets), `wifi` (a network profile, or a mission about Wi-Fi, being offline or the connection) | ✓ | ✓ | ✓ | ✓ | ✓ |
| `tabs` | `multitab` | `multitab` | ✓ | `multitab` | `multitab` |
| `note`, `report_problem`, `confirm_problem`, `finish` | ✓ | ✓ | ✓ | ✓ | ✓ |

Body traits are enforced here too, between the tool and the device, so they hold for every driver and
every future device (core's `body.ts` does the arithmetic; the tool server applies it):

- `precision` below 5 moves clicks, taps, long presses, drags, swipes and file picks or drops given
  as coordinates (spread 14, 8, 4, 2 px for 1–4, normal, capped at three spreads, kept on the screen),
  and at 1–2 turns some single mouse clicks into double ones (12 % and 6 %), by ref too.
- `typing: typos` misspells about one word in eight (three letters or more) of `type` and `fill`;
  `typing: pastes` sends `type` as a paste (inserted at once) and gives both typographic quotes and
  stray spaces.
- `pace: slow` waits 2.5–7 s before each action; `pace: rushes` creates the device with `rush`.
- `interruptions` may interrupt an action (never in the first three, then 6 % or 15 % once six or four
  actions have passed since the last): idle for 30–90 s, the connection off during the action and back
  three seconds after it, a reload first, or the tab closed and the page reopened in a new one. The
  persona is told in the result.
- `multitab` opens the current page in a second tab five actions in, once, and gives the `tabs` tool.

Random numbers come from a seed of the run id and the session id, shared by every connection of the
session, so a session slips the same way when it runs again. A `tool.result` lists what slipped
(`body`) and the thinking time (`thinkMs`); an interruption or the second tab is an `interruption`
event. Free tools are never changed.

Every tool result but `finish` carries a status line (page, title, visible toasts and alerts, an open
dialog or file picker, a navigation the test blocked, the time left, the actions left) so the agent
always knows where it is: after the result (a failed call too: a dialog that blocks a screenshot shows
there), before it for an outline, and before the screen size for a screenshot. A refused call says
that no actions are left, and a held report shows the similar ones.

Reports are deduplicated where the judgement is best, at the source:

- `report_problem` first looks for reports that may be the same problem: this run's reports
  (including the reporter's own) and the target's known issues, by `problemSimilarity` ≥ 0.25. If
  there are any, nothing is filed: the persona sees them ("Not filed yet: this may already be
  reported") and either confirms one or reports again with `not_same_as: [ids]` (only ids that look
  alike are kept; sending the very same report again before moving on also files it). A filed report
  attaches evidence: the last 20 events, a screenshot, the console and network errors of the last
  three minutes, the page, and the `notSameAs` judgement.
- `confirm_problem` (a report id `F-n` or a known issue `K-n`) records a vote with the voter's note,
  page and screenshot. One vote per session and problem; a session's own report needs none.
- `finish` ends the session and records the persona's diary (outcome, summary, ease, trust, would
  use, why).

The 0.25 hold threshold was calibrated on two real runs. On 65 reports from a clinical app, 29
would have been held and about 26 of those were duplicates. On 19 reports from the fixture app, no
unrelated pair scored above 0.27. A false hold costs the persona one extra call.

## 6. The driver protocol

JSON-RPC 2.0, one JSON object per line, over the driver's stdin and stdout. The driver writes logs to
stderr and runs in its own process group. Protocol version `1`.

| Direction | Method | Kind | Payload |
| --- | --- | --- | --- |
| host → driver | `initialize` | request | `{ protocolVersion, host: { name, version } }` → `{ protocolVersion, driver: { name, version } }` |
| host → driver | `capabilities` | request | `{ model, options }` → `{ imageInput, contextWindow, toolCalling, usesModel?, reportsCost?, notes? }` |
| host → driver | `session.run` | request | `SessionSpec` → `SessionResult` (when the session ends) |
| driver → host | `session.event` | notification | `{ sessionId, event }` |
| host → driver | `session.notice` | notification | `{ sessionId, text }`: appended as a user message at the next turn (budget warnings) |
| host → driver | `session.cancel` | notification | `{ sessionId, reason }` |
| host → driver | `shutdown` | request | `{}` → `{}` then the driver exits |

`SessionSpec`: `sessionId`, `model`, `instructions` (system text: no secrets, since a driver may pass
it on a command line), `kickoff` (first user message: where to start, and the account's credentials),
`mcp: { url, headers }`, `budget: { maxTurns, maxSeconds, maxOutputTokensPerTurn?, maxUsd? }` (`maxUsd`:
what is left of the run's spend cap, divided among the sessions that may run at once, for drivers
that can enforce it themselves), `memory:
{ keepImages, summarizeAfterTokens, maxToolTextChars }`, `options` (driver-specific, passed through).

`usesModel` (default true) says whether sessions spend model tokens on the run's account (the mock and
external drivers do not); `reportsCost` (default false) whether the driver reports cost in money. A
run with a spend cap refuses to start when a driver and model would spend without a way to count it
(no reported cost and no price in `persona-swarm.yaml`). The workspace's named providers reach every
driver as `options.providers`, and the session model's price, when there is one, as `options.price`:
the Claude Code driver costs each model call with it as the call happens (cache reads at the cache
price), counts each call once (the CLI may send one line per content block), and adds only the
difference when the CLI's own figure arrives at the end of a turn. A turn it has to stop (a pause, a
stop, its turn backstop) is interrupted rather than killed: the CLI reports the turn's result, and so
its cost, first (it is killed if it has not within 5 s).

Only `usage` events count toward cost and the spend cap; the usage in `SessionResult` is the driver's
own summary. `inputTokens` are the input tokens not read from a prompt cache, `cachedInputTokens`
those that were; a usage event without `costUsd` is priced from the workspace's prices (input,
cached input, output), or counted as nothing without one.

`SessionResult`: `stopReason` (`finished | budget | cancelled | error | model_stopped`), `finalMessage`,
`turns`, `usage: { inputTokens, outputTokens, cachedInputTokens?, costUsd? }`, `error?`.

Event types (driver → host): `assistant` (text), `tool_call`, `tool_result`, `turn`, `usage` (as model
calls happen), `memory` (summarised or pruned), `log` (`level`: `debug`, `info`, `warn` or `error`;
`info` lines are shown to the operator). An event of another type is only written to the driver's log.

The host starts drivers with `PERSONA_SWARM_RUN_DIR` (the run folder) and, for session processes,
`PERSONA_SWARM_SESSION`. Timing a driver can count on:

- `initialize` must be answered within 20 s.
- A session with no tool call and no driver event for 300 s is stalled: it is paused (resumable).
- At 80% of its time a session gets a notice to wrap up; when it calls `finish`, it has 45 s to end on
  its own; when its time is up, its last action spent (plus two minutes), or it is stopped, the driver
  gets `session.cancel` and 15 s to return before it is killed; a session that runs past its time by
  three minutes is killed.
- A session cancelled before it started never reaches the driver.

A driver's own children (the Claude Code CLI) run in its process group, which the host signals
whenever it stops the driver, even after the driver itself has exited. A session is skipped when its
model cannot call tools, cannot see screenshots its tool profile needs (`requires.vision` on the
persona overrides the profile, either way), or has a smaller context than `requires.minContext`. A
session that ends without calling `finish` (the model stopped) still counts as finished, without the
outcome `completed`.

The external driver writes a brief and a session file into `bridge/` and waits, sending a heartbeat
so a person thinking for minutes is not taken for a stall. Any agent that can run a shell command
plays the persona with `persona-swarm act <session-file> <tool> '<json>'`: each call takes the
session's lock (one action at a time), connects to the session's endpoint, calls one tool, saves
returned images as files, ends the MCP session and prints the result, followed by any notice from the
test (a time warning, no actions left) waiting for the agent. The session ends when `finish` succeeds,
at the deadline, two minutes after its last action is spent, or when stopped; the end marker says so,
so a late `act` is told. A resumed session counts only its own calls.

## 7. Events and findings

Event (`events/<sessionId>.jsonl`): `{ t, seq, session, type, ...payload }`. Types: `session.start`,
`session.end`, `tool.call`, `tool.result`, `device.signal`, `agent.text`, `agent.usage`,
`agent.memory`, `agent.log`, `note`, `finding`, `vote`, `diary`, `governor`, `dependency`, `notice`,
`interruption` (`kind`: `away|offline|reload|reopen|second-tab`, from the body traits), `check`,
`error`. Run-level events use the session `_run`. A `tool.result` may carry `body` (what the persona's
body did differently from the call: a miss in pixels, a double click, typos, a paste) and `thinkMs`.

Finding: `id` (`F-n`), `session`, `t`, `title`, `whatIDid`, `expected`, `actual`, `feltSeverity`
(`blocking|annoying|minor|cosmetic`), `confidence` (`sure|unsure`), `kind` (`bug|confusing|layout|
accessibility|copy|data|performance`), `url`, `evidence` (`eventSeqs`, `screenshot`, `signals`),
`votes` (`session`, `t`, `note`, `url?`, `screenshot?`), `source` (`persona|monkey|check`),
`notSameAs?` (similar reports the reporter judged different).

`findings.jsonl` lines are `{ type: 'finding', ...Finding }` or `{ type: 'vote', findingId, ...vote }`;
a vote on a known issue carries `known: true` and the issue's `title`.

## 8. Triage

`triageRun(runDir)` reads only the run folder (deterministic, re-runnable) and writes `triage.json`:

- Flags per report: `harness-suspect` (the action right before the report failed in the harness, and
  at least half of the last six actions in the three minutes before it did, however few there were;
  looking at the screen, the outline, notes and reports are not actions, nor are refused calls), `environment:<dep>` (a dependency was refused,
  failing, timing out or stubbed in the six minutes before), `governor` (memory was critical just
  before), `navigation-blocked` (the test stopped a link or pop-up in the three minutes before, and the
  report talks about it), `reporter-unsure`, `known:K-n`.
- Clusters: first what testers said in so many words (a report or confirmation that calls another
  the same: "same as F-2", "duplicate of F-2", "my F-4 is a duplicate of this"; a negated phrase or a
  mere mention, "unlike my F-2", is not one), then single-link clustering on `problemSimilarity` plus
  0.08 for the same route, at 0.36, strongest pairs first, then the run's grouping when it has one
  (below), which can only add. Reports a tester or a reviewer judged different are never merged (a
  reviewer's split, `apartFrom` in review.json, counts as a tester's `not_same_as`, also against a
  known issue). A cluster is
  named by its earliest report, counts its testers (reporters and confirmers) and keeps its `links`:
  for each join, the two reports and why (`tester`, `wording` with the score, or `grouping` with the
  grouper and its reason). Each report's words and trigrams are worked out once, and the pairwise
  comparison lets other work run every 20 ms, so a re-triage of hundreds of reports during a live run
  does not hold up the personas.
- Known issues: a report the grouping placed with a known issue gets it; otherwise a report matching
  a known issue by wording (≥ 0.35) does. Never one its reporter said it is not. `knownIssueMatch`
  says which; `knownIssues` lists every known issue seen in the run, with its testers and reports.
- `suggestedSeverity`: felt severity mapped to `major|minor|cosmetic`, one step up with two or more
  confirmations; `harness` or `environment` when flagged.
- Fingerprints (route pattern + sorted title words) and `seenInRuns`: earlier runs (by run id) in the
  workspace registry, which is updated under its lock.
- Similarity works in any script: text is folded to Unicode letters, marks and digits (accents that
  only decorate a letter, such as é, are folded away; marks that make another word, such as Indic
  vowel signs and Thai tone marks, are kept), scripts written without spaces are compared by
  character pairs, and empty text is similar to nothing. A route keeps the path in the fragment of an
  app that routes there (`/#/orders/:id`).
- Session metrics: actions, app errors, harness errors, backs and reloads, notes, reports, held
  reports, confirmations, tokens and cost, time to first report, the diary.

The report adds aggregates across the cohort (ease, trust, would-use and outcomes by proficiency and
by input).

### Grouping by a model or an agent

Wording finds only some duplicates: testers describe one fault in different words, from different
screens and devices (on one smoke run it joined none of five). Grouping asks a model or an
agent to read every report and known issue at once and say which belong together. The answer is
stored as `grouping.json` (`by`, `t`, `covered`: the reports it saw, `groups`: `{ ids, reason }`,
with at most one known issue per group, `usage`, `costUsd`), and triage applies it on every run
after that, so triage itself stays deterministic. A grouping can only join, after testers and wording
have: it never splits what they joined, `joined` counts only what they had missed, and a link (or a
known-issue match) that a tester's "not the same" rules out is refused and listed
(`grouping.keptApart`). Reports filed after the grouping are listed as `notCovered` until it runs
again. A damaged `grouping.json` is reported (`groupingError`), never fatal. Reports two groups both
matched to one known issue are joined too.

`groupingRequest` lists every report (id, page pattern, tester, title, what happened, what was
expected) and known issue, and the pairs testers kept apart. It always fits all of them in one
request, shortening the text first and then dropping to titles, since splitting the reports
would hide duplicates from each other. It refuses beyond about 120,000 characters (around 30,000
tokens; some 500 reports as titles). `parseGroupingAnswer` reads what models and agents write
(`{groups: [{ids, reason}]}`, a bare list, `f5` for `F-5`; JSON inside prose, a fenced block or an
agent CLI's `{"result": …}` envelope, where an object with the answer's shape wins over a stray list
of ids) and says what it could not use: unknown ids, groups without a report, extra known issues, a
report in two groups (they are joined). An answer with no list of groups, or none that can be used,
is refused and the run's earlier grouping stays; an empty list means "no duplicates", and so does a list
of single reports (as an agent may write it).

Three ways to run it, all through `persona-swarm group <run>` (which then triages and rewrites the
report), or automatically after a finished run when the cohort has `grouping`:

- `model: provider:model`: one call through the AI SDK (`answerWithTool` in the ai-sdk driver
  package) with a required `group_problems` tool. A model that writes text instead, or a call whose
  arguments are not valid JSON (local models often do both), is asked once more, and JSON is read
  from its text. Cost comes from the workspace's prices.
- `command: [...]`: any agent's command line (`claude -p`, `codex exec`, a script). It reads the task
  on stdin, runs in the run folder and its own process group, and prints its answer; `timeoutSec`
  (default 300) bounds it, and whatever it started goes with it.
- Neither: `persona-swarm group <run>` writes `grouping/brief.md` for any agent or person, and the
  reports it lists (`grouping/request.json`). The answer goes to `grouping/answer.json` and comes back
  with `persona-swarm group <run> --from <file> --by <name>`, which checks it against the reports the
  agent was shown and says what it could not use, so the agent can fix it.

After a run, grouping happens before triage, only for a finished run with reports. A failure is
logged, with the command to group later, and never fails the run. A signal or a stop during the
wrap-up cuts it short, and a second signal exits. Its cost is in `triage.totals.costUsd`, not in the
run's spend cap, which governs sessions.

## 9. Run modes

- `explore`: every persona once.
- `gate`: every persona `attempts` times (`<persona>--a<n>`). A persona passes when at least
  `mustPass` attempts finished with every journey check passing (the target's `hooks.check`, run for
  finished attempts only and logged as `check` events; only the checks after an attempt's last start
  count), or, without checks, finished with outcome `completed`. The verdict covers every attempt of
  the run, including those a narrower resume did not run again. Attempts that did not run to the end
  (paused, cancelled, crashed) are no evidence: when they could have decided the verdict, it is
  `inconclusive` rather than a product failure. The verdict goes to `gate.json`, `run.json`
  (`gate`) and `statusReason` (`gate passed`, `gate failed: <personas>` or `gate inconclusive: …`).
- `research`: as explore; the report's cohort aggregates are the point.
- `coverage`: every persona on every cell of `matrix.devices` × `matrix.locales`.

## 10. Exporters

Configured per cohort: `{ type, id?, with, only: approved|all }`, ids unique (the type is the
default id). Secrets come from environment variables named in `with`; relative paths in `with` are
resolved against the cohort's folder, and an exporter command runs there.

| Type | Settings (`with`) | What it does |
| --- | --- | --- |
| `json` | `file` (default: `export.json` in the run folder) | One file of exported findings; an entry is its run id plus its finding id, so one file can collect several runs (written under a lock) |
| `markdown` | `file` (default: `export.md` in the run folder) | Appends each finding |
| `webhook` | `url` or `urlEnv`, `headerEnv` (header → variable), `batch` | POSTs each finding (or all at once); any 2xx is a delivery; the URL is never recorded |
| `command` | `command` (argv), `timeoutSec` (120) | The finding on stdin, the external id on stdout; stopped, with whatever it started, after the timeout |
| `github` | `repo`, `tokenEnv` (`GITHUB_TOKEN`), `labels`, `apiUrl` | An issue per finding, with a severity label; persona text cannot @-mention people or link #issues |
| `linear` | `teamId`, `tokenEnv` (`LINEAR_API_KEY`), `labelIds` | An issue per finding |
| `jira` | `baseUrl`, `project`, `emailEnv`/`tokenEnv` (`JIRA_EMAIL`/`JIRA_API_TOKEN`), `issueType` | An issue per finding |
| `module` | `path` | Loads an `ExporterFactory` from a file |

Exporting needs only the cohort's `exporters` (not the target or personas, nor their secrets). One
export of a run runs at a time (a lock across processes; a second one gives up after 2 s). Approved
findings go by default; `only: all` sends every finding that is not rejected, a duplicate or
harness-suspect. Findings go one at a time unless the exporter is a `batch` one. Each is marked as
being sent in `exports.json` before it goes, and its success recorded before the next is sent (every
success counts, with or without an external id), so an interrupted export never files anything twice:
a finding that was on its way, or whose send failed in a way that may still have delivered it (a
timeout, a connection dropped before the answer, a gateway that gave up: 408, 504, 524), is held back
next time as "may already be filed" until a person checks and exports with `--retry-unsure`; a plain
refusal, or a request that never left (nothing listening, an unknown host), is sent again. Rejected and duplicate reports are
never exported; harness-suspect ones are held back and listed as such in the result, so a reviewer who
approved one knows why it did not go. When `triage.json` is missing or older than the reports, the
grouping or the known issues, the export (and the report) triages afresh first.

## 11. Governor

Samples memory every 2 s the way the operating system judges pressure: macOS `memory_pressure`
(falling back to `vm_stat`), Linux `MemAvailable`, otherwise `os.freemem`. Levels:

- `ok`: start sessions as scheduled.
- `tight` (below `minFreeMemoryPercent`): start nothing new.
- `critical` (below `stopBelowFreeMemoryPercent`): cancel the newest sessions one at a time, close
  their contexts, mark them `paused` (resumable).
- Two consecutive `critical` samples after all sessions are paused: abort the run cleanly. (Any sample
  above `critical` resets the count.)
- Ten minutes below `minFreeMemoryPercent` with sessions waiting and none running: stop the run (the
  sessions stay resumable) rather than wait forever.

`maxBrowsers` and `maxAgents` are hard caps. Every governor action is an event.

## 12. Local API and UI

`GET /api/runs`, `GET /api/runs/:run`, `GET /api/runs/:run/events?session=&after=&limit=` (at most
5,000 events a page: the replay pages through a long session),
`GET /api/runs/:run/findings` (findings, reviews, triage), `POST /api/runs/:run/findings/:id/review`,
`POST /api/runs/:run/findings/:id/apart` (`{ from }`: a reviewer's "not the same"; triages again),
`POST /api/runs/:run/triage`, `POST /api/runs/:run/export` (`{ dryRun }`),
`GET /api/runs/:run/files/<path>` (confined to the run folder), `GET /api/runs/:run/stream` (SSE:
state and events of a live run), `POST /api/runs/:run/stop`, `POST /api/runs/:run/sessions/:session/stop`
(409 when the run is not live in this process). The UI (runs, live grid, replay, findings review) is
static files served from disk.

The server answers only its own pages: it is bound to 127.0.0.1, refuses a Host header that does not
name this machine (127.0.0.1, localhost, [::1]: no DNS rebinding; any port, so an SSH tunnel may
forward another one), accepts writes only as `application/json` from the same origin (no
cross-site requests), and sends a Content-Security-Policy (`script-src 'self'`, no framing). A review
without a severity keeps the earlier one, and an empty one clears it. Of a
run's files it serves only screenshots, downloads and the report, as inert data (`nosniff`, a
sandbox policy without scripts or forms): never the bridge files, briefs or logs. Every decoded path
segment is a single name: an encoded slash or a dot-dot is refused before any check.

## 13. How a run starts

1. The plan: devices resolved, roles bound, accounts assigned. A persona that names an account gets it
   (every one of its sessions: gate attempts, coverage cells); the others get the first unused account
   not marked `shared`, one per session; a session left without one starts without credentials. Two
   sessions holding the same account that is not `shared` never run at the same time.
2. The run folder and its lock; a resume loads its `run.json` (and refuses a folder without one).
3. Memory: below `minFreeMemoryPercent` (default 30%) free, the run fails before starting anything.
4. Dependencies (the proxies), then the target: it counts as up when `health.url` (else `baseUrl`)
   answers below 500 without following redirects. Otherwise `lifecycle.up` runs (a background command
   is waited for at its `readyUrl`, and fails at once if it exits first), and the run fails if the
   target still does not answer 10 s later.
5. Hooks: `setup` (a failure fails the run), then the drivers' capabilities (sessions their model
   cannot play are skipped), then the sessions. Each session opens `signIn.url` (else `baseUrl`);
   scripted sign-in runs only for a session with an account, and any step that fails (a field or
   button not found, a `waitFor` text that never shows) fails the session; then `beforeSession` (a
   failure fails the session).
6. After each finished session, `check` runs for every journey (in every mode; gate verdicts use it);
   after every session that got a browser (finished, paused, failed or cancelled), `afterSession`. After the sessions: the gate verdict, `teardown`, the dependencies stop,
   `lifecycle.down` (only if the run started the target), grouping, triage and the report.

## 14. Failure behaviour and resume

- `persona-swarm run` exits 0 when the run finished (and its gate passed), 1 when it failed, was
  stopped or its gate was inconclusive, 3 when a gate failed; `act` exits 2 when the tool call failed.
  A run in which no session finished has failed.
- Every child process (drivers, lifecycle commands, exporter and grouping commands) runs in its own
  process group and is killed with everything it started on exit, crash, signal or timeout (a Ctrl-C,
  which no longer reaches another group by itself, is passed on to running commands before the CLI
  ends); the target's lifecycle processes are tracked from the moment they start, so a failed start-up
  stops them too. A command that exits while a child it left still holds its output is not waited for.
- `run.json` is rewritten atomically (write to a temp file, then rename); a failed write is retried,
  never fatal.
- A session that crashes is marked `failed` with its error; the run continues. A session paused by the
  governor or the run stopping, or one that stalled (no activity for the watchdog interval), is
  `paused` and resumable, even when the pause lands while it is still being set up. A persona that
  called `finish` is `finished`, whatever stop comes after; running out of time, or two minutes after
  the last action, also finishes a session (outcome `ran_out_of_time`); an operator's stop of one
  session is `cancelled`. A new attempt starts with a clean outcome and stop reason.
- A target hook may be a plain or an async function. One that throws fails only its own step, and one
  that has not finished after `hookTimeoutSec` (or, for `setup`, `beforeSession` and `check`, when the
  run stops) is given up on; the `signal` in its context aborts when it is given up on, so a clean-up
  hook (`afterSession`, `teardown`) keeps a live signal while the run is stopping. A journey check cut
  short by the run's stop is recorded as not run: that attempt is no evidence (the gate can be
  inconclusive, never failed, for it).
- The run owns the process's signals (SIGINT, SIGTERM, and, when a terminal is attached, SIGHUP from
  closing it; a run under `nohup` keeps ignoring hang-ups): the browser
  is launched without Playwright's own signal handlers, so a first signal winds the run down (stop,
  lifecycle `down`, triage, report), or, once the sessions are over, cuts the wrap-up short; a second
  signal from the operator exits at once, killing the drivers and the target's processes on the way
  out, even when the run was already stopping for another reason (the spend cap, memory). `stop` (and
  the UI's stop button) also cuts a wrap-up short. A run whose output nobody reads any more (a pager
  that quit, a closed terminal) goes on; it has its own log. After a run, the CLI exits within two
  seconds even if a stray handle is left (a slow upstream call); the dependency proxy also ends its
  calls in flight when it stops, and answers what is still queued instead of sending it upstream.
- One process per run: `run.lock` names it. `resume` refuses a run that is still executing, and
  `stop` signals only the process that holds the lock (a lock from another machine is reported, never
  signalled). A run that cannot start (its folder locked, nothing to resume) says why and exits 1.
- `resume` reapplies the command-line overrides stored in `run.json` (personas, driver, model,
  limits, budgets; flags given now win; `--no-replay`, `--no-ui` and `--port` apply only when given
  again), continues in the run's own folder wherever it is now and whatever it is called, starts
  nothing if the spend cap was already reached, and runs only the original sessions: every session
  that did not finish, fail or get skipped restarts with what is left of its budget (actions are steps
  in the app, as above), never less than two minutes and ten actions (enough to look around and
  finish), and a briefing built from its earlier notes and actions. Sessions a narrower
  `--personas` leaves out stay resumable. Event numbering, findings and screenshot numbering continue
  where they stopped.
