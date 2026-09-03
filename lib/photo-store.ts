import { put, del, list } from '@vercel/blob';

/**
 * Short-lived storage for a visit's Done photos.
 *
 * Photos used to travel as base64 inside the Done request itself. That is why
 * Done took 5-10 seconds (enough that a progress indicator had to be added on
 * 2026-08-01 so the operator did not think the tap had missed) and why bins
 * were capped at three — six photos was as much as one 30s function could
 * carry. They now upload as they are taken, and Done carries only URLs.
 *
 * Nothing here is durable ON PURPOSE. The done email is the delivery
 * mechanism; once it has sent, the photos are deleted. Keeping them would
 * create a retention policy, a privacy question and a growing bill that this
 * business has deliberately never had.
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
  // addRandomSuffix:false because the UUID already makes the key unguessable,
  // and a predictable prefix is what lets deleteVisitPhotos find every photo
  // for a visit without keeping a record of them anywhere.
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
 * Photos uploaded for a Done that never happened — the operator was
 * interrupted, or the job was skipped after the shots were taken.
 *
 * Swept opportunistically rather than on a schedule because this project has
 * no cron and cannot spare one of its twelve functions for one.
 */
export async function sweepStalePhotos(olderThanMs: number): Promise<number> {
  const cutoff = Date.now() - olderThanMs;
  const { blobs } = await list({ prefix: PREFIX });
  const stale = blobs.filter((b) => new Date(b.uploadedAt).getTime() < cutoff);
  if (stale.length === 0) return 0;
  await del(stale.map((b) => b.url));
  return stale.length;
}
