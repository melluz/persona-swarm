# Personas

A persona is a person who uses your app: who they are, what they know, how they see and move, and what
they came to do. It is a YAML file, usually in `personas/`. A cohort lists the personas it runs, and
its `roles` decide which driver and model play them. The same persona can be played by Sonnet, a local
model or a scripted monkey.

A persona is more than a prompt. Its **proficiency** decides which tools the agent gets, and its
**body traits** are enforced by the harness, whatever the model does with the brief: a persona with
unsteady hands misses small targets, and a low-vision persona's browser really is zoomed to 200 %.
**Mind traits** are written into the brief the agent plays from.

```yaml
# personas/low-vision.yaml
id: low-vision
name: Margaret Hughes
proficiency: 2
traits:
  patience: 4
  reading: reads
  recovery: back
  domain: 2
  risk: cautious
  focus: task
  priorTools: large-print letters and a magnifying glass
  helpSeeking: support
  vocal: stoic
  vision: low
  precision: 2
  pace: slow
background: |
  71, has macular degeneration and keeps her browser zoomed to 200 %. Reads slowly, loses her place when
  a page reflows or jumps sideways, and misses anything small, faint or far from where she is looking.
mission:
  goal: Do the main task from start to finish with your browser zoomed in, and say wherever text is cut off.
device: laptop-1366
```

## Fields

