/* global React, Icon */
const { useState: useStateBk, useMemo } = React;

// Map UI service id → API plan value
const SERVICE_TO_PLAN = {
  'one-time': 'oneoff',
  'monthly': 'monthly',
  'quarterly': 'quarterly',
  'biweekly': 'bimonthly',
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

// ===== Booking flow =====
const Booking = ({ tweaks }) => {
  const [step, setStep] = useStateBk(1);
  const [service, setService] = useStateBk('monthly');
  const [bins, setBins] = useStateBk(1);
  const [selectedDay, setSelectedDay] = useStateBk(null);
  const [selectedTime, setSelectedTime] = useStateBk(null);
  const [contact, setContact] = useStateBk({
    name: '',
    email: '',
    phone: '',
    street: '',
    city: 'Fort Saskatchewan',
    postalCode: '',
    pickupDay: 'monday',
  });
  const [submitState, setSubmitState] = useStateBk({ phase: 'idle' });

  const services = [
    { id: 'one-time', title: 'One-Time', meta: 'Try us once', price: 49 },
    { id: 'monthly', title: 'Monthly', meta: 'Every 4 weeks', price: 25 },
    { id: 'quarterly', title: 'Quarterly', meta: '4× per year', price: 35 },
    { id: 'biweekly', title: 'Bi-Weekly', meta: 'Every 2 weeks', price: 19 },
  ];

  // Generate next 28 days (mock calendar)
  const today = new Date();
  const days = useMemo(() => {
    const arr = [];
    const start = new Date(today);
    // pad to first Sunday of view
    const offset = start.getDay();
    start.setDate(start.getDate() - offset);
    for (let i = 0; i < 35; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const past = d < new Date(today.setHours(0,0,0,0));
      const isSun = d.getDay() === 0;
      arr.push({
        date: d,
        day: d.getDate(),
        month: d.getMonth(),
        disabled: past || isSun, // closed Sundays
        hasSlot: !past && !isSun && Math.random() > 0.25
      });
    }
    return arr;
  }, []);

  const timeSlots = ['8:00 AM', '10:00 AM', '11:30 AM', '1:00 PM', '2:30 PM', '4:00 PM'];

  const selectedService = services.find(s => s.id === service);
  const subtotal = selectedService.price * bins;
  const firstCleanFee = service === 'monthly' || service === 'biweekly' || service === 'quarterly' ? 15 : 0;
  const total = subtotal + firstCleanFee;

  const canAdvance = {
    1: !!service,
    2: !!selectedDay && !!selectedTime,
    3: contact.name && contact.email && contact.phone && contact.street && contact.postalCode && contact.pickupDay,
    4: true
  };

  const monthName = days[14]?.date?.toLocaleString('en', { month: 'long', year: 'numeric' });

  // ===== Submit to /api/book =====
  async function submitBooking() {
    setSubmitState({ phase: 'sending' });

    const plan = SERVICE_TO_PLAN[service] || 'monthly';
    const oneoffDate = selectedDay !== null
      ? days[selectedDay].date.toISOString().slice(0, 10)
      : null;

    const payload = {
      name: contact.name,
      email: contact.email,
      phone: contact.phone || undefined,
      street: contact.street,
      city: contact.city || 'Fort Saskatchewan',
      postal_code: contact.postalCode,
      pickup_day: contact.pickupDay,
      bin_count: bins,
      plan,
      ...(plan === 'oneoff' && oneoffDate ? { oneoff_date: oneoffDate } : {}),
    };

    try {
      const response = await fetch('/api/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));

      if (response.status === 200 && data.status === 'ok') {
        setSubmitState({ phase: 'success', firstVisitDate: data.first_visit_date });
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
            <h2>Stop smelling that.<br/>Start smelling nothing.</h2>
            <p>
              Real bookings — pick a service, pick a day, we'll be there. Cancel up to 24 hours
              ahead with no fee. Your card isn't charged until your bin is clean.
            </p>
            <ul className="booking-perks">
              <li><span className="perk-icon"><Icon.Check size={14}/></span>No need to be home — we just need bin access</li>
              <li><span className="perk-icon"><Icon.Check size={14}/></span>Photo proof emailed after every clean</li>
              <li><span className="perk-icon"><Icon.Check size={14}/></span>Eco-safe, kid-safe, pet-safe formula</li>
              <li><span className="perk-icon"><Icon.Check size={14}/></span>Pause or cancel anytime in your account</li>
              <li><span className="perk-icon"><Icon.Check size={14}/></span>Service area: {tweaks.city} + 15 miles</li>
            </ul>
          </div>

          <div className="booking-card">
            {step < 4 && (
              <div className="booking-steps">
                {['Service', 'Date & Time', 'Your Info', 'Confirm'].map((label, i) => {
                  const n = i + 1;
                  return (
                    <div
                      key={i}
                      className={`booking-step-pill ${step === n ? 'active' : step > n ? 'done' : ''}`}
                    >
                      {n}. {label}
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
                  <label>How many bins?</label>
                  <div style={{display: 'flex', gap: 8}}>
                    {[1,2,3,4].map(n => (
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
                    <span>${subtotal}</span>
                  </div>
                  {firstCleanFee > 0 && (
                    <div className="booking-summary-row">
                      <span>First-clean deep treatment</span>
                      <span>${firstCleanFee}</span>
                    </div>
                  )}
                  <div className="booking-summary-row total">
                    <span>Due today</span>
                    <span>${total}</span>
                  </div>
                </div>

                <div className="booking-nav">
                  <button
                    className="btn btn-primary"
                    onClick={() => setStep(2)}
                    disabled={!canAdvance[1]}
                    style={{width: '100%'}}
                  >
                    Pick a date <Icon.Arrow size={16}/>
                  </button>
                </div>
              </div>
            )}

            {step === 2 && (
              <div>
                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14}}>
                  <div style={{fontFamily: "'Nunito', sans-serif", fontWeight: 800, fontSize: 18}}>
                    {monthName}
                  </div>
                  <div style={{fontSize: 12, color: 'var(--ink-3)', display: 'flex', alignItems: 'center', gap: 6}}>
                    <span style={{width: 6, height: 6, background: 'var(--toxic)', borderRadius: '50%'}}></span>
                    open slots
                  </div>
                </div>
                <div className="cal">
                  {['S','M','T','W','T','F','S'].map(d => (
                    <div className="cal-head" key={d}>{d}</div>
                  ))}
                  {days.map((d, i) => (
                    <div
                      key={i}
                      className={`cal-day ${d.disabled ? 'disabled' : ''} ${d.hasSlot && !d.disabled ? 'has-slot' : ''} ${selectedDay === i ? 'selected' : ''}`}
                      onClick={() => !d.disabled && d.hasSlot && setSelectedDay(i)}
                    >
                      {d.day}
                    </div>
                  ))}
                </div>

                {selectedDay !== null && (
                  <div>
                    <div style={{fontFamily: "'Nunito', sans-serif", fontWeight: 800, fontSize: 16, marginTop: 24, marginBottom: 4}}>
                      Pick a time slot
                    </div>
                    <div style={{fontSize: 13, color: 'var(--ink-3)', marginBottom: 4}}>
                      {days[selectedDay].date.toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric' })}
                    </div>
                    <div className="time-slots">
                      {timeSlots.map(t => (
                        <button
                          key={t}
                          className={`time-slot ${selectedTime === t ? 'selected' : ''}`}
                          onClick={() => setSelectedTime(t)}
                        >
                          {t}
                        </button>
                      ))}
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
                    onChange={e => setContact({...contact, name: e.target.value})}
                  />
                </div>
                <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12}}>
                  <div className="field">
                    <label>Email</label>
                    <input
                      type="email"
                      placeholder="you@you.com"
                      value={contact.email}
                      onChange={e => setContact({...contact, email: e.target.value})}
                    />
                  </div>
                  <div className="field">
                    <label>Phone</label>
                    <input
                      type="tel"
                      placeholder="(555) 010-2580"
                      value={contact.phone}
                      onChange={e => setContact({...contact, phone: e.target.value})}
                    />
                  </div>
                </div>
                <div className="field">
                  <label>Street address</label>
                  <input
                    type="text"
                    placeholder="14 Clover Lane"
                    value={contact.street}
                    onChange={e => setContact({...contact, street: e.target.value})}
                  />
                </div>
                <div style={{display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12}}>
                  <div className="field">
                    <label>City</label>
                    <input
                      type="text"
                      placeholder="Fort Saskatchewan"
                      value={contact.city}
                      onChange={e => setContact({...contact, city: e.target.value})}
                    />
                  </div>
                  <div className="field">
                    <label>Postal code</label>
                    <input
                      type="text"
                      placeholder="T8L 0A1"
                      value={contact.postalCode}
                      onChange={e => setContact({...contact, postalCode: e.target.value.toUpperCase()})}
                    />
                  </div>
                </div>
                <div className="field">
                  <label>Pickup day (matches your city's garbage day)</label>
                  <select
                    value={contact.pickupDay}
                    onChange={e => setContact({...contact, pickupDay: e.target.value})}
                  >
                    <option value="monday">Monday</option>
                    <option value="tuesday">Tuesday</option>
                    <option value="wednesday">Wednesday</option>
                    <option value="thursday">Thursday</option>
                    <option value="friday">Friday</option>
                  </select>
                </div>
                <div className="field">
                  <label>Bin location (so we don't wake the dog)</label>
                  <select defaultValue="side">
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
                    onClick={() => { setSubmitState({ phase: 'idle' }); setStep(4); }}
                    disabled={!canAdvance[3]}
                  >
                    Review & confirm <Icon.Arrow size={16}/>
                  </button>
                </div>
              </div>
            )}

            {step === 4 && (
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
                        : selectedDay !== null
                          ? `${days[selectedDay].date.toLocaleDateString('en', {month: 'short', day: 'numeric'})}, ${selectedTime}`
                          : '—'}
                    </span>
                  </div>
                  <div className="booking-summary-row">
                    <span>Address</span>
                    <span style={{maxWidth: '60%', textAlign: 'right'}}>
                      {contact.street}, {contact.city}
                    </span>
                  </div>
                  <div className="booking-summary-row total">
                    <span>Charged after service</span>
                    <span>${total}</span>
                  </div>
                </div>

                {/* Branch on submitState.phase */}
                {submitState.phase === 'idle' && (
                  <div className="booking-nav">
                    <button className="btn btn-cream" onClick={() => setStep(3)}>Back</button>
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
                      Check <strong>{contact.email}</strong> for a link to manage your booking.
                    </p>
                    <button
                      className="btn btn-cream"
                      onClick={() => {
                        setStep(1);
                        setSelectedDay(null);
                        setSelectedTime(null);
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
