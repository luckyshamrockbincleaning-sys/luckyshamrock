# Per-Bin Quantities + Upload-As-Taken Photos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a job say "two black bins and a green one" instead of just a count, and move photo upload off the Done tap so an uncapped operator job cannot time out at a customer's door.

**Architecture:** `bin_types` becomes a sorted multiset, which needs no migration because the existing `array_length(bin_types,1) = bin_count` CHECK constraints already express exactly the invariant we now want. Photos POST one-at-a-time to a new `upload` op on the existing single-segment operator router, land in Vercel Blob, and Done carries URLs instead of bytes. The legacy inline-base64 path stays as the no-signal fallback.

**Tech Stack:** TypeScript on Vercel Functions (Node 20), Neon Postgres via Drizzle, zod validation, vitest against a real test database, React through Babel-standalone in the browser with **no build step**, Vercel Blob (new).

**Spec:** `docs/superpowers/specs/2026-09-03-per-bin-quantities-design.md`

## Global Constraints

- **Vercel Hobby is at 12/12 functions.** No new file under `api/`. New routes are ops on `api/operator/[action].ts`.
- **Multi-segment dynamic routes do not reach the function** in this project's Vercel runtime. Single dynamic segment only; everything else goes in the body.
- **No build step.** `ops/*.jsx`, `components-*.jsx`, `manage/*.jsx` are served raw and compiled by Babel in the browser. No imports, no npm modules, no JSX-only-in-build syntax. Plain `<script>` globals only.
- **`bin_count` is the source of truth for money and photo pairing.** `bin_types` is the descriptive companion; they must agree or the request is rejected, never reconciled.
- **Canonical sort order is load-bearing.** Photos, per-bin email sections and the receipt are keyed by position, so bin *n* must mean the same bin every visit.
- **Self-serve cap: 3 bins. Walk-up cap: 10** (a typo guard, not a policy).
- **Prices unchanged:** first bin at plan rate, `$12` per extra bin. `pricing.js` ↔ `lib/pricing.ts` drift guard must stay green.
- **Photos are never retained.** Deleted once the done email sends.
- **The legacy inline `before_photo` / `clean_photo` path must NOT be removed** — it is the no-signal fallback.
- Run `npm test` (vitest, real Neon test DB) and `npm run typecheck` before every commit. Baseline is **524 passing**.

### ⚠️ AB action required before Task 4

A Vercel Blob store must exist on the `luckyshamrock` project and expose `BLOB_READ_WRITE_TOKEN` to Production, Preview and Development. Tasks 1–3 do not need it; Task 4 onward does. Blob is free within the Hobby allotment and this design deletes photos after each send, so steady-state storage is only in-flight jobs.

---

### Task 1: `bin_types` becomes a multiset

**Files:**
- Modify: `lib/bin-types.ts`
- Test: `lib/_tests/bin-types.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `normalizeBinTypes(input: unknown): BinType[] | null` (now duplicate-preserving), `describeBins(types, count): string`, and new `binLabelsFor(types: readonly string[] | null | undefined, count: number): string[]` returning one display label per bin position.

- [ ] **Step 1: Write the failing tests**

Add to `lib/_tests/bin-types.test.ts`:

```ts
describe('normalizeBinTypes — multiset', () => {
  it('preserves duplicates', () => {
    expect(normalizeBinTypes(['garbage', 'garbage'])).toEqual(['garbage', 'garbage']);
  });

  it('sorts into canonical order regardless of input order', () => {
    expect(normalizeBinTypes(['organics', 'garbage', 'garbage'])).toEqual([
      'garbage', 'garbage', 'organics',
    ]);
  });

  it('still rejects an unknown type', () => {
    expect(normalizeBinTypes(['garbage', 'recycling'])).toBeNull();
  });

  it('still rejects an empty selection', () => {
    expect(normalizeBinTypes([])).toBeNull();
  });
});

describe('binLabelsFor', () => {
  it('numbers only within a repeated type', () => {
    expect(binLabelsFor(['garbage', 'garbage', 'organics'], 3)).toEqual([
      'Black bin 1', 'Black bin 2', 'Green bin',
    ]);
  });

  it('leaves a lone bin unnumbered', () => {
    expect(binLabelsFor(['garbage'], 1)).toEqual(['Black bin']);
  });

  it('falls back to positions for legacy rows with no types', () => {
    expect(binLabelsFor(null, 2)).toEqual(['Bin 1', 'Bin 2']);
  });
});

