# Movie ticket feature — SETTLED (2026-07-28)

Goal: help Maor get to a film at Hot Cinema Kiryon (Kiryat Bialik).

## Outcome: option 1. Shipped, and the rest is closed.

Three levels of automation were weighed during the day:
1. **Listing only** — the bot says what is playing, Maor books in the Hot
   Cinema app. **CHOSEN and SHIPPED** (`cinema.ts`, PR #61).
2. Prefill to seat selection, stop before payment. Initially chosen, then
   **dropped** the same day, see below.
3. Fully automated purchase incl. stored payment method — rejected: no API,
   and storing card details is a liability neither of us wants.

### Why option 2 was dropped

Reaching the seat map means talking to the Creatix backend as if this server
were the mobile app, and `hotcinema.co.il` already answers this server with a
403 — that is the operator's bot protection saying no to automated clients.
Working around it has no authorization behind it. Separately, the capability
option 2 needs is programmatic cart creation plus seat locking, which is the
exact primitive ticket bots are built from and the reason the protection
exists. Maor's use is obviously personal and benign, but the code would not
know that, and seat-locking without completing payment is seat-squatting
whether one person runs it or a thousand.

**Do not resume the guest-token work.** If the deeper integration is ever
wanted, the path is asking Hot Cinema or Creatix for API or affiliate access,
which turns a workaround into a real integration.

## What shipped instead

`cinema.ts` (read-only, no auth, no booking):
- `showtimes [--date YYYY-MM-DD] [--days N] [--q "<title substr>"]`
- `films`
Both cite their source. Routing lives in the CLAUDE.md "Movies" section: a
picked screening becomes a calendar event through the normal confirm.ts flow,
and "tell me when film X reaches Kiryon" is a monitor.ts keyword monitor.
`net.ts` gained charset-aware decoding along the way, since seret.co.il serves
windows-1255 and monitors on Hebrew sites had been matching mojibake.

The technical findings below are kept as a record of what was investigated.
They are history, not a to-do list.

## Technical findings

- The main site `hotcinema.co.il` / `tickets.hotcinema.co.il` returns 403
  (Cloudflare-style bot protection) — not usable as a direct HTTP target.
- `seret.co.il` shows Kiryon's showtimes without blocking, but has no direct
  booking link and depends on client-side JS for parts of the schedule.
- The Hot Cinema **mobile app** is a thin WebView wrapper around a ticketing
  platform called **Creatix** — the same backend also powers Cinema City and
  Globus Max.
- Creatix exposes a real JSON API, reachable (not Cloudflare-blocked) from
  this server:
  `https://pub-api-use1.biggerpicture.ai/ecomAPI/public/api`
  Hot Cinema's tenant id on that platform is **`HO-880`**.
- The API chain includes: branches, films/showtimes by date, seat map, cart
  creation, seat locking.
- Payment itself runs through a separate secure **CreditGuard** iframe, not
  through the Creatix API — this lines up well with the chosen design: stop
  right after the seat lock, before the CreditGuard step, so card data never
  touches the bot.

## Former "next step" — CLOSED, do not pick this up

The unfinished thread was the **guest session token** every Creatix call needs,
and how the app issues it. That work is deliberately abandoned per the decision
above. It is recorded here only so nobody rediscovers it and assumes it was
merely forgotten.

## Process rule (still applies to any future work here)

Maor wants all non-trivial coding/design work on this feature to run on
Opus, not the fast default model — this thread involves security-adjacent
work (third-party API reverse engineering, payment-boundary design) where he
wants the stronger model doing the thinking.

Update (2026-07-28, later the same day): this is now automatic. Dev-intent
messages route to Opus in `model.ts` with no manual `/opus`, and the detector
learned the Hebrew phrasings from this exact thread ("אני מפתח", "לפתח",
"פיתוח", "פיצ'ר" in both apostrophe spellings). `/sonnet` is the manual
override. Continuing this feature in chat will therefore run on Opus by
itself.

## Sources

- https://play.google.com/store/apps/details?id=com.creatix.globusapp.web
- https://tickets.hotcinema.co.il/
- https://www.seret.co.il/movies/s_theatres.asp?TID=50
