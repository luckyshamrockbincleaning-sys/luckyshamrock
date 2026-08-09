// Operator-page components. Babel-standalone, no build step.
// Loaded from /ops/index.html. The matching app entry in /ops/app-ops.jsx
// mounts <OpsApp/> into #root. Password-gated; talks to /api/operator/*.

const { useState, useEffect, useCallback } = React;

function formatDate(iso) {
  if (!iso) return '';
  // iso is YYYY-MM-DD — parse at local noon so the weekday doesn't shift.
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
}

// Local calendar day, not UTC — the operator's phone runs on Mountain Time and
// a UTC "today" flips mid-evening (same reason the server uses operatorTodayISO).
function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayISO() {
  return toISODate(new Date());
}

function isoPlusDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  // Day-of-month overflow rolls the month/year over correctly.
  return toISODate(new Date(y, m - 1, d + days));
}

// Walk-ups have no postal code (the operator was standing at the address), so
// every address string has to tolerate it being absent — otherwise the Maps
// link and the QR receipt read "... Fort Saskatchewan null".
function addressOf(x) {
  if (!x) return '';
  const cityLine = [x.city, x.postal_code].filter(Boolean).join(' ');
  return [x.street, cityLine].filter(Boolean).join(', ');
}

function Flash({ kind, text, onDismiss }) {
  if (!text) return null;
  return (
    <div className={`flash ${kind}`} role="status">
      {text}
      {onDismiss && (
        <button className="btn-ghost" style={{ float: 'right', padding: 0 }} onClick={onDismiss}>×</button>
      )}
    </div>
  );
}

function PasswordGate({ onAuthed }) {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e) {
    e.preventDefault();
    setErr('');
    setSubmitting(true);
    try {
      const r = await fetch('/api/operator/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (r.ok) {
        onAuthed();
      } else {
        const b = await r.json().catch(() => ({}));
        setErr(b.message || 'Incorrect password.');
      }
    } catch (e) {
      setErr('Network error — try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="ops-card login-card">
      <h2>Operator sign-in</h2>
      <p>Enter the shared route password.</p>
      <Flash kind="err" text={err} />
      <form onSubmit={submit}>
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
        />
        <button className="btn btn-primary ops-btn" style={{ marginTop: 12, width: '100%' }} disabled={submitting || !password}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

// Every payment_status the DB can hold needs an entry — a missing key renders
// no badge at all, which silently hides unpaid work from the operator.
const PAY_BADGE = {
  charged: { label: '💳 paid', color: '#1f7a1f', bg: 'var(--green-soft, #dfece1)' },
  failed: { label: '⚠ card failed', color: '#7A2222', bg: '#F5DADA' },
  comped: { label: 'comped', color: '#5a4632', bg: 'var(--cream-2, #f3efe6)' },
  paid_cash: { label: '💵 cash', color: '#1f7a1f', bg: 'var(--green-soft, #dfece1)' },
  paid_terminal: { label: '🔖 tapped', color: '#1f7a1f', bg: 'var(--green-soft, #dfece1)' },
  awaiting_payment: { label: '⏳ awaiting payment', color: '#7a5a12', bg: '#FBF0D5' },
  unpaid: { label: '⚠ unpaid', color: '#7A2222', bg: '#F5DADA' },
  refunded: { label: '↩ refunded', color: '#5a4632', bg: 'var(--cream-2, #f3efe6)' },
};

const BIN_LOCATION_LABEL = {
  curb: 'By the curb',
  side: 'Side of house / driveway',
  garage: 'In garage (unlocked)',
  back: 'Back yard / behind gate',
};

const CLEAN_PHOTO_MAX_SIDE = 1600;
const CLEAN_PHOTO_QUALITY = 0.78;

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read photo.'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load photo. Try a JPEG, PNG, or WebP image.'));
    img.src = src;
  });
}

async function prepareCleanPhoto(file, filename = 'clean-bin.jpg') {
  if (!file) return null;
  const dataUrl = await readFileAsDataUrl(file);
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, CLEAN_PHOTO_MAX_SIDE / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not prepare photo.');
  ctx.drawImage(img, 0, 0, width, height);
  const jpg = canvas.toDataURL('image/jpeg', CLEAN_PHOTO_QUALITY);
  const contentBase64 = jpg.split(',')[1];
  if (!contentBase64) throw new Error('Could not prepare photo.');
  return {
    filename,
    mime_type: 'image/jpeg',
    content_base64: contentBase64,
  };
}

// Persist prepared photos across tab reloads. On phones, switching to the
// camera or to Google Maps ("On my way") can make Android silently reload
// this tab — without this, a selected before-photo evaporates and the
// customer's email loses the wash animation. localStorage, keyed per visit,
// cleared on Done and aged out after a day.
const PHOTO_STORE_PREFIX = 'ls-ops-photos-';

function savedPhotos(visitId) {
  try {
    const raw = localStorage.getItem(PHOTO_STORE_PREFIX + visitId);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data.ts || Date.now() - data.ts > 24 * 60 * 60 * 1000) return null;
    return data;
  } catch (e) { return null; }
}

// One entry per bin: bins[i] = { before: {photo,filename}?, after: {photo,filename}? }.
function persistBinPhoto(visitId, binIndex, kind, photo, filename) {
  try {
    const cur = savedPhotos(visitId) || { ts: Date.now(), bins: [] };
    if (!Array.isArray(cur.bins)) cur.bins = [];
    cur.bins[binIndex] = { ...cur.bins[binIndex], [kind]: { photo, filename } };
    cur.ts = Date.now();
    localStorage.setItem(PHOTO_STORE_PREFIX + visitId, JSON.stringify(cur));
  } catch (e) { /* storage full/blocked — degrade silently */ }
}

