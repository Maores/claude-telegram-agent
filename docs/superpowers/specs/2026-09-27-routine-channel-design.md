# Routine channel: design spec (self-contained)

Date: 2026-09-27 (revision 1)
Status: approved section by section in brainstorming on 2026-09-27; this written spec waits for the
owner's review. Nothing here is built, deployed or scheduled.

> Self-contained for a fresh implementer. Read the file:line anchors in the live code before editing;
> line numbers drift. THE REPO IS PUBLIC: no real skill names, log content, people, paths or
> addresses in code, tests, fixtures, docs or the branch's history. Use synthetic items and
> placeholders such as `~`, `<YOUR_SERVER_IP>`, `<YOUR_KEY>`, `<python>`.

## Goal

Claude Desktop scheduled routines on the owner's PC ("routines") need a way to tell him when they
have something for him, and to take his answer (approve, reject, correct) from the phone with a
tap. This spec adds that channel through the Telegram agent: the routine drops a message or a set
of cards on the PC, the agent shows it in the owner's existing Telegram chat, his taps travel back
to the PC, and a tool on the PC carries them out.

## Why it is needed

Measured on 2026-09-27 in five supervised runs of the first client routine: the desktop app's own
push notification never reaches the phone from a scheduled run. The notification tool answered
"Mobile push not sent (Remote Control inactive)" in the first run and, in the others, that the
terminal was active so a notification would be redundant. A scheduled run starts without Remote
Control, and the tool that turns it on refuses unattended sessions, so a routine cannot fix this
for itself. A second, monthly routine relies on the same notification and has the same gap.

The first client is a weekly routine that drafts Hebrew descriptions for new items on a generated
page of the owner's installed skills ("the skills map"). It never approves on its own; approval
runs a command of the map's script on the PC, where the data file lives. Today the owner approves
by typing in that run's own session, which works but is hard to find.

## Decisions made with the owner

1. **Channel.** Telegram, through the existing agent and chat. Email was considered and dropped:
   the mail connector is untested inside unattended runs, and answering by mail is heavy.
2. **Speed.** An answer takes effect within minutes while the PC is awake: the PC checks every
   5 minutes.
3. **Cards, one item at a time.** Four buttons per card: approve, reject, approve all, other.
   Approve and reject act on the shown item and move to the next; approve all approves the shown
   item and every item after it that is still open; other opens a free answer about that item.
4. **Reject** deletes the draft; the item returns to "new, not described", and the routine drafts
   it again on its next run.
5. **Other.** The owner types or speaks what to change (the new text itself, or an instruction such
   as "shorter"). The agent writes the new description and shows it with ✓/✗; only ✓ records it.
   A question instead of a change is answered and the card stays open.
6. **Approach A.** The PC syncs with the agent over the existing ssh key; the agent owns the chat;
   each routine's own tool on the PC carries out the answers. A second bot owned by the PC alone
   was rejected (a second chat, a new token on the PC, taps kept by Telegram for only 24 hours).
7. **Approve from anywhere.** A small PC skill lets any Claude session list what is waiting and
   answer it through the same command the sync uses; the Telegram card then reads as handled on
   the PC. It replaces "type the answer in the run's own session".
8. **Shabbat and holidays.** A message created during Shabbat or a Yom Tov waits on the server until
   it ends, by a wide window (below), not exact sunset times.
9. **Presentation.** One message per request that turns from card to card (edited in place), ending
   as a summary that the PC's result then updates. Messages without answers ("notices") are plain.
10. The desktop push-notification calls are removed from both routines and replaced by the channel.

## Architecture

```
routine (PC, Claude)          sync task (PC, every 5 min)            agent (server)
  | writes request file   ->    outbox  --ssh, one call-->  rchannel.ts sync -> store
  |                                                            poller tick: send / hold
  |                                                            taps, "other" turn, ✓/✗
  |                              answers <--same call--------  store (answers not acked)
  |                              run registered handler
  |                              results --second call------>  store -> edit summary
skill (any PC session) ---- rchannel-pc.ts answer (same path) -> close note on next sync
```

Units and their one job each:

| Unit | Where | Job |
|---|---|---|
| `rchannel.ts` | server, repo root | store, quiet-time check, rendering, callback transitions, `sync` and `propose` CLI |
| poller glue | `poller.ts` | tick (send, hold, supersede, results), `rc:` callbacks, "other" directive, ✓/✗ |
| `scripts/rchannel-pc.ts` | PC, repo | outbox, `sync`, `answer`, `open`, `notice`, ledger, lock, handler runs |
| `scripts/rchannel-sync.ps1` | PC, repo | launcher for the scheduled task (same shape as `cc-journal-push.ps1`) |
| map handler | PC, outside the repo | `--phone-request`, `--phone-answers`, `--reject` in the map's script |
| `routine-inbox` skill | PC, outside the repo | show waiting cards in any session and answer through `answer` |

## The one safety rule

The PC never executes anything that came from the server. From the server come only an answer's
request id, card key, verdict (`approve`, `reject`, `correct`) and, for `correct`, the new text.
Which program handles a routine's answers is registered on the PC (`handlers.json`), and that
program validates every answer against its own data. A taken-over server can at most approve,
reject or correct descriptions in the map, and the map's script already refuses description text
that looks like a URL, an address, a path or a key.

Only the allowlisted chat can tap or reply (`handleCallback` already checks the allowlist,
`poller.ts:1910`). What leaves the PC: item names, labels and draft descriptions, and routine
notice text. No file contents, no keys.

## PC side

### Folder