| Field | Required | Value | What it does |
| --- | --- | --- | --- |
| `id` | yes | lower-case letters, digits, `.`, `-`, `_` | Names the persona's sessions (`low-vision`, `low-vision--a2` for a second gate attempt). |
| `name` | yes | text | The person's name, used in the brief and the UI. Fictional. |
| `proficiency` | yes | 1–5 | Skill with software, and the tools the agent gets (see below). |
| `traits` | no | see [Traits](#traits) | Mind and body traits. Each one is optional; one left out has no effect. |
| `background` | yes | text | Who they are, in plain words: age, job, habits, what bothers them. The agent role-plays it. |
| `mission` | yes | see below | What they came to do. A cohort's `missions` can replace the goal per run. |
| `device` | yes | a preset name, or a full profile | The screen, input and system settings (`persona-swarm presets` lists the presets). |
| `deviceOverrides` | no | device fields | Changes to the preset: only the fields given change. They win over what a vision trait sets. |
| `account` | no | an account id from the target | A specific test account; otherwise each persona gets a free one. |
| `media` | no | `{ tags, exclude, files, count, spread, cached }` | Which of the target's files this person has on their computer. Left out, every file. A cohort's `media` replaces it. See [docs/media.md](media.md). |
| `budget` | no | `{ minutes, turns, scale }` | This person's own time and actions, or a scale on the cohort's baseline (see [Budget](#budget)). |
| `requires` | no | `{ vision, minContext }` | `vision: false` lets a model that cannot see images play the persona (only with an outline-based tool profile); `minContext` is the smallest context window, in tokens, a model needs to play it. |
| `toolProfile` | no | `sight`, `reader`, `power`, `keyboard`, `screenreader` | Overrides the tool profile derived from input and proficiency. |
| `notes` | no | text | Extra instructions appended to the brief, under "Also". |

### `proficiency`

| Level | Who | Tool profile (mouse users) |
| --- | --- | --- |
| 1 | Has the wrong idea of what the product does; reads only big words; believes whatever the screen says. | `sight`: screenshots and coordinates only |
| 2 | Not at ease with software: skims, clicks the biggest button, gives up after two or three tries. | `sight` |
| 3 | Manages the main path of most apps, misses secondary controls, sometimes gets lost. | `reader`: adds the page outline, refs, `fill`, `select` |
| 4 | Confident: reads the screen, tries alternatives, recovers alone. | `power`: adds text search and tabs |
| 5 | Expert and fast; notices wrong details at once. | `power` |

Touch users always get `sight`, keyboard-only users `keyboard` and screen-reader users `screenreader`,
whatever their proficiency: the input decides first.

### `mission`

| Field | Value | What it does |
| --- | --- | --- |
| `goal` | text | What they want to get done, in their words. |
| `kind` | `open` (default) or `scripted` | `scripted` gives numbered steps to follow. |
| `steps` | list of text | The steps, for a scripted mission. |
| `success` | list of text | What done looks like, for checks and reviewers. |

## Traits

Mind traits change the brief. Body traits change the brief **and** what happens: the device is set up
for them, and the tool server changes the persona's actions on the way to the device. That is the same
for every driver and model, so a body trait never depends on how well a model role-plays.

Everything a body trait did is in the session's events: a `tool.result` carries `body` (what slipped,
for example `landed 6, -3 px off`, `clicked twice`, `delivery → delivert`) and `thinkMs`, and each
interruption is an `interruption` event. A reviewer can tell a finding caused by a slip from one caused
by the app.

### Mind traits

| Trait | Values | In the brief |
| --- | --- | --- |
| `patience` | 1–5 | 1–2: clicks again when nothing happens within a second or two, gives up quickly. 4–5: keeps trying other ways. |
| `reading` | `skims`, `reads`, `studies` | `skims` reads headings and buttons only; `studies` reads everything, small print included. |
| `recovery` | `back`, `reload`, `retry`, `asks` | What they do first when something goes wrong. `asks` looks for help, a chat or a support contact, and reports it when there is none. |
| `domain` | 1–5 | Knowledge of the product's field, separate from computer skill. 1: none of its words mean anything, and a wrong value looks as good as a right one. 5: an expert who notices a wrong term or number at once. |
| `risk` | `cautious`, `normal`, `bold` | `cautious` will not press anything that deletes, sends, pays or cannot be undone until sure, and reads confirmations. `bold` presses things to see what they do. |
| `focus` | `task`, `wanders` | Straight to the goal, or curious about menus, settings and side pages on the way. |
| `priorTools` | text | What they are used to ("Excel", "paper forms", "the old version"): they expect things to work and be named that way, and say so when they are not. |
| `language` | `{ native, fluency }` | Their first language (a BCP 47 tag: `es`, `pt-BR`, `ja`) and how well they read the app's language, 1 (a few words) to 5 (as well as their own). Pair it with `deviceOverrides.locale` when their computer is set to that language too. |
| `helpSeeking` | `never`, `tooltips`, `docs`, `support` | Where they look for help: nowhere, hints and info icons, help pages, or a person. |
| `vocal` | `stoic`, `normal`, `vocal` | How readily they report. A stoic persona's report means more; a vocal one reports small things too. |

### Body traits

| Trait | Values | What the harness does |
| --- | --- | --- |
| `vision` | `normal`, `low`, `blurred`, `protanopia`, `deuteranopia`, `tritanopia`, `achromatopsia`, `high-contrast`, or `{ zoom, deficiency, highContrast }` | Sets up the device, so every screenshot shows what the person sees (see below). |
| `precision` | 1–5 | Clicks, taps, drags and drops **at coordinates** land off target: a typical miss of 14 px at 1, 8 at 2, 4 at 3, 2 at 4, none at 5 (normally distributed, at most three times that, always on the screen). At 1 about one mouse click in eight, at 2 one in sixteen, comes out as a double click (by ref too). Actions by ref otherwise land where they should: a ref is the element itself, not a spot on the screen. |
| `pace` | `rushes`, `normal`, `slow` | `rushes`: an action returns as soon as it is done, without waiting for the page to load or settle, so the next one can land on a page still changing. `slow`: 2.5 to 7 s of looking before each action (it uses the session's time, not its actions; the budget adds that time, see [Budget](#budget)). |
| `typing` | `careful`, `typos`, `pastes` | Applies to `type` and `fill`. `typos`: about one word in eight of three letters or more gets one slip (a neighbouring key, a doubled or dropped letter, two letters swapped), not corrected. `pastes`: the text arrives at once (no key presses), with typographic quotes and apostrophes, sometimes a non-breaking space, and often a stray space at either end. |
| `interruptions` | `none`, `some`, `many` | Before an action, at random (never in the first three actions; `some`: a 6 % chance per action once six have passed since the last one; `many`: 15 % once four have passed): **away**, 30 to 90 s idle; **offline**, the connection drops during the action and returns three seconds after it; **reload**, the page reloads first, as a sleeping tab does; **reopen**, the tab is closed and the page opened again from history (session storage and unsaved form contents are lost). The persona is told what happened. |
| `multitab` | `true` or `false` | The `tabs` tool, whatever the proficiency. Five actions in, the page they are on opens in a second tab, as a habit would, and they continue in the new tab: two tabs on the same record. |

#### `vision`

| Shorthand | Device settings |
| --- | --- |
| `normal` | none |
| `low` | `zoom: 2` and `contrast: more`: the page lays out as at 200 % browser zoom |
| `blurred` | `visionDeficiency: blurredVision` |
| `protanopia`, `deuteranopia`, `tritanopia`, `achromatopsia` | that `visionDeficiency`: red-, green- or blue-blind, or no colour at all |
| `high-contrast` | `forcedColors: active` and `contrast: more`: Windows high-contrast mode |

The object form combines them: `{ zoom: 1.5, deficiency: deuteranopia, highContrast: true }`. Any of
these can be set or changed in `deviceOverrides` instead, which win over the trait.

Zoom is real browser-zoom layout: a 1440-pixel window at 200 % lays the page out in 720 CSS pixels, so
breakpoints, reflow and sideways scrolling behave as they do for someone who zooms. The persona's
screenshots are that size. Colour deficiencies and blur are rendered by Chromium for everything on the
page (CDP `Emulation.setEmulatedVisionDeficiency`), so a status shown only in red and green really is
lost on a deuteranopic persona.

### Slips are repeatable

A session's slips come from a seed made of the run id and the session id: the same session misses,
misspells and is interrupted the same way when it runs again, and a different session differently.

## Budget

Each session has a number of minutes and of actions (each step in the app is one action; looking,
notes and reports are free). The cohort's `budgets.minutesPerPersona` and `turnsPerPersona` are a
**baseline**, not everyone's budget: a novice takes more wrong turns than an expert, and a slow persona
spends minutes thinking, so a single number would starve some personas and waste time on others.

A session's budget is worked out in this order:

1. **Start** from the cohort's baseline, or from `--minutes` and `--turns` when the run was started
   with them.
2. **Scale by traits** (unless the cohort sets `budgets.scaleByTraits: false`):

   | Trait | Minutes | Actions |
   | --- | --- | --- |
   | `proficiency: 1` | ×1.5 | ×1.5 |
   | `proficiency: 2` | ×1.3 | ×1.3 |
   | `interruptions: some` | ×1.1 | – |
   | `interruptions: many` | ×1.25 | – |
   | `pace: slow` | + the thinking time its actions take (about 4.75 s each) | – |

3. **Scale** by the persona file's `budget.scale`, then by the cohort's `budgets.personas.<id>.scale`.
4. **Fixed values win.** `minutes` or `turns` given in the cohort's `budgets.personas.<id>`, or else in
   the persona file's `budget`, are used as they are, with no scaling or thinking time added. The
   cohort's win over the persona file's: the persona says "this person is slow", the cohort says "this
   mission in this app takes this long". `--minutes` and `--turns` replace fixed values too, so a quick
   run stays quick; the scales still apply.

Minutes are rounded to the half minute, actions to the whole action.

```yaml
# In a persona file: this person needs twice the usual time and actions, wherever they are used.
budget: { scale: 2 }

# In a cohort: a 10-minute baseline, the novice fixed at 25 minutes for this mission, the expert at half.
budgets:
  minutesPerPersona: 10
  turnsPerPersona: 100
  personas:
    novice-skimmer: { minutes: 25 }
    expert-power-user: { scale: 0.5 }
```

`persona-swarm run` prints each session's budget before it starts, and `persona-swarm persona <file>`
shows how a persona's budget is worked out against the default baseline (30 minutes, 200 actions). A
cohort that names a persona in `budgets.personas` that it does not run is refused, so a typo cannot
silently do nothing. A resumed session gets what its earlier attempts left of its own budget.

The budget ends a session; it does not stretch it. A persona that finishes its mission early ends
early, so a generous budget costs only what the persona actually uses.

## Device

`device` is a preset name or a full profile. `deviceOverrides` changes only the fields it names.

| Field | Value | What it does |
| --- | --- | --- |
| `viewport` | `{ width, height }` | The window, in CSS pixels. |
| `deviceScaleFactor` | number | Clamped by the run's `maxDeviceScaleFactor` (default 1). |
| `isMobile`, `hasTouch` | boolean | Mobile layout and a touch screen. |
| `userAgent` | text | The browser's user agent. |
| `input` | `mouse`, `touch`, `keyboard`, `screenreader` | How the persona operates the device; decides gestures and, first, the tool profile. |
| `locale`, `timezoneId` | `sv-SE`, `Europe/Stockholm` | The computer's language and time zone. |
| `colorScheme` | `light`, `dark` | `prefers-color-scheme`. |
| `reducedMotion` | `reduce`, `no-preference` | `prefers-reduced-motion`. |
| `network` | `slow-3g`, `fast-3g`, `clinic-dsl`, `offline`, or `{ latencyMs, downloadKbps, uploadKbps }` | Throttling of the target's `throttleUrls` (default: every request). A persona with a network gets the `wifi` tool. |
| `cpuThrottle` | 1–20 | CPU slowdown. |
| `zoom` | 1–4 | Browser zoom (set by `vision: low`). |
| `visionDeficiency` | `none`, `protanopia`, `deuteranopia`, `tritanopia`, `achromatopsia`, `blurredVision`, `reducedContrast` | How Chromium renders the page (set by the colour and blur shorthands). |
| `forcedColors` | `active`, `none` | Windows high-contrast mode. |
| `contrast` | `more`, `no-preference` | `prefers-contrast`. |

## The library

| Persona | Proficiency | Device | What it is for |
| --- | --- | --- | --- |
| `busy-phone-user` | 4 | iPhone 13, Swedish | Tiny targets, cut-off text, rushing, interruptions between appointments |
| `confused-newcomer` | 1 | laptop, dark mode | The wrong mental model, unsuitable inputs, believing whatever is shown |
| `curious-explorer` | 3 | laptop | Every screen, odd pasted inputs, two tabs |
| `expert-power-user` | 5 | desktop | Speed, precision, wrong details, keyboard shortcuts |
| `impatient-double-clicker` | 3 | desktop | Double submits, rushing, reloads, two tabs, interruptions |
| `international` | 4 | desktop, Japanese, Auckland time | Non-English names, pasted text, dates and time zones |
| `keyboard-only` | 4 | laptop, keyboard input | Focus order, visible focus, unreachable controls |
| `low-vision` | 2 | laptop, 200 % zoom | Reflow, sideways scrolling, small targets, faint text |
| `methodical-auditor` | 5 | large desktop, deuteranopia | Consistency between screens and exports; meaning carried by colour |
| `novice-skimmer` | 2 | old laptop | The main path without help, shaky clicks, typos |
| `screen-reader` | 4 | desktop, screen reader | Labels, headings, landmarks |
| `slow-network` | 3 | Android tablet, slow 3G | Saving over a bad connection, dropped connections |
| `tablet-touch` | 3 | iPad, touch | Touch targets, gestures, rotation |

`persona-swarm init` copies the library into a new workspace. Copy one and change it rather than start
from nothing.

## Writing a persona

- Pick the proficiency for what the person can do with software, and `domain` for what they know of
  the field: a dentist who is bad with computers is `proficiency: 2, domain: 5`.
- Give only the traits that matter for what you want to find. Each body trait costs something: `slow`
  and `interruptions` spend time (the budget adds it back, so the run takes longer), `rushes` and
  `precision` produce findings a careful person would not, which is the point.
- Write the background as a person, not as a test plan: age, work, habits, what annoys them. Keep
  test instructions in the mission.
- Keep names and details fictional.
- Check a persona with `persona-swarm persona personas/<id>.yaml`: it validates the file and prints
  the device it resolves to, its tool profile, its budget, what its vision trait sets, its body, and
  every line its traits add to the brief.
