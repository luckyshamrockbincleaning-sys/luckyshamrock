import { describe, it, expect } from 'vitest';
import {
  bookingConfirmedTemplate,
  magicLinkTemplate,
  onOurWayTemplate,
  doneTemplate,
  DONE_BEFORE_PHOTO_CID,
  DONE_AFTER_PHOTO_CID,
  DONE_WASH_GIF_CID,
  binBeforePhotoCid,
  binAfterPhotoCid,
} from '../email/templates.js';

describe('bookingConfirmedTemplate', () => {
  it('mentions the first visit date in subject and body', () => {
    const t = bookingConfirmedTemplate({
      name: 'Sam',
      firstVisitDate: '2026-06-04',
      manageUrl: 'https://example.com/manage?token=abc',
    });
    expect(t.subject).toMatch(/Lucky Shamrock/i);
    expect(t.text).toContain('2026-06-04');
    expect(t.text).toContain('Sam');
    expect(t.text).toContain('https://example.com/manage?token=abc');
    expect(t.html).toContain('2026-06-04');
  });
});

describe('magicLinkTemplate', () => {
  it('includes the manage URL prominently', () => {
    const t = magicLinkTemplate({
      manageUrl: 'https://example.com/manage?token=xyz',
    });
    expect(t.subject).toMatch(/manage/i);
    expect(t.text).toContain('https://example.com/manage?token=xyz');
    expect(t.html).toContain('https://example.com/manage?token=xyz');
  });
});

describe('onOurWayTemplate', () => {
  it('tells the customer the operator is on the way', () => {
    const t = onOurWayTemplate({ name: 'Sam' });
    expect(t.subject).toMatch(/way/i);
    expect(t.text).toContain('Sam');
    expect(t.text).toMatch(/way|cleaning|heading/i);
  });
});

