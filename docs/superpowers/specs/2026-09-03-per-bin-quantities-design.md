# Per-bin quantities + photo upload as taken — design

**Date:** 2026-09-03
**Status:** approved by AB, ready for implementation planning

## Problem

Booking asks *which* bins (Black · garbage, Green · organics) but each type can
only be picked once, so `bin_types` is a set of distinct values whose length
must equal `bin_count`. A household with two black bins cannot say so — online
or at the door. This was deferred deliberately on 2026-08-15 ("cheaper to add
later than to design around a case that may never occur"); the case occurred.

Lifting the restriction exposes a second problem. Every bin gets its own
before/after photo pair, and **all photos are sent inside the Done request** as
base64. At the current 3-bin ceiling that is 6 photos against Vercel's 30s
`maxDuration`, already tight enough that the wash GIF is generated from bin 1
only. Uncapping bins without changing the photo path moves a known-fragile flow
past its limit, and it fails while the operator is standing at a customer's bin.

The root cause of that fragility: **photos are never stored.** There are no
photo columns, no blob storage, no photo table. They ride the Done request,
attach to the customer's email, and cease to exist. There is nowhere to put a
photo before the email is built.

## Decisions (AB, 2026-09-03)

1. **Self-serve caps at 3 bins; the operator's walk-up form is uncapped.** This
   also closes the escape hatch left open on 2026-08-15.
2. **One before/after pair per bin, always** — no reduced-proof mode for large
   jobs. Accepted with the knowledge that it requires moving photo upload off
   the Done request.
3. **Vercel Blob, deleted once the done email sends.** Photos remain
   non-persistent, so today's privacy posture is unchanged and storage stays
   near-zero.

## Non-goals

- Re-adding recycling/blue bins. Lucky Shamrock does not service them.
- Persisting photos for history, /manage, or dispute evidence. Explicitly
  rejected — it creates a retention policy and a growing bill that do not
  exist today.
- Changing prices. Extra bins stay $12/clean.
- Raising the self-serve cap above 3.

## Design

### 1. Data model — `bin_types` becomes a multiset

`normalizeBinTypes` stops deduplicating and stable-sorts by `BIN_TYPES` order:
`['organics','garbage','garbage']` → `['garbage','garbage','organics']`.

**No migration.** The CHECK constraints
(`subscription_bin_types_match_count`, `visit_bin_types_match_count`,
`array_length(bin_types,1) = bin_count`) survive unchanged and get *stronger*:
they stop standing in for distinctness and become a real invariant that the
named bins and the billed count agree. `bin_count` remains the single source of
truth for money and photo pairing. Rows with `bin_types = null` (the three
pre-2026-08-15 subscriptions) keep falling back to `describeBins`' bare count.

Canonical sort order stays load-bearing for the same reason as before: photos,
per-bin email sections and the receipt are keyed by position, so bin *n* must
mean the same bin on every visit.

### 2. Validation — the cap splits by caller

- `lib/validation.ts` (booking): `bin_count` stays `1 | 2 | 3`.
- `lib/operator-handlers.ts` (walk-up): `bin_count` becomes
  `z.number().int().min(1).max(10)`.
- Both drop the distinctness rule. The message changes from "must list exactly
  bin_count distinct bins" to one entry per bin, repeats allowed.
- A request whose `bin_types` and `bin_count` disagree is still **rejected, not
  reconciled** — the 2026-08-15 rule holds. Trusting the smaller number cleans
  more bins than were paid for.

**The 10 is a typo guard, not a policy limit.** It stops a fat-fingered `99`
reaching the photo loop and generating 198 photo steps. If a real job needs
more, raising the number is a one-line change with a known consequence.

### 3. Photo pipeline — upload as taken

New `upload` op on `api/operator/[action].ts`. That file is a **single dynamic
segment**, the only shape proven to reach a function in this project's Vercel
runtime, so `/api/operator/upload` costs **no new function** — the deploy stays
at 12/12 on Hobby.

Flow:

1. `/ops` prepares the photo as it does now (`prepareCleanPhoto`, max side
   1600, JPEG q0.78) and POSTs it to the `upload` op **the moment it is taken**.
   The op writes it to Vercel Blob with a server-side `put()` and returns the
   URL.

   **Not the Blob client-upload SDK.** `/ops` runs React through
   Babel-standalone with no build step, so there is no module system to import
   `@vercel/blob/client` into. One photo per request is ~500 KB against a
   4.5 MB body limit and carries no timeout risk, which makes the server-side
   write both simpler and sufficient. The limit only ever strained because
   Done batched every photo into one request.
2. Each photo step shows its own upload state (pending / uploading / stored).
3. **Done sends URLs, not bytes.** The request becomes small and fast; the
   5–10s dead tap that needed a progress indicator on 2026-08-01 goes away.
4. The Done handler fetches the blobs (same region), builds the wash GIF from
   bin 1 as today, sends the email, then deletes the `visits/<visitId>/` prefix.

Blob key shape: `visits/<visitId>/<binIndex>-<before|after>-<uuid>.jpg`.

**Offline fallback.** The legacy inline `before_photo` / `clean_photo` fields
predate 2026-07-27 and are still accepted by `parsePhotoPairs`. If an upload
fails — no signal in a back alley, a real operating condition — `/ops` keeps
the base64 in memory and Done sends it inline exactly as it does today. Signal
loss degrades to current behaviour instead of blocking the job. This is why the
legacy path must **not** be removed as part of this work.

The per-visit localStorage store (`ls-ops-photos-<visitId>`, added 2026-07-13
because Android silently reloads the tab when the camera opens) now holds URLs
instead of base64. That store was always at risk of blowing the ~5 MB
localStorage quota on a 3-bin job; holding URLs removes the risk entirely.

**Orphan cleanup.** Photos uploaded when Done is never tapped are swept by
prefix on the next `today` load, anything older than 48h. Folded into an
existing request — no cron, no new function, consistent with how this repo has
handled every other background need.

### 4. UI

**Booking form and walk-up form** both replace the toggle row with a `− n +`
stepper per bin type, live total and price beneath. Booking's `+` disables at 3
total; the walk-up form's does not (until 10). Zero of a type is allowed as
long as the total is at least 1; the last remaining bin cannot be decremented
to zero, matching today's "last bin can't be unticked" behaviour.

**Labels number only within a repeated type**: `Black bin 1`, `Black bin 2`,
`Green bin`. A lone green bin never renders as "Green bin 1", which would read
as though a second one is missing. Applies to `/ops` photo steps, the per-bin
sections of the done email, and the receipt.

`describeBins` compresses for summaries: `Black bin ×2 + Green bin`.

`MAX_PHOTO_PAIRS = 3` in `lib/operator-handlers.ts` follows the walk-up ceiling
rather than the old bin cap.

### 5. Email weight

Sixteen photos at 1600px would be a 6–8 MB email arriving on a customer's phone
data. **Above 3 bins the client drops the max side to 1100px**, keeping any job
under roughly 3.5 MB. No photos are dropped and no bin goes unproven. The GIF
stays bin 1 only — a faster Done does not change the 30s ceiling on GIF
generation itself.

### 6. Pricing — unchanged

`baseChargeCents` reads only `bin_count` and already handles any positive
integer: first bin at the plan rate, $12 per extra bin. An 8-bin one-off is
$45 + 7 × $12 = $129. The operator's existing amount override covers a job
where linear pricing is wrong. `pricing.js` / `lib/pricing.ts` and their drift
guard are untouched.

### 7. /manage bin-count change — a latent 500 this work must fix

`api/subscription/[id]/update.ts` writes `binCount` without touching
`binTypes`. Once a subscription has `bin_types` set, any bin-count change from
/manage violates `subscription_bin_types_match_count` and the customer gets a
500.

**Verified latent, not live, on 2026-09-03:** all four subscriptions (Aaron
Cropper, Kalie Carey, Soleil Lee, and shea sommerfeld's cancelled one) have
`bin_types = null` — every one predates the 2026-08-15 picker and no recurring
plan has been sold since. The first recurring customer who books with bin types
and later changes their count triggers it.

This work makes that more likely rather than less, so the fix belongs here:
/manage gains the same per-type steppers as the booking form (capped at 3, the
self-serve limit) and sends `bin_types` alongside `bin_count`, with the server
applying the same agreement rule it applies at booking. A count-only request
from an older client keeps working: the server derives types by truncating or
extending the stored list in canonical order, and writes `null` if it cannot
produce an honest answer.

## Testing

- `normalizeBinTypes`: duplicates preserved, stable canonical sort, mixed input
  order, invalid types still rejected.
- Validation: count/types agreement including repeats; booking rejects 4;
  walk-up accepts 6 and rejects 11.
- Labels: numbering only within a repeated type, singular type unnumbered.
- `describeBins`: `×n` compression, `null` fallback for legacy rows.
- Upload op: operator auth required, rejects non-image mime, key scoping.
- Done: accepts URLs, deletes the prefix after send, still accepts legacy
  inline photos, and completes when an upload failed mid-job.
- Orphan sweep: deletes >48h, leaves today's alone.
- /manage: changing bin count on a subscription WITH bin_types no longer 500s;
  types and count still agree afterwards; a count-only legacy request works.
- Existing `pricing-sync` and `bin-types-sync` drift guards must stay green.

Current suite is 524; expect roughly 35 new.

## Risks

| Risk | Mitigation |
|---|---|
| Upload fails at the door | Inline base64 fallback — current behaviour |
| Blob leak from abandoned jobs | 48h prefix sweep on `today` |
| Photo/bin position drift | Canonical sort + position-keyed tests |
| Large job slows Done anyway | Done carries URLs only; GIF stays bin 1 |
| Operator enters an absurd count | `max(10)` typo guard |
| /manage count change breaks the constraint | Fixed here; regression test |

## Rollout

Branch `per-bin-quantities`, TDD, self-review before merge (the 2026-07-31 and
2026-07-26 review passes each caught money bugs), deploy, then live-verify on a
390×844 viewport: a 2-black-1-green booking, a 6-bin walk-up, one Done with a
deliberately failed upload, and blob deletion confirmed after the email sends.
