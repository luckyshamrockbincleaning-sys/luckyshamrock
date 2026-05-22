# Lucky Shamrock Mobile-First Booking Card — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `.booking` section of the Lucky Shamrock marketing site fully responsive at viewports ≤ 720px, fix the horizontal-page-scroll bug, and replace the cramped month-grid date picker with a horizontal week strip + vertical time list on phones — without changing the desktop layout above 720px.

**Architecture:** Single new `@media (max-width: 720px)` block appended to `styles.css`. A small `useIsMobile()` hook added to `components-booking.jsx` forks two render paths (step header + date picker). All existing class names retained — mobile rules hide the desktop variants rather than removing them. No new dependencies, no build step (site loads React + Babel-standalone in-browser).

**Tech Stack:** Plain CSS (no framework), React 18 via Babel-standalone, vanilla CSS Grid + Flexbox + scroll-snap. Manual verification via Chrome DevTools device mode at `http://localhost:8000`. No automated tests — this is a static marketing site with no test infrastructure; verification is visual.

**Spec:** [`docs/superpowers/specs/2026-05-22-lucky-shamrock-mobile-booking-design.md`](../specs/2026-05-22-lucky-shamrock-mobile-booking-design.md)

---

## File Structure

**Modify:**

- `styles.css` — append one new `@media (max-width: 720px)` block (~80 lines) at the end of the file, before the existing trailing media queries are left alone. New rules cover: `.booking-grid` stack, `.booking-info` perks trim, `.booking-card` padding, `.booking-steps` hide, `.booking-progress-mobile` new component, `.cal` hide, `.week-strip` + `.day-chip` new, `.time-slots` hide, `.time-list` new, `.booking-nav` sticky.

- `components-booking.jsx` — add `useIsMobile()` hook (uses `window.matchMedia('(max-width: 720px)')`), then conditionally render: (a) compact progress header vs 4-pill steps, (b) week strip + time list vs cal + time-slots. State (`selectedDay`, `selectedTime`) is shared between branches.

**Create:** none.

**Server:** `python3 -m http.server 8000` from the repo root (already running in this session, restart if needed).

---

## Verification approach

Because this is a static React-via-Babel site with no test runner, each task ends with a manual visual verification step in a browser. Use Chrome DevTools device mode (Cmd-Shift-M) at these viewports:

- **iPhone SE** (375×667) — smallest realistic phone
- **iPhone 14 Pro** (393×852) — common modern phone
- **iPad Mini** (768×1024) — tablet portrait, *should still show desktop layout* (above 720px breakpoint)
- **Desktop 1280×800** — *must be pixel-identical to current production*

For each task, the verification step lists the specific assertion to check (no horizontal page scroll, element visible/hidden, etc.). If a Chrome DevTools MCP is available, the `mcp__plugin_chrome-devtools-mcp__chrome-devtools__*` tools can drive these checks programmatically — otherwise use the browser manually.

---

## Task 1: Add `useIsMobile()` hook

**Files:**
- Modify: `components-booking.jsx:1-3` (top of file, after the existing destructure)

- [ ] **Step 1: Add hook above the `Booking` component**

In `components-booking.jsx`, change the top of the file from:

```jsx
/* global React, Icon */
const { useState: useStateBk, useMemo } = React;

// ===== Booking flow =====
const Booking = ({ tweaks }) => {
```

to:

```jsx
/* global React, Icon */
const { useState: useStateBk, useMemo, useEffect } = React;

// Returns true when the viewport is at or below the mobile breakpoint.
const useIsMobile = () => {
  const [isMobile, setIsMobile] = useStateBk(
    typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches
  );
  useEffect(() => {
    const mql = window.matchMedia('(max-width: 720px)');
    const onChange = e => setIsMobile(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return isMobile;
};

// ===== Booking flow =====
const Booking = ({ tweaks }) => {
  const isMobile = useIsMobile();
```

- [ ] **Step 2: Verify the hook returns the right value at both widths**

