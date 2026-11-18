# Can persona-swarm be rewritten in Rust?

## 1. Verdict

**Partly. A full rewrite is possible, but it isn't worth it now.** Every subsystem has a Rust path, but three pieces resist a Node-free port:

- **Playwright's AI aria snapshot and `aria-ref=` locators** (`packages/device-web/src/web-device.ts:420,955`). The personas see the page through this exact text.
- **The Vercel AI SDK's provider normalisation** (`drivers/ai-sdk/src/driver.ts:121-161`, `structured.ts:44-66`). genai 0.7.3 cannot put images inside tool results.
- **User JS loaded with `import()`**: target hooks get a live Device (`engine/src/orchestrator.ts:370`), and there are `module` exporters (`findings/src/exporters.ts:319-326`).

So even a full port ships Node: through the playwright-rs bundled driver, a hook sidecar, or the `claude` CLI itself. Adding up the verified estimates, a full port is about 130-160 dev-days. A Rust host with TS sidecars is about 75-90. On the 16 GB Mac, either one cuts persona-swarm's own Node memory by roughly 0.5-1 GB at 6 sessions. That moves the browser ceiling by about one session, because Chromium renderers and the `claude` CLI processes dominate. Most of that saving is available in TypeScript within a week.

## 2. Per subsystem (verified figures; the verifier wins where it disagreed with the first map)

| Subsystem | TS src lines | Difficulty | Rust days | Key crates | Blocker / main risk |
|---|---|---|---|---|---|
| core + server (fixture-app stays TS) | 3,710 | medium | ~22 | serde + garde, **serde-saphyr** (not serde_yaml_ng/norway, which are stale; not serde_yml, which has RUSTSEC-2025-0068), tokio, axum 0.8, unicode-normalization, libm | Useless on its own, because it is an in-process library for 23 source files. Needs bit-exact sha1 fingerprints (UTF-16 sort, `similarity.ts:141`), mulberry32 + V8 `Math.log/cos` (`body.ts:81`) and lock identity strings (`locks.ts`, `ps -o lstart=`). `detached:true` means `setsid` (`process.ts:77`), not `process_group(0)`. |
| device-web + tool-server | 2,514 | very high (Node-free) / medium (playwright-rs) | 35-45 / 10-14 | chromiumoxide 0.9.1 or chromey 2.58; **playwright-rs 0.20.1** (`AriaSnapshotMode::Ai`); rmcp 3.9.0 | Node-free means rebuilding the aria snapshot, aria-ref, actionability, navigation waits, pop-up auto-attach emulation and OOPIF handling. playwright-rs keeps exact behaviour but bundles a ~130 MB Node driver. |
| engine + dep-proxy | 2,261 | high | ~27 (dep-proxy alone ~4) | tokio, tokio-util `CancellationToken` + `OnceLock<StopReason>`, hyper 1.12, reqwest 0.13 (two clients) | Target hooks with a live Device need a Node hook-host sidecar. The in-process `onReady` live API (`orchestrator.ts:993-999`, `cli/main.ts:244-263`) and grouping through the AI SDK (`cli/grouping.ts:69`) also stay in process. Cancel-by-drop would skip the session `finally` at `orchestrator.ts:776-833`. Cache keys need a JS-compatible JSON canonicaliser (`proxy.ts:110-112`). |
| findings + cli | 2,981 | high | ~18 | regex (lookaheads rewritten), reqwest, clap, rmcp client (for `act`), rust-embed | Assumes core config/locks/stores (~1.9k lines) is already ported. `module` exporter. Lone-surrogate JSON written by TS `.slice()` (`exporters.ts:187`) is rejected by serde_json. Cross-process lock interop. Exactly-once export error mapping. |
| driver-kit + drivers | 2,109 | high | ~23 full / 4-5 host only | rmcp, native OpenAI/Anthropic/Gemini clients (~1,000-1,400 lines) | ai-sdk is about 60% of the work, and its provider quirks only show up against live providers. The `claude` CLI stream-json protocol is undocumented either way. |
| **Total** | ~13.6k + 1,078 UI | | **~130 full, plus integration ≈ 130-160** | | |

## 3. The memory question: would Rust have stopped the 17-browser crash?