describe('describeBins', () => {
  it('compresses repeats', () => {
    expect(describeBins(['garbage', 'garbage', 'organics'], 3)).toBe('Black bin ×2 + Green bin');
  });

  it('still falls back to the bare count for legacy rows', () => {
    expect(describeBins(null, 2)).toBe('2 bins');
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- lib/_tests/bin-types.test.ts`
Expected: FAIL — duplicates collapse to one entry, and `binLabelsFor` is not exported.

- [ ] **Step 3: Implement**

In `lib/bin-types.ts`, replace the `Set` in `normalizeBinTypes` with a duplicate-preserving array and a stable sort:

```ts
export function normalizeBinTypes(input: unknown): BinType[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const out: BinType[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') return null;
    const v = raw.trim().toLowerCase();
    if (!isBinType(v)) return null;
    out.push(v);
  }
  if (out.length === 0) return null;
  // Stable sort into canonical order. Duplicates are now legal — a household
  // with two black bins is a real customer — so this is a multiset, and the
  // count constraint in the database is what keeps it honest against
  // bin_count rather than distinctness doing it implicitly.
  return out.sort((a, b) => ORDER.get(a)! - ORDER.get(b)!);
}
```

Add below `describeBins`:

```ts
/**
 * One display label per bin position, numbered ONLY where a type repeats.
 * A lone green bin reads "Green bin", never "Green bin 1" — the number would
 * imply a second one exists and was missed. Legacy rows with no types fall
 * back to positions so the photo steps still have something to say.
 */
export function binLabelsFor(
  types: readonly string[] | null | undefined,
  count: number,
): string[] {
  const normalized = types && types.length > 0 ? normalizeBinTypes([...types]) : null;
  if (normalized === null) {
    return Array.from({ length: Math.max(1, count) }, (_, i) => `Bin ${i + 1}`);
  }
  const totals = new Map<BinType, number>();
  for (const t of normalized) totals.set(t, (totals.get(t) ?? 0) + 1);
  const seen = new Map<BinType, number>();
  return normalized.map((t) => {
    const n = (seen.get(t) ?? 0) + 1;
    seen.set(t, n);
    return totals.get(t)! > 1 ? `${BIN_TYPE_SHORT[t]} ${n}` : BIN_TYPE_SHORT[t];
  });
}
```

And make `describeBins` compress repeats:

```ts
export function describeBins(types: readonly string[] | null | undefined, count: number): string {
  const normalized = types && types.length > 0 ? normalizeBinTypes([...types]) : null;
  if (normalized === null) return `${count} bin${count === 1 ? '' : 's'}`;
  const totals = new Map<BinType, number>();
  for (const t of normalized) totals.set(t, (totals.get(t) ?? 0) + 1);
  return [...totals.entries()]
    .map(([t, n]) => (n > 1 ? `${BIN_TYPE_SHORT[t]} ×${n}` : BIN_TYPE_SHORT[t]))
    .join(' + ');
}
```

Update the file's header comment: `bin_types` is a multiset, and the CHECK constraint is now the real invariant rather than a stand-in for distinctness.

- [ ] **Step 4: Run the tests**

Run: `npm test -- lib/_tests/bin-types.test.ts`
Expected: PASS. Then `npm test` — the whole suite must stay green; `bin-types-sync.test.ts` in particular.

- [ ] **Step 5: Commit**

```bash
git add lib/bin-types.ts lib/_tests/bin-types.test.ts
git commit -m "Let a job name the same bin twice"
```

---

### Task 2: Validation accepts repeats, with the cap split by caller

**Files:**
- Modify: `lib/validation.ts:17`, `lib/validation.ts:64`, `lib/validation.ts:82-98`
- Modify: `lib/operator-handlers.ts:97-100`, `lib/operator-handlers.ts:424-431`
- Test: `lib/_tests/validation.test.ts`, `lib/_tests/operator-job.test.ts`

**Interfaces:**
- Consumes: `normalizeBinTypes` from Task 1.
- Produces: booking rejects `bin_count > 3`; the walk-up schema accepts `bin_count` 1–10; both accept repeated types when the count agrees.

- [ ] **Step 1: Write the failing tests**

```ts
// lib/_tests/validation.test.ts
it('accepts two of the same bin when the count agrees', () => {
  const r = bookRequestSchema.safeParse(validBooking({ bin_count: 2, bin_types: ['garbage', 'garbage'] }));
  expect(r.success).toBe(true);
});

it('rejects types that disagree with the count', () => {
  const r = bookRequestSchema.safeParse(validBooking({ bin_count: 3, bin_types: ['garbage', 'garbage'] }));
  expect(r.success).toBe(false);
});

it('still caps self-serve at three bins', () => {
  const r = bookRequestSchema.safeParse(validBooking({ bin_count: 4, bin_types: ['garbage', 'garbage', 'garbage', 'organics'] }));
  expect(r.success).toBe(false);
});
```

```ts
// lib/_tests/operator-job.test.ts
it('accepts a six-bin walk-up', async () => {
  const res = await postJob({ bin_count: 6, bin_types: ['garbage','garbage','garbage','organics','organics','organics'] });
  expect(res.statusCode).toBe(201);
});

it('rejects an absurd count as a typo', async () => {
  const res = await postJob({ bin_count: 11 });
  expect(res.statusCode).toBe(400);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- lib/_tests/validation.test.ts lib/_tests/operator-job.test.ts`
Expected: FAIL — repeats are rejected by the distinctness rule; 6 exceeds the walk-up `max(3)`.

- [ ] **Step 3: Implement**

`lib/validation.ts` — the array bound now follows the **count cap**, not the vocabulary size, because repeats mean a 3-bin order can name the same type three times:

```ts
const MAX_SELF_SERVE_BINS = 3;
const binCount = z.union([z.literal(1), z.literal(2), z.literal(3)]);
```

```ts
    bin_types: z.array(z.string()).max(MAX_SELF_SERVE_BINS).optional(),
```

and in the `superRefine`, replace the distinctness message:

```ts
      } else if (normalized.length !== data.bin_count) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'bin_types must list one entry per bin, matching bin_count',
          path: ['bin_types'],
        });
      }
```

`lib/operator-handlers.ts` — the walk-up schema:

```ts
    // A typo guard, not a policy limit: 99 would generate 198 photo steps.
    // Raising it is a one-line change with a known consequence.
    bin_count: z.number().int().min(1).max(10).default(1),
    bin_types: z.array(z.string()).max(10).optional(),
```

and its message at `:426`:

```ts
      errors: { bin_types: ['Pick which bins to clean — one entry per bin.'] },
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS, whole suite green.

- [ ] **Step 5: Commit**

```bash
git add lib/validation.ts lib/operator-handlers.ts lib/_tests/
git commit -m "Let the operator enter more bins than a customer can order"
```

---

### Task 3: Fix the latent `/manage` 500

**Files:**
- Modify: `api/subscription/[id]/update.ts:18-21`, `:77-83`
- Test: `api/_tests/subscription-update.test.ts`

**Interfaces:**
- Consumes: `normalizeBinTypes`, `BIN_TYPES` from Task 1.
- Produces: `PATCH`/`POST` to the update route accepts optional `bin_types`; a count-only request still succeeds.

**Why:** the route writes `binCount` without touching `binTypes`, so once a subscription has types set, a count change violates `subscription_bin_types_match_count` and the customer gets a 500. Verified latent on 2026-09-03 — all four live subscriptions predate the picker and have `bin_types = null`.

- [ ] **Step 1: Write the failing test**

```ts
it('changing bin count on a subscription with types does not 500', async () => {
  const sub = await seedSubscription({ binCount: 3, binTypes: ['garbage', 'garbage', 'organics'] });
  const res = await patch(sub.id, { bin_count: 2 });
  expect(res.statusCode).toBe(200);
  const after = await getSubscription(sub.id);
  expect(after.binCount).toBe(2);
  expect(after.binTypes).toHaveLength(2);
});

it('honours an explicit type list', async () => {
  const sub = await seedSubscription({ binCount: 1, binTypes: ['garbage'] });
  const res = await patch(sub.id, { bin_count: 2, bin_types: ['garbage', 'organics'] });
  expect(res.statusCode).toBe(200);
  expect((await getSubscription(sub.id)).binTypes).toEqual(['garbage', 'organics']);
});

it('still accepts a count-only request from a legacy client', async () => {
  const sub = await seedSubscription({ binCount: 2, binTypes: null });
  const res = await patch(sub.id, { bin_count: 3 });
  expect(res.statusCode).toBe(200);
  expect((await getSubscription(sub.id)).binTypes).toBeNull();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- api/_tests/subscription-update.test.ts`
Expected: FAIL — the first test errors on the CHECK constraint violation.

- [ ] **Step 3: Implement**

Add to the schema:

```ts
    bin_types: z.array(z.string()).max(3).optional(),
```

and derive types when the client sends only a count:

```ts
    const newBinCount = parsed.data.bin_count ?? sub.binCount;

    // bin_types must agree with bin_count or the CHECK constraint rejects the
    // write. An explicit list wins. A count-only request (older /manage
    // client) truncates or extends the stored list in canonical order; a
    // subscription that never had types keeps null rather than being handed
    // an invented list.
    let newBinTypes: string[] | null = sub.binTypes ?? null;
    if (parsed.data.bin_types !== undefined) {
      newBinTypes = normalizeBinTypes(parsed.data.bin_types);
      if (newBinTypes === null || newBinTypes.length !== newBinCount) {
        res.status(400).json({
          status: 'invalid',
          errors: { bin_types: ['Pick which bins to clean — one entry per bin.'] },
        });
        return;
      }
    } else if (newBinTypes !== null && newBinTypes.length !== newBinCount) {
      newBinTypes =
        newBinCount < newBinTypes.length
          ? newBinTypes.slice(0, newBinCount)
          : [...newBinTypes, ...Array(newBinCount - newBinTypes.length).fill(BIN_TYPES[0])];
      newBinTypes = normalizeBinTypes(newBinTypes);
    }
```

then include it in the update:

```ts
        .set({ cadence: newCadence, binCount: newBinCount, binTypes: newBinTypes })
```

and return it in the 200 body alongside `bin_count`.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/subscription/ api/_tests/
git commit -m "Stop a bin-count change on /manage breaking the booking"
```

---

### Task 4: The `upload` op and the photo store

**Files:**
- Create: `lib/photo-store.ts`
- Modify: `api/operator/[action].ts`, `lib/operator-handlers.ts`
- Test: `lib/_tests/photo-store.test.ts`, `lib/_tests/operator-upload.test.ts`
- Modify: `package.json` (add `@vercel/blob`), `.env.example`, `CLAUDE.md`

**Interfaces:**
- Consumes: `getOperatorSession` (existing auth guard, returns falsy → `401 {status:'unauthorized'}`).
- Produces:
  - `putVisitPhoto(visitId: string, binIndex: number, kind: 'before'|'after', body: Buffer): Promise<string>` → public blob URL
  - `fetchVisitPhoto(url: string): Promise<Buffer>`
  - `deleteVisitPhotos(visitId: string): Promise<void>`
  - `sweepStalePhotos(olderThanMs: number): Promise<number>` → count deleted
  - `handlePhotoUpload(req, res)` exported from `lib/operator-handlers.ts`, wired as `upload` in the router.
  - Wire contract: `POST /api/operator/upload {visit_id, bin_index, kind, content_base64, mime_type}` → `200 {status:'ok', url}`.

- [ ] **Step 1: Install the dependency**

```bash
npm install @vercel/blob
```

Add `BLOB_READ_WRITE_TOKEN=` to `.env.example` with a comment that it comes from the Vercel Blob store.

- [ ] **Step 2: Write the failing tests**

```ts
// lib/_tests/photo-store.test.ts — @vercel/blob mocked via vi.mock
it('keys a photo under its visit, bin and kind', async () => {
  const url = await putVisitPhoto('v-123', 1, 'before', Buffer.from('x'));
  expect(putSpy.mock.calls[0][0]).toMatch(/^visits\/v-123\/1-before-[0-9a-f-]+\.jpg$/);
  expect(url).toBe('https://blob.example/visits/v-123/1-before-abc.jpg');
});

it('deletes every photo for one visit and nothing else', async () => {
  listSpy.mockResolvedValue({ blobs: [
    { url: 'a', pathname: 'visits/v-123/0-before-x.jpg' },
    { url: 'b', pathname: 'visits/v-999/0-before-y.jpg' },
  ]});
  await deleteVisitPhotos('v-123');
  expect(delSpy).toHaveBeenCalledWith(['a']);
});

it('sweeps only blobs older than the cutoff', async () => {
  const now = Date.now();
  listSpy.mockResolvedValue({ blobs: [
    { url: 'old', pathname: 'visits/a/0-before-x.jpg', uploadedAt: new Date(now - 72 * 3600_000) },
    { url: 'new', pathname: 'visits/b/0-before-y.jpg', uploadedAt: new Date(now - 60_000) },
  ]});
  expect(await sweepStalePhotos(48 * 3600_000)).toBe(1);
  expect(delSpy).toHaveBeenCalledWith(['old']);
});
```

```ts
// lib/_tests/operator-upload.test.ts
it('refuses an unauthenticated upload', async () => {
  const res = await postUpload({ authed: false });
  expect(res.statusCode).toBe(401);
});

it('refuses a non-image mime type', async () => {
  const res = await postUpload({ mime_type: 'application/pdf' });
  expect(res.statusCode).toBe(400);
});

it('refuses a photo over 5MB', async () => {
  const res = await postUpload({ content_base64: 'A'.repeat(8 * 1024 * 1024) });
  expect(res.statusCode).toBe(400);
});

it('returns a url for a good photo', async () => {
  const res = await postUpload({});
  expect(res.statusCode).toBe(200);
  expect(res.body.url).toMatch(/^https:\/\//);
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npm test -- lib/_tests/photo-store.test.ts lib/_tests/operator-upload.test.ts`
Expected: FAIL — `lib/photo-store.ts` does not exist and `upload` is not a route.

- [ ] **Step 4: Implement `lib/photo-store.ts`**

```ts
import { put, del, list } from '@vercel/blob';

/**
 * Short-lived storage for a visit's Done photos.
 *
 * Photos used to travel as base64 inside the Done request, which is why Done
 * could take 5-10s and why bins were capped at 3 — six photos was as much as
 * one 30s function could carry. They now upload as they are taken and Done
 * carries only URLs.
 *
 * Nothing here is durable ON PURPOSE. The done email is the delivery
 * mechanism; once it has sent, the photos are deleted. Keeping them would
 * create a retention policy and a growing bill that this business has
 * deliberately never had.
 */
const PREFIX = 'visits/';

export function visitPrefix(visitId: string): string {
  return `${PREFIX}${visitId}/`;
}

export async function putVisitPhoto(
  visitId: string,
  binIndex: number,
  kind: 'before' | 'after',
  body: Buffer,
): Promise<string> {
  const key = `${visitPrefix(visitId)}${binIndex}-${kind}-${crypto.randomUUID()}.jpg`;
  // addRandomSuffix:false — the UUID in the key already makes it unguessable,
  // and a predictable key shape is what lets deleteVisitPhotos work by prefix.
  const blob = await put(key, body, {
    access: 'public',
    contentType: 'image/jpeg',
    addRandomSuffix: false,
  });
  return blob.url;
}

export async function fetchVisitPhoto(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`photo fetch failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function deleteVisitPhotos(visitId: string): Promise<void> {
  const { blobs } = await list({ prefix: visitPrefix(visitId) });
  if (blobs.length === 0) return;
  await del(blobs.map((b) => b.url));
}

/**
 * Photos uploaded for a Done that never happened — the operator got
 * interrupted, or the job was skipped after the shots were taken. Swept
 * opportunistically rather than on a schedule because this project has no
 * cron and cannot spare a function for one.
 */
export async function sweepStalePhotos(olderThanMs: number): Promise<number> {
  const cutoff = Date.now() - olderThanMs;
  const { blobs } = await list({ prefix: PREFIX });
  const stale = blobs.filter((b) => new Date(b.uploadedAt).getTime() < cutoff);
  if (stale.length === 0) return 0;
  await del(stale.map((b) => b.url));
  return stale.length;
}
```

- [ ] **Step 5: Implement `handlePhotoUpload` in `lib/operator-handlers.ts`**

```ts
const uploadSchema = z.object({
  visit_id: z.string().uuid(),
  bin_index: z.number().int().min(0).max(9),
  kind: z.enum(['before', 'after']),
  mime_type: z.string().regex(/^image\/(jpeg|png|webp)$/),
  content_base64: z.string().min(1),
});

export async function handlePhotoUpload(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  if (!(await getOperatorSession(req))) {
    res.status(401).json({ status: 'unauthorized' });
    return;
  }
  const parsed = uploadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'invalid', errors: parsed.error.flatten().fieldErrors });
    return;
  }
  const body = Buffer.from(parsed.data.content_base64, 'base64');
  if (body.byteLength > MAX_CLEAN_PHOTO_BYTES) {
    res.status(400).json({ status: 'invalid', message: 'Photo is too large.' });
    return;
  }
  try {
    const url = await putVisitPhoto(parsed.data.visit_id, parsed.data.bin_index, parsed.data.kind, body);
    res.status(200).json({ status: 'ok', url });
  } catch (err) {
    // /ops falls back to sending this photo inline on Done, so a failure here
    // is recoverable — say so plainly rather than failing the job.
    console.error('[operator/upload] blob put failed', err);
    res.status(502).json({ status: 'upload_failed', message: 'Could not store the photo.' });
  }
}
```

Add `upload: handlePhotoUpload` to `ONE_SEG` in `api/operator/[action].ts` and to its route comment. Add the import.

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: PASS. Confirm the deploy is still **12/12 functions** — `upload` is an op on an existing file, not a new one.

- [ ] **Step 7: Commit**

```bash
git add lib/photo-store.ts lib/operator-handlers.ts "api/operator/[action].ts" lib/_tests/ package.json package-lock.json .env.example
git commit -m "Store a photo the moment it is taken"
```

---

### Task 5: Done accepts URLs, then deletes them

**Files:**
- Modify: `lib/operator-handlers.ts:247-278` (`MAX_PHOTO_PAIRS`, `parsePhotoPairs`), and the Done handler around `:1270-1340`
- Test: `lib/_tests/operator-done-photos.test.ts`

**Interfaces:**
- Consumes: `fetchVisitPhoto`, `deleteVisitPhotos` (Task 4); `binLabelsFor` (Task 1).
- Produces: `parsePhotoPairs` accepts `{before_url?, after_url?}` entries alongside the existing inline `{before?, after?}` attachments, and resolves both to `EmailAttachment`.

- [ ] **Step 1: Write the failing tests**

```ts
it('accepts photo urls and attaches what it fetched', async () => {
  const res = await postDone({ photos: [{ before_url: URL_A, after_url: URL_B }] });
  expect(res.statusCode).toBe(200);
  expect(sentEmail.attachments).toHaveLength(2);
});

it('deletes the visit’s photos once the email has sent', async () => {
  await postDone({ photos: [{ before_url: URL_A, after_url: URL_B }] });
  expect(deleteVisitPhotosSpy).toHaveBeenCalledWith(visitId);
});

it('still accepts inline photos from a no-signal fallback', async () => {
  const res = await postDone({ before_photo: inline(), clean_photo: inline() });
  expect(res.statusCode).toBe(200);
  expect(sentEmail.attachments.length).toBeGreaterThan(0);
});

it('accepts a six-bin job', async () => {
  const res = await postDone({ photos: sixPairsOfUrls() });
  expect(res.statusCode).toBe(200);
});

it('completes even when a photo cannot be fetched back', async () => {
  fetchSpy.mockRejectedValueOnce(new Error('gone'));
  const res = await postDone({ photos: [{ before_url: URL_A, after_url: URL_B }] });
  expect(res.statusCode).toBe(200); // the clean happened; the email degrades
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- lib/_tests/operator-done-photos.test.ts`
Expected: FAIL — `before_url` is not recognised and 6 pairs exceed `MAX_PHOTO_PAIRS`.

- [ ] **Step 3: Implement**

Raise the ceiling and teach `parsePhotoPairs` about URLs:

```ts
const MAX_PHOTO_PAIRS = 10; // matches the walk-up bin_count ceiling
```

```ts
async function resolvePhotoEntry(
  entry: any,
  kind: 'before' | 'after',
  label: string,
): Promise<{ ok: true; attachment: EmailAttachment | null } | { ok: false; message: string }> {
  const url = entry?.[`${kind}_url`];
  if (typeof url === 'string' && url.length > 0) {
    try {
      const content = await fetchVisitPhoto(url);
      return {
        ok: true,
        attachment: {
          filename: kind === 'before' ? 'before-bin.jpg' : 'clean-bin.jpg',
          mimeType: 'image/jpeg',
          content,
        },
      };
    } catch (err) {
      // The clean genuinely happened. A photo we cannot fetch back costs the
      // customer an image, never the job — Done must not fail at a door.
      console.error(`[operator/visit/done] ${label} fetch failed`, err);
      return { ok: true, attachment: null };
    }
  }
  return parsePhotoAttachment(entry?.[kind], label);
}
```

Make `parsePhotoPairs` async and route each entry through `resolvePhotoEntry`, keeping the legacy `clean_photo`/`before_photo` branch untouched. Await it at the call site (`:933`).

After the done email sends, in the same best-effort block that already logs GIF outcomes:

```ts
  // Photos exist only to be delivered. Once the email is away they are
  // deleted — this system has never retained customer photos and this
  // feature does not change that.
  void deleteVisitPhotos(visitId).catch((err) =>
    console.error('[operator/visit/done] photo cleanup failed (swept later)', err),
  );
```

Replace the positional `Bin ${n}` labels at `:1339` with `binLabelsFor(binTypes, binCount)[n - 1]`.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/operator-handlers.ts lib/_tests/
git commit -m "Done carries photo urls instead of photos"
```

---

### Task 6: Sweep abandoned photos on the `today` load

**Files:**
- Modify: `lib/operator-handlers.ts` (`handleToday`)
- Test: `lib/_tests/operator-today.test.ts`

**Interfaces:**
- Consumes: `sweepStalePhotos` (Task 4).
- Produces: no response change — `today` returns exactly what it returns now.

- [ ] **Step 1: Write the failing test**

```ts
it('sweeps stale photos without delaying the response', async () => {
  const res = await getToday();
  expect(res.statusCode).toBe(200);
  expect(sweepSpy).toHaveBeenCalledWith(48 * 60 * 60 * 1000);
});

it('still returns stops when the sweep throws', async () => {
  sweepSpy.mockRejectedValueOnce(new Error('blob down'));
  expect((await getToday()).statusCode).toBe(200);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- lib/_tests/operator-today.test.ts`
Expected: FAIL — nothing calls the sweep.

- [ ] **Step 3: Implement**

After the response is sent in `handleToday`:

```ts
  // Opportunistic cleanup: photos uploaded for a Done that never happened.
  // Fire-and-forget after the response so the operator never waits on it,
  // and folded into an existing request because this project has no cron and
  // cannot spare a function for one.
  void sweepStalePhotos(48 * 60 * 60 * 1000).catch((err) =>
    console.error('[operator/today] photo sweep failed', err),
  );
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/operator-handlers.ts lib/_tests/
git commit -m "Clean up photos from jobs that were never finished"
```

---

### Task 7: `/ops` — steppers, upload as taken, per-bin labels

**Files:**
- Modify: `ops/components-ops.jsx` (walk-up form ~`:278-380`, `prepareCleanPhoto` ~`:158`, photo store ~`:182-215`, `StopCard` ~`:499-700`, Done payload ~`:576-582`)
- Modify: `pricing.js` (no change to values — read `LS_BIN_TYPES` as today)

**No unit tests.** These files have no test harness (Babel-standalone, no build step); the repo's established check is `esbuild` parse-validation plus live verification on a 390×844 viewport. Task 9 covers the live pass.

**Interfaces:**
- Consumes: `POST /api/operator/upload` (Task 4); the Done contract from Task 5.
- Produces: Done payload entries shaped `{before_url?, after_url?, before?, after?}`.

- [ ] **Step 1: Bin steppers on the walk-up form**

Replace the toggle block at `:361-380` with a `− n +` row per entry in `window.LS_BIN_TYPES`. Keep counts in `form.bin_qty` (`{garbage: 1, organics: 0}`), and derive on submit:

```jsx
const binTypes = [];
(window.LS_BIN_TYPES || []).forEach((opt) => {
  for (let i = 0; i < (form.bin_qty[opt.value] || 0); i++) binTypes.push(opt.value);
});
// bin_count is what gets priced; bin_types must agree or the server rejects it.
body.bin_count = binTypes.length;
body.bin_types = binTypes;
```

`+` disables at a total of 10; `−` disables at 0; the total cannot reach 0 (mirrors today's "last bin can't be unticked"). Show the running total and price beneath.

- [ ] **Step 2: Upload each photo as it is taken**

In `onBinPhotoChange`, after `prepareCleanPhoto` succeeds, POST to `/api/operator/upload` and store the returned URL:

```jsx
setBinPhoto(binIndex, kind, { phase: 'uploading', photo, filename, message: 'Saving photo…' });
try {
  const r = await fetch('/api/operator/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      visit_id: stop.id, bin_index: binIndex, kind,
      mime_type: photo.mime_type, content_base64: photo.content_base64,
    }),
  });
  const data = await r.json();
  if (!r.ok || !data.url) throw new Error('upload failed');
  // Keep only the URL. The base64 is dropped here, which is what stops the
  // per-visit localStorage store blowing its ~5MB quota on a big job.
  setBinPhoto(binIndex, kind, { phase: 'ready', url: data.url, photo: null, filename });
  persistBinPhoto(stop.id, binIndex, kind, null, filename, data.url);
} catch (e) {
  // No signal in a back alley is a real operating condition. Hold the bytes
  // and let Done send them inline, exactly as it did before uploads existed.
  setBinPhoto(binIndex, kind, { phase: 'ready', url: null, photo, filename, message: 'Saved on this phone' });
  persistBinPhoto(stop.id, binIndex, kind, photo, filename, null);
}
```

Extend `persistBinPhoto` / `savedPhotos` to carry `url` alongside `photo`.

- [ ] **Step 3: Send URLs from Done**

```jsx
photos: bins.map((b) => ({
  before_url: b.before.url || undefined,
  after_url: b.after.url || undefined,
  before: b.before.url ? undefined : (b.before.photo || undefined),
  after: b.after.url ? undefined : (b.after.photo || undefined),
})),
```

- [ ] **Step 4: Per-bin labels**

Mirror `binLabelsFor` in the existing local `describeBins` mirror block at `:14`, and use it for the photo step titles at `:677` and `:689` and the missing-photo warnings at `:560-569`.

- [ ] **Step 5: Smaller photos on big jobs**

```jsx
const CLEAN_PHOTO_MAX_SIDE = 1600;
const CLEAN_PHOTO_MAX_SIDE_MANY = 1100; // >3 bins: keeps the email under ~3.5MB
```

Pass the bin count into `prepareCleanPhoto` and pick the side accordingly.

- [ ] **Step 6: Parse-check and commit**

```bash
npx esbuild ops/components-ops.jsx --loader=jsx --outfile=/dev/null
git add ops/components-ops.jsx
git commit -m "Take photos one at a time, and say which bin each one is"
```

---

### Task 8: Booking and /manage steppers

**Files:**
- Modify: `components-booking.jsx:136-137`, `:393-394`, `:503-520`
- Modify: `manage/components-manage.jsx:248-283`

- [ ] **Step 1: Booking steppers**

Replace `binTypes` / `bins` state with a quantity map, deriving the same way as Task 7 Step 1 but capped at **3 total**. The `+` disables at 3, and the live price beneath keeps reading `window.LS_PRICING` exactly as it does now.

- [ ] **Step 2: /manage steppers**

Replace the `bin_count` `<select>` with the same stepper pair, capped at 3, and send `bin_types` alongside `bin_count` to the update route (Task 3 accepts it).

- [ ] **Step 3: Parse-check and commit**

```bash
npx esbuild components-booking.jsx --loader=jsx --outfile=/dev/null
npx esbuild manage/components-manage.jsx --loader=jsx --outfile=/dev/null
git add components-booking.jsx manage/components-manage.jsx
git commit -m "Let a customer say how many of each bin"
```

---

### Task 9: Review, deploy, verify live

- [ ] **Step 1: Self-review the whole branch**

`git diff main...HEAD`. The 2026-07-26 and 2026-07-31 review passes each caught customer-facing money bugs before merge; this branch touches pricing inputs and the Done path, so it gets the same treatment. Use `superpowers:requesting-code-review`.

- [ ] **Step 2: Full green build**

```bash
npm test && npm run typecheck
```
Expected: ~559 passing (524 baseline + ~35), typecheck clean.

- [ ] **Step 3: Update `CLAUDE.md`**

Document: `bin_types` is a multiset and the CHECK constraint is the invariant; photos upload as taken and are deleted after the done email; the inline path is the deliberate no-signal fallback; `upload` is an op, not a function.

- [ ] **Step 4: Merge and deploy**

```bash
git checkout main && git merge --no-ff per-bin-quantities && git push
```
Confirm the Vercel build reports **12/12 functions** and `/api/health` returns `db:true`.

- [ ] **Step 5: Verify live on a 390×844 viewport**

- A 2-black-1-green booking prices at $59 and stores `['garbage','garbage','organics']`.
- A 6-bin walk-up is accepted; a 4-bin online booking is refused.
- Photo steps read `Black bin 1`, `Black bin 2`, `Green bin`.
- Done returns quickly and the customer email shows every bin.
- Blobs for that visit are gone afterwards (`list({prefix:'visits/<id>/'})` is empty).
- With the network throttled to offline mid-job, the photo falls back to on-phone and Done still completes.
- A `/manage` bin-count change on a subscription with types returns 200.

- [ ] **Step 6: Log the work**

Append a dated entry to `~/Documents/My Brain/Projects/Lucky Shamrock/Lucky Shamrock.md` under `## Session Log`, and a billing row to `Billing Log.md` (September is open) — date, what shipped, honest hours, type **F**.