Reload `http://localhost:8000`. Open DevTools console.

At full desktop width run:
```js
window.matchMedia('(max-width: 720px)').matches
```
Expected: `false`.

Resize the window narrow (or toggle device mode to iPhone SE). Run the same query.
Expected: `true`.

The page must still render normally — no crashes from the new hook. If you see "Cannot read property 'addEventListener'" the JSX import order is wrong; recheck `useEffect` destructure.

- [ ] **Step 3: Commit**

```bash
cd ~/Documents/luckyshamrock
git add components-booking.jsx
git commit -m "Add useIsMobile hook for mobile booking branches

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Mobile breakpoint — grid stack, card padding, perks trim

**Files:**
- Modify: `styles.css` (append a new `@media (max-width: 720px)` block at end of file, line ~1218)

- [ ] **Step 1: Append the new media block to `styles.css`**

Add at the very end of `styles.css`:

```css
/* ---------- Mobile booking card (≤ 720px) ---------- */

@media (max-width: 720px) {
  /* Stack the two-column grid */
  .booking-grid {
    grid-template-columns: 1fr;
    gap: 28px;
    margin-top: 28px;
  }

  /* Tighten container padding so the card has breathing room */
  .booking .container {
    padding: 0 16px;
  }

  /* Smaller card padding so content actually fits */
  .booking-card {
    padding: 20px;
    border-radius: 18px;
  }

  /* Trim perks list to first 3 items */
  .booking-perks li:nth-child(n+4) {
    display: none;
  }

  /* Shrink the info hero on mobile so it doesn't dominate */
  .booking-info h2 {
    font-size: clamp(32px, 8vw, 44px);
  }
}
```

- [ ] **Step 2: Verify in iPhone SE viewport (375×667)**

Reload `http://localhost:8000`, scroll to the booking section, switch to iPhone SE in device mode.

Run in DevTools console:
```js
document.body.scrollWidth <= window.innerWidth
```
Expected: `true` (no horizontal page scroll).

Visual checks:
- Info copy ("Stop smelling that...") sits above the booking card, not beside it.
- The booking card fits inside the viewport — no clipped right edge.
- Only 3 perks visible (No need to be home / Photo proof / Eco-safe). The "Pause or cancel" and "Service area" items are hidden.

- [ ] **Step 3: Verify desktop is unchanged at 1280×800**

Switch device mode off (or set to 1280×800). Booking section must look identical to before this task: 2-column grid, 50px gap, all 5 perks visible, full 36px card padding.

- [ ] **Step 4: Commit**

```bash
git add styles.css
git commit -m "Stack booking grid + trim card on mobile

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Compact step header (replace 4 pills on mobile)

**Files:**
- Modify: `components-booking.jsx` — replace the `.booking-steps` block (lines ~80–94) with a conditional that picks mobile header vs desktop pills
- Modify: `styles.css` — add mobile rules to hide pills and style new progress component

- [ ] **Step 1: Replace the step-pill render with a mobile/desktop conditional**

In `components-booking.jsx`, find this block (around lines 80–94):

```jsx
{step < 4 && (
  <div className="booking-steps">
    {['Service', 'Date & Time', 'Your Info', 'Confirm'].map((label, i) => {
      const n = i + 1;
      return (
        <div
          key={i}
          className={`booking-step-pill ${step === n ? 'active' : step > n ? 'done' : ''}`}
        >
          {n}. {label}
        </div>
      );
    })}
  </div>
)}
```

Replace it with:

```jsx
{step < 4 && (
  isMobile ? (
    <div className="booking-progress-mobile">
      <div className="bpm-label">
        Step {step} of 4 · {['Service', 'Date & Time', 'Your Info', 'Confirm'][step - 1]}
      </div>
      <div className="bpm-bar">
        {[1, 2, 3, 4].map(n => (
          <div key={n} className={`bpm-seg ${step >= n ? 'filled' : ''}`} />
        ))}
      </div>
    </div>
  ) : (
    <div className="booking-steps">
      {['Service', 'Date & Time', 'Your Info', 'Confirm'].map((label, i) => {
        const n = i + 1;
        return (
          <div
            key={i}
            className={`booking-step-pill ${step === n ? 'active' : step > n ? 'done' : ''}`}
          >
            {n}. {label}
          </div>
        );
      })}
    </div>
  )
)}
```

- [ ] **Step 2: Add CSS for the mobile progress header**

In `styles.css`, inside the `@media (max-width: 720px)` block created in Task 2 (just before the closing brace), add:

```css
  /* Compact step header on mobile */
  .booking-steps { display: none; }

  .booking-progress-mobile {
    margin-bottom: 22px;
  }
  .booking-progress-mobile .bpm-label {
    font-family: 'Nunito', sans-serif;
    font-weight: 800;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--ink-2);
    margin-bottom: 8px;
  }
  .booking-progress-mobile .bpm-bar {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px;
  }
  .booking-progress-mobile .bpm-seg {
    height: 4px;
    background: var(--cream-2);
    border-radius: var(--r-pill);
    transition: background 200ms;
  }
  .booking-progress-mobile .bpm-seg.filled {
    background: var(--green);
  }
