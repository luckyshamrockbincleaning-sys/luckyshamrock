// Manage-page components. Babel-standalone, no build step.
// Loaded from /manage/index.html. The matching app entry in
// /manage/app-manage.jsx mounts <ManageApp/> into #root.

const { useState, useEffect, useCallback } = React;

const CADENCE_LABEL = {
  monthly: 'Monthly (every 4 weeks)',
  seasonal: 'Three Wash Season (3×/year)',
  bimonthly: 'Bimonthly (every 8 weeks)',
  quarterly: 'Quarterly (every 13 weeks)',
};

// Plans a customer may switch INTO — only what the storefront sells, with the
// per-clean price shown (mirrors window.LS_PRICING used on the main site).
// bimonthly/quarterly are legacy: still labelled above for customers already on
// them, but never offered as a switch target (the API rejects them too).
const SOLD_CADENCES = ['monthly', 'seasonal'];
const CADENCE_PRICE_LABEL = {
  monthly: 'Monthly (every 4 weeks) — $35/clean',
  seasonal: 'Three Wash Season (3×/year) — $105/season',
};

const PICKUP_LABEL = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
};

function formatDate(iso) {
  if (!iso) return '';
  // These are date-only values (visit.scheduled_for, subscription.started_on).
  // They arrive either as a bare "2026-06-09" or as a UTC-midnight timestamp
  // "2026-06-09T00:00:00.000Z" — both render as the PREVIOUS day in Mountain
  // Time if parsed directly. Pull the calendar-day prefix and pin to local noon
  // so the day never shifts. (The booking email shows the raw date; this keeps
  // the manage page consistent with it.)
  const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})/);
  const d = m ? new Date(`${m[1]}T12:00:00`) : new Date(iso);
  return d.toLocaleDateString('en-CA', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}

function Flash({ kind, text, onDismiss }) {
  if (!text) return null;
  return (
    <div className={`flash ${kind}`} role="status">
      {text}
      {onDismiss && <button className="btn-ghost" style={{float: 'right', padding: 0}} onClick={onDismiss}>×</button>}
    </div>
  );
}

function LoginCard() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState('');
  // /api/magic-link/verify redirects dead links here with ?link=expired so the
  // customer gets a banner + the resend form instead of a raw JSON error.
  const [linkExpired, setLinkExpired] = useState(
    () => new URLSearchParams(window.location.search).get('link') === 'expired',
  );

  async function submit(e) {
    e.preventDefault();
    setErr('');
    setSubmitting(true);
    try {
      const r = await fetch('/api/magic-link/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      if (!r.ok && r.status !== 200) {
        const body = await r.json().catch(() => ({}));
        setErr(body.message || 'Could not send link, try again.');
      } else {
        setSent(true);
      }
    } catch (e) {
      setErr('Network error — try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <div className="manage-card login-card">
        <h2>Check your inbox.</h2>
        <p>If we have a booking for that email, a manage link is on its way (1-hour expiry).</p>
        <button className="btn btn-ghost" onClick={() => { setSent(false); setEmail(''); }}>Use a different email</button>
      </div>
    );
  }

  return (
    <div className="manage-card login-card">
      <h2>Sign in to manage your booking.</h2>
      <p>We'll email you a one-tap link.</p>
      {linkExpired && (
        <Flash
          kind="err"
          text="That manage link has expired — they only last an hour. Enter your email below and we'll send you a fresh one."
          onDismiss={() => setLinkExpired(false)}
        />
      )}
      <Flash kind="err" text={err} />
      <form onSubmit={submit}>
        <div className="form-row" style={{justifyContent: 'center'}}>
          <div className="field" style={{maxWidth: 320}}>
            <label>Email</label>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </div>
        </div>
        <button className="btn btn-primary" style={{marginTop: 12}} disabled={submitting || !email}>
          {submitting ? 'Sending…' : 'Email me a manage link'}
        </button>
      </form>
    </div>
  );
}