Everything lives under `~\.claude\tools\routine-channel\`, a path that is not redirected by the
desktop app's packaged-AppData behaviour, so sessions and the scheduled task see the same files:

- `app\`: a `git archive` copy of the repo files the PC side needs, never a development checkout
- `config.json`: `{"target": "<user>@<YOUR_SERVER_IP>", "key": "<YOUR_KEY path>", "outbox": "..."}` (a key path, never a key)
- `handlers.json`: `{"<routine>": {"argv": ["<python>", "<script>", "--phone-answers"], "timeout_s": 120}}`
- `outbox\`: request files; `outbox\rejected\` for files that fail validation
- `state.json`: requests sent and their cards, the ledger of applied answer ids, queued results and closes
- `sync.log` (last 200 lines), `last-sync-ok` (marker for the watchdog), `lock` (O_EXCL, stale after 10 minutes)

### Request file (schema v1)

Written by a routine's tool with a temp file and a rename, one file per request:

```json
{
  "v": 1,
  "id": "map-20261004-0945-a1b2",
  "routine": "map",
  "title": "<Hebrew title shown first>",
  "kind": "cards",
  "text": "<Hebrew intro line, or the whole notice>",
  "supersedes": true,
  "cards": [
    {"key": "<stored item name>", "heading": "<label>", "body": "<draft description>", "note": "לא נבדק"}
  ]
}
```

Limits, checked on the PC and again on the server: `id` `[a-z0-9-]{1,60}` and unique; `routine`
`[a-z0-9-]{1,40}`, and for `kind: "cards"` it must be registered in `handlers.json`; `title` up to
60 characters, `text` up to 1,000, at most 30 cards, `key` and `heading` up to 100, `body` up to
600, `note` up to 40. `kind: "notice"` has no cards. `supersedes: true` closes any open cards request
of the same routine when this one is shown.

### `rchannel-pc.ts sync` (the scheduled task)

1. Take the lock; if another run or an `answer` holds it, log nothing and exit 0.
2. Validate outbox files; move a bad one to `outbox\rejected\` with one log line.
3. One ssh call, `BatchMode=yes`, `ConnectTimeout=15`, whole call capped at 60 seconds, the fixed
   remote command `cd ~/claude-bot && bun run rchannel.ts sync`, and a JSON payload on stdin:
   `{"v": 1, "requests": [...new], "acks": [...answer ids], "results": [...], "closes": [...]}`.
   No user data on the command line. One attempt per cycle: the next cycle is the retry.
   Two facts are unverified and must be checked read-only before the plan fixes the command: the
   `bun` a non-interactive ssh session finds (use the absolute path the service unit uses if PATH
   lacks it), and whether the key's `authorized_keys` entry on the server carries a forced command
   or other restrictions (the journal push only needs `cat`, `wc` and `mv`).
4. The reply on stdout: `{"v": 1, "received": [request ids], "answers": [...not yet acked]}`.
   Outbox files named in `received` move to `sent\` (last 50 kept); sent acks, results and closes
   are cleared from `state.json`.
5. For each answer whose id is not in the ledger: group by routine, write
   `work\<routine>-<stamp>.json` (`[{"card", "verdict", "text"?}]`), and run the registered argv
   with that file appended: no shell, the handler's timeout, output captured.
6. The handler prints one JSON line per card: `{"card", "outcome": "approved|rejected|corrected|already|refused", "detail"}`.
   Exit 0: record the answer ids in the ledger and queue acks and results. Exit 3 (busy): leave
   them unacked for the next cycle. Any other exit or unreadable output: queue results with
   outcome `failed` and ack, so one bad answer cannot block the queue. A routine with no handler:
   the same, with detail "no handler".
7. When step 5 ran anything, a second ssh call carries the new acks and results at once, so the
   summary message updates within the same cycle.
8. On a successful exchange, write `last-sync-ok`. Log one line per cycle only when something
   happened or failed.

The ledger makes delivery effectively once: the server keeps an answer until it is acked, and the
PC never runs an answer id twice. Handlers are idempotent on top of that (approving an approved
item reports `already`).

### `answer`, `open`, `notice` (for sessions and routines)

- `open` prints every sent cards request whose cards are not all applied on the PC, with each
  open card's heading, body and note.
- `answer --request <id> (--card <key> | --all) --verdict approve|reject|correct [--text "<new>"]`
  takes the lock, runs the handler at once, records a local answer id in the ledger, and queues a
  `close` so the next sync marks those cards "handled on the PC" in Telegram.
- `notice --routine <name> --title "<title>" --text "<text>"` writes a notice request to the outbox.

### Scheduled task

"TelegramAgent routine channel": every 5 minutes, only when the user is logged on, never wakes the
machine, `conhost.exe --headless` in front of pwsh (Windows Terminal ignores `-WindowStyle Hidden`),
runs `app\scripts\rchannel-sync.ps1 sync`. Runs are judged by `sync.log` and `last-sync-ok`,
because the headless host hides the exit code. Registered at rollout on the owner's go, and he
watches its first run.

### Watchdog (PC, outside the repo)

A new section in the daily 20:00 `check.ps1`, using its existing awake-hours helper: warn when
`last-sync-ok` is more than 2 awake hours old, and when a file in `outbox\` or `outbox\rejected\`
is more than 2 hours old.

## Server side

### Store

`~/rchannel/store.json`, outside the repo (so it adds nothing to the repo's ignored runtime list),
written under the existing `withFileLock` because the `sync` CLI and the poller both write it:

- `requests[]`: `id`, `short` (server-assigned, `q1`, `q2`, ...), `routine`, `title`, `kind`,
  `text`, `supersedes`, `cards[]` (`key`, `heading`, `body`, `note`, `state`: `open`, `approve`,
  `reject`, `correct` or `closed`, `text`, `outcome`), `status` (`queued`, `showing`, `answered`,
  `done`, `superseded`), `chatId`, `messageId`, `cursor`, `createdAt`, `sentAt`.
- `answers[]`: `id` (`a1`, `a2`, ...), `request`, `card`, `verdict`, `text`, `at`.
- `proposals[]`: an open ✓/✗ correction: `request`, `card`, `text`, `messageId`, `expiresAt`.

Finished requests are pruned after 30 days. The store is not in the nightly backup: losing it
loses open cards, and the PC can resend a request by moving its file from `sent\` back to `outbox\`.

### `rchannel.ts sync`

Reads stdin (cap 1 MB; larger is refused), validates `v` and every request with the same limits as
the PC, stores new requests as `queued` (an id seen before is only reported in `received`), drops
acked answers, stores results on their cards, applies closes, prints the reply JSON, exits 0.
Exit 2 on malformed input, with a one-line reason on stderr and nothing stored.

### Poller tick

On the existing 30-second tick (beside `checkDigest`, `poller.ts:2998`):

1. **Quiet time.** A request stays `queued` while `quietNow(now)` holds (below).
2. **Send.** A notice is sent as `<title>: <text>` and marked `done`. A cards request first closes
   older open cards requests of the same routine when `supersedes` is set (their message is edited
   to "הוחלף בעדכון של D/M"), then sends its first card and becomes `showing`.
3. **Results.** When results arrive for every answered card, the summary is edited: "המחשב עדכן"
   with counts, and any `refused` or `failed` card named with its short detail. `already` counts as
   handled.
4. **Closes.** Cards closed by an `answer` on the PC are marked "טופל במחשב": the shown card
   moves on to the next open one, and a request with no open card left renders its summary with
   those cards counted as handled on the PC.

### Quiet time

`quietNow(now)` is true when today is Shabbat or a Yom Tov and the local time is before 21:00, or
when tomorrow is Shabbat or a Yom Tov and the local time is 14:00 or later. It reuses the Hebrew
calendar reader and the Yom Tov table in `ccdigest.ts` (`hebrewDate`, `YOM_TOV`), moved to a shared
module or exported. An unreadable calendar counts as quiet: a message on a holiday is the worse
failure. The wide window was chosen over exact sunset times, which would need an outside source.

### Card message

One message per request, edited in place. A card renders as:

```
<title> · פריט <n> מתוך <N>
<heading>
<body>
<note, when present>
```

with the keyboard `[✓ מאשר] [✗ דוחה]` / `[מאשר הכל] [אחר…]` and callback data
`rc:<short>:<n>:<a|r|all|o>` (well inside Telegram's 64 bytes). The text follows the repo's BiDi
rules: no English fragment joined to Hebrew with a dash or a colon.

- `a` / `r`: record the answer, move the cursor to the next open card, render it; with no open card
  left, render the summary ("<title>: אושרו 4, נדחה 1, תוקן 1." and "ממתין למחשב.").
- `all`: approve the shown card and every open card after it (one answer per card), then the summary.
- `o`: open an "other" ask for this chat (one-shot, 10 minutes, the same shape as the custom-snooze
  ask at `poller.ts:338`), and edit the card to add "כתוב או הקלט מה לשנות" with one button
  `[חזרה לכרטיס]` (`rc:<short>:<n>:back`).
- A tap on a closed, superseded or already answered card gets "כבר טופל" and no change.

### "Other"

The owner's next message (text, or a voice note after transcription) closes the ask and runs a
normal turn with a directive, joined to the existing ones at `poller.ts:1569` and `:1853`:

> The owner is answering "אחר" on item <heading> of <title>. Its current description: <body>. If
> he asks for a change to the description, write the full new description in Hebrew (one or two
> plain sentences, no links, paths, commands or addresses) and run
> `bun run rchannel.ts propose --request <short> --card <n> --text "<new>"`, then reply in one short
> line. If he asks a question about the item, answer it and propose nothing. If the message is
> about something else, handle it normally and propose nothing.

`propose` validates the request, the card (still open) and the text (length, no URL, path or
address shapes, the repo's threat scan) and stores a proposal for this turn. After the turn the
poller sends "התיאור החדש ל<heading>:" with the text and `[✓] [✗]` (`rc:<short>:<n>:ok|no`). ✓
records a `correct` answer and advances the card message; ✗ edits the proposal to "בוטל" and the
card stays. A proposal expires after 24 hours.

## The map handler (PC, the map's script, outside the repo)

- `--phone-request`: writes a cards request with every draft still waiting, this run's batch first,
  then older drafts; card key = the item's stored name, heading = its label, body = its draft
  description, note "לא נבדק" when an item from outside the machine has no review verdict;
  `supersedes: true`. Prints `request=<id> cards=<n>`, or `request=none` when nothing waits.
- `--reject NAME...`: deletes those draft entries (an approved entry is reported, not touched), so
  the items return to "new, not described" and the next weekly run drafts them again.
- `--phone-answers FILE`: for each answer, `approve` approves by stored name, `reject` rejects,
  `correct` replaces the description and approves in one step (the owner already confirmed the new
  text with ✓; today `--correct` leaves a draft as a draft). Rebuilds the page once at the end.
  Prints one JSON result line per card; exit 0 when the file was processed (some cards may be
  `already` or `refused`), 3 when the data file is locked and nothing was done, 2 on a malformed file.

## Routine changes (PC, outside the repo)

- **Weekly map routine.** Step 6 runs `--phone-request` instead of the push notification; a failed
  or refused request adds ", בלי התראה" to the session title as before. The failure step runs
  `notice` with a fixed text ("העדכון השבועי נכשל. הפרטים בסשן של הריצה."), so no model-written
  text is passed on a command line. The reply's closing instruction points to Telegram or to the
  skill in any session; if the owner answers in the run's own session, the run invokes the skill.
- **Monthly notify-only routine.** Its push notification becomes one `notice` call with the same
  text; only a date fills in, so the argument is digits and a slash.

## The `routine-inbox` skill (PC, outside the repo)

Triggers on questions like "what is waiting for my approval" and on approval words in any session.
It runs `open`, shows the waiting cards in Hebrew the way the phone does, and turns the owner's
words into `answer` calls: approve one, approve all, reject one, or correct one (Claude drafts the
new text and asks for a yes before `answer --verdict correct`). It reports the handler's results.
One execution path: it never runs the map's script directly.

## Failure behaviour

| Situation | What happens |
|---|---|
| PC asleep or off | Answers wait on the server; the summary reads "ממתין למחשב" until results arrive |
| Server unreachable | Outbox files wait; the next successful sync sends them; the watchdog warns after 2 awake hours |
| Answered on the phone and in a session | The second one reaches the handler as `already` and reads "כבר טופל" |
| Draft changed or approved elsewhere meanwhile | The handler reports `already` or `refused`; nothing acts on stale data |
| Map script busy | Exit 3; the answers stay unacked and run on the next cycle |
| Quiet time | Requests stay queued and are sent at 21:00 at the end of Shabbat or the holiday |
| A request never answered | Stays open with no reminders; the next week's request supersedes it and carries its drafts |

## Testing

Run the repo suite from Git Bash on the PC (from PowerShell, `bash` is the WSL launcher and three
deploy tests fail falsely).

- **Server:** store transitions (queue, show, answer, all, supersede, ack, results, prune);
  `quietNow` on a table of instants: Friday 13:59 and 14:00, Saturday 20:59 and 21:00, both days of
  Rosh Hashanah, Yom Kippur, an ordinary Tuesday, and an unreadable calendar; `sync` stdin/stdout
  contract, the 1 MB cap and malformed input; callback parsing including stale taps; rendering of
  a card, the summary and the results line, with the BiDi rules checked; `propose` validation.
- **PC:** `sync` with an injected ssh (the pattern of `cc-journal-push.ts`), outbox validation,
  ledger dedupe across two cycles, a fake handler for exit 0, 3 and a crash, lock contention with
  `answer`, the second call for results, `notice`, `open`.
- **Map handler:** tests in the tool's own suite for `--phone-request`, `--reject` and
  `--phone-answers`, including `already` and a busy lock.
- **End to end, supervised, on the owner's go:** a planted item as in the 2026-09-27 runs, a real
  card on his phone, one tap of each kind (approve, reject, approve all, other with a correction),
  then the data file, the page and the Telegram message checked; one notice from the monthly routine.

## Rollout (only on the owner's explicit go)

1. Server half as a PR; review; merge; deploy with `deploy.sh`, the restart proven by the poller's
   start time changing; `rchannel.ts sync` with an empty payload checked over ssh.
2. PC half: the `app\` copy, `config.json`, `handlers.json`, the scheduled task (he watches the first
   run), and the watchdog section (backup of `check.ps1` first).
3. The map handler (local commit in the tool's own repo) and the two routine prompts.
4. The skill, with its row in the vault's skills index.
5. The supervised end-to-end run.

## Out of scope

Email; reminders for unanswered cards; exact Shabbat times; answering from the phone into an
arbitrary PC Claude session (Remote Control's job); routines other than the two named here, which
join later by registering a handler.

## Known limits

- A rejected item may come back next week with a similar draft, since the routine sees the same
  facts; "other" is the way to steer it.
- Answers take up to 5 minutes, and only while the PC is awake.
- Claude Desktop routines run only while the app runs, so a request is created only then.