```

- [ ] **Step 3: Verify on iPhone SE**

Reload. At iPhone SE width, the booking card now shows "Step 1 of 4 · Service" with a 4-segment progress bar underneath (first segment filled). Tap "Pick a date" → header updates to "Step 2 of 4 · Date & Time" and 2 segments fill. The old pill row is gone.

Run in DevTools console:
```js
document.querySelector('.booking-steps').offsetHeight
```
Expected: `0` (hidden).

```js
document.querySelector('.booking-progress-mobile') !== null
```
Expected: `true`.

- [ ] **Step 4: Verify desktop unchanged (1280 wide)**

Pills row is present and identical to before. No progress bar element rendered.

```js
document.querySelector('.booking-progress-mobile')
```
Expected: `null`.

- [ ] **Step 5: Commit**

```bash
git add components-booking.jsx styles.css
git commit -m "Replace step pills with compact progress header on mobile

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Week-strip date picker + vertical time list

**Files:**
- Modify: `components-booking.jsx` — replace the step 2 calendar + time-slots block (lines ~163–209) with a mobile/desktop conditional
- Modify: `styles.css` — add `.week-strip`, `.day-chip`, `.time-list` rules inside the mobile media block

- [ ] **Step 1: Replace the step 2 date+time render with a conditional**

In `components-booking.jsx`, find this block (the inside of `{step === 2 && ...}`, lines ~163 onward, starting with the `monthName` header and ending just before `<div className="booking-nav"...>`):

```jsx
<div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14}}>
  <div style={{fontFamily: "'Nunito', sans-serif", fontWeight: 800, fontSize: 18}}>
    {monthName}
  </div>
  <div style={{fontSize: 12, color: 'var(--ink-3)', display: 'flex', alignItems: 'center', gap: 6}}>
    <span style={{width: 6, height: 6, background: 'var(--toxic)', borderRadius: '50%'}}></span>
    open slots
  </div>
</div>
<div className="cal">
  {['S','M','T','W','T','F','S'].map(d => (
    <div className="cal-head" key={d}>{d}</div>
  ))}
  {days.map((d, i) => (
    <div
      key={i}
      className={`cal-day ${d.disabled ? 'disabled' : ''} ${d.hasSlot && !d.disabled ? 'has-slot' : ''} ${selectedDay === i ? 'selected' : ''}`}
      onClick={() => !d.disabled && d.hasSlot && setSelectedDay(i)}
    >
      {d.day}
    </div>
  ))}
</div>

{selectedDay !== null && (
  <div>
    <div style={{fontFamily: "'Nunito', sans-serif", fontWeight: 800, fontSize: 16, marginTop: 24, marginBottom: 4}}>
      Pick a time slot
    </div>
    <div style={{fontSize: 13, color: 'var(--ink-3)', marginBottom: 4}}>
      {days[selectedDay].date.toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric' })}
    </div>
    <div className="time-slots">
      {timeSlots.map(t => (
        <button
          key={t}
          className={`time-slot ${selectedTime === t ? 'selected' : ''}`}
          onClick={() => setSelectedTime(t)}
        >
          {t}
        </button>
      ))}
    </div>
  </div>
)}
```

