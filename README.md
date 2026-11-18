# persona-swarm

Simulated users test your web app. Each persona is an AI agent with a proficiency, a device, a way of
working and a mission; it uses your app in its own browser, thinks aloud, reports what goes wrong in its
own words, and gives an honest account at the end. You watch them live, replay every session, review
the findings and send the good ones to your tracker.

- **Model-agnostic.** Personas run on any model: OpenAI, Anthropic, Google, OpenRouter, a local model
  through Ollama or vLLM, the Claude Code CLI, or any agent that can run a shell command. Drivers are
  separate processes speaking a small JSON protocol, so they can be written in any language.
- **Faithful personas.** Proficiency is enforced by the tools a persona gets, not only by its prompt:
  novices and touch users act on what they see (screenshots and coordinates), keyboard users get keys,
  screen-reader users get the page outline and no screenshots. Body traits are enforced too: unsteady
  hands miss small targets, low vision zooms the browser, colour blindness is rendered into every
  screenshot, and typos, rushing and interruptions happen whatever the model does.
- **Trustworthy findings.** Every report carries evidence (the screen, the console and network errors,
  the actions before it). Duplicates are caught where the judgement is best: before a report is filed,
  the persona is shown similar reports and confirms one instead. Triage flags reports caused by the
  harness or the environment, groups the rest (a model or an agent can find the duplicates wording
  misses), matches known issues, fingerprints problems across runs and suggests a severity. By default
  nothing reaches your tracker until you approve it.
- **Safe to run on your own machine.** One browser for the whole run (an isolated context per persona),
  a memory governor that pauses personas before the machine runs short, budgets per persona and per
  run, and a dependency proxy that puts slow or costly services behind a cache or stub.

## Quick start

```bash
pnpm install && pnpm build
node packages/cli/dist/main.js doctor              # Node, browser, memory, drivers, keys
node packages/cli/dist/main.js fixture --port 4500 # a small app with 7 planted bugs (keep it running)
node packages/cli/dist/main.js run examples/kiln/monkey.yaml
```

`examples/kiln/monkey.yaml` needs no model and no keys: three model-free "monkeys" (a mouse, a phone
and a keyboard-only persona) start signed in, press things at random for a few minutes and report
anything that crashes. They show the machinery, not much more: real findings need a model or an agent.
`run` prints a live view URL: a grid of every persona's screen, what they are saying, memory and cost,
with stop buttons. When the run ends, `report.html` is in the run folder, and `persona-swarm ui` lets
you replay sessions and review findings.

`examples/kiln/cohort.yaml` is the same app with three shopkeepers played by outside agents (the
`external` driver): run it, then give each agent its brief from `runs/<id>/bridge/<persona>.md`. To use
a model instead, set `roles.persona` to `{ driver: ai-sdk, model: openai:gpt-5-mini }` (or any model
below).

Start your own workspace with `persona-swarm init my-tests`: it writes a target, a cohort and the persona
library. The cohort runs the model-free "monkey" out of the box; switch its `roles.persona` to a real
model when you are ready.

## Concepts

| Term | What it is |
| --- | --- |
| Target | Your app: base URL, a product brief (what a user could know), test accounts, sign-in, media (files personas upload, described one by one, with ground truth), slow dependencies, known issues, optional hooks. `targets/*.yaml` |
| Persona | Who: name, proficiency 1–5, mind traits (patience, reading, recovery, domain knowledge, risk, focus, prior tools, language, help-seeking, how vocal), body traits (vision, precision, pace, typing, interruptions, multitab), background, mission, device. `personas/*.yaml`; a library of thirteen ships with the tool. Every field: [docs/personas.md](docs/personas.md). |
| Device | A preset (`persona-swarm presets`: desktops, laptops, iPhone, Pixel, iPads, Galaxy Tab) plus overrides: locale, time zone, dark mode, input (mouse, touch, keyboard, screen reader), slow network, CPU throttling, zoom, colour-vision emulation, high contrast. |
| Cohort | A run definition: target, personas, mode, roles (driver and model), missions, budgets, limits, schedule, exporters. |
| Run | One execution. Everything lives in `runs/<runId>/`: state, per-session event logs, screenshots, findings, reviews, triage, report. |
| Driver | What plays a persona: `ai-sdk`, `claude-code`, `external`, `mock`, `python-reference`, or your own. |

