/* global React, Icon */
const { useState: useStateBk, useMemo, useRef } = React;

// Map UI service id → API plan value
const SERVICE_TO_PLAN = {
  'one-time': 'oneoff',
  'monthly': 'monthly',
  'three-wash': 'seasonal',
};

// ===== Waitlist capture (rendered when /api/book returns 422 out_of_area) =====
function WaitlistCapture({ email, postalCode, message }) {
  const [state, setState] = useStateBk('idle');

  async function joinWaitlist() {
    setState('sending');
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, postal_code: postalCode }),
      });
      setState(res.ok ? 'joined' : 'error');
    } catch {
      setState('error');
    }
  }

  if (state === 'joined') {
    return (
      <div className="booking-success">
        <p>You're on the waitlist. We'll email you when service reaches your area.</p>
      </div>
    );
  }

  return (
    <div className="booking-warning">
      <p>{message}</p>
      <button
        className="btn btn-primary"
        onClick={joinWaitlist}
        disabled={state === 'sending'}
        style={{ marginTop: 12 }}
      >
        {state === 'sending' ? 'Joining…' : 'Notify me when you serve my area'}
      </button>
      {state === 'error' && (
        <p style={{ marginTop: 10, fontSize: 13 }}>
          Couldn't join the waitlist — try again or email us at hello@luckyshamrock.ca.
        </p>
      )}
    </div>
  );
}

// Pickup day-of-week → date-fns-style index (0=Sun..6=Sat)
const PICKUP_DOW = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5 };
const PICKUP_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
const CADENCE_INTERVAL = { monthly: 'every 4 weeks', 'three-wash': '3 cleans a year (spring, summer, fall)' };

// First clean = day after the NEXT pickup-day-of-week strictly after today.
// Mirrors lib/schedule.ts so the preview matches the booking confirmation.
function firstCleanDate(pickupDay) {
  if (!pickupDay) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = PICKUP_DOW[pickupDay];
  let delta = target - today.getDay();
  if (delta <= 0) delta += 7;
  const clean = new Date(today);
  clean.setDate(today.getDate() + delta + 1); // pickup + 1
  return clean;
}

// Seasonal preview: first clean-day (pickup+1) on/after the next Apr/Jul/Sep
// lead month strictly after today. Mirrors lib/schedule.ts generateSeasonalDates.
const SEASON_LEAD_MONTHS = [3, 6, 8]; // Apr, Jul, Sep (0-based)
function firstSeasonalDate(pickupDay) {
  if (!pickupDay) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cleanDow = (PICKUP_DOW[pickupDay] + 1) % 7;
  for (let year = today.getFullYear(); year <= today.getFullYear() + 1; year++) {
    for (const m of SEASON_LEAD_MONTHS) {
      const lead = new Date(year, m, 1);
      let delta = cleanDow - lead.getDay();
      if (delta < 0) delta += 7;
      const wash = new Date(year, m, 1 + delta);
      if (wash.getTime() > today.getTime()) return wash;
    }
  }
  return null;
}

function fmtNice(d) {
  return d ? d.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' }) : '—';
}

let _bookingStripeJsPromise = null;
function loadBookingStripeJs() {
  if (window.Stripe) return Promise.resolve(window.Stripe);
  if (!_bookingStripeJsPromise) {
    _bookingStripeJsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://js.stripe.com/v3/';
      s.onload = () => resolve(window.Stripe);
      s.onerror = () => reject(new Error('Failed to load secure card form.'));
      document.head.appendChild(s);
    });
  }
  return _bookingStripeJsPromise;
}