Replace it with:

```jsx
{isMobile ? (
  <>
    <div style={{fontFamily: "'Nunito', sans-serif", fontWeight: 800, fontSize: 18, marginBottom: 14}}>
      Pick a day
    </div>
    <div className="week-strip">
      {days
        .filter(d => !d.disabled)
        .slice(0, 14)
        .map((d) => {
          const originalIndex = days.indexOf(d);
          const isSelected = selectedDay === originalIndex;
          const isFull = !d.hasSlot;
          return (
            <button
              key={originalIndex}
              className={`day-chip ${isSelected ? 'selected' : ''} ${isFull ? 'disabled' : ''}`}
              onClick={() => !isFull && setSelectedDay(originalIndex)}
              disabled={isFull}
            >
              <div className="dc-dow">
                {d.date.toLocaleDateString('en', { weekday: 'short' })}
              </div>
              <div className="dc-day">{d.day}</div>
              <div className="dc-meta">{isFull ? 'full' : 'open'}</div>
            </button>
          );
        })}
    </div>

    {selectedDay !== null && (
      <div>
        <div style={{fontFamily: "'Nunito', sans-serif", fontWeight: 800, fontSize: 16, marginTop: 24, marginBottom: 4}}>
          Pick a time slot
        </div>
        <div style={{fontSize: 13, color: 'var(--ink-3)', marginBottom: 10}}>
          {days[selectedDay].date.toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric' })}
        </div>
        <div className="time-list">
          {timeSlots.map(t => (
            <button
              key={t}
              className={`time-slot ${selectedTime === t ? 'selected' : ''}`}
              onClick={() => setSelectedTime(t)}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
    )}
  </>
) : (
  <>
    <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14}}>
      <div style={{fontFamily: "'Nunito', sans-serif", fontWeight: 800, fontSize: 18}}>
        {monthName}
      </div>
      <div style={{fontSize: 12, color: 'var(--ink-3)', display: 'flex', alignItems: 'center', gap: 6}}>
        <span style={{width: 6, height: 6, background: 'var(--toxic)', borderRadius: '50%'}}></span>
        open slots
      </div>
    </div>
    <div className="cal">
      {['S','M','T','W','T','F','S'].map(d => (
        <div className="cal-head" key={d}>{d}</div>
      ))}
      {days.map((d, i) => (
        <div
          key={i}
          className={`cal-day ${d.disabled ? 'disabled' : ''} ${d.hasSlot && !d.disabled ? 'has-slot' : ''} ${selectedDay === i ? 'selected' : ''}`}
          onClick={() => !d.disabled && d.hasSlot && setSelectedDay(i)}
        >
          {d.day}
        </div>
      ))}
    </div>

    {selectedDay !== null && (
      <div>
        <div style={{fontFamily: "'Nunito', sans-serif", fontWeight: 800, fontSize: 16, marginTop: 24, marginBottom: 4}}>
          Pick a time slot
        </div>
        <div style={{fontSize: 13, color: 'var(--ink-3)', marginBottom: 4}}>
          {days[selectedDay].date.toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric' })}
        </div>
        <div className="time-slots">
          {timeSlots.map(t => (
            <button
              key={t}
              className={`time-slot ${selectedTime === t ? 'selected' : ''}`}
              onClick={() => setSelectedTime(t)}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
    )}
  </>
)}
```

Note: the desktop branch is the original block, untouched. The mobile branch reuses the same `selectedDay`, `selectedTime`, `timeSlots`, and `days` already defined in the component — no new state.