### Run modes

- `explore`: personas roam, report and finish. The default.
- `gate`: each persona plays several attempts (`gate: { attempts, mustPass }`); target hooks can check
  journeys. Agents are not deterministic, so gates pass on thresholds, never on one attempt.
- `research`: many personas on the same task; the diaries' scores and the friction notes are the point.
- `coverage`: each persona is expanded over `matrix.devices` and `matrix.locales`.

## Drivers

| Driver | Models | Notes |
| --- | --- | --- |
| `ai-sdk` | `openai:<model>`, `anthropic:<model>`, `google:<model>`, `openrouter:<model>`, `ollama:<model>`, or `<provider>:<model>` from `persona-swarm.yaml` | Built on the Vercel AI SDK. Own loop, session memory (old screenshots pruned, long sessions summarised), budgets. Keys from the environment. |
| `claude-code` | `sonnet`, `opus`, `haiku` or a full id | Runs the local Claude Code CLI with every built-in tool disabled: only the persona's tools exist. Uses the CLI's own login: the first `claude` on PATH, or `PERSONA_SWARM_CLAUDE_BIN` (`doctor` shows which, and other installs; sign in with that one). |
| `external` | any agent or a person | Writes a brief per session; the agent acts with `persona-swarm act <session-file> <tool> '<json>'`. Lets Codex, Cursor, a Claude Code subagent or a human play a persona. |
| `mock` | none | `mode: monkey` (seeded random exploration that reports crashes) or `mode: script` (deterministic steps with `$ref(text)` lookups). For tests and chaos baselines. |
| `python-reference` | none | A standard-library Python driver: the skeleton for writing drivers in Python. |

Before trusting a model with personas, qualify it: `persona-swarm conformance --driver ai-sdk --model
openai:gpt-5-mini`. It signs in, creates an order, hits a spot by coordinates, reports, finishes, and
counts how many of the fixture app's seven planted bugs it found (recall). It uses the workspace's
browser settings, prices and limits, but always a browser on this machine (the fixture app listens on
127.0.0.1 only). Results go to `.persona-swarm/conformance.json`.

A persona whose tools need screenshots is never paired with a model that cannot see: the orchestrator
asks each driver what each model can do before the run and skips impossible pairings with a reason.
Text-only models can still play outline-based personas (`toolProfile: screenreader`).

### Writing a driver

A driver is any executable that reads JSON-RPC 2.0 messages, one per line, on stdin and answers on
stdout (logs go to stderr). See `ARCHITECTURE.md` §6 for the messages. In TypeScript:

```ts
import { connectPersonaTools, serveDriver } from '@persona-swarm/driver-kit'

await serveDriver({
  name: 'my-agent',
  version: '1.0.0',
  capabilities: (model) => ({ imageInput: true, contextWindow: 128_000, toolCalling: true }),
  async runSession(spec, context) {
    const tools = await connectPersonaTools(spec.mcp) // the persona's MCP endpoint
    // Loop: give spec.instructions and spec.kickoff to your agent, run its tool calls with
    // tools.call(name, args), emit events with context.emit(...), stop on context.signal or budget.
    return { stopReason: 'finished', finalMessage: '...', turns: 0 }
  },
})
```

Register it in `persona-swarm.yaml`: `drivers: { my-agent: { command: [node, ./my-agent.js] } }`.
`drivers/python-reference/driver.py` does the same in plain Python.

## Personas

A persona is a YAML file: who the person is, what they can do with software, how they see and move, and
what they came to do. [docs/personas.md](docs/personas.md) documents every field; the library in
`personas/` has thirteen to copy from.

