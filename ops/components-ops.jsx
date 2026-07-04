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

const PAY_BADGE = {
  charged: { label: '💳 paid', color: '#1f7a1f', bg: 'var(--green-soft, #dfece1)' },
  failed: { label: '⚠ card failed', color: '#7A2222', bg: '#F5DADA' },
  comped: { label: 'comped', color: '#5a4632', bg: 'var(--cream-2, #f3efe6)' },
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

function StopCard({ stop, onAction, busy, showDate }) {
  const isDone = stop.status === 'done';
  const isCancelled = stop.status === 'cancelled';
  const isSkipped = stop.status === 'skipped';
  const heading = stop.status === 'heading_there';
  const bins = stop.bin_count ? `${stop.bin_count} bin${stop.bin_count > 1 ? 's' : ''}` : 'bins —';
  const [discount, setDiscount] = useState('');
  const [photoState, setPhotoState] = useState({ phase: 'idle', photo: null, filename: '', message: '' });
  const [beforeState, setBeforeState] = useState({ phase: 'idle', photo: null, filename: '', message: '' });
  const pay = PAY_BADGE[stop.payment_status];

  function doneWithDiscount() {
    if (!photoState.photo) {
      setPhotoState((s) => ({ ...s, phase: 'error', message: 'Take a clean-bin photo before tapping Done.' }));
      return;
    }
    const dollars = parseFloat(discount);
    const discount_cents = Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : 0;
    const payload = { discount_cents, clean_photo: photoState.photo };
    // Optional before shot → customer gets the side-by-side card in the email.
    if (beforeState.photo) payload.before_photo = beforeState.photo;
    onAction('done', stop, payload);
  }

  async function onPhotoChange(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setPhotoState({ phase: 'loading', photo: null, filename: file.name, message: 'Preparing photo…' });
    try {
      const photo = await prepareCleanPhoto(file);
      setPhotoState({ phase: 'ready', photo, filename: file.name, message: 'Photo ready.' });
    } catch (err) {
      setPhotoState({
        phase: 'error',
        photo: null,
        filename: file.name,
        message: err.message || 'Could not prepare photo.',
      });
    }
  }

  async function onBeforePhotoChange(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setBeforeState({ phase: 'loading', photo: null, filename: file.name, message: 'Preparing photo…' });
    try {
      const photo = await prepareCleanPhoto(file, 'before-bin.jpg');
      setBeforeState({ phase: 'ready', photo, filename: file.name, message: 'Photo ready.' });
    } catch (err) {
      setBeforeState({
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
          <div className="ops-addr">{stop.street}, {stop.city} {stop.postal_code}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <span className={`visit-status ${stop.status}`}>{stop.status.replace('_', ' ')}</span>
          {pay && (
            <span className="visit-status" style={{ background: pay.bg, color: pay.color }}>{pay.label}</span>
          )}
        </div>
      </div>

      <div className="ops-meta">
        <span>{bins}</span>
        {stop.bin_location && <span>📍 {BIN_LOCATION_LABEL[stop.bin_location] || stop.bin_location}</span>}
        {stop.phone && <a className="ops-phone" href={`tel:${stop.phone}`}>{stop.phone}</a>}
      </div>

      {stop.notes && <div className="ops-notes">{stop.notes}</div>}

      {!isDone && !isCancelled && (
        <div className="ops-photo" style={{ marginTop: 12 }}>
          <label style={{ display: 'block', fontSize: 13, color: 'var(--ink-3, #6b6b6b)', marginBottom: 6 }}>
            Before photo (optional — snap when you arrive)
          </label>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            disabled={busy}
            onChange={onBeforePhotoChange}
            style={{ width: '100%' }}
          />
          {beforeState.message && (
            <div style={{
              marginTop: 6,
              fontSize: 12,
              color: beforeState.phase === 'error' ? '#7A2222' : 'var(--ink-3, #6b6b6b)',
            }}>
              {beforeState.filename ? `${beforeState.filename} · ` : ''}{beforeState.message}
            </div>
          )}
        </div>
      )}

      {!isDone && !isCancelled && (
        <div className="ops-photo" style={{ marginTop: 12 }}>
          <label style={{ display: 'block', fontSize: 13, color: 'var(--ink-3, #6b6b6b)', marginBottom: 6 }}>
            Clean-bin photo
          </label>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            disabled={busy}
            onChange={onPhotoChange}
            style={{ width: '100%' }}
          />
          {photoState.message && (
            <div style={{
              marginTop: 6,
              fontSize: 12,
              color: photoState.phase === 'error' ? '#7A2222' : 'var(--ink-3, #6b6b6b)',
            }}>
              {photoState.filename ? `${photoState.filename} · ` : ''}{photoState.message}
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
          <button className="btn btn-primary ops-btn" disabled={busy} onClick={() => onAction('notify', stop)}>
            {heading ? 'Resend “on my way”' : 'On my way'}
          </button>
        )}
        {!isDone && !isCancelled && (
          <button
            className="btn btn-go ops-btn"
            disabled={busy || photoState.phase === 'loading' || beforeState.phase === 'loading' || !photoState.photo}
            onClick={doneWithDiscount}
          >
            Done
          </button>
        )}
        {!isDone && !isCancelled && !isSkipped && (
          <button className="btn btn-skip ops-btn" disabled={busy} onClick={() => onAction('skip', stop)}>Skip</button>
        )}
        <button className="btn btn-ghost ops-btn" disabled={busy} onClick={() => onAction('note', stop)}>Note</button>
      </div>
    </div>
  );
}

function AttentionCard({ item, onAction, busy }) {
  const amt = item.amount_cents != null ? `$${(item.amount_cents / 100).toFixed(2)}` : '—';
  return (
    <div className="ops-card">
      <div className="ops-card-head">
        <div>
          <div className="ops-date">{formatDate(item.scheduled_for)}</div>
          <div className="ops-name">{item.customer.name}</div>
          <div className="ops-addr">{item.customer.street}, {item.customer.city} {item.customer.postal_code}</div>
        </div>
        <span className="visit-status" style={{ background: '#F5DADA', color: '#7A2222' }}>⚠ card failed</span>
      </div>
      <div className="ops-meta">
        <span>Owed {amt}</span>
        {item.customer.phone && <a className="ops-phone" href={`tel:${item.customer.phone}`}>{item.customer.phone}</a>}
      </div>
      {item.failure_reason && <div className="ops-notes">{item.failure_reason}</div>}
      <div className="ops-actions">
        <button className="btn btn-primary ops-btn" disabled={busy || !item.has_card} onClick={() => onAction('retry', item)}>
          {item.has_card ? 'Retry charge' : 'No card on file'}
        </button>
      </div>
    </div>
  );
}

function OpsApp() {
  const [authed, setAuthed] = useState(null); // null = unknown, true, false
  const [view, setView] = useState('today'); // 'today' | 'upcoming' | 'attention'
  const [data, setData] = useState({ loading: true, stops: [], date: null });
  const [flash, setFlash] = useState({ kind: '', text: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (which) => {
    setData((d) => ({ ...d, loading: true }));
    const url =
      which === 'upcoming' ? '/api/operator/upcoming'
      : which === 'attention' ? '/api/operator/attention'
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
      setData({ loading: false, stops: b.visits || [], date: b.date || null });
    } catch (e) {
      setData({ loading: false, stops: [], date: null });
      setFlash({ kind: 'err', text: e.message });
    }
  }, []);

  useEffect(() => {
    load(view);
  }, [load, view]);

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
      if (action === 'done' && opts.clean_photo) {
        body.clean_photo = opts.clean_photo;
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
        if (c?.attempted && c.ok && c.amount_cents > 0) chargeNote = ` Charged $${(c.amount_cents / 100).toFixed(2)}.`;
        else if (c?.attempted && c.ok && c.amount_cents === 0) chargeNote = ' Comped.';
        else if (c?.attempted && !c.ok) chargeNote = ' ⚠ Card declined — collect another way.';
        const next = j.next_visit_date ? `next clean ${formatDate(j.next_visit_date)}.` : 'no more scheduled cleans.';
        setFlash({ kind: c?.attempted && !c.ok ? 'err' : 'ok', text: `Done — ${next}${chargeNote}` });
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
        <h1>{view === 'today' ? "Today's route" : view === 'attention' ? 'Needs attention' : 'All upcoming'}</h1>
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
      </div>

      <Flash kind={flash.kind} text={flash.text} onDismiss={() => setFlash({ kind: '', text: '' })} />

      {data.loading ? (
        <div className="ops-card"><p>Loading…</p></div>
      ) : data.stops.length === 0 ? (
        <div className="ops-card">
          <p className="muted">
            {view === 'today' ? 'No stops scheduled today.'
              : view === 'attention' ? 'No failed charges — all paid up. 🍀'
              : 'Nothing booked after today.'}
          </p>
        </div>
      ) : view === 'attention' ? (
        data.stops.map((s) => (
          <AttentionCard key={s.id} item={s} onAction={onAction} busy={busy} />
        ))
      ) : (
        data.stops.map((s) => (
          <StopCard key={s.id} stop={s} onAction={onAction} busy={busy} showDate={view === 'upcoming'} />
        ))
      )}
    </div>
  );
}

// Expose to the app entry
window.OpsApp = OpsApp;
