import { SignJWT, jwtVerify } from 'jose';
import { timingSafeEqual } from 'node:crypto';
import type { VercelRequest } from '@vercel/node';

/**
 * Operator authentication — a separate session from the customer `ls_session`.
 * One shared password (env `OPERATOR_PASSWORD`) gates `POST /api/operator/login`,
 * which sets an `ls_operator` HS256 JWT signed with `OPERATOR_SECRET`. The JWT
 * carries no identity beyond `{ op: true }` — there is one operator.
 *
 * Mirrors lib/cookies.ts + lib/session.ts but kept separate so operator and
 * customer auth can never be confused for one another.
 */

export const OPERATOR_COOKIE_NAME = 'ls_operator';
export const OPERATOR_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function getSecret(): Uint8Array {
  const raw = process.env.OPERATOR_SECRET;
  if (!raw) {
    throw new Error('OPERATOR_SECRET is not set');
  }
  return new TextEncoder().encode(raw);
}

export async function signOperatorCookie(): Promise<string> {
  return await new SignJWT({ op: true })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${OPERATOR_TTL_SECONDS}s`)
    .sign(getSecret());
}

export async function verifyOperatorCookie(token: string): Promise<boolean> {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'] });
    return payload.op === true;
  } catch {
    return false;
  }
}

export function formatOperatorCookieHeader(token: string): string {
  return [
    `${OPERATOR_COOKIE_NAME}=${token}`,
    `Path=/`,
    `Max-Age=${OPERATOR_TTL_SECONDS}`,
    `HttpOnly`,
    `Secure`,
    `SameSite=Lax`,
  ].join('; ');
}

export function formatClearOperatorCookieHeader(): string {
  return [
    `${OPERATOR_COOKIE_NAME}=`,
    `Path=/`,
    `Max-Age=0`,
    `HttpOnly`,
    `Secure`,
    `SameSite=Lax`,
  ].join('; ');
}

/**
 * Reads the ls_operator cookie off a request and verifies it. Operator-gated
 * endpoints call this first and respond 401 {status:'unauthorized'} on false.
 */
export async function getOperatorSession(req: VercelRequest): Promise<boolean> {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return false;

  const match = cookieHeader
    .split(/;\s*/)
    .map((p) => p.split('='))
    .find(([k]) => k === OPERATOR_COOKIE_NAME);
  if (!match) return false;
  const token = match[1];
  if (!token) return false;

  return await verifyOperatorCookie(token);
}

/**
 * Timing-safe comparison against OPERATOR_PASSWORD. Returns false (never throws)
 * when the env var is unset or the lengths differ.
 */
export function verifyOperatorPassword(password: string): boolean {
  const expected = process.env.OPERATOR_PASSWORD;
  if (!expected) return false;
  const a = Buffer.from(password);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Today's calendar day in Fort Saskatchewan (America/Edmonton), as YYYY-MM-DD.
 * The route runs in Mountain Time; a plain UTC "today" flips mid-evening local.
 */
export function operatorTodayISO(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Edmonton',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * The shape a joined visit row must provide to render an operator stop. The
 * read endpoints select exactly these columns (customer + subscription join).
 */
export interface OperatorVisitRow {
  id: string;
  customerId: string;
  scheduledFor: Date;
  status: string;
  paymentStatus: string;
  notes: string | null;
  headingThereAt: Date | null;
  doneAt: Date | null;
  name: string;
  phone: string | null;
  street: string;
  city: string;
  postalCode: string | null;
  binLocation: string | null;
  binCount: number | null;
  binTypes?: string[] | null;
  creditCents?: number | null;
}

/** Pure mapper: joined DB row → the snake_case stop DTO the /ops page consumes. */
export function toOperatorVisit(r: OperatorVisitRow) {
  return {
    id: r.id,
    // Needed so /ops can correct a walk-up's details after the fact.
    customer_id: r.customerId,
    scheduled_for: r.scheduledFor.toISOString().slice(0, 10),
    customer_name: r.name,
    phone: r.phone,
    street: r.street,
    city: r.city,
    postal_code: r.postalCode,
    bin_location: r.binLocation,
    bin_count: r.binCount,
    // Which bins, when we know. Null on plans booked before we asked, so
    // /ops falls back to the count.
    bin_types: r.binTypes ?? null,
    // Shown as a badge on the stop card so the operator sees a reduced
    // charge coming BEFORE tapping Done, never as a surprise afterwards.
    credit_cents: r.creditCents ?? 0,
    status: r.status,
    payment_status: r.paymentStatus,
    notes: r.notes,
    heading_there_at: r.headingThereAt,
    done_at: r.doneAt,
  };
}
