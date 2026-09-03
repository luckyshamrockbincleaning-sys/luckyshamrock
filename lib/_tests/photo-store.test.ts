import { describe, it, expect, beforeEach, vi } from 'vitest';

const putSpy = vi.fn();
const delSpy = vi.fn();
const listSpy = vi.fn();

vi.mock('@vercel/blob', () => ({
  put: (...a: any[]) => putSpy(...a),
  del: (...a: any[]) => delSpy(...a),
  list: (...a: any[]) => listSpy(...a),
}));

const { putVisitPhoto, deleteVisitPhotos, sweepStalePhotos, visitPrefix } = await import('../photo-store.js');

beforeEach(() => {
  putSpy.mockReset();
  delSpy.mockReset();
  listSpy.mockReset();
  putSpy.mockResolvedValue({ url: 'https://blob.example/x.jpg' });
  delSpy.mockResolvedValue(undefined);
});

describe('putVisitPhoto', () => {
  it('keys a photo under its visit, bin and kind', async () => {
    const url = await putVisitPhoto('v-123', 1, 'before', Buffer.from('x'));
    expect(putSpy.mock.calls[0]![0]).toMatch(/^visits\/v-123\/1-before-[0-9a-f-]+\.jpg$/);
    expect(url).toBe('https://blob.example/x.jpg');
  });

  it('does not let Blob add its own suffix — deletion works by prefix', async () => {
    await putVisitPhoto('v-1', 0, 'after', Buffer.from('x'));
    expect(putSpy.mock.calls[0]![2]).toMatchObject({ addRandomSuffix: false, access: 'public' });
  });
});

describe('deleteVisitPhotos', () => {
  it('deletes this visit and nothing else', async () => {
    listSpy.mockResolvedValue({
      blobs: [{ url: 'a', pathname: 'visits/v-123/0-before-x.jpg' }],
    });
    await deleteVisitPhotos('v-123');
    expect(listSpy).toHaveBeenCalledWith({ prefix: visitPrefix('v-123') });
    expect(delSpy).toHaveBeenCalledWith(['a']);
  });

  it('does nothing when there is nothing to delete', async () => {
    listSpy.mockResolvedValue({ blobs: [] });
    await deleteVisitPhotos('v-none');
    expect(delSpy).not.toHaveBeenCalled();
  });
});

describe('sweepStalePhotos', () => {
  it('deletes only what is older than the cutoff', async () => {
    const now = Date.now();
    listSpy.mockResolvedValue({
      blobs: [
        { url: 'old', pathname: 'visits/a/0-before-x.jpg', uploadedAt: new Date(now - 72 * 3600_000) },
        { url: 'new', pathname: 'visits/b/0-before-y.jpg', uploadedAt: new Date(now - 60_000) },
      ],
    });
    expect(await sweepStalePhotos(48 * 3600_000)).toBe(1);
    expect(delSpy).toHaveBeenCalledWith(['old']);
  });

  it('leaves an all-fresh store alone', async () => {
    listSpy.mockResolvedValue({
      blobs: [{ url: 'new', pathname: 'visits/b/0.jpg', uploadedAt: new Date() }],
    });
    expect(await sweepStalePhotos(48 * 3600_000)).toBe(0);
    expect(delSpy).not.toHaveBeenCalled();
  });
});