```yaml
id: novice-skimmer
name: Kwabena Asante
proficiency: 2               # 1–5: skill with software, and which tools the agent gets
traits:
  patience: 2                # mind traits: written into the brief
  reading: skims
  domain: 2                  # knowledge of the field, separate from computer skill
  risk: cautious
  priorTools: paper forms and phone calls
  precision: 2               # body traits: enforced by the harness as well
  pace: slow
  typing: typos
background: |
  64, runs a small family business and uses a computer reluctantly. ...
mission:
  goal: Get the one main thing this product is for done from start to finish, without help.
device: laptop-old
```

| Kind | Traits | Enforced by |
| --- | --- | --- |
| Mind | `patience`, `reading`, `recovery`, `domain`, `risk`, `focus`, `priorTools`, `language`, `helpSeeking`, `vocal` | The brief the agent plays from |
| Body | `vision` (zoom, colour blindness, blur, high contrast), `precision` (missed and double clicks), `pace` (rushing, thinking time), `typing` (typos, pasting), `interruptions` (stepping away, dropped connection, reloads, reopened tabs), `multitab` | The device and the tool server, for every driver; each slip is logged with the action |

`persona-swarm persona personas/low-vision.yaml` checks a persona: it prints the device it resolves to,
its tool profile, its body, and every line its traits add to the brief.

## The persona's tools

Tools come from MCP, one endpoint and token per session, bound to that persona's device: an agent can
never reach another persona's browser. The set depends on the tool profile:

| Profile | Who | Tools |
| --- | --- | --- |
| `sight` | proficiency 1–2, all touch users | screenshot, click_at / tap_at, scroll, type, press; with a mouse: drag, drop_file; with touch: swipe, pinch, long_press_at |
| `reader` | proficiency 3 | + outline, click / tap by ref, fill, select |
| `power` | proficiency 4–5 | + find_text, tabs |
| `keyboard` | keyboard-only users | screenshot, type, press (no pointer at all) |
| `screenreader` | blind users, text-only models | outline, find_text, fill, select, type, press (no screenshots) |

Every persona also has `back`, `forward`, `reload`, `go_to`, `pick_file`, `answer_dialog`, `wait`,
`note`, `report_problem`, `confirm_problem` and `finish`; `wifi` when its device has a network profile
or its mission is about Wi-Fi, being offline or the connection; `rotate` on phones and tablets. A file picker behaves as in a real browser: clicking "Choose file" opens it (the status
line says so) and `pick_file` gives it a file; `pick_file` can also open the picker by its control.