- [ ] **Step 2: Add `.week-strip`, `.day-chip`, `.time-list` CSS**

In `styles.css`, inside the `@media (max-width: 720px)` block, append:

```css
  /* Hide desktop month grid on mobile */
  .cal { display: none; }
  .time-slots { display: none; }

  /* Horizontal week strip */
  .week-strip {
    display: flex;
    gap: 10px;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 4px 4px 12px;
    margin: 0 -4px;
    scroll-snap-type: x mandatory;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .week-strip::-webkit-scrollbar { display: none; }

  .day-chip {
    flex: 0 0 auto;
    width: 76px;
    padding: 12px 8px;
    border: 1.5px solid rgba(31, 26, 18, 0.12);
    border-radius: var(--r-md);
    background: white;
    cursor: pointer;
    text-align: center;
    scroll-snap-align: start;
    transition: all 150ms;
    font-family: inherit;
  }
  .day-chip:hover:not(:disabled) { border-color: var(--green); }
  .day-chip.selected {
    background: var(--green);
    border-color: var(--green);
    color: white;
    box-shadow: 0 0 0 4px rgba(45, 122, 45, 0.15);
  }
  .day-chip.disabled,
  .day-chip:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .day-chip .dc-dow {
    font-family: 'Nunito', sans-serif;
    font-weight: 700;
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-3);
  }
  .day-chip.selected .dc-dow { color: rgba(255,255,255,0.8); }
  .day-chip .dc-day {
    font-family: 'Nunito', sans-serif;
    font-weight: 900;
    font-size: 22px;
    line-height: 1.1;
    margin: 2px 0;
  }
  .day-chip .dc-meta {
    font-size: 11px;
    color: var(--ink-3);
  }
  .day-chip.selected .dc-meta { color: rgba(255,255,255,0.8); }

  /* Vertical time list */
  .time-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 10px;
  }
  .time-list .time-slot {
    width: 100%;
    padding: 14px 16px;
    font-size: 15px;
    text-align: center;
  }
```

- [ ] **Step 3: Verify week strip on iPhone SE**

Reload. At iPhone SE width, navigate to step 2.

Visual checks:
- "Pick a day" header instead of `{monthName}` and the dot legend.
- A horizontal row of day chips visible, each ~76px wide, showing `DOW / day-number / open|full`.
- The row can be scrolled horizontally with a swipe / trackpad. No visible scrollbar.
- Tapping an "open" chip selects it (green fill, white text).
- Tapping a "full" chip does nothing.
- After selecting, the time list appears below as a vertical stack of full-width buttons.
- Selecting a time turns the button green.

