# Lucky Shamrock — Mobile-First Booking Card Redesign

**Date:** 2026-05-22
**Scope:** Make the `.booking` section (and its embedded scheduling flow) responsive and mobile-friendly without regressing the desktop design.
**Files touched:** `styles.css`, `components-booking.jsx`.
**Out of scope:** Other sections (hero, features, testimonials, FAQ, footer) already have working mobile rules. The marketing-vs-product placement decision (sub-domain vs path in front of the BinWash Django app) stays where it is — still open, but unrelated to this work.

## Problem

The booking section is the only major section in `styles.css` with **no mobile breakpoint**. On phones:

- `.booking-grid` stays 2-column (info copy squashed beside the card).
- `.booking-card` keeps `padding: 36px` — eats ~72px of a 360px viewport.
- `.booking-steps` has 4 pills with labels like "Date & Time" that wrap/overflow.
- `.cal` (7-col month grid) survives but cells drop to ~38–42px square — below Apple's 44px tap-target floor — and the `has-slot` dot fights for room inside the `aspect-ratio: 1` cell.
- `.time-slots` (3-col) and `.service-options` (2×2) work but cramp at the smallest widths.

## Design

### Scheduling step (step 2) — direction B: horizontal week strip

The desktop month grid stays. On mobile (≤ 720px), the calendar swaps to a horizontally-scrolling row of day chips followed by a vertical list of time slots.

**Day chip** (each chip is a tap target ≥ 56px wide × 64px tall):

```
┌──────────┐ ┌──────────┐ ┌──────────┐
│   WED    │ │   THU    │ │   FRI    │
│    28    │ │    29    │ │    30    │
│ 4 slots  │ │ 6 slots  │ │ full     │
└──────────┘ └──────────┘ └──────────┘
   ↑ selected (green bg, white text)
```

- Chips render the next 14 days that aren't past or Sunday (same rules as the desktop grid).
- Days with `!hasSlot` render as disabled "full" chips (muted, not tappable) so the strip stays predictable and people can see how booked-up upcoming days are.
- The row uses `overflow-x: auto`, `scroll-snap-type: x mandatory`, and `scroll-snap-align: start` on each chip so swipes land cleanly.
- A gradient mask on the right edge tells the user there's more to scroll. No visible scrollbar.

**Time list** (renders below the strip once a day is selected):

- Vertical stack of full-width buttons, 48px tall, 12px gap.
- Selected slot fills with `--green`, white text, same treatment as desktop.
- Replaces the desktop `.time-slots` 3-col grid only on mobile.

**Why this and not the month grid:** below 720px the month grid forces cells under the tap-target floor and the slot dot fights for room. The week strip gives every tap target ≥ 44px naturally, makes "open slots" legible inline (no dot indicator needed), and matches the pattern users already know from Calendly / OpenTable / DoorDash.

### Rest of the booking card on mobile (≤ 720px)

| Element | Desktop | Mobile |
|---|---|---|
| `.booking-grid` | `1fr 1.3fr`, 50px gap | `1fr`, info copy stacked above card, 28px gap |
| `.booking-info` perks list | full 5 items | first 3 only (`li:nth-child(n+4) { display: none }`) |
| `.booking-card` padding | 36px | 20px |
| Container side padding | 24px | 16px |
| `.booking-steps` (4 pills) | full row | replaced by **compact header**: "Step 2 of 4 · Date & Time" + 4-segment progress bar (2px tall) underneath |
| `.service-options` | 2×2 | 2×2 (kept — already thumb-friendly) |
| `.cal` | 7-col month grid | hidden; replaced by week strip (above) |
| `.time-slots` | 3-col grid | 1-col vertical list (above) |
| `.booking-nav` (Back / Continue) | inline at bottom of card content | **sticky**: `position: sticky; bottom: 16px;` with a soft top shadow, so action is always reachable without scrolling |

### Compact step header (mobile)

```
Step 2 of 4 · Date & Time
████████████░░░░░░░░░░░░░░░░░░░░
```

