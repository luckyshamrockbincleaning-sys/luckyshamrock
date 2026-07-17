# Google Ads Launch — Design

**Date:** 2026-07-16
**Goal:** Bring in Lucky Shamrock bookings via Google Ads, with Claude acting as strategist/optimizer, structured so full API automation can be added later once the campaign is proven.

## Context

- Google Ads account **608-194-5119** already exists (auto-created via the Google Business Profile), currently parked mid-signup on a **Smart Campaign** wizard. Smart Campaigns are excluded from API management and hide keyword/search-term control — **we abandon that wizard** and use Expert Mode.
- A **"spend $500, get $500" credit** is available on the account — the test budget.
- The site (luckyshamrock.ca) is a no-build static React page with the booking widget on the main page; bookings complete client-side with a success step. No CSP blocks third-party scripts.
- Decisions made: conversions **carry the plan's dollar value**; **no cookie-consent banner** (small local Canadian business, ad-measurement cookies, PIPEDA-proportionate).

## Part 1 — Conversion tracking (the code)

The one technical foundation. Without it, neither human nor AI optimization has a signal.

- **Tag:** Google Ads `gtag.js` snippet added to `index.html` `<head>` with the account's `AW-XXXXXXXXXX` id (obtained from the dashboard during setup; hardcoded in the file like other site constants — no build step, no env plumbing on the static side).
- **Booking conversion:** on the booking widget's success step (the moment `/api/book` returns ok), fire `gtag('event', 'conversion', { send_to: 'AW-XXX/LABEL', value: <plan price in dollars>, currency: 'CAD', transaction_id: <booking/visit id> })`.
  - Value source: `window.LS_PRICING` (already the client price source of truth): oneoff 45, monthly 35, seasonal 105.
  - `transaction_id` prevents double-counting on refresh/re-render of the success step.
- **Phone-call conversion (secondary):** `gtag` click handler conversion on `tel:` links in header/footer, no value. Cheap to add, calls matter for local service.
- **Safety:** all gtag calls guarded (`typeof gtag === 'function'`) and fire-and-forget — an ad-blocker or failed script must never affect booking. No behavior change when the tag is absent (local dev, print page).
- **Verification:** Google Tag Assistant on the live page + one controlled live test booking (comped, then wiped) confirming the conversion registers in the Ads dashboard (Ads UI shows conversions with up-to-3h lag; "tag active" diagnostic is same-day).

## Part 2 — Campaign blueprint (Claude produces, AB pastes)

One Search campaign, Expert Mode:

- **Geo:** radius/postal targeting on Fort Saskatchewan (T8L) + immediate surroundings only; "presence" targeting (people IN the area, not "interested in").
- **Ad groups (2):** ① bin cleaning (core), ② near-me/generic cleaning intent.
- **Keywords:** phrase/exact, high-intent only — garbage bin cleaning, trash can cleaning service, wheelie bin washing, bin cleaning fort saskatchewan, garbage can cleaning near me, etc. Full list delivered at setup.
- **Negatives:** jobs, hiring, DIY, how to, free, dumpster rental, bin rental, franchise, equipment/truck for sale.
- **Ads:** 2 responsive search ads per ad group in brand voice (190°F sanitizing, before/after photo proof, only charged when clean, locally owned, book in 90 seconds). Pinned headline 1 = "Garbage Bin Cleaning" variants for relevance.
- **Assets/extensions:** sitelinks (Book Now, Pricing, Monthly Plan, How It Works), callouts, structured snippets, call asset (587) 982-8887, location asset linked to the GBP.
- **Budget & bidding:** ~$16/day (≈$500/month → matches the credit's typical spend window). Start Maximize Clicks with a max CPC cap (~$3.50); switch to Maximize Conversions after ~15–20 tracked conversions or 30 days, whichever first.

## Part 3 — Setup session (one sitting, AB + Claude)

1. AB opens ads.google.com; abandon/ignore the Smart Campaign draft; switch account to Expert Mode.
2. AB completes **billing** and confirms the $500 credit is applied to this account (AB-only: payment details).
3. Create the conversion action in the dashboard → yields `AW-id` + label → Claude ships the Part-1 code → verify tag.
4. Paste in the Part-2 blueprint (Claude guides screen-by-screen via Chrome).
5. Publish. Campaign live.

## Part 4 — Operating loop & success criteria

- **Weekly (Claude):** read search-terms report, performance by keyword/ad, and conversion data (via AB's browser session); output a concrete change list (new negatives, pauses, copy rotations, bid/budget nudges). AB applies in minutes or lets Claude drive the browser.
- **Success test for the credit period (~2 months):** cost per booked customer < $40 one-offs / < $60 recurring (recurring LTV justifies more). If conversions flow and CPA beats those bars → scale budget and green-light the **Google Ads API automation project** (separate spec: developer token application, OAuth, automated rules).
- **Kill criteria:** if after the full credit there are clicks but near-zero bookings with tracking verified working, stop and rethink channel (GBP/SEO/Facebook local groups may fit better).

## Out of scope (deliberately)

- Google Ads API automation (its own project after the campaign proves out).
- Performance Max, Display, YouTube campaigns.
- Cookie-consent banner.
- Landing-page changes beyond the tracking tag.
