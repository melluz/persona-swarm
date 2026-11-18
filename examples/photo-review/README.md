# Photo review example (mock app)

A template for an app with a slow, paid AI service behind it. "Lumen Albums" is made up: copy this
folder, then change `target.yaml` to your app (its folder, start and stop commands, port, test
accounts and the AI service it calls).

What it shows:

- **Lifecycle.** The run starts the app if it is not already up (`npm run dev`), resets the test
  database between runs, and stops the app at the end.
- **A dependency proxy in `cached` mode.** The app calls the tagger through the proxy on port 9001.
  Answers come from `tag-cache/` with a realistic 6 to 14 s delay, so a run never pays for or waits
  on real tagging. A cache miss goes to the real tagger on port 9000.
- **Media with a manifest.** `files/manifest.yaml` describes each file, tags it, and points to the
  expected labels (`truth`) that hooks and reviewers can compare against. Personas never see `truth`.
  `blurry.png` and `notes.txt` are the awkward cases: a poor photo and the wrong kind of file.
- **A desktop and a phone persona** from the shared library, given this app's mission.

All images are synthetic. To fill the cache, start the real tagger and run, from this folder:

```bash
persona-swarm deps warm target.yaml tagger --tags photo
```

Then check which files each persona will get, and run:

```bash
persona-swarm media cohort.yaml
```

```bash
persona-swarm run cohort.yaml
```
