# Operator Photo Proof + All Upcoming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator attach a clean-bin photo when marking a visit Done, include that photo in the done email, and show all future booked actionable stops instead of only the next 7 days.

**Architecture:** Keep this v1 lean: the browser reads and downsizes the selected/taken photo, sends it in the existing `POST /api/operator/act` Done body, and Gmail sends it as an attachment. No new Vercel function and no durable photo storage are added. The upcoming route removes the artificial 7-day upper bound while still excluding today and non-actionable visit statuses.

**Tech Stack:** Static React/Babel operator UI, Vercel Node API, Gmail RFC822 MIME builder, Drizzle/Postgres, Vitest.

---

### Task 1: Email Attachment Plumbing

**Files:**
- Modify: `lib/gmail.ts`
- Modify: `lib/email.ts`
- Modify: `lib/notifications.ts`
- Test: `lib/_tests/gmail.test.ts`
- Test: `lib/_tests/notifications.test.ts`

- [x] Add tests for Gmail RFC822 output with an attachment and for notification forwarding of attachments.
- [x] Add `EmailAttachment` types and pass attachments from `sendAndLog` through `sendEmail` to `sendViaGmail`.
- [x] Build multipart/mixed email output when attachments are present: alternative text/html part plus base64 attachment part.

### Task 2: Done Photo Validation + Email

**Files:**
- Modify: `lib/operator-handlers.ts`
- Modify: `lib/email/templates.ts`
- Test: `api/_tests/operator-done.test.ts`
- Test: `lib/_tests/templates.test.ts`

- [x] Add tests that Done accepts a valid JPEG photo payload, forwards it as an email attachment, and mentions photo proof in the done template.
- [x] Add tests that invalid photo MIME/base64/oversize payloads return 400 before marking the visit Done.
- [x] Validate `clean_photo` on the Done action body with allowed MIME types `image/jpeg`, `image/png`, and `image/webp`, decoded max 5 MB.
- [x] Include photo proof copy in the done email when a photo is attached.

### Task 3: Operator UI Photo Input

**Files:**
- Modify: `ops/components-ops.jsx`
- Test: static JSX parse check with esbuild.

- [x] Add a photo input to each stop card for actionable visits: `accept="image/*"` and `capture="environment"`.
- [x] Read the selected image in-browser, resize/compress it to JPEG with a 1600 px max side, and send `clean_photo` only when Done is tapped.
- [x] Show selected-photo filename/status and include it in the Done request body.

### Task 4: All Upcoming

**Files:**
- Modify: `lib/operator-handlers.ts`
- Modify: `ops/components-ops.jsx`
- Test: `api/_tests/operator-upcoming.test.ts`

- [x] Change `/api/operator/upcoming` to return all future actionable visits after the anchor date, with no 7-day cap.
- [x] Update operator UI copy from “Next 7 days” to “All upcoming”.
- [x] Keep ordering by scheduled date, then customer name.

### Task 5: Verification + Ship

**Files:**
- Modify: `CLAUDE.md` if conventions change.
- Update: `/Users/homie/Documents/My Brain/Projects/Lucky Shamrock/Lucky Shamrock.md`

- [x] Run `npm run typecheck`.
- [x] Run targeted tests for Gmail, notifications, templates, operator done, and operator upcoming.
- [x] Run JSX parse check for `ops/components-ops.jsx`.
- [x] Run full `npm test`.
- [ ] Commit, push, and verify Vercel deployment plus production `/api/health`.
