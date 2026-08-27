# Backlog

The ledger for this project. Every open question, defect and wanted change lives
here, with its evidence and its history.

`docs/backlog-view.html` is **generated** from this file by
`bun run scripts/backlog-view.ts`. Never edit the HTML by hand — regenerate it.

## How this works

- **Sessions file, Maor triages.** Any session may add a row, always as
  `proposed`. No session moves a row to another status on its own; every
  transition is a conversation with Maor. Filing is not deciding.
- **Check for duplicates before filing.** Search this file first, including the
  update history of existing rows. If it is already here, say so and point at the
  row instead of adding a second one.
- **State how we will know it is done, at filing time.** A row without a
  `Done when` is a wish, not a task. Write it before anyone builds anything.
- **Nothing is ever deleted.** Closed rows keep the reason. Shipped rows stay as
  history.
- **Proof before `shipped`.** `shipped` means built *and* verified, with the
  verification recorded on the row: what was run, what it showed. An unverified
  fix is a claim.
- **The row stays short, the history accretes.** Scannable fields live in the
  table. Anything longer goes in the detail block below, under a dated update.
  Append updates, never rewrite them.

### IDs

Format `TA-MMDD-slug`, for example `TA-0827-uploads-unbounded`. Immutable, never
reused, and safe to cite in chat, commits and notes.

Deliberately **not** a running counter. A counter needs every writer to re-read
the highest number immediately before writing, and two sessions filing on the
same day still collide. Date plus slug removes that failure mode instead of
policing it: two sessions collide only if they file the same item, which the
duplicate rule already catches.

### Status

The `shown as` column is the label Maor reads. These are a user interface, not a
taxonomy. If one of them ever misleads him, rewrite it.

| status | shown as | means |
|---|---|---|
| `proposed` | דורש החלטה | filed with evidence, waiting on Maor |
| `approved` | מאושר | he said do it; not built yet |
| `parked` | בהקפאה | real, deliberately not now |
| `shipped` | קיים | built and verified in the live agent |
| `closed` | נסגר | decided against; the reason stays on the row |

### Size

`S` under an hour · `M` about a session · `L` more than a session, or needs a design pass.

## Order of work

Nothing sealed yet. When Maor sets a priority order it goes here, dated and
attributed to him. The generated view flags any item named here whose status has
since moved, so this block cannot quietly drift out of sync.

---

## Reliability and data

| ID | Item | Status | Size | Done when |
|---|---|---|---|---|
| TA-0827-loose-runtime-dump | A gitignored runtime dump still sits in the working tree on the server | proposed | S | The file is out of the repo directory and a check confirms none remains under the working tree |
| TA-0827-source-not-in-backup | The nightly backup captures runtime state but no source, so agent-written files have no backup path | proposed | M | A file written by the agent on the server appears in the newest backup archive, verified by listing it |

## Self-development and safety

| ID | Item | Status | Size | Done when |
|---|---|---|---|---|
| TA-0827-untracked-selfdev-invisible | Brand-new source files written by the agent are surfaced by nothing | proposed | M | A new untracked source file on the server appears in the nightly summary, proven by planting one and reading the next summary |
| TA-0827-stale-droplet-stash | An unreviewed stash from 2026-06-10 sits on the server, touching the core file | proposed | S | Its diff has been read, and it is either rescued to a branch or dropped on Maor's word |

## Skills and memory

| ID | Item | Status | Size | Done when |
|---|---|---|---|---|
| TA-0827-skills-not-reached-for | A skill written for a task goes unused even when that exact task occurs | proposed | M | The agent performs a task a skill covers and that skill's use counter increases |

## Housekeeping

| ID | Item | Status | Size | Done when |
|---|---|---|---|---|
| TA-0827-uploads-unbounded | The uploads directory grows without limit | proposed | S | The directory is bounded by age or count, and a run proves old entries are removed |
| TA-0827-test-artifacts-litter | The test suite leaves stray artifacts in the repo root | proposed | S | A full test run finishes with no new stray files in the repo root |

---

# Detail

Source, reasoning and dated history. The tables above stay scannable; the weight
lives here.

## TA-0827-loose-runtime-dump

**Source:** health sweep, 2026-08-27.

**Why:** A runtime text dump produced during the 2026-08-24 database incident is
still sitting in the repo working directory on the server. It is gitignored, it is
also named in the pre-commit hook's blocklist, and the server holds no push
credentials, so it cannot reach the public repo. Measured rather than assumed: an
identical copy is already kept deliberately outside the repo, byte for byte, with
checksums compared on both machines.

Assessed as **not urgent**. The realistic reader is someone who already has a
shell on that box, and such a person already reaches far more sensitive things
there. Filed as hygiene rather than exposure: there is no reason for it to sit in
a repo directory, and the original incident began with exactly that shape.

## TA-0827-source-not-in-backup

**Source:** health sweep, 2026-08-27, while checking whether an agent-written file
was recoverable.

**Why:** The nightly archive contains runtime state (the JSON stores, memory,
history, access config) and no source, which is correct while all source lives in
git. It stops being correct the moment the agent writes a file that is never
committed. Verified by listing the newest archive: source paths are absent.
Together with `TA-0827-untracked-selfdev-invisible`, a file the agent writes for
itself exists on exactly one disk with nothing watching it.

## TA-0827-untracked-selfdev-invisible

**Source:** health sweep, 2026-08-27, after the agent wrote itself a 191-line
helper to satisfy a user request.

**Why:** `selfdev-check.ts` deliberately skips untracked and ignored paths, because
its stated job is "what would a deploy destroy" and `git reset --hard` genuinely
does not touch them. That reasoning is correct and the code is not buggy. The
consequence is still real: a brand-new source file is safe from deletion and
invisible to every report, so it sits unreviewed and unbacked indefinitely. A
visibility gap rather than a safety gap, so the fix belongs beside the guard
rather than inside it.

## TA-0827-stale-droplet-stash

**Source:** health sweep, 2026-08-27, while assessing whether pruning the server's
git objects was safe.

**Why:** One stash exists on the server, dated 2026-06-10, touching the core
poller file. It is almost certainly dead given how much that file has changed
since, but "almost certainly" is not a basis for an irreversible delete. It also
blocks any object prune there, since expiring reflogs would destroy it. Reading it
costs a minute and settles it either way.

## TA-0827-skills-not-reached-for

**Source:** health sweep, 2026-08-27.

**Why:** A skill exists describing how to deliver a file to the chat. Its use
counter reads zero, including on the day the agent delivered a file and instead
wrote a helper from scratch to do it. Delivery worked, so this is not a defect in
the output; it is a signal that the skill never reached the point of decision.
Five further skills also sit at zero uses. Worth knowing whether the suggestion
mechanism is not surfacing them or the agent is not reaching for what it is shown,
because those have different fixes.

## TA-0827-uploads-unbounded

**Source:** health sweep, 2026-08-27.

**Why:** The uploads directory holds 94 files at roughly 10 MB and nothing prunes
it. Harmless today, on a disk at 20 percent, and it only ever grows. Filed so that
it becomes a decision rather than a surprise later.

## TA-0827-test-artifacts-litter

**Source:** open-source sanitization audit handed over 2026-08-27.

**Why:** The suite leaves temporary JSON artifacts in the repo root. All are
gitignored and untracked, so nothing leaks and nothing breaks, but 112 of them
were present at the time of the audit. A teardown that removes what a test created
is the ordinary fix.