function CustomerCard({ customer, showPickupDay }) {
  // Pickup day only drives recurring schedules — for one-off customers it's a
  // meaningless placeholder value, so hide the row entirely.
  return (
    <div className="manage-card">
      <h2>Account</h2>
      <div className="manage-row"><span>Name</span><span className="v">{customer.name}</span></div>
      <div className="manage-row"><span>Email</span><span className="v">{customer.email}</span></div>
      <div className="manage-row"><span>Address</span><span className="v">{customer.street}, {customer.city} {customer.postal_code}</span></div>
      {showPickupDay && (
        <div className="manage-row"><span>Pickup day</span><span className="v">{PICKUP_LABEL[customer.pickup_day]}</span></div>
      )}
    </div>
  );
}

// The customer's own service record. Before this, a clean vanished from this
// page the moment it was done — somebody charged $57 had nothing to look back
// at, and the done email was their only receipt.
const PAY_METHOD_LABEL = {
  card: 'card on file',
  cash: 'cash',
  terminal: 'card in person',
  qr: 'paid by QR',
};

function PastVisitsCard({ visits }) {
  if (!visits || visits.length === 0) return null;

  function paidLabel(v) {
    if (v.payment_status === 'comped') return 'no charge';
    if (v.amount_cents == null) return '';
    const amount = `$${(v.amount_cents / 100).toFixed(2)}`;
    const how = PAY_METHOD_LABEL[v.payment_method];
    return how ? `${amount} · ${how}` : amount;
  }

  return (
    <div className="manage-card">
      <h2>Past cleans</h2>
      {visits.map((v) => (
        <div className="manage-row" key={v.id}>
          <span>{formatDate(v.scheduled_for)}</span>
          <span className="v">
            {paidLabel(v)}
            {v.credit_cents > 0 && (
              <span style={{ color: '#1d7a3d' }}> (incl. ${(v.credit_cents / 100).toFixed(2)} credit)</span>
            )}
          </span>
        </div>
      ))}
      <p style={{ marginBottom: 0, marginTop: 10, fontSize: 13, color: 'var(--ink-3, #6b6b6b)' }}>
        Showing your {visits.length === 1 ? 'most recent clean' : `${visits.length} most recent cleans`}.
        Every clean also emails you a photo and a receipt.
      </p>
    </div>
  );
}

// The customer's own referral code, their balance, and how many neighbours
// they've sent us. Renders nothing without a code — rows predating the feature
// are backfilled, but a null must degrade quietly rather than show "undefined".
function ReferralCard({ referral }) {
  const [copied, setCopied] = useState('');
  if (!referral || !referral.code) return null;

  const shareUrl = `${window.location.origin}/?ref=${encodeURIComponent(referral.code)}`;

  async function copy(text, which) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(''), 1800);
    } catch (e) {
      // Clipboard blocked (insecure context / permissions) — the code is
      // already on screen to read out, so this is not worth an error state.
    }
  }

  return (
    <div className="manage-card">
      <h2>Refer a neighbour</h2>
      <p style={{ marginTop: 0, color: 'var(--ink-3, #6b6b6b)', fontSize: 14 }}>
        Give a neighbour your code and you both get $5. They save on their first clean,
        and your $5 comes off your next one automatically.
      </p>

      <div style={{ textAlign: 'center', margin: '14px 0' }}>
        <div style={{
          fontFamily: 'monospace', fontSize: 28, fontWeight: 'bold',
          letterSpacing: 3, color: '#1d7a3d',
        }}>{referral.code}</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 10, flexWrap: 'wrap' }}>
          <button className="btn btn-ghost" onClick={() => copy(referral.code, 'code')}>
            {copied === 'code' ? 'Copied ✓' : 'Copy code'}
          </button>
          <button className="btn btn-ghost" onClick={() => copy(shareUrl, 'link')}>
            {copied === 'link' ? 'Copied ✓' : 'Copy link'}
          </button>
        </div>
      </div>

      {referral.credit_cents > 0 && (
        <div className="manage-row">
          <span>Your credit</span>
          <span className="v" style={{ color: '#1d7a3d', fontWeight: 600 }}>
            ${(referral.credit_cents / 100).toFixed(2)} — comes off your next clean
          </span>
        </div>
      )}
      {referral.referred_count > 0 && (
        <div className="manage-row">
          <span>Neighbours referred</span>
          <span className="v">{referral.referred_count}</span>
        </div>
      )}
    </div>
  );
}