describe('doneTemplate', () => {
  it('confirms the clean and mentions the next visit when present', () => {
    const withNext = doneTemplate({ name: 'Sam', nextVisitDate: '2026-06-11' });
    expect(withNext.subject).toMatch(/done|clean|complete/i);
    expect(withNext.text).toContain('Sam');
    expect(withNext.text).toContain('2026-06-11');

    const withoutNext = doneTemplate({ name: 'Sam', nextVisitDate: null });
    expect(withoutNext.text).toContain('Sam');
    expect(withoutNext.text).not.toContain('Next clean');
  });

  it('includes a review link when reviewUrl is provided', () => {
    const withReview = doneTemplate({ name: 'Sam', nextVisitDate: null, reviewUrl: 'https://g.page/r/review' });
    expect(withReview.text).toContain('https://g.page/r/review');
    expect(withReview.html).toContain('https://g.page/r/review');
    expect(withReview.text.toLowerCase()).toContain('review');
  });

  it('omits the review CTA when no reviewUrl is given', () => {
    const noReview = doneTemplate({ name: 'Sam', nextVisitDate: null });
    expect(noReview.text.toLowerCase()).not.toContain('review');
  });

  it('renders five tap-a-star links that replace the plain review link', () => {
    const t = doneTemplate({
      name: 'Sam',
      nextVisitDate: null,
      reviewUrl: 'https://g.page/r/review',
      ratingBaseUrl: 'https://www.luckyshamrock.ca/api/rate?v=abc&t=tok',
    });
    for (let n = 1; n <= 5; n++) {
      expect(t.html).toContain(`stars=${n}`);
    }
    // The star links subsume the plain review CTA (4-5★ forwards to Google).
    expect(t.html).not.toContain('Leave us a review');
    expect(t.text).toContain('stars=5');
  });

  it('mentions photo proof when a clean photo is attached', () => {
    const t = doneTemplate({ name: 'Sam', nextVisitDate: null, hasPhoto: true });
    expect(t.text.toLowerCase()).toContain('photo');
    expect(t.html.toLowerCase()).toContain('photo');
  });

  it('renders the clean photo inline when only the after photo exists', () => {
    const t = doneTemplate({ name: 'Sam', nextVisitDate: null, hasPhoto: true });
    expect(t.html).toContain(`cid:${DONE_AFTER_PHOTO_CID}`);
    expect(t.html).not.toContain(`cid:${DONE_BEFORE_PHOTO_CID}`);
  });

  it('renders the before → after story when both photos exist', () => {
    const t = doneTemplate({ name: 'Sam', nextVisitDate: null, hasPhoto: true, hasBeforePhoto: true });
    expect(t.html).toContain(`cid:${DONE_BEFORE_PHOTO_CID}`);
    expect(t.html).toContain(`cid:${DONE_AFTER_PHOTO_CID}`);
    expect(t.html).toMatch(/before/i);
    expect(t.html).toMatch(/after/i);
    expect(t.html.indexOf(`cid:${DONE_BEFORE_PHOTO_CID}`)).toBeLessThan(t.html.indexOf(`cid:${DONE_AFTER_PHOTO_CID}`));
    expect(t.text.toLowerCase()).toContain('before');
  });

  it('shows ONLY the wash GIF when hasWashGif is set (whole story in one image)', () => {
    const t = doneTemplate({ name: 'Sam', nextVisitDate: null, hasPhoto: true, hasBeforePhoto: true, hasWashGif: true });
    expect(t.html).toContain(`cid:${DONE_WASH_GIF_CID}`);
    expect(t.html).not.toContain(`cid:${DONE_BEFORE_PHOTO_CID}`);
    expect(t.html).not.toContain(`cid:${DONE_AFTER_PHOTO_CID}`);
    expect(t.text.toLowerCase()).toContain('animation');
  });

  it('omits the wash GIF cid when hasWashGif is not set', () => {
    const t = doneTemplate({ name: 'Sam', nextVisitDate: null, hasPhoto: true, hasBeforePhoto: true });
    expect(t.html).not.toContain(`cid:${DONE_WASH_GIF_CID}`);
  });

  it('ignores hasBeforePhoto without hasPhoto and renders no cid refs when photoless', () => {
    const before_only = doneTemplate({ name: 'Sam', nextVisitDate: null, hasBeforePhoto: true });
    expect(before_only.html).not.toContain('cid:');
    const none = doneTemplate({ name: 'Sam', nextVisitDate: null });
    expect(none.html).not.toContain('cid:');
  });

  it('renders bin 2+ as plain before/after cards under the bin-1 hero section', () => {
    const t = doneTemplate({
      name: 'Sam',
      nextVisitDate: null,
      hasPhoto: true,
      hasBeforePhoto: true,
      hasWashGif: true,
      extraBins: [{ hasBefore: true, hasAfter: true }],
    });
    // Bin 1's story stays the GIF-only layout — no bin-1 cid regression.
    expect(t.html).toContain(`cid:${DONE_WASH_GIF_CID}`);
    expect(t.html).not.toContain(`cid:${DONE_BEFORE_PHOTO_CID}`);
    // Bin 2 gets its own before/after cids, and never a GIF cid of its own
    // (there is only ever one wash-animation cid, generated for bin 1 only).
    expect(t.html).toContain(`cid:${binBeforePhotoCid(2)}`);
    expect(t.html).toContain(`cid:${binAfterPhotoCid(2)}`);
    expect(t.html).toMatch(/Bin 2/);
  });

  it('renders bin 2 after-only (no before) as a single photo, matching the bin-1 anti-testimonial rule', () => {
    const t = doneTemplate({
      name: 'Sam',
      nextVisitDate: null,
      hasPhoto: true,
      extraBins: [{ hasBefore: false, hasAfter: true }],
    });
    expect(t.html).toContain(`cid:${binAfterPhotoCid(2)}`);
    expect(t.html).not.toContain(`cid:${binBeforePhotoCid(2)}`);
  });

  it('omits a bin entirely when it has no after photo, even with a before photo (no anti-testimonial)', () => {
    const t = doneTemplate({
      name: 'Sam',
      nextVisitDate: null,
      hasPhoto: true,
      extraBins: [{ hasBefore: true, hasAfter: false }],
    });
    expect(t.html).not.toContain(`cid:${binBeforePhotoCid(2)}`);
    expect(t.html).not.toContain(`cid:${binAfterPhotoCid(2)}`);
  });

  it('numbers multiple extra bins starting at 2 and mentions the total bin count in the summary line', () => {
    const t = doneTemplate({
      name: 'Sam',
      nextVisitDate: null,
      hasPhoto: true,
      extraBins: [
        { hasBefore: true, hasAfter: true },
        { hasBefore: true, hasAfter: true },
      ],
    });
    expect(t.html).toContain(`cid:${binBeforePhotoCid(2)}`);
    expect(t.html).toContain(`cid:${binBeforePhotoCid(3)}`);
    expect(t.text).toContain('all 3 bins');
  });

  it('defaults to no extra bins when the field is omitted', () => {
    const t = doneTemplate({ name: 'Sam', nextVisitDate: null, hasPhoto: true });
    expect(t.html).not.toContain(`cid:${binAfterPhotoCid(2)}`);
  });

  it('acts as a receipt: states the charged amount', () => {
    const t = doneTemplate({ name: 'Sam', nextVisitDate: null, charge: { kind: 'charged', amountCents: 3500 } });
    expect(t.text).toContain('$35.00');
    expect(t.html).toContain('$35.00');
    expect(t.text.toLowerCase()).toContain('charged');
  });

  it('tells a cash customer they paid in cash — never claims the card on file', () => {
    const t = doneTemplate({ name: 'Sam', nextVisitDate: null, charge: { kind: 'cash' } });
    expect(t.text.toLowerCase()).toContain('cash');
    expect(t.html.toLowerCase()).toContain('cash');
    expect(t.text.toLowerCase()).not.toContain('card on file');
    expect(t.html.toLowerCase()).not.toContain('card on file');
  });

  it('tells a terminal customer they paid by card in person — never claims the card on file', () => {
    const t = doneTemplate({ name: 'Sam', nextVisitDate: null, charge: { kind: 'terminal' } });
    expect(t.text.toLowerCase()).toContain('in person');
    expect(t.html.toLowerCase()).toContain('in person');
    expect(t.text.toLowerCase()).not.toContain('card on file');
    expect(t.html.toLowerCase()).not.toContain('card on file');
  });

  it('says a comped clean was free', () => {
    const t = doneTemplate({ name: 'Sam', nextVisitDate: null, charge: { kind: 'comped' } });
    expect(t.text.toLowerCase()).toContain('no charge');
  });

  it('tells the customer when the charge failed', () => {
    const t = doneTemplate({ name: 'Sam', nextVisitDate: null, charge: { kind: 'failed' } });
    expect(t.text.toLowerCase()).toContain("couldn't charge");
    expect(t.text.toLowerCase()).toContain('payment method');
  });

  it('says nothing about payment when no billing was attempted', () => {
    for (const t of [
      doneTemplate({ name: 'Sam', nextVisitDate: null, charge: { kind: 'none' } }),
      doneTemplate({ name: 'Sam', nextVisitDate: null }),
    ]) {
      expect(t.text.toLowerCase()).not.toContain('charge');
      expect(t.text).not.toContain('$');
    }
  });
});

describe('all templates produce non-empty html and text', () => {
  it.each([
    ['bookingConfirmed', bookingConfirmedTemplate({ name: 'X', firstVisitDate: '2026-01-01', manageUrl: 'https://x.com' })],
    ['magicLink', magicLinkTemplate({ manageUrl: 'https://x.com' })],
    ['onOurWay', onOurWayTemplate({ name: 'X' })],
    ['done', doneTemplate({ name: 'X', nextVisitDate: null })],
  ])('%s', (_name, t) => {
    expect(t.subject.length).toBeGreaterThan(0);
    expect(t.text.length).toBeGreaterThan(0);
    expect(t.html.length).toBeGreaterThan(0);
  });
});