Run in console:
```js
const strip = document.querySelector('.week-strip');
strip.scrollWidth > strip.clientWidth
```
Expected: `true` (the strip overflows horizontally — that's what enables the scroll).

```js
document.body.scrollWidth <= window.innerWidth
```
Expected: `true` (no horizontal *page* scroll — overflow is on `.week-strip`, not on `<body>`).

- [ ] **Step 4: Verify desktop unchanged**

Switch to 1280×800. Step 2 shows the original month grid + the 3-col time slots. No week strip in the DOM:

```js
document.querySelector('.week-strip')
```
Expected: `null`.

- [ ] **Step 5: Commit**

```bash
git add components-booking.jsx styles.css
git commit -m "Add mobile week strip + vertical time list for step 2

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Sticky `.booking-nav` bar on mobile

**Files:**
- Modify: `styles.css` — add sticky rule inside the mobile media block

- [ ] **Step 1: Append the sticky-nav rule**

In `styles.css`, inside the `@media (max-width: 720px)` block, append:

```css
  /* Sticky action bar so Back/Continue stay reachable */
  .booking-nav {
    position: sticky;
    bottom: 16px;
    background: var(--paper);
    padding: 12px 0;
    margin: 16px -20px -20px;
    padding-left: 20px;
    padding-right: 20px;
    box-shadow: 0 -8px 16px -8px rgba(0,0,0,0.12);
    z-index: 2;
  }
```

Note: the negative horizontal margins + matching padding push the sticky bar to the full inner width of the card so the shadow spans edge-to-edge.

- [ ] **Step 2: Verify the bar stays put while scrolling step content**

Reload at iPhone SE. Navigate to step 1 (which has the most content: service options + bins + summary). Scroll the *page* down so the booking card's content scrolls behind the sticky nav.

Expected:
- "Pick a date" button stays pinned 16px from the bottom of the booking-card visual area.
- A soft top shadow visible under the sticky bar.
- No layout shift when sticky activates.
- Tap "Pick a date" → still works, advances to step 2.

Then in step 2, scroll the time-list and verify the Back/Continue row stays anchored.

- [ ] **Step 3: Verify desktop unchanged**

At 1280×800, `.booking-nav` is *not* sticky — it sits inline at the bottom of the step content as before. Run in console:

```js
window.getComputedStyle(document.querySelector('.booking-nav')).position
```
Expected: `static` (because the sticky rule only applies inside the mobile media query).

- [ ] **Step 4: Commit**

```bash
git add styles.css
git commit -m "Make booking action bar sticky on mobile

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Cross-device verification + polish pass

**Files:** none initially — only modify if a check fails.

- [ ] **Step 1: Walk all five viewports through the full booking flow**

For each viewport below, reload `http://localhost:8000`, scroll to `#book`, and run steps 1 → 2 → 3 → 4 of the booking flow.

| Viewport | Expected layout |
|---|---|
| iPhone SE (375×667) | Mobile: progress bar, week strip, vertical times, sticky nav |
| iPhone 14 Pro (393×852) | Mobile (same as SE, just more room) |
| Pixel 7 (412×915) | Mobile |
| iPad Mini (768×1024) | **Desktop layout** (above 720px breakpoint) |
| Desktop 1280×800 | Desktop — pixel-identical to pre-change |

For each: confirm no horizontal page scroll, all controls tappable, no clipped text, no broken state when navigating between steps. The form inputs in step 3 must not trigger iOS zoom-on-focus (already prevented by the existing `font-size: 16px` on inputs).

- [ ] **Step 2: Fix any issues found**

If a check fails, fix it in `styles.css` or `components-booking.jsx`, commit the fix with a focused message ("Fix step-3 form overflow on iPhone SE" etc.), and re-verify. Multiple small commits are preferred over one omnibus fix.

- [ ] **Step 3: Final commit (only if there are pending changes)**

If no fixes were needed, this step is a no-op. Otherwise:

```bash
git add -A
git commit -m "Polish mobile booking from cross-device pass

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Update the project session log**

Append a dated entry to `~/Documents/My Brain/Projects/Lucky Shamrock/Lucky Shamrock.md` under `## Session Log`:

```markdown
### 2026-05-22
- Audited booking section for mobile: 2-col grid never collapsed, card overflowed viewport, pills truncated, month grid cells under 44px tap floor.
- Designed mobile-first redesign: 720px breakpoint, horizontal week strip + vertical time list, compact step header with progress bar, sticky Back/Continue, perks list trimmed to 3.
- Spec: `docs/superpowers/specs/2026-05-22-lucky-shamrock-mobile-booking-design.md`. Plan: `docs/superpowers/plans/2026-05-22-lucky-shamrock-mobile-booking-impl.md`.
- Implemented + verified across iPhone SE / 14 Pro / Pixel 7 / iPad Mini / Desktop 1280.
- **Next:** decide if/when to push to remote; pick host + wire deploy.
```

---

## Open follow-ups (deferred, not part of this plan)

- Push to `origin/main` (separate decision — the user may want to host first).
- Pick a host (Cloudflare Pages / Netlify / GitHub Pages) and wire deploy.
- Real availability data on `hasSlot` (BinWash backend work).
- Account-view "my schedule" page (separate surface, separate spec).
- Operator schedule board (separate surface, separate spec).