function SubscriptionCard({ subscription, onUpdate, onCancel, busy }) {
  const [cadence, setCadence] = useState(subscription.cadence);
  const [binCount, setBinCount] = useState(subscription.bin_count);

  const dirty = cadence !== subscription.cadence || binCount !== subscription.bin_count;
  const cancelled = subscription.status === 'cancelled';

  return (
    <div className="manage-card">
      <h2>Subscription</h2>
      <div className="manage-row"><span>Status</span><span className="v" style={{textTransform: 'capitalize'}}>{subscription.status}</span></div>
      <div className="manage-row"><span>Started</span><span className="v">{formatDate(subscription.started_on)}</span></div>

      {!cancelled && (
        <>
          <div className="form-row" style={{marginTop: 16}}>
            <div className="field">
              <label>Cadence</label>
              <select value={cadence} onChange={(e) => setCadence(e.target.value)} disabled={busy}>
                {/* Legacy cadence (bimonthly/quarterly)? Show it so the select
                    reflects reality, but it disappears once they switch off. */}
                {!SOLD_CADENCES.includes(subscription.cadence) && (
                  <option value={subscription.cadence}>{CADENCE_LABEL[subscription.cadence]} (legacy)</option>
                )}
                {SOLD_CADENCES.map((v) => <option key={v} value={v}>{CADENCE_PRICE_LABEL[v]}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Bins</label>
              <select value={binCount} onChange={(e) => setBinCount(Number(e.target.value))} disabled={busy}>
                <option value={1}>1 bin</option>
                <option value={2}>2 bins</option>
                <option value={3}>3 bins</option>
              </select>
            </div>
          </div>
          <div style={{display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap'}}>
            <button className="btn btn-primary" disabled={!dirty || busy} onClick={() => onUpdate({ cadence, bin_count: binCount })}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
            <button className="btn btn-danger" disabled={busy} onClick={onCancel}>
              Cancel subscription
            </button>
          </div>
          {cadence !== subscription.cadence && (
            <p className="muted" style={{marginTop: 8}}>
              Cadence change will reschedule your upcoming visits.
            </p>
          )}
        </>
      )}
    </div>
  );
}

// An active subscriber in November has no upcoming visits — not because
// anything went wrong, but because we can't pressure-wash through an Alberta
// winter. Without this they'd see a bare "Nothing scheduled." and reasonably
// assume their subscription had lapsed.
function OffSeasonCard({ season, hasSubscription }) {
  if (!season || season.in_season) return null;
  const backIn = new Date(`${season.next_start}T12:00:00`).toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
  return (
    <div className="manage-card" style={{ borderLeft: '4px solid #1d7a3d' }}>
      <h2>Paused for winter ❄️</h2>
      <p style={{ marginBottom: 8 }}>
        Our cleaning season runs <strong>{season.label}</strong> — we can't pressure-wash
        a bin once it's freezing.
      </p>
      <p style={{ marginBottom: 0 }}>
        {hasSubscription
          ? <>Your plan is still active and <strong>you won't be charged over the winter</strong> — we only
             bill once a bin is actually cleaned. We'll email you before we start up again in {backIn}.</>
          : <>We'll be back in {backIn}. Book any time and we'll schedule your first clean for the new season.</>}
      </p>
    </div>
  );
}

function VisitsCard({ visits, onSkip, onReschedule, busyVisitId }) {
  // Which visit currently has its date picker open, and what's typed in it.
  const [editing, setEditing] = useState(null);
  const [draftDate, setDraftDate] = useState('');
  const [err, setErr] = useState('');

  if (!visits || visits.length === 0) {
    return (
      <div className="manage-card">
        <h2>Upcoming visits</h2>
        <p className="muted">Nothing scheduled.</p>
      </div>
    );
  }

  // The season, mirrored from lib/season.ts. Bounding the picker means a
  // customer can't pick a winter date and get rejected after the fact.
  const now = new Date();
  const seasonYear = now.getMonth() + 1 > 10 ? now.getFullYear() + 1 : now.getFullYear();
  const todayISO = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const seasonOpen = `${seasonYear}-05-01`;
  const minDate = todayISO > seasonOpen ? todayISO : seasonOpen;
  const maxDate = `${seasonYear}-10-31`;

  async function save(visitId) {
    setErr('');
    if (!draftDate) return;
    const message = await onReschedule(visitId, draftDate);
    if (message) { setErr(message); return; }
    setEditing(null);
    setDraftDate('');
  }

  return (
    <div className="manage-card">
      <h2>Upcoming visits</h2>
      {visits.map((v) => (
        <div key={v.id}>
          <div className="visit-row">
            <div>
              <div className="visit-date">{formatDate(v.scheduled_for)}</div>
              <div className="muted" style={{marginTop: 2}}><span className={`visit-status ${v.status}`}>{v.status}</span></div>
            </div>
            {v.status === 'scheduled' && (
              <div style={{display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end'}}>
                <button
                  className="btn btn-ghost"
                  disabled={busyVisitId === v.id}
                  onClick={() => {
                    setErr('');
                    setEditing(editing === v.id ? null : v.id);
                    setDraftDate(v.scheduled_for.slice(0, 10));
                  }}
                >
                  {editing === v.id ? 'Close' : 'Change date'}
                </button>
                <button className="btn btn-skip" disabled={busyVisitId === v.id} onClick={() => onSkip(v.id, !v.subscription_id)}>
                  {busyVisitId === v.id
                    ? (v.subscription_id ? 'Skipping…' : 'Cancelling…')
                    : (v.subscription_id ? 'Skip this one' : 'Cancel this visit')}
                </button>
              </div>
            )}
          </div>

          {editing === v.id && (
            <div style={{padding: '10px 0 14px'}}>
              <label htmlFor={`d-${v.id}`} style={{display: 'block', fontSize: 13, color: 'var(--ink-3, #6b6b6b)', marginBottom: 6}}>
                Pick a new day for this clean
              </label>
              <div style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}>
                <input
                  id={`d-${v.id}`}
                  type="date"
                  value={draftDate}
                  min={minDate}
                  max={maxDate}
                  onChange={(e) => setDraftDate(e.target.value)}
                  style={{padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(0,0,0,0.15)', fontSize: 15}}
                />
                <button className="btn btn-primary" disabled={busyVisitId === v.id || !draftDate} onClick={() => save(v.id)}>
                  {busyVisitId === v.id ? 'Saving…' : 'Save'}
                </button>
              </div>
              {err && <div style={{color: '#7A2222', fontSize: 13, marginTop: 6}}>{err}</div>}
              <div style={{fontSize: 12, color: 'var(--ink-3, #6b6b6b)', marginTop: 6}}>
                We clean May through October, and never on a Sunday. Only this
                visit moves — the rest of your schedule stays put.
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// Loads Stripe.js once (from the official CDN) and resolves window.Stripe.
let _stripeJsPromise = null;
function loadStripeJs() {
  if (window.Stripe) return Promise.resolve(window.Stripe);
  if (!_stripeJsPromise) {
    _stripeJsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://js.stripe.com/v3/';
      s.onload = () => resolve(window.Stripe);
      s.onerror = () => reject(new Error('Failed to load Stripe.js'));
      document.head.appendChild(s);
    });
  }
  return _stripeJsPromise;
}

function PaymentCard({ customer, onSaved }) {
  const [phase, setPhase] = useState('idle'); // idle | loading | ready | saving | saved | error
  const [err, setErr] = useState('');
  const elementsRef = React.useRef(null);
  const stripeRef = React.useRef(null);

  async function startAddCard() {
    setErr('');
    setPhase('loading');
    try {
      // Get a SetupIntent + publishable key from our backend.
      const r = await fetch('/api/me', { method: 'POST', credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || 'Card setup is unavailable right now.');

      const Stripe = await loadStripeJs();
      const stripe = Stripe(j.publishable_key);
      stripeRef.current = stripe;
      const elements = stripe.elements({ clientSecret: j.client_secret });
      elementsRef.current = elements;
      const paymentEl = elements.create('payment');
      // Mount after React paints the container.
      setPhase('ready');
      setTimeout(() => {
        const mountPoint = document.getElementById('card-element');
        if (mountPoint) paymentEl.mount('#card-element');
      }, 0);
    } catch (e) {
      setErr(e.message);
      setPhase('error');
    }
  }

  async function saveCard() {
    setErr('');
    setPhase('saving');
    try {
      const { error } = await stripeRef.current.confirmSetup({
        elements: elementsRef.current,
        confirmParams: { return_url: window.location.href },
        redirect: 'if_required',
      });
      if (error) throw new Error(error.message || 'Could not save the card.');
      setPhase('saved');
      if (onSaved) await onSaved();
    } catch (e) {
      setErr(e.message);
      setPhase('error');
    }
  }

  return (
    <div className="manage-card">
      <h2>Payment method</h2>
      {customer.has_card ? (
        <div>
          <div className="manage-row"><span>Card on file</span><span className="v">✓ saved</span></div>
          {phase !== 'ready' && (
            <button className="btn btn-ghost" style={{marginTop: 10}} onClick={startAddCard}>Replace card</button>
          )}
        </div>
      ) : (
        phase === 'idle' && (
          <>
            <p className="muted" style={{marginBottom: 12}}>
              Save a card so we can charge automatically after each clean. You're only charged once your bin is clean.
            </p>
            <button className="btn btn-primary" onClick={startAddCard}>Add a card</button>
          </>
        )
      )}

      <Flash kind="err" text={err} />

      {(phase === 'ready' || phase === 'saving') && (
        <div style={{marginTop: 12}}>
          <div id="card-element" />
          <button className="btn btn-primary" style={{marginTop: 12}} disabled={phase === 'saving'} onClick={saveCard}>
            {phase === 'saving' ? 'Saving…' : 'Save card'}
          </button>
        </div>
      )}
      {phase === 'loading' && <p className="muted" style={{marginTop: 10}}>Loading secure card form…</p>}
      {phase === 'saved' && <p style={{marginTop: 10, color: 'var(--green-deep)'}}>Card saved. ✓</p>}
    </div>
  );
}

function ManageApp() {
  const [state, setState] = useState({ loading: true, me: null, error: null });
  const [flash, setFlash] = useState({ kind: '', text: '' });
  const [busy, setBusy] = useState(false);
  const [busyVisitId, setBusyVisitId] = useState(null);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const r = await fetch('/api/me', { credentials: 'same-origin' });
      if (r.status === 401) { setState({ loading: false, me: null, error: null }); return; }
      const body = await r.json();
      if (!r.ok) throw new Error(body.message || 'Could not load.');
      setState({ loading: false, me: body, error: null });
    } catch (e) {
      setState({ loading: false, me: null, error: e.message });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function postJson(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(json.message || json.status || `${r.status}`);
    return json;
  }

  // Move one clean to a different day. Returns an error message on failure so
  // the row can show it inline (a page-level flash would scroll out of view on
  // a phone, which is where most of these edits happen).
  async function onReschedule(visitId, date) {
    setBusyVisitId(visitId);
    try {
      const r = await fetch('/api/me', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'reschedule', visit_id: visitId, date }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) return body.message || 'Could not move that clean.';
      setFlash({ kind: 'ok', text: `Moved to ${formatDate(body.scheduled_for)}.` });
      await load();
      return '';
    } catch (e) {
      return 'Network error — try again.';
    } finally {
      setBusyVisitId(null);
    }
  }

  async function onSkip(visitId, isOneoff) {
    if (isOneoff && !confirm('Cancel this visit? This one-off booking will be removed.')) return;
    setBusyVisitId(visitId);
    setFlash({ kind: '', text: '' });
    try {
      const out = await postJson(`/api/visit/${visitId}/skip`);
      setFlash({
        kind: 'ok',
        text: out.cancelled ? 'Visit cancelled.' : `Skipped. A make-up clean was added on ${formatDate(out.replacement_date)}.`,
      });
      await load();
    } catch (e) {
      setFlash({ kind: 'err', text: `Could not ${isOneoff ? 'cancel' : 'skip'}: ${e.message}` });
    } finally {
      setBusyVisitId(null);
    }
  }

  async function onUpdate(body) {
    if (!state.me?.subscription) return;
    setBusy(true);
    setFlash({ kind: '', text: '' });
    try {
      await postJson(`/api/subscription/${state.me.subscription.id}/update`, body);
      setFlash({ kind: 'ok', text: 'Subscription updated.' });
      await load();
    } catch (e) {
      setFlash({ kind: 'err', text: `Update failed: ${e.message}` });
    } finally {
      setBusy(false);
    }
  }

  async function onCancel() {
    if (!state.me?.subscription) return;
    if (!confirm('Cancel your subscription? Your upcoming visits will be cancelled.')) return;
    setBusy(true);
    setFlash({ kind: '', text: '' });
    try {
      await postJson(`/api/subscription/${state.me.subscription.id}/cancel`);
      setFlash({ kind: 'ok', text: 'Subscription cancelled.' });
      await load();
    } catch (e) {
      setFlash({ kind: 'err', text: `Cancel failed: ${e.message}` });
    } finally {
      setBusy(false);
    }
  }

  async function onLogout() {
    try {
      await postJson('/api/me', { op: 'logout' });
    } finally {
      setState({ loading: false, me: null, error: null });
      setFlash({ kind: 'ok', text: 'Signed out.' });
    }
  }

  if (state.loading) {
    return <div className="manage-shell"><div className="manage-card"><p>Loading…</p></div></div>;
  }

  return (
    <div className="manage-shell">
      <div className="manage-header">
        <h1>Manage your booking</h1>
        <a className="brand" href="/">Lucky Shamrock</a>
      </div>

      <Flash kind={flash.kind} text={flash.text} onDismiss={() => setFlash({ kind: '', text: '' })} />

      {!state.me ? (
        <LoginCard />
      ) : (
        <>
          {state.me.payment_alert && (
            <div className="manage-card" style={{ borderLeft: '4px solid #c0392b', background: '#fbeaea' }}>
              <h2 style={{ color: '#7A2222' }}>Payment needs attention</h2>
              <p className="muted" style={{ marginBottom: 0 }}>
                A recent clean couldn't be charged to your card
                {state.me.payment_alert.failed_count > 1 ? ` (${state.me.payment_alert.failed_count} cleans)` : ''}.
                Please update your card below so we can collect for it — your service continues either way.
              </p>
            </div>
          )}
          <CustomerCard
            customer={state.me.customer}
            showPickupDay={!!state.me.subscription && state.me.subscription.status === 'active'}
          />
          {state.me.subscription && (
            <SubscriptionCard
              subscription={state.me.subscription}
              onUpdate={onUpdate}
              onCancel={onCancel}
              busy={busy}
            />
          )}
          <OffSeasonCard
            season={state.me.season}
            hasSubscription={!!state.me.subscription && state.me.subscription.status === 'active'}
          />
          <VisitsCard
            visits={state.me.upcoming_visits}
            onSkip={onSkip}
            onReschedule={onReschedule}
            busyVisitId={busyVisitId}
          />
          <PastVisitsCard visits={state.me.past_visits} />
          <ReferralCard referral={state.me.referral} />
          {state.me.billing_enabled && (
            <PaymentCard customer={state.me.customer} onSaved={load} />
          )}
          <div style={{textAlign: 'center', marginTop: 16}}>
            <button className="btn btn-ghost" onClick={onLogout}>Sign out</button>
          </div>
        </>
      )}
    </div>
  );
}

// Expose to the app entry
window.ManageApp = ManageApp;