**No.** Here is what a run spawns, from the code and from measurements taken today:

- **One orchestrator Node process** hosts the CLI, engine, tool-server (`orchestrator.ts:1013`, one `ToolServer` for all personas), device-web (`orchestrator.ts:510`, one Chromium) and the API server. Importing the CLI alone peaks at ~167-170 MB RSS (verifier measurement).
- **One Chromium** (browser, GPU and network processes), plus **one BrowserContext per persona**. Each context runs its own renderer process(es), with more for the second-tab body trait and for cross-origin iframes. Expect 150-500 MB per persona depending on the target app.
- **One Node driver process per session** (`orchestrator.ts:647`), plus one probe per driver/model pair (`:449`). Measured idle peak RSS: mock 72 MB, claude-code 75 MB, external 77 MB, ai-sdk 86 MB. These grow with conversation history and base64 screenshots.
- **The claude-code driver also spawns the `claude` CLI** (`drivers/claude-code/src/driver.ts:102`), a Node app that is not ours. I did not measure a live session; estimate a few hundred MB each. The last 3 runs in `runs/` all used `claude-code` with 5 sessions.
- **The external driver starts a fresh ~170 MB Node process for every `persona-swarm act` call.** The cost is transient.
- **Other processes:** the target's lifecycle commands, and the Docker VM if one is running (7.6 GB on this machine).

At 6 sessions, persona-swarm's own Node memory is about 0.15 GB plus 6 × 0.08-0.15 GB, roughly **0.6-1.1 GB**. A complete Rust port, ai-sdk driver included, brings that to about 0.1-0.2 GB. At 17 sessions it would save about 1.2-2.4 GB, set against an estimated 3.5-8.5 GB of Chromium renderers and the `claude` CLI processes, which a port leaves untouched. **Rust raises the cap by roughly one or two personas. What prevents crashes is the governor** (`engine/src/governor.ts`, using `memory_pressure`), which already exists. Two cheaper TS fixes get most of the Rust saving (see option C):

- **Driver pooling.** `serveDriver` already multiplexes sessions by `sessionId` (`packages/driver-kit/src/serve.ts:47,79-83`).
- **Lazy imports.**

## 4. Three options

### A. Full rewrite (Node-free where possible)
- **Effort:** ~130-160 dev-days (6-8 months solo), then a long tail of flaky behaviour against real target apps.
- **You gain:**
  - one binary for the file-only commands;
  - ~0.5-1 GB less RAM at 6 sessions;
  - millisecond `act` calls;
  - typed `StopReason` and run state (today `RunState`/`SessionState` are unvalidated interfaces, `core/src/schemas/run.ts:112-191`).
- **You lose:**
  - Playwright's battle-tested auto-wait, navigation and emulation (or you keep Node via playwright-rs);
  - the AI SDK's provider smoothing;
  - JS target hooks and `module` exporters, which become a breaking change or a sidecar;
  - cross-run fingerprint continuity, unless golden tests match bit for bit.
- **Risk:** very high. Behaviour drift turns into misattributed findings. Exactly-once exporters could file tracker issues twice.

### B. Hybrid: Rust host, engine and CLI as a single binary; TS/Python sidecars
- **Effort:** ~75-90 days. That is core (22) + engine (27, includes the hook sidecar and live-API IPC) + findings/cli (18) + driver host (4-5) + device-web/tool-server (playwright-rs, 10-14) or a TS device sidecar with a Device RPC.
- **You gain:**
  - a Rust orchestrator;
  - Rust `act` (the clearest win, about 0.5 s → a few ms per action);
  - dep-proxy as its own binary;
  - typed process and cancellation handling.
  
  The driver protocol is already language-neutral: JSON-RPC lines over stdio, proven by `drivers/python-reference/driver.py`.
- **You lose:**
  - the single-runtime story, since Node is still required for Playwright, ai-sdk, hooks and `claude`;
  - you take on 2-3 new process boundaries (Device RPC, hook host, live-run IPC);
  - a long hybrid period in which lock files, `run.json`, JSONL and fingerprints must stay byte-compatible between the languages.
- **Memory gain:** small, unless the drivers are also ported.
- **Risk:** high. The interop invariants are the bug surface.