function clearPhotos(visitId) {
  try { localStorage.removeItem(PHOTO_STORE_PREFIX + visitId); } catch (e) {}
}

function purgeStalePhotoStores() {
  try {
    const now = Date.now();
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith(PHOTO_STORE_PREFIX)) {
        const data = JSON.parse(localStorage.getItem(key) || '{}');
        if (!data.ts || now - data.ts > 24 * 60 * 60 * 1000) localStorage.removeItem(key);
      }
    }
  } catch (e) {}
}
purgeStalePhotoStores();

// One photo capture step with a live thumbnail + captured/ missing state, so
// the operator can SEE at a glance which shots are attached before tapping Done.
function PhotoStep({ n, title, hint, state, onChange, busy }) {
  const ready = state.phase === 'ready' && state.photo;
  const thumb = ready ? `data:${state.photo.mime_type};base64,${state.photo.content_base64}` : null;
  return (
    <div
      className="ops-photo"
      style={{
        marginTop: 12,
        border: `1px solid ${ready ? '#1f7a1f' : 'rgba(0,0,0,0.12)'}`,
        borderRadius: 10,
        padding: 12,
        background: ready ? 'var(--green-soft, #eef6ef)' : 'transparent',
      }}
    >
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 20, height: 20, borderRadius: '50%', fontSize: 12, color: '#fff',
          background: ready ? '#1f7a1f' : '#9aa79a',
        }}>{ready ? '✓' : n}</span>
        {title}
      </label>
      <div style={{ fontSize: 12, color: 'var(--ink-3, #6b6b6b)', marginBottom: 8 }}>{hint}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {thumb && <img src={thumb} alt="" style={{ width: 54, height: 54, objectFit: 'cover', borderRadius: 8, flexShrink: 0 }} />}
        <input
          type="file"
          accept="image/*"
          disabled={busy}
          onChange={onChange}
          style={{ width: '100%', minWidth: 0 }}
        />
      </div>
      {state.message && (
        <div style={{ marginTop: 6, fontSize: 12, color: state.phase === 'error' ? '#7A2222' : 'var(--ink-3, #6b6b6b)' }}>
          {state.filename ? `${state.filename} · ` : ''}{state.message}
        </div>
      )}
    </div>
  );
}

