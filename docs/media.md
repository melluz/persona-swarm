# Media: the files personas use

Many apps need files to be useful: a photo to tag, images to annotate, a spreadsheet to import, a
photo of the goods. A target's `media` lists those files. Each persona gets its own set of them,
described in a user's words, and can upload them through the app's file picker or, with a mouse, by
dragging them onto the page. The files stay where they are on your disk; nothing is copied into the
repository or the run.

```yaml
# target.yaml
media:
  - dir: ${env:PHOTOS}/trip              # any folder; ~ and ${env:...} work
    pattern: '\.(jpg|png|heic)$'
    manifest: photos.yaml                 # describes files one by one (optional)
    description: a holiday photo          # for files the manifest does not describe
    tags: [photo]
  - dir: ./wrong
    description: something a user might upload by mistake
    tags: [wrong-kind]
```

```yaml
# photos.yaml, next to the target (paths in it are relative to it)
files:
  - name: beach-014.jpg
    description: a photo of a beach, a bit tilted
    tags: [landscape, tilted]
    truth: truth/beach-014.json           # expected labels: never shown to personas
    notes: Sea and sky are almost the same blue; the tagger often misses "sea" here.
  - name: party-022.heic
    description: a photo from a birthday party, straight from a phone
    tags: [people, heic]
    type: image/heic
```

```yaml
# cohort.yaml: which files each persona has
media:
  "*": { tags: [photo], count: 3, cached: tagger }   # everyone: three photos the tagger has answers for
  confused-newcomer: { tags: [wrong-kind, photo], count: 4 }
```

`persona-swarm media target.yaml` lists the files with their tags, types and truth;
`persona-swarm media cohort.yaml` shows the files each session would get.

## Sources (`media` in the target)