// ===== Booking flow =====
const Booking = ({ tweaks }) => {
  const [step, setStep] = useStateBk(1);
  const [service, setService] = useStateBk('monthly');
  const [bins, setBins] = useStateBk(1);
  const [selectedDay, setSelectedDay] = useStateBk(null);
  const [contact, setContact] = useStateBk({
    name: '',
    email: '',
    phone: '',
    street: '',
    city: 'Fort Saskatchewan',
    postalCode: '',
    pickupDay: '',
    binLocation: 'side',
  });
  const [submitState, setSubmitState] = useStateBk({ phase: 'idle' });
  const [paymentState, setPaymentState] = useStateBk({ phase: 'idle' });
  const stripeRef = useRef(null);
  const elementsRef = useRef(null);
  const paymentSetupRef = useRef(null);

  // Prices come from the single client source (window.LS_PRICING, loaded from
  // /pricing.js, guarded against lib/pricing.ts by pricing-sync.test.ts). The
  // inline fallback only applies if that script fails to load.
  const P = (typeof window !== 'undefined' && window.LS_PRICING) ||
    { oneoff: 45, monthly: 35, seasonalSeason: 105, seasonalPerWash: 35, extraBinPerClean: 12 };

  const services = [
    { id: 'one-time', title: 'One-Time', meta: 'Try us once', price: P.oneoff },
    { id: 'monthly', title: 'Monthly', meta: 'Every 4 weeks', price: P.monthly },
    { id: 'three-wash', title: 'Three Wash Season', meta: '3 cleans a year', price: P.seasonalSeason },
  ];

  const isOneoff = service === 'one-time';
  const isSeasonal = service === 'three-wash';

  // Real calendar for one-off bookings: every future non-Sunday day is bookable.
  // (No fake "open slots" — the system has no per-day capacity model at v1.)
  const days = useMemo(() => {
    const arr = [];
    const t0 = new Date();
    t0.setHours(0, 0, 0, 0);
    const start = new Date(t0);
    start.setDate(start.getDate() - start.getDay()); // pad to the week's Sunday
    for (let i = 0; i < 35; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const past = d < t0;
      const isSun = d.getDay() === 0; // no Sunday service
      arr.push({ date: d, day: d.getDate(), disabled: past || isSun });
    }
    return arr;
  }, []);

  const selectedService = services.find(s => s.id === service);
  // Per-clean price, charged AFTER each clean — mirrors lib/pricing.ts
  // (monthly $35, one-off $45, Three Wash Season $35/wash for the first bin,
  // plus $12/clean per extra bin). Nothing is charged at booking: the card is
  // saved now, then charged once the bin is clean.
  const PER_CLEAN_PRICE = { 'one-time': P.oneoff, 'monthly': P.monthly, 'three-wash': P.seasonalPerWash };
  const perClean = (PER_CLEAN_PRICE[service] ?? selectedService.price) + Math.max(0, bins - 1) * P.extraBinPerClean;

  // One-off → the explicitly chosen calendar date; seasonal → next Apr/Jul/Sep
  // wash; other recurring → first clean derived from pickup day.
  const previewDate = isOneoff
    ? (selectedDay !== null ? days[selectedDay].date : null)
    : isSeasonal
      ? firstSeasonalDate(contact.pickupDay)
      : firstCleanDate(contact.pickupDay);

  const canAdvance = {
    1: !!service,
    2: isOneoff ? selectedDay !== null : !!contact.pickupDay,
    3: contact.name && contact.email && contact.phone && contact.street && contact.postalCode,
    4: paymentState.phase === 'saved',
    5: true
  };

  const monthName = days[14]?.date?.toLocaleString('en', { month: 'long', year: 'numeric' });

  function updateContact(next) {
    setContact(next);
    if (paymentState.phase !== 'idle') {
      setPaymentState({ phase: 'idle' });
      stripeRef.current = null;
      elementsRef.current = null;
      paymentSetupRef.current = null;
    }
  }

  async function startPaymentSetup() {
    setPaymentState({ phase: 'loading' });
    try {
      const response = await fetch('/api/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent: 'payment_setup',
          name: contact.name,
          email: contact.email,
          phone: contact.phone || undefined,
          postal_code: contact.postalCode,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.status !== 'ok') {
        throw new Error(data.message || 'Card setup is unavailable right now.');
      }

      const Stripe = await loadBookingStripeJs();
      const stripe = Stripe(data.publishable_key);
      const elements = stripe.elements({ clientSecret: data.client_secret });
      const paymentEl = elements.create('payment');

      stripeRef.current = stripe;
      elementsRef.current = elements;
      paymentSetupRef.current = {
        stripe_customer_id: data.stripe_customer_id,
        setup_intent_id: data.setup_intent_id,
      };
      setPaymentState({ phase: 'ready' });
      setTimeout(() => {
        const mountPoint = document.getElementById('booking-card-element');
        if (mountPoint) paymentEl.mount('#booking-card-element');
      }, 0);
    } catch (err) {
      setPaymentState({ phase: 'error', message: err.message || 'Could not load secure card form.' });
    }
  }

  async function savePaymentMethod() {
    if (!stripeRef.current || !elementsRef.current) return;
    setPaymentState({ phase: 'saving' });
    try {
      const { error } = await stripeRef.current.confirmSetup({
        elements: elementsRef.current,
        confirmParams: { return_url: window.location.href },
        redirect: 'if_required',
      });
      if (error) throw new Error(error.message || 'Could not save this card.');
      setPaymentState({ phase: 'saved' });
    } catch (err) {
      setPaymentState({ phase: 'ready', message: err.message || 'Could not save this card.' });
    }
  }

  // ===== Submit to /api/book =====
  async function submitBooking() {
    setSubmitState({ phase: 'sending' });

    const plan = SERVICE_TO_PLAN[service] || 'monthly';
    // Build YYYY-MM-DD from the LOCAL date parts — toISOString() would shift the
    // day backward for evening Mountain-Time bookings.
    const oneoffDate = (plan === 'oneoff' && selectedDay !== null)
      ? (() => {
          const d = days[selectedDay].date;
          const mm = String(d.getMonth() + 1).padStart(2, '0');
          const dd = String(d.getDate()).padStart(2, '0');
          return `${d.getFullYear()}-${mm}-${dd}`;
        })()
      : null;

    const payload = {
      name: contact.name,
      email: contact.email,
      phone: contact.phone || undefined,
      street: contact.street,
      city: contact.city || 'Fort Saskatchewan',
      postal_code: contact.postalCode,
      // Recurring schedules are driven by pickup_day; one-offs use only
      // oneoff_date, but the API still requires a valid pickup_day.
      pickup_day: plan === 'oneoff' ? 'monday' : contact.pickupDay,
      bin_count: bins,
      bin_location: contact.binLocation,
      plan,
      ...(plan === 'oneoff' && oneoffDate ? { oneoff_date: oneoffDate } : {}),
      ...(paymentSetupRef.current ? { payment_setup: paymentSetupRef.current } : {}),
    };

    try {
      const response = await fetch('/api/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));

      if (response.status === 200 && data.status === 'ok') {
        setSubmitState({ phase: 'success', firstVisitDate: data.first_visit_date_long || data.first_visit_date });
        return;
      }
      if (response.status === 422 && data.status === 'out_of_area') {
        setSubmitState({ phase: 'out_of_area', message: data.message });
        return;
      }
      if (response.status === 409 && data.status === 'already_subscribed') {
        setSubmitState({ phase: 'already_subscribed', message: data.message });
        return;
      }
      if (response.status === 400 && data.status === 'invalid') {
        setSubmitState({ phase: 'invalid', fieldErrors: data.errors || {} });
        return;
      }
      setSubmitState({
        phase: 'error',
        message: data.message || 'Something went wrong. Please try again or email hello@luckyshamrock.ca.',
      });
    } catch {
      setSubmitState({
        phase: 'error',
        message: 'Network error. Check your connection and try again.',
      });
    }
  }

  return (
    <section className="booking" id="book">
      <div className="container">
        <div className="booking-grid">
          <div className="booking-info">
            <h2>Stop smelling that.<br/>Start smelling freshness.</h2>
            <p>
              Real bookings — pick a service, pick a day, we'll be there. Cancel up to 24 hours
              ahead with no fee. Your card isn't charged until your garbage bin is clean.
            </p>
            <ul className="booking-perks">
              <li><span className="perk-icon"><Icon.Check size={14}/></span>No need to be home — we just need garbage bin access</li>
              <li><span className="perk-icon"><Icon.Check size={14}/></span>Photo proof emailed after every clean</li>
              <li><span className="perk-icon"><Icon.Check size={14}/></span>Eco-safe, kid-safe, pet-safe formula</li>
              <li><span className="perk-icon"><Icon.Check size={14}/></span>Pause or cancel anytime in your account</li>
              <li><span className="perk-icon"><Icon.Check size={14}/></span>Service area: all of {tweaks.city}</li>
            </ul>
          </div>

          <div className="booking-card">
            {step < 5 && (
              <div className="booking-steps">
                {['Service', 'Schedule', 'Your Info', 'Payment', 'Confirm'].map((label, i) => {
                  const n = i + 1;
                  return (
                    <div
                      key={i}
                      className={`booking-step-pill ${step === n ? 'active' : step > n ? 'done' : ''}`}
                    >
                      <span className="bsp-num">{n}</span>
                      <span className="bsp-label">{label}</span>
                    </div>
                  );
                })}
              </div>
            )}

            {step === 1 && (
              <div>
                <div style={{fontFamily: "'Nunito', sans-serif", fontWeight: 800, fontSize: 18, marginBottom: 14}}>
                  How often should we visit?
                </div>
                <div className="service-options">
                  {services.map(s => (
                    <button
                      key={s.id}
                      className={`service-option ${service === s.id ? 'selected' : ''}`}
                      onClick={() => setService(s.id)}
                    >
                      <div className="so-title">
                        {s.title}
                        <span className="so-price">${s.price}</span>
                      </div>
                      <div className="so-meta">{s.meta}</div>
                    </button>
                  ))}
                </div>

                <div className="field" style={{marginTop: 22}}>
                  <label>How many garbage bins?</label>
                  <div style={{display: 'flex', gap: 8}}>
                    {[1,2,3].map(n => (
                      <button
                        key={n}
                        onClick={() => setBins(n)}
                        className={`service-option ${bins === n ? 'selected' : ''}`}
                        style={{flex: 1, textAlign: 'center', padding: '14px 8px'}}
                      >
                        <div className="so-title" style={{margin: 0}}>{n}</div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="booking-summary">
                  <div className="booking-summary-row">
                    <span>{selectedService.title} × {bins} bin{bins>1?'s':''}</span>
                    <span>${perClean}{isOneoff ? '' : ' / clean'}</span>
                  </div>
                  <div className="booking-summary-row total">
                    <span>Charged today</span>
                    <span>$0</span>
                  </div>
                  <div className="booking-summary-row" style={{fontSize: 12, color: 'var(--ink-3)'}}>
                    <span>Card saved before confirmation — charged only after each clean.</span>
                  </div>
                  {bins > 1 && (
                    <div className="booking-summary-row" style={{fontSize: 12, color: 'var(--ink-3)'}}>
                      <span>Extra bins are $12 each per clean.</span>
                    </div>
                  )}
                </div>

                <div className="booking-nav">
                  <button
                    className="btn btn-primary"
                    onClick={() => setStep(2)}
                    disabled={!canAdvance[1]}
                    style={{width: '100%'}}
                  >
                    Continue <Icon.Arrow size={16}/>
                  </button>
                </div>
              </div>
            )}

            {step === 2 && !isOneoff && (
              <div>
                <div style={{fontFamily: "'Nunito', sans-serif", fontWeight: 800, fontSize: 18, marginBottom: 6}}>
                  Which day is your garbage pickup?
                </div>
                <div style={{fontSize: 13, color: 'var(--ink-3)', marginBottom: 16}}>
                  We clean the day after your garbage bin goes out, so it's empty. {isSeasonal ? "Three cleans a year — spring, summer, and fall." : (CADENCE_INTERVAL[service] ? `We'll come back ${CADENCE_INTERVAL[service]}.` : '')}
                </div>

                <div className="pickup-days" style={{display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8}}>
                  {PICKUP_DAYS.map(d => (
                    <button
                      key={d}
                      className={`service-option ${contact.pickupDay === d ? 'selected' : ''}`}
                      style={{textAlign: 'center', padding: '14px 4px', textTransform: 'capitalize'}}
                      onClick={() => setContact({...contact, pickupDay: d})}
                    >
                      <div className="so-title" style={{margin: 0, fontSize: 14}}>{d.slice(0, 3)}</div>
                    </button>
                  ))}
                </div>

                {contact.pickupDay && previewDate && (
                  <div className="booking-summary" style={{marginTop: 18}}>
                    <div className="booking-summary-row">
                      <span>Your first clean</span>
                      <span><strong>{fmtNice(previewDate)}</strong></span>
                    </div>
                    <div className="booking-summary-row" style={{fontSize: 12, color: 'var(--ink-3)'}}>
                      <span>then {CADENCE_INTERVAL[service] || 'on a recurring schedule'}</span>
                    </div>
                  </div>
                )}

                <div className="booking-nav" style={{marginTop: 24}}>
                  <button className="btn btn-cream" onClick={() => setStep(1)}>Back</button>
                  <button
                    className="btn btn-primary"
                    onClick={() => setStep(3)}
                    disabled={!canAdvance[2]}
                  >
                    Continue <Icon.Arrow size={16}/>
                  </button>
                </div>
              </div>
            )}

            {step === 2 && isOneoff && (
              <div>
                <div style={{fontFamily: "'Nunito', sans-serif", fontWeight: 800, fontSize: 18, marginBottom: 6}}>
                  Pick your clean day
                </div>
                <div style={{fontSize: 13, color: 'var(--ink-3)', marginBottom: 14}}>
                  {monthName} · we service Monday through Saturday.
                </div>
                <div className="cal">
                  {['S','M','T','W','T','F','S'].map((d, i) => (
                    <div className="cal-head" key={i}>{d}</div>
                  ))}
                  {days.map((d, i) => (
                    <div
                      key={i}
                      className={`cal-day ${d.disabled ? 'disabled' : ''} ${!d.disabled ? 'has-slot' : ''} ${selectedDay === i ? 'selected' : ''}`}
                      role="button"
                      tabIndex={d.disabled ? -1 : 0}
                      aria-disabled={d.disabled}
                      aria-pressed={selectedDay === i}
                      aria-label={fmtNice(d.date)}
                      onClick={() => !d.disabled && setSelectedDay(i)}
                      onKeyDown={(e) => {
                        if (d.disabled) return;
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedDay(i); }
                      }}
                    >
                      {d.day}
                    </div>
                  ))}
                </div>

                {selectedDay !== null && (
                  <div className="booking-summary" style={{marginTop: 18}}>
                    <div className="booking-summary-row">
                      <span>Your clean day</span>
                      <span><strong>{fmtNice(days[selectedDay].date)}</strong></span>
                    </div>
                  </div>
                )}

                <div className="booking-nav" style={{marginTop: 24}}>
                  <button className="btn btn-cream" onClick={() => setStep(1)}>Back</button>
                  <button
                    className="btn btn-primary"
                    onClick={() => setStep(3)}
                    disabled={!canAdvance[2]}
                  >
                    Continue <Icon.Arrow size={16}/>
                  </button>
                </div>
              </div>
            )}

            {step === 3 && (
              <div>
                <div style={{fontFamily: "'Nunito', sans-serif", fontWeight: 800, fontSize: 18, marginBottom: 14}}>
                  Where are we headed?
                </div>
                <div className="field">
                  <label>Your name</label>
                  <input
                    type="text"
                    placeholder="Maeve O'Sullivan"
                    value={contact.name}
                    onChange={e => updateContact({...contact, name: e.target.value})}
                  />
                </div>
                <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12}}>
                  <div className="field">
                    <label>Email</label>
                    <input
                      type="email"
                      placeholder="you@you.com"
                      value={contact.email}
                      onChange={e => updateContact({...contact, email: e.target.value})}
                    />
                  </div>
                  <div className="field">
                    <label>Phone</label>
                    <input
                      type="tel"
                      placeholder="(555) 010-2580"
                      value={contact.phone}
                      onChange={e => updateContact({...contact, phone: e.target.value})}
                    />
                  </div>
                </div>
                <div className="field">
                  <label>Street address</label>
                  <input
                    type="text"
                    placeholder="14 Clover Lane"
                    value={contact.street}
                    onChange={e => updateContact({...contact, street: e.target.value})}
                  />
                </div>
                <div style={{display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12}}>
                  <div className="field">
                    <label>City</label>
                    <input
                      type="text"
                      placeholder="Fort Saskatchewan"
                      value={contact.city}
                      onChange={e => updateContact({...contact, city: e.target.value})}
                    />
                  </div>
                  <div className="field">
                    <label>Postal code</label>
                    <input
                      type="text"
                      placeholder="T8L 0A1"
                      value={contact.postalCode}
                      onChange={e => updateContact({...contact, postalCode: e.target.value.toUpperCase()})}
                    />
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="bin-location">Bin location (so we don't wake the dog)</label>
                  <select
                    id="bin-location"
                    value={contact.binLocation}
                    onChange={e => updateContact({...contact, binLocation: e.target.value})}
                  >
                    <option value="curb">By the curb on service day</option>
                    <option value="side">Side of house / driveway</option>
                    <option value="garage">Inside garage (unlocked)</option>
                    <option value="back">Back yard / behind gate</option>
                  </select>
                </div>

                <div className="booking-nav">
                  <button className="btn btn-cream" onClick={() => setStep(2)}>Back</button>
                  <button
                    className="btn btn-primary"
                    onClick={() => setStep(4)}
                    disabled={!canAdvance[3]}
                  >
                    Continue to payment <Icon.Arrow size={16}/>
                  </button>
                </div>
              </div>
            )}

            {step === 4 && (
              <div>
                <div style={{fontFamily: "'Nunito', sans-serif", fontWeight: 800, fontSize: 18, marginBottom: 8}}>
                  Save your payment method
                </div>
                <p style={{fontSize: 13, color: 'var(--ink-3)', marginBottom: 16}}>
                  We save your card now so your booking is complete. Nothing is charged today — your card is charged only after your bin is clean.
                </p>

                {paymentState.phase === 'idle' && (
                  <button className="btn btn-primary" onClick={startPaymentSetup} style={{width: '100%'}}>
                    Set up secure payment <Icon.Arrow size={16}/>
                  </button>
                )}

                {paymentState.phase === 'loading' && (
                  <div className="booking-loading" style={{marginTop: 18, textAlign: 'center', color: 'var(--ink-3)'}}>
                    Loading secure card form…
                  </div>
                )}

                {(paymentState.phase === 'ready' || paymentState.phase === 'saving') && (
                  <div>
                    <div id="booking-card-element" style={{padding: 14, border: '1px solid var(--line)', borderRadius: 12, background: 'white'}} />
                    {paymentState.message && (
                      <div className="booking-error" style={{marginTop: 12}}>
                        <p>{paymentState.message}</p>
                      </div>
                    )}
                    <button
                      className="btn btn-primary"
                      onClick={savePaymentMethod}
                      disabled={paymentState.phase === 'saving'}
                      style={{width: '100%', marginTop: 14}}
                    >
                      {paymentState.phase === 'saving' ? 'Saving…' : 'Save card'}
                    </button>
                  </div>
                )}

                {paymentState.phase === 'saved' && (
                  <div className="booking-success" style={{marginTop: 18}}>
                    <div className="check-big">
                      <Icon.Check size={32} color="white"/>
                    </div>
                    <h3>Card saved. No charge today.</h3>
                    <p>You're ready to confirm the booking.</p>
                  </div>
                )}

                {paymentState.phase === 'error' && (
                  <div className="booking-error" style={{marginTop: 18}}>
                    <p>{paymentState.message}</p>
                    <button className="btn btn-primary" onClick={startPaymentSetup} style={{marginTop: 12}}>Try again</button>
                  </div>
                )}

                <div className="booking-nav" style={{marginTop: 24}}>
                  <button className="btn btn-cream" onClick={() => setStep(3)}>Back</button>
                  <button
                    className="btn btn-primary"
                    onClick={() => { setSubmitState({ phase: 'idle' }); setStep(5); }}
                    disabled={!canAdvance[4]}
                  >
                    Review & confirm <Icon.Arrow size={16}/>
                  </button>
                </div>
              </div>
            )}

            {step === 5 && (
              <div>
                {/* Summary always shown on confirm step */}
                <div style={{fontFamily: "'Nunito', sans-serif", fontWeight: 800, fontSize: 18, marginBottom: 14}}>
                  {submitState.phase === 'success' ? "You're booked!" : 'Confirm your booking'}
                </div>

                <div className="booking-summary" style={{textAlign: 'left'}}>
                  <div className="booking-summary-row">
                    <span>Service</span>
                    <span>{selectedService.title} × {bins} bin{bins>1?'s':''}</span>
                  </div>
                  <div className="booking-summary-row">
                    <span>First visit</span>
                    <span>
                      {submitState.phase === 'success' && submitState.firstVisitDate
                        ? submitState.firstVisitDate
                        : fmtNice(previewDate)}
                    </span>
                  </div>
                  <div className="booking-summary-row">
                    <span>Address</span>
                    <span style={{maxWidth: '60%', textAlign: 'right'}}>
                      {contact.street}, {contact.city}
                    </span>
                  </div>
                  <div className="booking-summary-row total">
                    <span>{isOneoff ? 'Charged after your clean' : 'Charged per clean'}</span>
                    <span>${perClean}{isOneoff ? '' : ' / clean'}</span>
                  </div>
                </div>

                {/* Branch on submitState.phase */}
                {submitState.phase === 'idle' && (
                  <div className="booking-nav">
                    <button className="btn btn-cream" onClick={() => setStep(4)}>Back</button>
                    <button
                      className="btn btn-primary booking-cta"
                      onClick={submitBooking}
                    >
                      Confirm booking <Icon.Arrow size={16}/>
                    </button>
                  </div>
                )}

                {submitState.phase === 'sending' && (
                  <div className="booking-loading" style={{marginTop: 18, textAlign: 'center', color: 'var(--ink-3)'}}>
                    Booking…
                  </div>
                )}

                {submitState.phase === 'success' && (
                  <div className="booking-success" style={{marginTop: 18}}>
                    <div className="check-big">
                      <Icon.Check size={36} color="white"/>
                    </div>
                    <h3>You're booked. We're already excited.</h3>
                    <p>
                      Your first clean is scheduled for <strong>{submitState.firstVisitDate}</strong>.
                    </p>
                    <p>
                      Your card is saved and will be charged only after your bin is clean. Check <strong>{contact.email}</strong> for your manage link.
                    </p>
                    <button
                      className="btn btn-cream"
                      onClick={() => {
                        setStep(1);
                        setSelectedDay(null);
                        setSubmitState({ phase: 'idle' });
                      }}
                    >
                      Book another bin
                    </button>
                  </div>
                )}

                {submitState.phase === 'out_of_area' && (
                  <div style={{marginTop: 18}}>
                    <WaitlistCapture
                      email={contact.email}
                      postalCode={contact.postalCode}
                      message={submitState.message}
                    />
                    <div className="booking-nav" style={{marginTop: 14}}>
                      <button className="btn btn-cream" onClick={() => setStep(3)}>
                        Edit address
                      </button>
                    </div>
                  </div>
                )}

                {submitState.phase === 'already_subscribed' && (
                  <div className="booking-warning" style={{marginTop: 18}}>
                    <p>{submitState.message}</p>
                  </div>
                )}

                {submitState.phase === 'invalid' && (
                  <div className="booking-error" style={{marginTop: 18}}>
                    <p>Please fix the highlighted fields and try again.</p>
                    <ul>
                      {Object.entries(submitState.fieldErrors).map(([field, msgs]) => (
                        <li key={field}>
                          <strong>{field}:</strong> {Array.isArray(msgs) ? msgs.join(', ') : String(msgs)}
                        </li>
                      ))}
                    </ul>
                    <div className="booking-nav" style={{marginTop: 14}}>
                      <button className="btn btn-cream" onClick={() => setStep(3)}>
                        Edit details
                      </button>
                      <button
                        className="btn btn-primary"
                        onClick={() => setSubmitState({ phase: 'idle' })}
                      >
                        Try again
                      </button>
                    </div>
                  </div>
                )}

                {submitState.phase === 'error' && (
                  <div className="booking-error" style={{marginTop: 18}}>
                    <p>{submitState.message}</p>
                    <div className="booking-nav" style={{marginTop: 14}}>
                      <button
                        className="btn btn-primary"
                        onClick={() => setSubmitState({ phase: 'idle' })}
                      >
                        Try again
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
};

window.Booking = Booking;