### C. Stay in TS and fix the specific pain points
- **Effort:** ~3-8 days.
- **The fixes:**
  1. **Lazy subcommand imports** in `cli/main.ts:30-35`. Measured: `act` drops from ~0.5 s / 170 MB to ~0.25 s / 80 MB, about an hour of work.
  2. **Driver pooling:** one process per driver type rather than per session (`orchestrator.ts:647`). Saves (N-1) × 75-150 MB. The trade-off is crash isolation and per-session process-group kill, so keep per-session processes for claude-code, whose real cost is its `claude` child anyway.
  3. **Count persona-swarm's own processes in the governor** (driver and `claude` RSS by process group), so the cap follows real usage rather than a fixed ≤6.
  4. **Validate `run.json`/state on read** with zod.
  5. **Optional:** a `persona-swarm-act` thin entry point, or a Node SEA build for packaging.
- **You lose:** nothing.
- **Risk:** low. The ~165 vitest cases stay valid as they are.

## 5. Recommendation

**Do C now.** It addresses the problems that are actually measured (`act` startup and RSS, per-session driver processes, memory headroom) at about 5% of the cost. If Rust is still wanted afterwards, whether for distribution, type safety or interest, migrate in this order, smallest and most self-contained first. Fixture-app, the ai-sdk driver and the Python driver stay in TS/Python throughout.

**Phase 0, the parity harness (~5 days, before any Rust).**
- Generate a golden corpus from the TS code:
  - archived run folders from `runs-archive/`, with their `triage.json`, `report.html` and registry fingerprints;
  - PRNG/aim streams;
  - dep-proxy cache keys;
  - lock-file identity strings;
  - YAML configs from `examples/`.
- Move tests that matter to process boundaries (CLI argv/stdout, HTTP, run-folder diffs), so the same vitest suites can run against either the TS or the Rust binary.

**The phases, each with its acceptance check:**

| Phase | What moves to Rust | Days | Acceptance check |
|---|---|---|---|
| 1 | dep-proxy as a standalone binary | ~4 | `dep-proxy/test/proxy.test.ts` passes over HTTP. Cache keys match TS on the corpus. |
| 2 | Core formats + findings + file-only CLI commands (status, review, triage, report, export minus `module`) | ~25-30 | `triage.json` and fingerprints are identical to TS on every archived run. Lock interop is tested with a live TS holder. |
| 3 | `act` + external bridge (rmcp client) | ~5 | Existing external-driver tests pass against the binary. |
| 4 | Driver host + engine, with device-web/tool-server and hooks in a TS sidecar | ~30-35 | `engine/test/orchestrator.test.ts` E2E passes against the binary with mock, Python and external drivers. |
| 5 (optional) | device-web via playwright-rs | ~10-14 | The 15 device tests and 12 tool-server tests pass. |

**Stop after any phase that does not pay for itself.**

## 6. Open questions

1. **Why Rust? What problem are you solving?**
   - RAM headroom for more personas? (Section 3: Rust buys ~1 session; pooling and the governor buy similar.)
   - Install and distribution (one binary, no pnpm/Node)? Only a full port achieves that, and only if hooks and module exporters are dropped.
   - Snappier `act` for external agents? Lazy imports first.
   - Type safety or robustness?
   - Learning or interest? That is a valid reason, but it points to phases 1-3 only.
2. **Is "Node-free" a hard requirement?** If so, are you willing to break TS target hooks and `module` exporters, and to replace Playwright's outline text that the prompts are tuned on?
3. **Which drivers matter?** Recent runs are all `claude-code`. If that is the norm, its `claude` child processes dominate driver memory, and porting ai-sdk is low value.
4. **Must cross-run history survive?** Registry fingerprints, `seenInRuns`, dep-proxy caches and seeded replays all require bit-exact parity work.
5. **What actually crashed at 17 browsers?** Was Docker running? Was it persona-swarm or another swarm? Run one session with `ps -axo rss,pgid,comm` sampling to get real per-session numbers, including `claude`, before deciding anything on memory grounds.
6. **How much time are you willing to spend?** Weeks (C plus phases 1-3) or months (B or A)?
7. **Does Windows or Linux matter?** It changes the process-group, lock and `memory_pressure` porting work.