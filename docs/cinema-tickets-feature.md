# Movie ticket booking feature — status (2026-07-28)

Goal: let Maor order movie tickets through the bot. Starting scope is Hot
Cinema Kiryon (Kiryat Bialik) only — not a generic multi-cinema engine yet.

## Decided design (option 2 of 3 discussed)

Three levels of automation were weighed:
1. Search-only — bot sends a direct booking link, Maor pays on the site.
2. Prefill to seat selection, stop before payment, Maor approves + pays. **Chosen.**
3. Fully automated purchase incl. stored payment method — rejected: needless
   complexity, no API, likely bot defenses, and storing card details is a
   security liability neither of us wants.

So the CLI this feature needs should: list showtimes, show the seat map,
create a cart, lock seats — then stop and hand Maor a link/next step to
complete payment himself. Card details should never pass through the bot.

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

## Open item / next step

Every API call needs a **guest session token**, issued by the app before
anything else. That issuance flow (endpoint, headers, payload) hasn't been
reverse-engineered yet — that's the next concrete task, followed by a small
CLI (same pattern as `cal.ts` / `todo.ts`) for: showtimes by date → seat map →
cart + seat lock → link for Maor to pay.

## Process rule for this feature

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