| Field | Value | What it does |
| --- | --- | --- |
| `dir` | folder | Where the files are. Relative to the target file; `~` and `${env:NAME}` work. |
| `pattern` | regular expression | Which file names count (default: every name not starting with a dot). |
| `id` | slug | Names the source in listings (default: the folder's name). |
| `description` | text | What every file here is, in a user's words, unless the manifest says otherwise. |
| `tags` | list | Tags of every file here; a manifest entry adds its own. |
| `type` | MIME type | The type every file here is uploaded as (default: from each file's extension). |
| `manifest` | YAML file | Files described one by one (below). Relative to the target. |

`fixtures` is the older name for `media`; a target may still use it, and `label` still works as a
source's `description`.

Only plain files in the folder count. A symbolic link that points outside the folder is ignored, so a
link to a private file can never become an upload. When two folders hold files with the same name, the
second is called `name (2).ext` in the persona's list and is uploaded under its own name.

## Manifests

A manifest is a list of files, or `{ files: [...] }`:

| Field | Shown to personas | What it is |
| --- | --- | --- |
| `name` | yes | The file's name in the source folder. |
| `description` | yes | What it is, in the words of someone who would upload it. |
| `tags` | no | For choosing files (added to the source's). |
| `type` | no | The MIME type to upload it as (HEIC, a ZIP of an album...). |
| `truth` | no | Reference results for this file: expected labels, annotations, values. A path, relative to the manifest. |
| `notes` | no | Anything a reviewer should know about the file. |

A manifest entry for a file that is not in the folder (or does not match the pattern) stops the run
with an error, so a typo cannot quietly drop a file. Files the manifest does not mention are still
offered, with the source's description and tags.

Write descriptions as the person who has the file would think of it: "the photo of my daughter at the
beach", not "IMG_0142_crop2.jpg". They are what a persona chooses by. Keep anything that would
give away the answer (the right labels, how many people) in `truth` or `notes`.

## Choosing files (`media` in a persona or a cohort)

Without a selection a persona has every file of the target. A selection narrows it:

| Field | Value | What it does |
| --- | --- | --- |
| `tags` | list | Files with any of these tags. |
| `exclude` | list | Never files with any of these tags. |
| `files` | list of names | These files, whatever their tags (with `tags`, either matches). |
| `count` | number | At most this many of the matching files. |
| `spread` | `true` (default) or `false` | With `count`: take the files the run's other sessions have used least, so a cohort covers different files; `false` picks at random for each session. |
| `cached` | a dependency id | Only files the dependency's cache already has an answer for (see below). |

A persona file's `media` travels with the persona; a cohort's `media` (by persona id, or `"*"` for
every persona) replaces it for that run, the way `missions` replace goals. A cohort that names a
persona it does not run is refused.

Choices are seeded by the run id: a resumed run gives each session the files it had, and the run
folder's `media.json` records them. `persona-swarm run` prints how many files each session has, and
warns when a selection leaves a persona with none, or with more than 50 (every file is listed in the
persona's tools, so a long list costs tokens on every turn: give it a `count`).

### Only files with cached answers

When uploading a file starts slow or costly work (an AI model that needs minutes of GPU per image),
the target puts that service behind a [dependency](../README.md#targets) in `cached` mode, and the cache
is filled ahead of the run:

```bash
persona-swarm deps warm target.yaml tagger --tags photo
```

Without file names, `deps warm` warms the target's own media (all of it, or the files with any of
`--tags`). A selection with `cached: tagger` then gives personas only files whose answers are in the
cache, so no run ever waits for, or pays for, the real computation.

## What personas see

Each file appears in the `pick_file` (and `drop_file`) tool as its name, size and description:

```
Files on this computer: beach-014.jpg (2.1 MB, a photo of a beach, a bit tilted); notes.pdf
(433 B, a PDF of notes from the trip, not a photo).
```

A persona can upload only its own files, by those names. A file is uploaded with its own file name and
its declared or usual type; a type the browser would not guess from the extension (HEIC) is sent as
declared.

## Evidence, ground truth and hooks

- **Findings.** A report carries the files its reporter had uploaded in the session before reporting
  (`evidence.media`, latest last). The report and the UI show them, and the report adds each file's
  description, tags, notes and truth path from `media.json`.
- **Events.** Every upload is a `tool.call` of `pick_file` or `drop_file` with the file's name.
- **Hooks.** A target's hooks receive `media` (every file of the target, with absolute paths, truth and
  notes) and, for a session, `sessionMedia` (that persona's files). A `check` hook can compare what the
  app produced for an uploaded image with its truth:

```js
// hooks.mjs
import { readFile } from 'node:fs/promises'

export async function check({ journey, events, sessionMedia }) {
  if (journey !== 'labels-correct') return { passed: true, details: 'not this journey' }
  const uploaded = events.filter((e) => e.type === 'tool.call' && e.tool === 'pick_file').map((e) => e.input.file)
  const item = sessionMedia.find((file) => file.name === uploaded.at(-1) && file.truth)
  if (!item) return { passed: false, details: 'no image with a reference was uploaded' }
  const truth = JSON.parse(await readFile(item.truth, 'utf8'))
  const saved = await fetchSavedLabels() // from the app's API or database
  const missing = truth.labels.filter((label) => !saved.includes(label))
  return { passed: missing.length === 0, details: `missing on ${item.name}: ${missing.join(', ') || 'none'}` }
}
```

## Data already in the app

Some tests start from an app that already holds data: an album with 200 photos half tagged, a
customer with three earlier orders. That is the target's state, not files a persona uploads, and it
belongs in the target's lifecycle and hooks:

- `lifecycle.up` commands start the app when it is not running, and can restore a known database on
  the way (a snapshot, a seed script). They do not run when the app already answers.
- A `setup` hook runs once per run with every media file: it can upload them to the app through its
  API, so personas find them there.
- A `beforeSession` hook runs per session with that persona's files and test account: it can create
  the persona's own project from them, so sessions do not step on each other.

```js
// hooks.mjs: give each persona a project with its images already in it
export async function beforeSession({ account, sessionMedia, target }) {
  const token = await signIn(target.baseUrl, account)
  const project = await createProject(target.baseUrl, token, `Swarm ${account.id}`)
  for (const item of sessionMedia.filter((file) => file.tags.includes('photo'))) await uploadImage(target.baseUrl, token, project, item.file)
}
```

Those helpers are your app's API calls; persona-swarm only provides the files, the account and the
moment to run them.