- One short line in the same Nunito weight currently used by pills.
- Progress bar: 4 equal segments, filled segments use `--green`, empty use `--cream-2`, 2px tall, `border-radius: var(--r-pill)`.
- Replaces 4 pills only at the mobile breakpoint — desktop pills unchanged.

### Sticky action bar

- `.booking-nav` gets `position: sticky; bottom: 16px;` on mobile.
- Background: `var(--paper)` (the card's own bg) with a soft `box-shadow: 0 -8px 16px -8px rgba(0,0,0,0.12)` on top so it visually detaches from the scrolled content.
- Buttons keep `flex: 1` so they share the row evenly.

## Breakpoint

Single new breakpoint: **`@media (max-width: 720px)`**.

Rationale: existing site uses `880px` as the main breakpoint, but the booking card is denser than other sections and needs to flip earlier in the small-tablet range. 720px lands cleanly between iPad portrait (768px) and the largest phones (~430px wide). Above 720px, desktop layout stays exactly as it is today.

## Component changes (`components-booking.jsx`)

To support the mobile week strip without forking the component, the JSX gains a `useIsMobile()` hook (matches `(max-width: 720px)`) and conditionally renders one of two date-pickers:

- Desktop branch: existing `.cal` 7-col grid + 3-col `.time-slots` (unchanged).
- Mobile branch: new `.week-strip` (horizontal day chips, sourced from the same `days` array, filtered to `!disabled` and sliced to the next 14 entries) + new `.time-list` (vertical version of the same `timeSlots` array).

State (`selectedDay`, `selectedTime`) is shared — only the rendering forks.

The compact step header (mobile) and 4-pill steps (desktop) follow the same conditional pattern.

Sticky `.booking-nav` is pure CSS — no JS change needed.

## CSS contract

New class names introduced:

- `.booking-progress-mobile` — wraps the "Step X of 4 · Label" line + progress bar.
- `.booking-progress-mobile .bar` — the 4-segment progress bar.
- `.week-strip` — the horizontal scrolling row.
- `.week-strip .day-chip` — each day card.
- `.week-strip .day-chip.selected` / `.disabled` — state variants.
- `.time-list` — vertical time-slot list (mobile only).
- `.time-list .time-slot` — reuses existing `.time-slot` styling but in column flow.

Existing class names (`.cal`, `.cal-day`, `.time-slots`, `.booking-steps`, `.booking-step-pill`) are **not removed** — they get `display: none` inside the mobile media query so the desktop branch stays untouched.

## Testing checklist

Manually verify in Chrome DevTools device mode at:

- iPhone SE (375 × 667)
- iPhone 14 Pro (393 × 852)
- Pixel 7 (412 × 915)
- iPad Mini portrait (744 × 1133)
- Desktop 1280 wide

For each: open `http://localhost:8000`, scroll to `#book`, run through steps 1 → 4. Verify:

1. Step 1: service options 2×2, no overflow, sticky Continue button visible.
2. Step 2: week strip scrolls horizontally with snap, time list selects, no horizontal page scroll triggered.
3. Step 3: form inputs full-width, no zoom-on-focus regression (`font-size: 16px` already in place).
4. Step 4: confirmation card readable, "Book another bin" reachable.
5. Above 720px: identical to current desktop layout (visual diff = none).

## Out of scope (deferred)

- Real availability data (`hasSlot: Math.random() > 0.25` stays mock; real calendar wiring is BinWash backend work).
- Account view / "my schedule" page (separate surface).
- Operator schedule board (separate surface).
- Touch-gesture niceties beyond scroll-snap (no drag-to-reorder, no swipe-to-cancel).
- Internationalization of date formatting.

## Success criteria

- Booking section renders without horizontal page scroll on viewports 320–720px wide.
- Every interactive element in the booking card has a hit area ≥ 44 × 44px on mobile.
- Sticky `.booking-nav` stays visible while user fills the current step.
- Desktop layout (> 720px) is pixel-identical to current production.
- Page lighthouse mobile score for `#book` does not regress (manual check via Chrome DevTools MCP).
