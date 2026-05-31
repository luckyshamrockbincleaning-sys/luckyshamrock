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

function StopCard({ stop, onAction, busy, showDate }) {
  const isDone = stop.status === 'done';
  const isCancelled = stop.status === 'cancelled';
  const isSkipped = stop.status === 'skipped';
  const heading = stop.status === 'heading_there';
  const bins = stop.bin_count ? `${stop.bin_count} bin${stop.bin_count > 1 ? 's' : ''}` : 'bins —';

  return (
    <div className="ops-card">
      <div className="ops-card-head">
        <div>
          {showDate && <div className="ops-date">{formatDate(stop.scheduled_for)}</div>}
          <div className="ops-name">{stop.customer_name}</div>
          <div className="ops-addr">{stop.street}, {stop.city} {stop.postal_code}</div>
        </div>
        <span className={`visit-status ${stop.status}`}>{stop.status.replace('_', ' ')}</span>
      </div>

      <div className="ops-meta">
        <span>{bins}</span>
        {stop.phone && <a className="ops-phone" href={`tel:${stop.phone}`}>{stop.phone}</a>}
      </div>

      {stop.notes && <div className="ops-notes">{stop.notes}</div>}

      <div className="ops-actions">
        {!isDone && !isCancelled && (
          <button className="btn btn-primary ops-btn" disabled={busy} onClick={() => onAction('notify', stop)}>
            {heading ? 'Resend “on my way”' : 'On my way'}
          </button>
        )}
        {!isDone && !isCancelled && (
          <button className="btn btn-go ops-btn" disabled={busy} onClick={() => onAction('done', stop)}>Done</button>
        )}
        {!isDone && !isCancelled && !isSkipped && (
          <button className="btn btn-skip ops-btn" disabled={busy} onClick={() => onAction('skip', stop)}>Skip</button>
        )}
        <button className="btn btn-ghost ops-btn" disabled={busy} onClick={() => onAction('note', stop)}>Note</button>
      </div>
    </div>
  );
}

function OpsApp() {
  const [authed, setAuthed] = useState(null); // null = unknown, true, false
  const [view, setView] = useState('today'); // 'today' | 'upcoming'
  const [data, setData] = useState({ loading: true, stops: [], date: null });
  const [flash, setFlash] = useState({ kind: '', text: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (which) => {
    setData((d) => ({ ...d, loading: true }));
    const url = which === 'upcoming' ? '/api/operator/upcoming?days=7' : '/api/operator/today';
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

  async function onAction(action, stop) {
    setBusy(true);
    setFlash({ kind: '', text: '' });
    try {
      let url;
      let body;
      if (action === 'note') {
        const text = window.prompt(`Add a note for ${stop.customer_name}:`, '');
        if (!text || !text.trim()) {
          setBusy(false);
          return;
        }
        url = `/api/operator/visit/${stop.id}/note`;
        body = { text: text.trim() };
      } else {
        url = `/api/operator/visit/${stop.id}/${action}`;
      }

      const r = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
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
        setFlash({ kind: 'ok', text: j.next_visit_date ? `Done — next clean ${formatDate(j.next_visit_date)}.` : 'Done — no more scheduled cleans.' });
      } else if (action === 'skip') {
        setFlash({ kind: 'ok', text: `Skipped ${stop.customer_name}.` });
      } else if (action === 'note') {
        setFlash({ kind: 'ok', text: 'Note saved.' });
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
        <h1>{view === 'today' ? "Today's route" : 'Next 7 days'}</h1>
        <a className="brand" href="/">Lucky Shamrock</a>
      </div>

      <div className="ops-toggle">
        <button className={view === 'today' ? 'active' : ''} onClick={() => setView('today')}>
          Today{data.date && view === 'today' ? ` · ${formatDate(data.date)}` : ''}
        </button>
        <button className={view === 'upcoming' ? 'active' : ''} onClick={() => setView('upcoming')}>
          Next 7 days
        </button>
      </div>

      <Flash kind={flash.kind} text={flash.text} onDismiss={() => setFlash({ kind: '', text: '' })} />

      {data.loading ? (
        <div className="ops-card"><p>Loading…</p></div>
      ) : data.stops.length === 0 ? (
        <div className="ops-card">
          <p className="muted">{view === 'today' ? 'No stops scheduled today.' : 'Nothing scheduled in the next 7 days.'}</p>
        </div>
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
