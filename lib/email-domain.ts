/**
 * Is this email address one we can actually reach?
 *
 * Written after a real customer paid $57 with `@hotmail.co` (no such domain).
 * All four emails we sent her — booking confirmation, on-the-way, receipt,
 * review request — were accepted by Gmail and then bounced into a void. Our
 * `notification_log` recorded four successful sends. Nobody noticed for weeks.
 *
 * Kept dependency-light (node:dns only) for the same reason as `referral.ts`:
 * it is imported by request-path code that must not drag heavy modules in.
 */

export type EmailDomainVerdict = 'ok' | 'undeliverable' | 'unknown';

type MxRecord = { exchange: string; priority: number };
type MxResolver = (domain: string) => Promise<MxRecord[]>;

/** Walk-up jobs mint these for customers who give no email. Never look them up. */
const OWN_DOMAIN = 'luckyshamrock.ca';

const DEFAULT_TIMEOUT_MS = 2500;

/**
 * Domains that are a keystroke away from a real one. Typing `.co` for `.com`
 * is the single most common way to lose a customer, because most of these
 * resolve to a squatter rather than bouncing.
 */
const KNOWN_TYPOS: Record<string, string> = {
  'gmial.com': 'gmail.com',
  'gmai.com': 'gmail.com',
  'gmal.com': 'gmail.com',
  'gmail.co': 'gmail.com',
  'gmail.con': 'gmail.com',
  'gmail.cm': 'gmail.com',
  'gnail.com': 'gmail.com',
  'gamil.com': 'gmail.com',
  'hotmail.co': 'hotmail.com',
  'hotmail.con': 'hotmail.com',
  'hotmial.com': 'hotmail.com',
  'hotmai.com': 'hotmail.com',
  'homail.com': 'hotmail.com',
  'yahoo.co': 'yahoo.com',
  'yahoo.con': 'yahoo.com',
  'yaho.com': 'yahoo.com',
  'outlook.co': 'outlook.com',
  'outlook.con': 'outlook.com',
  'outook.com': 'outlook.com',
  'icloud.co': 'icloud.com',
  'iclould.com': 'icloud.com',
  'shaw.c': 'shaw.ca',
  'telus.ent': 'telus.net',
};

export function emailDomainOf(email: string): string | null {
  const at = email.trim().toLowerCase().lastIndexOf('@');
  if (at < 1) return null;
  const domain = email.trim().toLowerCase().slice(at + 1);
  return domain.length > 0 ? domain : null;
}

/**
 * The obvious correction for a fat-fingered domain, or null if there isn't one.
 * Used to turn "we can't reach that address" into "did you mean …?".
 */
export function suggestEmailFix(email: string): string | null {
  const domain = emailDomainOf(email);
  if (domain === null) return null;
  const fixed = KNOWN_TYPOS[domain];
  if (fixed === undefined) return null;
  const at = email.trim().lastIndexOf('@');
  return `${email.trim().slice(0, at)}@${fixed}`;
}

/**
 * `undeliverable` only when DNS gives a definitive answer that no mail server
 * exists. Every other outcome — timeout, SERVFAIL, an address we can't parse —
 * is `unknown`, which callers must treat as "let them through". A flaky
 * resolver must never cost a booking.
 *
 * A domain with an A record but no MX is `undeliverable` on purpose. RFC 5321
 * says to fall back to the A record, but in the wild an A-only "mail domain"
 * is a typosquatter (gmial.com is one), and quietly handing a customer's
 * address to a squatter is worse than telling them to check the spelling.
 */
export async function checkEmailDomain(
  email: string,
  opts: { resolve?: MxResolver; timeoutMs?: number } = {},
): Promise<EmailDomainVerdict> {
  const domain = emailDomainOf(email);
  if (domain === null) return 'unknown';
  if (domain === OWN_DOMAIN) return 'ok';

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Under `npm test` there is no network contract to rely on, and the suite
  // books hundreds of `@example.com` customers — a domain that publishes a
  // null MX and would be (correctly) rejected. Tests that mean to exercise
  // this logic inject their own resolver, which still runs.
  if (opts.resolve === undefined && process.env.LUCKYSHAMROCK_TEST_RUN === '1') {
    return 'unknown';
  }
  const resolve = opts.resolve ?? (await defaultResolver());
  if (resolve === null) return 'unknown';

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const records = await Promise.race([
      resolve(domain),
      new Promise<null>((r) => {
        timer = setTimeout(() => r(null), timeoutMs);
      }),
    ]);
    if (records === null) return 'unknown';
    const usable = records.filter((r) => {
      if (typeof r?.exchange !== 'string') return false;
      const exchange = r.exchange.trim().replace(/\.$/, '');
      // RFC 7505 "null MX": a single `0 .` record is a domain declaring loudly
      // that it accepts no mail. example.com publishes one.
      return exchange !== '';
    });
    return usable.length > 0 ? 'ok' : 'undeliverable';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // ENOTFOUND = no such domain. ENODATA = domain exists, publishes no MX.
    // Both are definitive answers; anything else is the resolver having a bad day.
    if (code === 'ENOTFOUND' || code === 'ENODATA') return 'undeliverable';
    return 'unknown';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

let cachedResolver: MxResolver | null | undefined;

async function defaultResolver(): Promise<MxResolver | null> {
  if (cachedResolver !== undefined) return cachedResolver;
  try {
    const dns = await import('node:dns/promises');
    cachedResolver = (domain: string) => dns.resolveMx(domain);
  } catch {
    cachedResolver = null;
  }
  return cachedResolver;
}

/** The message a customer sees. Names the domain so the typo is obvious. */
export function undeliverableEmailMessage(email: string): string {
  const suggestion = suggestEmailFix(email);
  if (suggestion !== null) {
    return `We can't send email to that address. Did you mean ${suggestion}?`;
  }
  const domain = emailDomainOf(email) ?? 'that address';
  return `We can't find a mail server for ${domain}, so your photos and receipt would never arrive. Please double-check the spelling.`;
}
