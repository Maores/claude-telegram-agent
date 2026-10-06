# Phone inbox: a Telegram group the agent files, a PC session reads on request

Date: 2026-10-05. Status: approved by the owner on 2026-10-05; revised the same day after a first round of three plan reviewers, with his answers to the questions it raised and a security section he approved part by part.

## Why

The owner keeps finding things on the phone (mostly screenshots, also links and tools that might be worth installing) and has no quick way to hand them to the PC. Sending them to the agent's private chat starts a full Claude turn each time and mixes them into the conversation. He wants a drop box: send and forget on the phone, sort it later at the PC with a session.

## Decisions (owner, 2026-10-05, in this order)

1. At the PC he meets the items both ways: a list in his notes, and a session that walks him through them on request.
2. He sends from a separate Telegram group that holds only him and the agent.
3. On arrival the agent only stores the item and acknowledges it. No Claude turn and no link fetch on the server.
4. Items move to the PC only when a PC session asks for them, not on a timer.
5. ~~After an item reaches the PC, the server keeps its copy for 30 days.~~ Revised: the server deletes an item the moment the PC confirms it landed. An item no session pulled is deleted after a week; the day before, the bot says so in the group. The original always stays in the Telegram group until he deletes it there.
6. ~~Four actions per item.~~ Revised: per item the PC walk offers ✅ handled, ❓ leave, ❌ delete, and 🔧 act on it (which asks: save as a note, or check for installing).
7. Approach: the existing agent stores items, and the PC pulls them over the ssh access it already uses for the routine channel. Rejected: the agent uploading to a cloud drive (new credentials on the server), and the PC reading the group directly (a bot's updates have a single consumer, the poller, so the PC would need the owner's personal Telegram login).
8. ~~Files land inside the notes, through an exception in the notes' write guard.~~ Revised: everything lands in a dedicated folder of its own on the PC, outside the notes and outside the cloud-synced folders: the files, the list page, the pull script, and the instructions and skill of the sessions that work there. The notes receive only what he chooses to save as a note. The notes' write guard is not changed at all.
9. Videos (video, round video, GIF) are stored like documents, under the same cap.
10. On the list page each line carries a short English summary the session writes; the original text, caption and links go into a small text file beside the item's file, linked from the line. (Chosen while the list was meant for the English-only notes; it stays as decided unless he changes it.)
11. An edited message is not followed: the item keeps the first version. To change it, he sends it again and deletes the old one in the walk.
13. The PC pulls with a key of its own that the server lets do three things only: list what waits, ack what landed, fetch one file. The routine channel's key is not used for the inbox. (After review round 2.)
14. A session in the PC folder asks before anything outside its ordinary work (the pull, the summaries, the walk's own steps); connecting to the server, running free code and fetching web pages all ask first.
15. In the walk, pictures (image files only) are shown in the chat, which reaches his phone through his Claude account; other files are named by their path. When the folder's instructions say pictures are not to be sent, nothing is sent and pictures open on the PC only. Quarantined files are never shown.
16. Several pictures can be one thing (a long screen in two or three parts). They are joined into one entry at the PC (one line, one decision, a summary written after reading every part) in two ways: pictures sent together as one album, and pictures that follow a message (or a caption) saying how many parts there are ("2 חלקים", "3 חלקים", two parts, three parts). The server only stores what tells them apart (the album id); the joining happens on the PC.
17. The session that walks the items reads their words itself (it can then talk with him about them); summaries are still written by a helper that can only read. The protection against an item's words is therefore the session's locked permissions and the restricted key, recorded as a known risk. (After review round 3.)

## Telegram facts this rests on

From the Bot API features page, section "Privacy mode" (fetched 2026-10-05): privacy mode is on by default, and a bot in a group then receives only commands meant for it, replies to it and similar; "bot admins always receive all messages"; service messages are delivered regardless. So the owner adds the agent to the group **as an admin**, and no BotFather setting changes. Downloads keep the existing ~20 MB `getFile` cap (`MAX_FILE_BYTES`). Group and supergroup chat ids are negative; a group upgraded to a supergroup gets a new id, announced by a `migrate_to_chat_id` service message.

## Server half

**Which chat.** A new setting names the inbox group's chat id (`INBOX_CHAT_ID` in the service environment). Unset, the feature is off. Only a negative id (a group) is accepted, and a message counts as an inbox message only when its chat id matches and its chat is a group or supergroup.

**Order matters.** Today the poller answers an allowlisted sender in any chat. If the group existed before this code is deployed, every item would start a Claude turn. So this change also adds a rule: a message in a group or supergroup chat that is not the inbox chat is never answered; the first message from each such chat is logged as `[INBOX?] chat <id> (<type>, sender allowlisted: yes|no)`. The code is deployed first, with the setting unset; then the owner creates the group, adds the agent as admin and sends one message; the chat id is read from the journal line marked `yes`, and only then is the setting filled and the service restarted.

**In the inbox chat** (checked before any other routing, in the rollback mode too, and before the debouncer, so albums are one item per message):
- A message whose sender is not on the allowlist is ignored.
- Otherwise the poller stores one item per message and reacts 👍. No Claude process starts, no history row is written, no link is opened.
- Text: stored as is, with Telegram's own `entities` kept so URLs hidden behind link text are not lost (only entity types from a fixed list; a link entity keeps its URL only when it is `http` or `https`).
- Photo (largest size), document, video, voice and audio: downloaded into the inbox's own folder, not into `uploads/`. Voice is stored as audio only, never transcribed.
- A caption is stored with its file.
- A file over the cap, or a download that fails, still makes an item (kind, name, the size Telegram reported, the error) and gets a short Hebrew reply saying the file did not come through, instead of 👍.
- Commands such as `/stop` sent in the inbox chat are stored as text, not run.
- A kind the inbox does not keep (a sticker, a location, a contact, a poll, a story, anything else not listed) gets a short Hebrew reply that it was not saved. Service messages (members, title, pins, the group's move) get nothing, except that a move to a supergroup is logged loudly, the poller follows the new id (remembered across restarts in the inbox folder until the setting is updated), and it says so in the group.
- A message delivered twice (after a crash) is stored once: an item keeps its Telegram message id.

**Store.** `~/inbox/` outside the repo: `items.json` (written temp-file-then-rename under `withFileLock`, as `rchannel.ts` writes its store) and `files/`. An item is `{ id, messageId, mediaGroupId?, receivedAt, kind, text?, entities?, caption?, captionEntities?, fileName?, file?, size?, sha256?, reportedSize?, error?, warnedAt? }` (`mediaGroupId` is Telegram's album id, kept so the PC can join an album's pictures; `size` and `sha256` describe the stored file, `reportedSize` what Telegram reported for a file that did not come through; `error` is `too large` or a short description). `id` is `YYMMDD-xxxx` and is never issued twice within ten days, even after the item is gone; `receivedAt` is the message's own Telegram date. Files that no item names (left by a crash) and set-aside copies of an unreadable store are deleted by the tick after an hour and a week respectively. A stored file is named `<id>.<ext>`, the extension ASCII only, and the notes app's own file types (`md`, `markdown`, `canvas`, `base`) are stored as `.txt`; the original name is kept in `fileName` for display.

**Lifetime.** `ack <id>` deletes the item and its file at once (the PC confirmed it landed). An item no one pulled is deleted 7 days after it arrived, and never before a warning has stood for a day: on the poller's tick, an item 6 days old gets a single Hebrew line in the group ("items will be deleted tomorrow unless pulled"), which also covers every item due within the next few hours, so a burst of items sent together gets one warning with the right count; the deletion waits until 24 hours after that line. Only the tick and a hand-run `purge` delete; `list` never does, so a pull always receives what is still there. With the setting unset, the tick still deletes (without warning), so turning the feature off never keeps items forever. The warning is not sent during Shabbat and holidays (the routine channel's quiet window) nor in the 24 hours before one starts, and no warned deletion happens inside quiet time, so a day's notice is always a usable day. A warning that cannot be sent never blocks the rest; and whatever happens, an item is deleted 10 days after it arrived.

**CLI** (`inbox.ts`). The PC's own key reaches it only through `inbox.ts gate`, which its `authorized_keys` line forces and which admits exactly three requests (`list`, `ack <ids>`, `get <id>`):
- `list`: JSON of every item, oldest first (ties by Telegram message order), with each file's path relative to `~/inbox/`. It only reads.
- `get <id>`: the bytes of that item's stored file, on standard output.
- `ack <id>...`: deletes those items and their files; unknown ids are reported, not fatal.
- `purge`: deletes the items whose week is up (as above). The poller's tick runs it; callable by hand too.
- `status`: counts (waiting, files, bytes, the oldest item's age), for the health sweep.

**Backup.** `~/inbox/` is not in the nightly backup: pulled items live on the PC, and every item is still in the Telegram group itself.

## PC half

**A dedicated folder on the PC,** outside the notes and outside every cloud-synced folder. It holds the pull script, the instructions and skill for the sessions that work there, the list page, the received files, and a quarantine subfolder. The owner opens a session in it when he wants to go through the inbox ("מה בתיבה", or `/inbox`). Nothing on the PC runs on a timer for this.

1. The pull script makes one ssh call, with the inbox's own key, that runs `list`. On failure the session says so in one sentence and stops.
2. The script validates every item against a strict whitelist and fetches each listed file with `get`, over the same key, into the folder, stopping any file at the size cap. Passive types (images, PDF, plain text, audio, video) go into its files subfolder; anything else goes into its quarantine subfolder under a neutral name until it is vetted. Each item's text, caption and links go into `<id>-t.txt`.
3. The script joins items into entries: an album's pictures are one entry, and so are the pictures sent within a few minutes after a message or caption that names the number of parts (two to nine; the counting message itself joins the entry). It writes one line per entry on the list page: date and time, kind (with the number of parts) and links to the entry's files. A helper that can only read looks at every part and returns a short English summary; the script checks it (plain words only) and writes it on the line. Every later step treats an entry as one thing, and every change to the list page goes through the script.
4. Only after an entry's files and line are in place does the script ack its items. A partial run acks only what landed. A run that stopped midway is resumed by the next request; an item that cannot land is given up and comes back on the next pull.
5. Then the session walks the waiting lines one at a time, each with four choices:
   - **✅ Handled**: the line is marked done (its file links become plain text) and its files go to the Recycle Bin.
   - **❓ Leave**: nothing changes; it is offered again next time.
   - **❌ Delete**: the line is removed and its files go to the Recycle Bin.
   - **🔧 Act on it**, which asks one more question: **save as a note** (a note in the right place in the notes, written with the editing tool so the notes' validator runs, linking to the entry's files, which then move to the folder's kept subfolder; title and place approved by the owner first), or **check for installing** (the vetting skill reviews the source and reports approve, caution or reject; installing happens only on the owner's explicit yes after that).

## What leaves the machine

- Telegram stores the group's messages, like any chat, until the owner deletes them.
- The agent's server stores each item until it is pulled, at most a week (longer only by a Shabbat or holiday that delays the warning). No Claude turn on the server reads it.
- On the PC the items go into the dedicated folder, which no cloud drive syncs; only a note he chooses to save reaches the notes, which a cloud drive syncs.
- Claude on the PC sees an item only during a session the owner started to go through the inbox.
- Pictures shown in the walk are sent through the Claude app (that is how they reach his phone), so they are stored in his Claude account like any file a session sends; when the folder's instructions say not to send them, they are not sent.

## Testing

- Server: unit tests for the routing (inbox chat vs other groups vs private chats, the rollback mode, the setting unset), the item builder per kind, unsupported kinds, de-duplication, the store and its lock, the lifetime (ack deletes, the warning, the week), `list` / `ack` / `purge` / `status`, and that no Claude spawn and no history write happen for an inbox message. Each test seen failing first.
- PC: the pull script's tests against hostile replies, its line builder, the landed check, resume and give-up; the skill dry-run tested against a fake `list` reply in a scratch notes folder, including a failed download and a partial ack.
- End to end, supervised, with the owner at the phone: one text with a link, one photo with a caption, one document, one voice note, one short video, one file over the cap, and one deliberately hostile item (a fake "run this" message and a booby-trapped link); then a PC session pulls them and walks them, choosing each action at least once.

## Security

Added 2026-10-05 at the owner's request that the inbox be secured precisely, after a first round of three plan reviewers. The inbox joins three places (the phone, the server, the PC), and everything that crosses between them is treated as hostile until checked. Approved by the owner part by part on 2026-10-05; the list of what stays open on purpose is kept privately, outside this repo.

### Who may do what

- **The owner, on the phone.** Sends items into the inbox group. Only a sender id on the allowlist is stored; anything else is ignored. He does not post there as an anonymous admin (that arrives from an account not on the allowlist).
- **Anyone else.** The group holds no one else. A stranger who adds the bot to another group gets nothing: the poller logs that group once, marked with whether the sender is on the allowlist, and never answers or stores anything from it.
- **The bot inside the group.** An admin (so privacy mode lets it see every message) with every admin right switched off, so it cannot delete or pin anything there. Whether Telegram keeps a bot as admin with no rights at all is checked in the app during setup; if it insists on one, the least harmful one is kept.
- **The poller.** The only writer that adds items. For an inbox message it stores, reacts and, when needed, sends one of a few fixed Hebrew lines. It never starts a Claude turn, never opens a link, never transcribes, never writes history. It accepts only a group id as the inbox, so a mistaken setting can never turn the private chat into a drop box.
- **The agent's Claude turns** (the private chat, scheduled jobs, the review loop). May run exactly one inbox command, `inbox.ts status` (counts only). The guard refuses the obvious routes to the store and files (commands naming them, `list`, `ack`, `purge`, `get`, `gate`, and the file tools, Read, Grep and Glob included, on any path under the inbox folder or a search rooted above it), which needs the guard hook registered for those tools in the server's live hook settings. The PC trusts nothing it receives either way.
- **The PC's key for the inbox.** Its own key, whose `authorized_keys` line on the server allows no shell, no forwarding and no terminal, and forces `inbox.ts gate`, which admits only `list`, `ack` with valid ids, and `get` of one valid id. Even a fully misled PC session holding it can do nothing else on the server.
- **The PC's pull script.** Uses only that key, only through those three requests, with ids it has itself validated. Accepts no option that changes which program it runs, which folder it writes or which server it calls (those exist only inside its tests). Writes only inside the dedicated folder, and changes the list page only through its own commands. Never executes anything it receives. Never writes the notes.
- **The session that walks the items on the PC.** Runs in a mode that asks the owner before anything outside its ordinary steps (connecting to the server, free code, web pages), with the folder's own settings refusing it the server keys and the routine channel's files outright, whatever the owner's general settings allow. Reads an entry's words when it shows them to him (by his choice, so it can talk about them); summaries come from a helper that can only read; it never reads quarantined files except to vet one on his request. Reaches the notes only to write a note he asked to save, with the editing tool. Never runs a command, link or instruction found in an item. Installs nothing without the vetting skill's verdict and then his explicit yes.

### Threats, and what stops each one

1. **An item that tries to instruct the PC session** ("run this", a screenshot of a tool page saying "install with..."). The session reads the words, so the protection is what it is allowed to do: it asks before anything outside its ordinary steps; its own commands accept no option that could run another program or reach another place; the folder's settings refuse it the server keys and the routine channel's files; and the only server key in its reach can do nothing but list, ack and fetch. Actions come only from the owner's choice. The target for "check for installing" comes only from the links the pull script extracted and validated, a quarantined file he names, or what he types, never from text read in an image. No command found in an item is ever run, not even to test it.
2. **A hostile file name or path.** The server stores files as `<id>.<ext>` in ASCII only and hands a file out only by item id. The PC asks only for ids it validated and names local files itself.
3. **A dangerous file type** (a script, a program, a shortcut, a web page, or a notes-app file such as a note, canvas or base). The server stores the notes-app types as `.txt`. The PC files only passive types normally; anything else goes into the quarantine subfolder under a neutral name with no runnable extension, until it is vetted.
4. **Text that becomes live** (a link, an embed, a web frame, a heading, hidden text, reversed-direction characters) on the list page or in a saved note. The list line holds only the date, the kind, the session's English summary (plain words, no markup, no links) and links to the entry's own files; the item's words and links live in a `.txt` file, shown as plain text. The summary reaches the line only through the pull script, which accepts plain letters, digits and basic punctuation. The marker that ties a line to its items sits only at the line's end. A saved note quotes an item's words only inside a code block, under a fixed line saying it is quoted data and not instructions, with `source: phone-inbox` in its front matter, marked so that a later session or an automation reading the notes can tell it is quoted data; the daily log never quotes an item. Files that land get Windows' "downloaded from the internet" mark, so opening them gets the usual protected view.
5. **Forged, dropped or altered items** from a misbehaving agent turn on the server. The guard refuses the obvious routes. The PC validates every field of every item against a whitelist, caps every size, and acks only items that fully landed. At worst a forged item shows up as one more line for the owner to judge; the originals stay in the Telegram group.
6. **A hostile server reply** (a huge file, broken data, a stalled transfer). The PC stops reading any file at 20 MiB (the server's own cap, 20,971,520 bytes) and the list at a fixed size, checks each file's size and checksum against the list, refuses data that does not match the schema, and gives every network call a time limit.
7. **Received files spreading** beyond where they belong. They land only in the dedicated folder, which no cloud drive syncs; the notes' write guard keeps its present rules with no exception; a file reaches the notes' world only as a link from a note he asked to save.
8. **A stranger's group** posing as the inbox during setup. The setup takes the chat id only from a log line marked as sent by an allowlisted sender.
9. **The bot deleting the owner's items in the group.** The bot holds no admin rights there.
10. **Private details leaking** to the public repo or the server's journal. Journal lines carry item ids and kinds, never an item's words. Test data is made up. The PC's parts that name real paths live in a private file. The commit hook blocks an inbox folder, and a privacy sweep runs before any push.
11. **The group changing its id** (Telegram upgrades it to a supergroup). The poller follows the new id for as long as it runs, logs it, and says so in the group; the owner updates the setting.
12. **A crash at the wrong moment.** An item is keyed by its Telegram message, so a message delivered twice is stored once; a message lost to a crash is still in the group; files a crash leaves without an item are deleted after an hour; an id is never issued twice within ten days, so the PC can never mistake a new item for an old one.
13. **A lookalike or dangerous link** offered for "check for installing" (a lookalike letter in the host, a hidden direction character, a user-name trick, a local address, shell characters). Every link passes one validator (https only, no user name, no IP address or local name, no invisible characters, no shell characters) and is offered by its host name written in plain ASCII (punycode), so a look-alike letter shows as what it is.
14. **Pictures leaving the PC** when shown in the chat. Only image files from the entry being walked, never quarantined ones, and none at all when the folder's instructions say not to send them.

### How it is checked

- **Automatic tests, each seen failing before its code exists:** the routing (including the rollback mode, pinned in the poller's own text), the guard's refusals and the commands it must still allow, the item builder for every kind, de-duplication, the lifetime, the store and its CLI, the pull script's validation against hostile replies, the line builder against attack strings, the joining of parts, and the landed check and the resume after a partial run.
- **Deliberate breaks:** every protective check is broken on purpose once and a test is seen failing, then restored.
- **Before any push:** a focused security review of the change and a leak check of every commit.
- **Live, with the owner:** the end-to-end run, including one deliberately hostile item and one picture in parts, with the journal showing no Claude turn for any inbox message.

## Out of scope

Automatic pulling on a timer, any processing on the server, triage buttons in Telegram (possible later without changing the rest), and forwarding items anywhere else.