// Walk-up job: someone flags the truck down. Deliberately minimal — street,
// bins, and an optional email are all that's needed to start cleaning.
function NewJobCard({ onCreated }) {
  // Field order matches how the conversation actually goes at a gate: who are
  // you, where, how do I reach you, how many bins, and an email if you'll give
  // one. No postal code — the operator is standing at the address.
  const emptyForm = { name: '', street: '', phone: '', bin_count: 1, email: '', scheduled_for: '' };
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const today = todayISO();
  // Blank = today. Anything else is a "come back later" deal made at the door.
  const isFuture = !!form.scheduled_for && form.scheduled_for > today;

  async function submit() {
    if (busy) return;
    setErr('');
    if (!form.street.trim()) {
      setErr('Street address is required.');
      return;
    }
    setBusy(true);
    try {
      const body = {
        street: form.street.trim(),
        bin_count: Number(form.bin_count) || 1,
      };
      if (form.phone.trim()) body.phone = form.phone.trim();
      if (form.email.trim()) body.email = form.email.trim();
      if (form.name.trim()) body.name = form.name.trim();
      if (form.scheduled_for) body.scheduled_for = form.scheduled_for;
      const r = await fetch('/api/operator/job', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        if (r.status === 401) {
          throw new Error('Session expired — sign in again to create jobs.');
        }
        const j = await r.json().catch(() => ({}));
        // Field errors (e.g. a bad date) come back as {errors:{field:[msg]}}.
        const fieldErr = j.errors && Object.values(j.errors).flat()[0];
        throw new Error(fieldErr || j.message || j.status || `${r.status}`);
      }
      const created = await r.json().catch(() => ({}));
      setForm(emptyForm);
      setOpen(false);
      onCreated(created);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="btn btn-primary ops-btn" style={{ width: '100%', marginBottom: 12 }} onClick={() => setOpen(true)}>
        + New job here
      </button>
    );
  }

  const field = { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(0,0,0,0.15)', fontSize: 15, marginBottom: 8 };
  const chip = (active) => ({
    padding: '7px 10px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
    border: active ? '2px solid #1f7a1f' : '1px solid rgba(0,0,0,0.15)',
    background: active ? 'var(--green-soft, #eef6ef)' : '#fff',
    fontWeight: active ? 600 : 400,
  });
  return (
    <div className="ops-card" style={{ marginBottom: 12 }}>
      <h2 style={{ marginTop: 0, fontSize: 17 }}>New job at this address</h2>
      <Flash kind="err" text={err} />
      <input style={field} placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <input style={field} placeholder="Street address *" value={form.street} onChange={(e) => setForm({ ...form, street: e.target.value })} />
      <input style={field} type="tel" inputMode="tel" placeholder="Phone number" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
      <select style={field} value={form.bin_count} onChange={(e) => setForm({ ...form, bin_count: e.target.value })}>
        <option value={1}>1 bin</option>
        <option value={2}>2 bins</option>
        <option value={3}>3 bins</option>
      </select>
      <input style={field} type="email" inputMode="email" placeholder="Email (optional — for receipt &amp; photos)" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />

      <label style={{ display: 'block', fontSize: 13, color: 'var(--ink-3, #6b6b6b)', marginBottom: 6 }}>
        When?
      </label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {[
          ['', 'Today'],
          [isoPlusDays(today, 7), 'In 1 week'],
          [isoPlusDays(today, 14), 'In 2 weeks'],
        ].map(([value, label]) => (
          <button
            key={label}
            type="button"
            disabled={busy}
            onClick={() => setForm({ ...form, scheduled_for: value })}
            style={chip(form.scheduled_for === value)}
          >{label}</button>
        ))}
      </div>
      <input
        style={field}
        type="date"
        min={today}
        value={form.scheduled_for}
        onChange={(e) => setForm({ ...form, scheduled_for: e.target.value })}
      />
      {isFuture && (
        <div style={{ fontSize: 12, color: 'var(--ink-3, #6b6b6b)', marginTop: -2, marginBottom: 8 }}>
          Booked for {formatDate(form.scheduled_for)} — it'll show under <strong>All upcoming</strong>, not today's route.
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-go ops-btn" disabled={busy} onClick={submit}>
          {busy ? 'Saving…' : isFuture ? 'Book job' : 'Start job'}
        </button>
        <button className="btn btn-ghost ops-btn" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

// Details typed one-handed at a gate get typos, and customers often decide to
// give an email only after the job is done. Read-only until opened.
function EditCustomerCard({ stop, onSaved, onClose }) {
  const [form, setForm] = useState({
    name: stop.customer_name || '', street: stop.street || '',
    phone: stop.phone || '', email: '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function save() {
    if (busy) return;
    setErr('');
    if (!form.street.trim()) { setErr('Street address is required.'); return; }
    setBusy(true);
    try {
      const body = { customer_id: stop.customer_id };
      if (form.name.trim()) body.name = form.name.trim();
      if (form.street.trim()) body.street = form.street.trim();
      body.phone = form.phone.trim();
      if (form.email.trim()) body.email = form.email.trim();
      const r = await fetch('/api/operator/customer', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || j.status || `${r.status}`);
      onSaved();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  const f = { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(0,0,0,0.15)', fontSize: 15, marginBottom: 8 };
  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed rgba(0,0,0,0.12)' }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Fix these details</div>
      <Flash kind="err" text={err} />
      <input style={f} placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <input style={f} placeholder="Street address *" value={form.street} onChange={(e) => setForm({ ...form, street: e.target.value })} />
      <input style={f} type="tel" inputMode="tel" placeholder="Phone number" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
      <input style={f} type="email" inputMode="email" placeholder="Add an email (for receipt &amp; photos)" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-go ops-btn" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save details'}</button>
        <button className="btn btn-ghost ops-btn" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

function StopCard({ stop, onAction, onRefresh, busy, showDate }) {
  const isDone = stop.status === 'done';
  const isCancelled = stop.status === 'cancelled';
  const isSkipped = stop.status === 'skipped';
  const heading = stop.status === 'heading_there';
  const binCount = stop.bin_count || 1;
  const binsLabel = stop.bin_count ? `${stop.bin_count} bin${stop.bin_count > 1 ? 's' : ''}` : 'bins —';
  const [discount, setDiscount] = useState('');
  const [payMethod, setPayMethod] = useState('card_on_file');
  const [amountOverride, setAmountOverride] = useState('');
  // On-the-spot extra for a bin in a genuinely bad state. The reason is
  // mandatory because it prints on the customer's receipt.
  const [surcharge, setSurcharge] = useState('');
  const [surchargeReason, setSurchargeReason] = useState('');
  // A Done with photos genuinely takes 5-10s: ~1MB of images upload over mobile
  // data, then the server builds the wash animation (7-13s on real photos). It
  // can't move to the background — Vercel freezes the function once it responds.
  // So the button has to SAY it's working, or the operator assumes he missed it
  // and taps again.
  const [submitting, setSubmitting] = useState(false);
  const [editing, setEditing] = useState(false);
  // One before/after pair per bin. bin 0 is the "hero" pair — it's the one
  // the server turns into the wash-GIF animation; bins 1+ always ride along
  // as plain before/after photos (see lib/operator-handlers.ts).
  const idlePhoto = () => ({ phase: 'idle', photo: null, filename: '', message: '' });
  const [bins, setBins] = useState(() => {
    const saved = savedPhotos(stop.id);
    const restore = (entry) =>
      entry ? { phase: 'ready', photo: entry.photo, filename: entry.filename, message: 'Photo restored.' } : idlePhoto();
    return Array.from({ length: binCount }, (_, i) => ({
      before: restore(saved?.bins?.[i]?.before),
      after: restore(saved?.bins?.[i]?.after),
    }));
  });
  // 'unpaid' is the default for every not-yet-serviced visit — showing it
  // pre-completion would paint the whole route red before the operator has
  // done anything. Only meaningful once the visit is done and still unpaid.
  const pay = stop.payment_status === 'unpaid' && !isDone ? null : PAY_BADGE[stop.payment_status];

  function setBinPhoto(binIndex, kind, next) {
    setBins((prev) => {
      const updated = prev.slice();
      updated[binIndex] = { ...updated[binIndex], [kind]: next };
      return updated;
    });
  }

  async function doneWithDiscount() {
    if (submitting) return; // guard the impatient double-tap
    const missingAfter = bins.findIndex((b) => !b.after.photo);
    if (missingAfter !== -1) {
      setBinPhoto(missingAfter, 'after', {
        ...bins[missingAfter].after,
        phase: 'error',
        message: binCount > 1 ? `Take Bin ${missingAfter + 1}'s after photo before tapping Done.` : 'Take a clean-bin photo before tapping Done.',
      });
      return;
    }
    // No before photo means no wash animation (bin 1) or no proof shot (other
    // bins) in the customer's email — that is sometimes intentional, but
    // never let it happen silently.
    if (bins.some((b) => !b.before.photo)) {
      const proceed = window.confirm(
        binCount > 1
          ? "One or more bins is missing a BEFORE photo — the customer's email will show only that bin's after photo, and bin 1 loses the wash animation if it's the one missing.\n\nTap Cancel to add the missing photo(s), or OK to finish without them."
          : 'No BEFORE photo (Step 1) — the customer will NOT get the leprechaun wash animation, just the plain after photo.\n\nTap Cancel to add the before photo, or OK to finish without it.',
      );
      if (!proceed) return;
    }
    const dollars = parseFloat(discount);
    const discount_cents = Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : 0;
    const payload = {
      discount_cents,
      payment_method: payMethod,
      photos: bins.map((b) => ({ before: b.before.photo || undefined, after: b.after.photo })),
    };
    const amt = parseFloat(amountOverride);
    if (Number.isFinite(amt) && amt > 0) payload.amount_cents = Math.round(amt * 100);
    const sur = parseFloat(surcharge);
    if (Number.isFinite(sur) && sur > 0) {
      if (!surchargeReason.trim()) {
        window.alert('Add a short reason for the extra charge — the customer sees it on their receipt.');
        return;
      }
      payload.surcharge_cents = Math.round(sur * 100);
      payload.surcharge_reason = surchargeReason.trim();
    }
    setSubmitting(true);
    let result;
    try {
      result = await onAction('done', stop, payload);
    } finally {
      setSubmitting(false);
    }
    // onAction swallows errors and returns undefined on failure (and on a 401),
    // so a falsy result means the Done did NOT go through — keep the persisted
    // photos so the operator can retry without re-shooting them in the field.
    if (!result) return;
    clearPhotos(stop.id);
    // Any QR result is surfaced by OpsApp (lifted state — see QrPanel), not
    // here: this card is about to unmount when the list reloads to drop the
    // now-done visit, so state kept on THIS component would vanish with it.
  }

  async function onBinPhotoChange(binIndex, kind, e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setBinPhoto(binIndex, kind, { phase: 'loading', photo: null, filename: file.name, message: 'Preparing photo…' });
    try {
      const filename = kind === 'before' ? 'before-bin.jpg' : 'clean-bin.jpg';
      const photo = await prepareCleanPhoto(file, filename);
      persistBinPhoto(stop.id, binIndex, kind, photo, file.name);
      setBinPhoto(binIndex, kind, { phase: 'ready', photo, filename: file.name, message: 'Photo ready.' });
    } catch (err) {
      setBinPhoto(binIndex, kind, {
        phase: 'error',
        photo: null,
        filename: file.name,
        message: err.message || 'Could not prepare photo.',
      });
    }
  }

  return (
    <div className="ops-card">
      <div className="ops-card-head">
        <div>
          {showDate && <div className="ops-date">{formatDate(stop.scheduled_for)}</div>}
          <div className="ops-name">{stop.customer_name}</div>
          <div className="ops-addr">{addressOf(stop)}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <span className={`visit-status ${stop.status}`}>{stop.status.replace('_', ' ')}</span>
          {pay && (
            <span className="visit-status" style={{ background: pay.bg, color: pay.color }}>{pay.label}</span>
          )}
        </div>
      </div>

      <div className="ops-meta">
        <span>{binsLabel}</span>
        {stop.bin_location && <span>📍 {BIN_LOCATION_LABEL[stop.bin_location] || stop.bin_location}</span>}
        {stop.phone && <a className="ops-phone" href={`tel:${stop.phone}`}>{stop.phone}</a>}
        {/* Referral credit comes off automatically at Done. Surfaced here so a
            smaller-than-expected charge is never a surprise after the fact. */}
        {stop.credit_cents > 0 && !isDone && (
          <span style={{ color: '#1f7a1f', fontWeight: 600 }}>
            💳 ${(stop.credit_cents / 100).toFixed(2)} credit applies
          </span>
        )}
      </div>

      {stop.notes && <div className="ops-notes">{stop.notes}</div>}

      {!isDone && !isCancelled && bins.map((bin, i) => (
        <React.Fragment key={i}>
          <PhotoStep
            n={i * 2 + 1}
            title={binCount > 1 ? `Bin ${i + 1} — Before photo` : 'Before photo'}
            hint={
              i === 0
                ? 'Snap the dirty bin when you arrive — this is what makes the wash animation.'
                : `Snap this bin dirty, before you clean it.`
            }
            state={bin.before}
            onChange={(e) => onBinPhotoChange(i, 'before', e)}
            busy={busy}
          />
          <PhotoStep
            n={i * 2 + 2}
            title={binCount > 1 ? `Bin ${i + 1} — After photo` : 'After photo'}
            hint={i === 0 ? 'Snap the clean bin. Required to finish.' : 'Snap this bin clean. Required to finish.'}
            state={bin.after}
            onChange={(e) => onBinPhotoChange(i, 'after', e)}
            busy={busy}
          />
        </React.Fragment>
      ))}

      {!isDone && !isCancelled && (
        <div className="ops-pay" style={{ marginTop: 12 }}>
          <label style={{ display: 'block', fontSize: 13, color: 'var(--ink-3, #6b6b6b)', marginBottom: 6 }}>
            How are they paying?
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {[
              ['card_on_file', '💳 Card on file'],
              ['qr', '📱 QR code'],
              ['terminal', '🔖 Tap in Stripe'],
              ['cash', '💵 Cash'],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                disabled={busy}
                onClick={() => setPayMethod(value)}
                style={{
                  padding: '7px 10px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
                  border: payMethod === value ? '2px solid #1f7a1f' : '1px solid rgba(0,0,0,0.15)',
                  background: payMethod === value ? 'var(--green-soft, #eef6ef)' : '#fff',
                  fontWeight: payMethod === value ? 600 : 400,
                }}
              >{label}</button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <label style={{ fontSize: 13, color: 'var(--ink-3, #6b6b6b)' }}>Amount&nbsp;$</label>
            <input
              type="number" min="0" max="1000" step="1" inputMode="decimal" placeholder="auto"
              value={amountOverride} onChange={(e) => setAmountOverride(e.target.value)}
              style={{ width: 90, padding: '6px 8px', borderRadius: 8, border: '1px solid rgba(0,0,0,0.15)', fontSize: 15 }}
            />
            <span style={{ fontSize: 12, color: 'var(--ink-3, #6b6b6b)' }}>blank = standard price</span>
          </div>

          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed rgba(0,0,0,0.12)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ fontSize: 13, color: 'var(--ink-3, #6b6b6b)' }}>Extra&nbsp;$</label>
              <input
                type="number" min="0" max="500" step="1" inputMode="decimal" placeholder="0"
                value={surcharge} onChange={(e) => setSurcharge(e.target.value)}
                style={{ width: 90, padding: '6px 8px', borderRadius: 8, border: '1px solid rgba(0,0,0,0.15)', fontSize: 15 }}
              />
              <span style={{ fontSize: 12, color: 'var(--ink-3, #6b6b6b)' }}>for a really bad bin</span>
            </div>
            {parseFloat(surcharge) > 0 && (
              <div style={{ marginTop: 8 }}>
                <input
                  type="text" maxLength={200}
                  placeholder="Why? e.g. maggots, caked-on food — needed a second pass"
                  value={surchargeReason} onChange={(e) => setSurchargeReason(e.target.value)}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(0,0,0,0.15)', fontSize: 14 }}
                />
                <div style={{ fontSize: 12, color: 'var(--ink-3, #6b6b6b)', marginTop: 4 }}>
                  Required — this prints on their receipt so the extra isn't a surprise.
                </div>
              </div>
            )}
          </div>
          {payMethod === 'terminal' && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ink-3, #6b6b6b)' }}>
              <a
                href="https://dashboard.stripe.com/payments"
                target="_blank"
                rel="noopener"
                style={{ color: '#1d7a3d', fontWeight: 600 }}
              >Open Stripe app to tap →</a>
              <div>Collect there, then tap Done here to record it.</div>
            </div>
          )}
        </div>
      )}

      {!isDone && !isCancelled && (
        <div className="ops-discount" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
          <label style={{ fontSize: 13, color: 'var(--ink-3, #6b6b6b)' }}>Discount&nbsp;$</label>
          <input
            type="number" min="0" step="1" inputMode="decimal" placeholder="0"
            value={discount} onChange={(e) => setDiscount(e.target.value)}
            style={{ width: 80, padding: '6px 8px', borderRadius: 8, border: '1px solid rgba(0,0,0,0.15)', fontSize: 15 }}
          />
          <span style={{ fontSize: 12, color: 'var(--ink-3, #6b6b6b)' }}>applied when you tap Done</span>
        </div>
      )}

      <div className="ops-actions">
        {!isDone && !isCancelled && (
          <button
            className="btn btn-primary ops-btn"
            disabled={busy}
            onClick={() => {
              // Open directions synchronously in the tap handler (popup
              // blockers kill window.open from async callbacks), then notify.
              const dest = encodeURIComponent(addressOf(stop));
              window.open(`https://www.google.com/maps/dir/?api=1&destination=${dest}`, '_blank', 'noopener');
              onAction('notify', stop);
            }}
          >
            {heading ? 'Resend “on my way”' : 'On my way'}
          </button>
        )}
        {!isDone && !isCancelled && (
          <button
            className="btn btn-go ops-btn"
            disabled={busy || submitting || bins.some((b) => b.before.phase === 'loading' || b.after.phase === 'loading' || !b.after.photo)}
            onClick={doneWithDiscount}
            style={submitting ? { opacity: 0.85 } : undefined}
          >
            {submitting ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <span className="ops-spinner" aria-hidden="true" />
                Finishing…
              </span>
            ) : 'Done'}
          </button>
        )}
        {!isDone && !isCancelled && !isSkipped && (
          <button className="btn btn-skip ops-btn" disabled={busy || submitting} onClick={() => onAction('skip', stop)}>Skip</button>
        )}
        <button className="btn btn-ghost ops-btn" disabled={busy || submitting} onClick={() => onAction('note', stop)}>Note</button>
        {!isDone && !isCancelled && (
          <button className="btn btn-ghost ops-btn" disabled={busy || submitting} onClick={() => setEditing(!editing)}>
            {editing ? 'Close' : 'Edit details'}
          </button>
        )}
      </div>

      {editing && (
        <EditCustomerCard
          stop={stop}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); onRefresh(); }}
        />
      )}

      {submitting && (
        <div style={{ marginTop: 10, fontSize: 13, color: 'var(--ink-3, #6b6b6b)' }}>
          Sending the photos and building the wash animation — this takes a few
          seconds. Don't close the page.
        </div>
      )}
    </div>
  );
}

// QR result lives in OpsApp state (not the StopCard that created it) so it
// survives the list reload that happens right after Done — see B1: the
// just-completed visit drops out of the actionable list and its StopCard
// unmounts, which used to take the QR with it before the customer ever saw it.
function QrPanel({ qr, onDismiss }) {
  if (!qr) return null;
  return (
    <div className="ops-card" style={{ textAlign: 'center', border: '1px solid #cde3cd', background: '#f7fbf7' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', textAlign: 'left' }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Have {qr.customerName} scan to pay</div>
          <div style={{ fontSize: 12, color: 'var(--ink-3, #6b6b6b)' }}>{qr.address}</div>
        </div>
        <button className="btn-ghost" style={{ padding: 0 }} onClick={onDismiss} aria-label="Dismiss">×</button>
      </div>
      {qr.svg
        ? <div style={{ display: 'flex', justifyContent: 'center', marginTop: 8 }} dangerouslySetInnerHTML={{ __html: qr.svg }} />
        : <div style={{ fontSize: 12, marginTop: 8 }}>QR unavailable — use the link below.</div>}
      <div style={{ marginTop: 8, fontSize: 12 }}>
        <a href={qr.url} target="_blank" rel="noopener" style={{ color: '#1d7a3d' }}>or open the payment link</a>
      </div>
    </div>
  );
}

// A finished job. Read-only on purpose: history is for looking things up, not
// for re-doing work — an action button here would be a way to accidentally
// re-charge a customer weeks later.
const HISTORY_STATUS_STYLE = {
  done: { label: '✓ done', color: '#1f7a1f', bg: 'var(--green-soft, #dfece1)' },
  skipped: { label: 'skipped', color: '#7a5a12', bg: '#FBF0D5' },
  cancelled: { label: 'cancelled', color: '#5a4632', bg: 'var(--cream-2, #f3efe6)' },
};

function HistoryCard({ item }) {
  const st = HISTORY_STATUS_STYLE[item.status] || HISTORY_STATUS_STYLE.done;
  const pay = PAY_BADGE[item.payment_status];
  const bins = item.bin_count ? `${item.bin_count} bin${item.bin_count > 1 ? 's' : ''}` : null;
  // Only meaningful on a job that actually settled.
  const collected = item.amount_cents != null ? `$${(item.amount_cents / 100).toFixed(2)}` : null;

  return (
    <div className="ops-card">
      <div className="ops-card-head">
        <div>
          <div className="ops-date">{formatDate(item.scheduled_for)}</div>
          <div className="ops-name">{item.customer_name}</div>
          <div className="ops-addr">{addressOf(item)}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <span className="visit-status" style={{ background: st.bg, color: st.color }}>{st.label}</span>
          {item.status === 'done' && pay && (
            <span className="visit-status" style={{ background: pay.bg, color: pay.color }}>{pay.label}</span>
          )}
        </div>
      </div>
      <div className="ops-meta">
        {bins && <span>{bins}</span>}
        {collected && <span>{collected} collected</span>}
        {item.credit_cents > 0 && <span>incl. ${(item.credit_cents / 100).toFixed(2)} credit</span>}
        {item.phone && <a className="ops-phone" href={`tel:${item.phone}`}>{item.phone}</a>}
      </div>
      {item.notes && <div className="ops-notes">{item.notes}</div>}
    </div>
  );
}

// Distinct badge per underlying payment_status — a QR nobody scanned yet and
// a walk-up with no card at all are not "card failed" (see N2).
const ATTENTION_BADGE = {
  failed: { label: '⚠ card failed', color: '#7A2222', bg: '#F5DADA' },
  awaiting_payment: { label: '⏳ waiting on payment', color: '#7a5a12', bg: '#FBF0D5' },
  unpaid: { label: '⚠ not collected', color: '#7A2222', bg: '#F5DADA' },
};

function AttentionCard({ item, onAction, busy }) {
  const amt = item.amount_cents != null ? `$${(item.amount_cents / 100).toFixed(2)}` : '—';
  const badge = ATTENTION_BADGE[item.payment_status] || ATTENTION_BADGE.unpaid;
  // Retry only makes sense for a genuinely declined card that still has a
  // card on file — a QR nobody scanned or a walk-up with nothing on file
  // would just 409 (see N2).
  const canRetry = item.payment_status === 'failed' && item.has_card;
  return (
    <div className="ops-card">
      <div className="ops-card-head">
        <div>
          <div className="ops-date">{formatDate(item.scheduled_for)}</div>
          <div className="ops-name">{item.customer.name}</div>
          <div className="ops-addr">{addressOf(item.customer)}</div>
        </div>
        <span className="visit-status" style={{ background: badge.bg, color: badge.color }}>{badge.label}</span>
      </div>
      <div className="ops-meta">
        <span>Owed {amt}</span>
        {item.customer.phone && <a className="ops-phone" href={`tel:${item.customer.phone}`}>{item.customer.phone}</a>}
      </div>
      {item.failure_reason && <div className="ops-notes">{item.failure_reason}</div>}
      <div className="ops-actions">
        {canRetry ? (
          <button className="btn btn-primary ops-btn" disabled={busy} onClick={() => onAction('retry', item)}>
            Retry charge
          </button>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--ink-3, #6b6b6b)' }}>
            {item.payment_status === 'awaiting_payment' ? 'Waiting on the customer to scan.' : 'Collect at the door.'}
          </div>
        )}
      </div>
    </div>
  );
}

// Spring restart. Bookings stop at Oct 31; this books the new season for every
// active plan and emails those customers. Lives behind a confirm because it
// touches every subscriber at once — though it is safe to run twice (a plan
// that already has visits this season is skipped, and the email is idempotent).
function SeasonOpenCard() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');

  async function open() {
    if (busy) return;
    if (!window.confirm(
      'Open the new cleaning season?\n\nThis books visits for every active plan and emails those customers that we are back. Safe to run more than once.',
    )) return;
    setBusy(true);
    setResult('');
    try {
      const r = await fetch('/api/operator/season', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b.message || `${r.status}`);
      setResult(
        b.visits_created > 0
          ? `Season opened — ${b.visits_created} cleans booked across ${b.subscriptions_opened} plan(s). Customers emailed.`
          : `Nothing to book — all ${b.subscriptions_opened} active plan(s) already have this season's cleans.`,
      );
    } catch (e) {
      setResult(`Could not open the season: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ops-card" style={{ marginBottom: 12 }}>
      <h2 style={{ marginTop: 0, fontSize: 17 }}>Start of season</h2>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Cleaning runs May 1 – Oct 31. Tap this in the spring once the ground has
        thawed — it books the new season for every active plan and emails those
        customers.
      </p>
      <button className="btn btn-primary ops-btn" disabled={busy} onClick={open}>
        {busy ? 'Opening…' : 'Open the new season'}
      </button>
      {result && <div style={{ marginTop: 10, fontSize: 13 }}>{result}</div>}
    </div>
  );
}

function OpsApp() {
  const [authed, setAuthed] = useState(null); // null = unknown, true, false
  const [view, setView] = useState('today'); // 'today' | 'upcoming' | 'attention'
  const [data, setData] = useState({ loading: true, stops: [], date: null });
  const [flash, setFlash] = useState({ kind: '', text: '' });
  const [busy, setBusy] = useState(false);
  // QR from the most recent Done tap — lifted up here (not in StopCard) so it
  // survives the list reload that follows every Done. See QrPanel.
  const [qr, setQr] = useState(null);

  const load = useCallback(async (which) => {
    setData((d) => ({ ...d, loading: true }));
    const url =
      which === 'upcoming' ? '/api/operator/upcoming'
      : which === 'attention' ? '/api/operator/attention'
      : which === 'history' ? '/api/operator/history'
      : '/api/operator/today';
    try {
      const r = await fetch(url, { credentials: 'same-origin' });
      if (r.status === 401) {
        setAuthed(false);
        setData({ loading: false, stops: [], date: null });
        return;
      }
      const b = await r.json();
      if (!r.ok) throw new Error(b.message || 'Could not load.');
      setAuthed(true);
      setData({ loading: false, stops: b.visits || [], date: b.date || null, hasMore: !!b.has_more });
    } catch (e) {
      setData({ loading: false, stops: [], date: null });
      setFlash({ kind: 'err', text: e.message });
    }
  }, []);

  useEffect(() => {
    load(view);
  }, [load, view]);

  // A stale QR panel must not follow the operator across tabs — clear it on
  // every view change so switching away from (or back to) Today can't leave
  // a previous customer's live payment link on screen (see N5).
  useEffect(() => {
    setQr(null);
  }, [view]);

  async function onAction(action, stop, opts = {}) {
    setBusy(true);
    setFlash({ kind: '', text: '' });
    try {
      // All visit actions go through the single-segment /api/operator/act route
      // (id + op in the body) — multi-segment operator URLs 404 in Vercel's runtime.
      const body = { id: stop.id, op: action };
      if (action === 'note') {
        const text = window.prompt(`Add a note for ${stop.customer_name}:`, '');
        if (!text || !text.trim()) {
          setBusy(false);
          return;
        }
        body.text = text.trim();
      }
      if (action === 'done' && opts.discount_cents > 0) {
        body.discount_cents = opts.discount_cents;
      }
      // This field must be forwarded explicitly — it's the exact allow-list
      // that silently dropped before_photo in the past (2026-07-25 P0: the
      // before photo never left the browser because it wasn't in this list).
      // One entry per bin; the server combines bin 0's before+after into the
      // leprechaun wash animation GIF, so a missing bin-0 photo silently
      // disables the animation for that Done.
      if (action === 'done' && opts.photos) {
        body.photos = opts.photos;
      }
      if (action === 'done' && opts.payment_method) {
        body.payment_method = opts.payment_method;
      }
      if (action === 'done' && opts.amount_cents) {
        body.amount_cents = opts.amount_cents;
      }

      const r = await fetch('/api/operator/act', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.status === 401) {
        setAuthed(false);
        return;
      }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || j.status || `${r.status}`);

      if (action === 'notify') {
        setFlash({ kind: 'ok', text: j.skipped ? `${stop.customer_name} was already notified.` : `Notified ${stop.customer_name}.` });
      } else if (action === 'done') {
        // Surface the charge outcome alongside the "done" confirmation.
        let chargeNote = '';
        const c = j.charge;
        // QR is the exception: charge.ok only means "Stripe session created",
        // NOT that the customer has paid. Never tell the operator money
        // arrived until the webhook confirms it. Guard on payment_url too —
        // if Stripe hiccuped and createDoorstepCheckoutSession returned null,
        // there's no code to scan, so fall through to nothing_collected
        // instead of sending the operator to show a nonexistent QR.
        if (opts.payment_method === 'qr' && j.payment_url) chargeNote = ' Awaiting payment — have them scan the code.';
        else if (j.nothing_collected) chargeNote = ' ⚠ Nothing collected — no card on file. Settle with cash or QR.';
        else if (c?.attempted && c.ok && c.amount_cents > 0) chargeNote = ` Charged $${(c.amount_cents / 100).toFixed(2)}.`;
        else if (c?.attempted && c.ok && c.amount_cents === 0) chargeNote = ' Comped.';
        else if (c?.attempted && !c.ok) chargeNote = ' ⚠ Card declined — collect another way.';
        const next = j.next_visit_date ? `next clean ${formatDate(j.next_visit_date)}.` : 'no more scheduled cleans.';
        const troubled = (c?.attempted && !c.ok) || j.nothing_collected;
        setFlash({ kind: troubled ? 'err' : 'ok', text: `Done — ${next}${chargeNote}` });
        // Lifted out of StopCard: the visit is about to drop out of the
        // actionable list on reload below, which would unmount the card (and
        // the QR with it) before the operator could show the customer.
        if (j.payment_url) {
          setQr({
            visitId: stop.id,
            url: j.payment_url,
            svg: j.payment_qr_svg || '',
            customerName: stop.customer_name,
            address: addressOf(stop),
          });
        } else {
          // No code on this Done — clear any stale panel from a PREVIOUS
          // customer's QR. Otherwise it stays pinned on screen and the next
          // customer's scan could post against the wrong visit (see N5).
          setQr(null);
        }
      } else if (action === 'skip') {
        setFlash({ kind: 'ok', text: `Skipped ${stop.customer_name}.` });
      } else if (action === 'note') {
        setFlash({ kind: 'ok', text: 'Note saved.' });
      } else if (action === 'retry') {
        const c = j.charge;
        setFlash({
          kind: c?.ok ? 'ok' : 'err',
          text: c?.ok
            ? `Charged $${(c.amount_cents / 100).toFixed(2)} — paid up.`
            : `Still declined${c?.error ? ': ' + c.error : ''}.`,
        });
      }
      await load(view);
      return j;
    } catch (e) {
      setFlash({ kind: 'err', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  if (authed === null) {
    return (
      <div className="ops-shell">
        <div className="ops-card"><p>Loading…</p></div>
      </div>
    );
  }

  if (authed === false) {
    return (
      <div className="ops-shell">
        <div className="ops-header">
          <h1>Operator</h1>
          <a className="brand" href="/">Lucky Shamrock</a>
        </div>
        <PasswordGate onAuthed={() => { setAuthed(true); load(view); }} />
      </div>
    );
  }

  return (
    <div className="ops-shell">
      <div className="ops-header">
        <h1>{
          view === 'today' ? "Today's route"
          : view === 'attention' ? 'Needs attention'
          : view === 'history' ? 'History'
          : 'All upcoming'
        }</h1>
        <a className="brand" href="/">Lucky Shamrock</a>
      </div>

      <div className="ops-toggle">
        <button className={view === 'today' ? 'active' : ''} onClick={() => setView('today')}>
          Today{data.date && view === 'today' ? ` · ${formatDate(data.date)}` : ''}
        </button>
        <button className={view === 'upcoming' ? 'active' : ''} onClick={() => setView('upcoming')}>
          All upcoming
        </button>
        <button className={view === 'attention' ? 'active' : ''} onClick={() => setView('attention')}>
          Needs attention
        </button>
        <button className={view === 'history' ? 'active' : ''} onClick={() => setView('history')}>
          History
        </button>
      </div>

      <div style={{ textAlign: 'right', margin: '-4px 0 10px' }}>
        <a
          href="/ops/help.html"
          style={{ fontSize: 13, color: 'var(--green, #1d7a3d)', fontWeight: 600, textDecoration: 'none' }}
        >
          Operator field card →
        </a>
      </div>

      <Flash kind={flash.kind} text={flash.text} onDismiss={() => setFlash({ kind: '', text: '' })} />

      {view === 'history' && <SeasonOpenCard />}

      {view === 'today' && (
        <NewJobCard
          onCreated={(created) => {
            // A future-dated job lands in "All upcoming", so it will NOT appear
            // in the list that reloads under this card — say so explicitly
            // rather than letting the operator wonder if it saved.
            const when = created?.scheduled_for;
            if (when && when > todayISO()) {
              // Say plainly whether the customer got written confirmation —
              // if not (no email given, or the send failed), the operator
              // should tell them the date out loud before driving off.
              const mailed = created.confirmation_sent
                ? ' Confirmation emailed.'
                : ' ⚠ No confirmation email sent — tell them the date.';
              setFlash({ kind: 'ok', text: `Job booked for ${formatDate(when)} — find it under “All upcoming.”${mailed}` });
            } else {
              setFlash({ kind: 'ok', text: 'Job created — it’s on today’s route.' });
            }
            load(view);
          }}
        />
      )}

      <QrPanel qr={qr} onDismiss={() => setQr(null)} />

      {data.loading ? (
        <div className="ops-card"><p>Loading…</p></div>
      ) : data.stops.length === 0 ? (
        <div className="ops-card">
          <p className="muted">
            {view === 'today' ? 'No stops scheduled today.'
              : view === 'attention' ? 'Nothing needs attention — all paid up. 🍀'
              : view === 'history' ? 'No finished jobs yet — completed cleans show up here.'
              : 'Nothing booked after today.'}
          </p>
        </div>
      ) : view === 'attention' ? (
        data.stops.map((s) => (
          <AttentionCard key={s.id} item={s} onAction={onAction} busy={busy} />
        ))
      ) : view === 'history' ? (
        <>
          {data.stops.map((s) => <HistoryCard key={s.id} item={s} />)}
          {data.hasMore && (
            <div className="ops-card" style={{ textAlign: 'center' }}>
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                Showing the {data.stops.length} most recent. Older jobs aren't shown yet.
              </p>
            </div>
          )}
        </>
      ) : (
        data.stops.map((s) => (
          <StopCard key={s.id} stop={s} onAction={onAction} onRefresh={() => load(view)} busy={busy} showDate={view === 'upcoming'} />
        ))
      )}
    </div>
  );
}

// Expose to the app entry
window.OpsApp = OpsApp;