When a persona reports a problem that looks like one already reported (by anyone, itself included, or
in the target's known issues), the report is held: the persona sees the similar reports and either
confirms one with `confirm_problem` (its note, page and screenshot become evidence) or files its own
with `not_same_as`. Replayed over a real 65-report run, about nine in ten of the reports it would have
held were true duplicates.

## Targets

```yaml
id: shop
name: Shop
baseUrl: http://localhost:3000
brief: What the marketing site says.
lifecycle:
  up: [{ run: [npm, run, dev], cwd: ../shop, background: true, readyUrl: http://localhost:3000 }]
accounts: [{ id: a, username: a@example.test, password: pw }]
signIn: { mode: scripted, url: /login, steps: [{ fill: Email, value: '{{username}}' }, { fill: Password, value: '{{password}}' }, { click: Sign in }, { waitFor: My orders }] }
media: [{ dir: ./files, pattern: '\.(png|pdf)$', manifest: files.yaml, tags: [photo] }]   # see docs/media.md
dependencies:
  - id: ml
    listen: { port: 8001 }                 # point your app's ML URL here during runs
    upstream: http://localhost:8000
    mode: cached                           # real | cached | stub | record
    cache: { dir: ./.cache/ml, key: { multipartField: image }, statuses: [200, 422] }
    latencyMs: { min: 60000, max: 90000 }  # replayed answers still feel real
    concurrency: 1
    maxWaitMs: 80000                       # refuse rather than compute answers nobody waits for
knownIssues: known-issues.yaml
hooks: ./hooks.mjs                         # setup, teardown, beforeSession, afterSession, check
```

Scripted sign-in steps name fields and buttons the way the accessibility tree does (an exact name wins
over a partial one), so they work on any device, a keyboard-only one included. End them with a
`waitFor` naming text only a signed-in user sees: a sign-in that did not work (a changed password, a
locked account) then fails the session instead of leaving the persona signed out. Hooks may be plain
or async functions; each call is given up on after the target's `hookTimeoutSec` (300 by default). `persona-swarm deps warm target.yaml ml` pre-computes a dependency's cache for the target's media (or name files, or pick them with `--tags`).

`media` are the files personas can upload: images to annotate, documents to import, the wrong file a
user picks by mistake. A manifest describes each file the way its owner would ("a photo of a beach, a
bit tilted"), tags it, and can point to its ground truth (expected annotations), which
personas never see. A persona or a cohort chooses which files each persona has
(`media: { "*": { tags: [photo], count: 3, cached: tagger } }`), spread so sessions cover different
files. Reports name the files uploaded before them, and hooks get every file with its truth to check
results or seed the app. `persona-swarm media target.yaml` lists the files; the details are in
[docs/media.md](docs/media.md).

Any string in a configuration file may say `${env:NAME}` (for example `password: ${env:SHOP_PASSWORD}`):
the value comes from the environment when the file is loaded, and a missing variable stops the run
with a clear error. Model API keys always come from the environment.

`known-issues.yaml` lists what the team already knows (`- { id: K-1, title: ..., description: ... }`).
Personas who hit one confirm it instead of reporting it again, and the report shows which known issues
were seen in the run and by whom: a cheap regression signal.

## Findings, review and export

- `persona-swarm triage <run>` re-runs the pipeline: harness-suspect and environment flags, groups
  (what testers said in so many words first, such as "my F-4 is a duplicate of this", then wording and
  page, then a model's or agent's grouping if the run has one; reports a tester called different stay
  apart), known issues, fingerprints (and the cross-run registry in
  `.persona-swarm/registry.json`), suggested severities, per-session metrics (actions, errors, Back
  and reload counts, notes, held reports, confirmations, cost, diary scores). The report adds ease,
  trust and outcomes by proficiency and by input. Every group says why its reports are together.
- `persona-swarm group <run>` lets a model or an agent find the duplicates wording misses (one fault
  described in other words, from another screen or device) and match reports to known issues. It
  works with any model (`--model openai:gpt-5-mini`, `ollama:qwen2.5`, or the cohort's
  `grouping: { model }`), any agent command line (`grouping: { command: [claude, -p] }`: the task on
  its stdin, the answer on its stdout), or any agent or person reading `grouping/brief.md` and
  answering with `persona-swarm group <run> --from answer.json --by <name>`. With `grouping` in the
  cohort it runs by itself after each finished run. It only ever joins; a tester's "not the same"
  always wins.
- Review in the web UI (approve, reject, needs info, duplicate of, severity, note), or with
  `persona-swarm review <run> F-3 approved --severity major`. Every group says why its reports are
  together; when wording or a grouper got it wrong, "not the same" in the UI (or
  `persona-swarm split <run> F-3 F-2`) splits it for good, as a tester's own "not the same" would.
- `persona-swarm export <run> [--dry-run]` sends approved findings (or, with `only: all`, every one
  not rejected, a duplicate or harness-suspect) through the cohort's exporters: `markdown`, `json`,
  `webhook` (`urlEnv` keeps a secret URL out of the cohort file), `command` (pipe JSON to any program),
  `github`, `linear`, `jira`, or `type: module` with your own exporter; their settings are listed in
  `ARCHITECTURE.md` §10. A finding is marked before it is sent and recorded as soon as it is filed, and
  one export of a run runs at a time, so an exporter never files the same finding twice, even after an
  interruption or a double click: a finding that may have arrived when an export was cut off is held
  back until you check and export with `--retry-unsure`.

## Where runs execute

- **Laptop**: small cohorts, with the defaults below keeping memory in check.
- **A VM**: the same CLI, bigger limits. Start runs with `--detach`, run `persona-swarm ui` there, and
  watch through an SSH tunnel (`ssh -L 4400:127.0.0.1:4400 vm`, any local port): the UI only ever
  listens on the VM's own 127.0.0.1.
- **CI**: a `gate` cohort. `persona-swarm run` exits 0 when the run finished and its gate passed, 3
  when the gate failed (the product), and 1 when the run failed, was stopped or the gate was
  inconclusive (attempts that could decide it did not run to the end: the harness, not the product).
- **A browser elsewhere** (a cloud browser service, a browser on another machine): set
  `browser.connect` in `persona-swarm.yaml`. The run's personas then use contexts in that browser.

```yaml
browser:
  connect: { url: 'wss://browser.example.test/?token=${env:BROWSER_TOKEN}', protocol: cdp }
```

## Safety and resources

- Synthetic data only, isolated test environments only, never production.
- Personas can only open the target's origin (plus any `extraOrigins` the target lists, such as a
  sign-in provider): links, redirects and pop-ups elsewhere are stopped, and the persona is told. They
  only upload plain files the target declares (no links out of the folder), and have no outward tools.
- `persona-swarm ui` listens on 127.0.0.1 only and answers only its own pages: other websites cannot
  read runs or send reviews, and run files are served as inert data (never bridge tokens or briefs).
- External-driver agents run as your own user. Each session's file is readable only by that user, but
  not by one agent rather than another: treat the agents you hand briefs to as trusted with the run.
- `limits`: `maxBrowsers`, `maxAgents`, `minFreeMemoryPercent` (start nothing new below it),
  `stopBelowFreeMemoryPercent` (pause the newest session; abort if it persists), `maxDeviceScaleFactor`
  (1 by default: canvas memory grows with its square).
- `budgets`: minutes and actions per persona (each step in the app is one action; looking at the
  screen, notes and reports are free; the persona sees both counting down, and its session ends two
  minutes after its last action), `usdPerRun` for the whole run. `minutesPerPersona` and
  `turnsPerPersona` are a baseline: each persona's own budget is scaled by its traits (novices get
  more, a slow persona gets its thinking time, interruptions add minutes), by a `budget` in the
  persona file, and by `budgets.personas` in the cohort, which can also fix one persona's minutes and
  actions for this mission (`personas: { novice-skimmer: { minutes: 25 } }`). `--minutes` and
  `--turns` replace the baseline for one run. `run` prints each session's budget; the rules are in
  [docs/personas.md](docs/personas.md#budget). A spend cap is only accepted when every model in the
  run has a cost source: a driver that reports cost (Claude Code), or a price in `persona-swarm.yaml`
  (`prices`); otherwise the run refuses to start rather than run with a cap it cannot keep.
- Runs survive their terminal (`--detach`; a run in the foreground also winds down cleanly when its
  terminal closes) and can be resumed (`persona-swarm resume <run>`, also for a run folder that was
  moved): the run continues with the command-line options it was started with (`--no-replay`,
  `--no-ui` and `--port` apply only when given again), and a resumed persona gets a briefing of what it
  had done.

## Layout

`packages/`: `core` (schemas, stores, presets), `driver-kit` (protocol), `device-web` (Playwright),
`tool-server` (MCP), `dep-proxy`, `findings`, `engine` (orchestrator), `server` (API and web UI),
`fixture-app`, `cli`. `drivers/`: `ai-sdk`, `claude-code`, `external`, `mock`, `python-reference`.
`personas/`: the library. `examples/kiln`: cohorts against the fixture app (the model-free quick start
and one for outside agents). `examples/photo-review` and `examples/helpdesk-waves`: templates for
your own app (a mock app with a slow AI service behind a cached dependency, and a campaign of waves
with several roles and assistive input; see their READMEs). `ARCHITECTURE.md` is the contracts, `docs/personas.md` the persona reference, `docs/media.md` the media reference.

```bash
pnpm test   # builds, then runs every suite (browser suites use one Chromium, two workers)
pnpm lint   # biome: lint and formatting
```

## License

MIT. See [LICENSE](LICENSE).
