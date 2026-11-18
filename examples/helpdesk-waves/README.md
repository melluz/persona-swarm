# Help desk waves example (mock app)

A template for a longer campaign: several waves of personas against one app, each wave starting
from what the last one left in the database. "Harbor Desk" is made up: copy this folder, then change
`target.yaml` to your app (its folder, start and stop commands, port and seeded test accounts).

What it shows:

- **Roles in one app.** Admins, agents and customers, each signing in with their own seeded account.
- **Personas written inline** in each wave, with traits (patience, reading, language, vision),
  devices, and a goal that fits the role.
- **Staged waves.** `schedule.waveSize` and `waveIntervalSec` start the admins first and the people
  who need their setup later.
- **Files per persona.** A clean CSV for one admin, a broken one for the other, and an attachment for
  everyone else (`files/manifest.yaml`).
- **Assistive input** in wave 2: keyboard only, screen reader, and no colour vision, enforced by the
  harness, not just described.
- **A different model and effort per persona** (`assign`), to compare what each one finds.
- **A coverage plan** (`waves/PLAN.md`) that is updated after each wave and decides the next one.

Check which files each persona gets, then run a wave from this folder:

```bash
persona-swarm media waves/wave-01.yaml
```

```bash
persona-swarm run waves/wave-01.yaml
```
