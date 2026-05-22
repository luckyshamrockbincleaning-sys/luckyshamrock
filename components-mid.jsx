/* global React, Icon, CleanBin */
const { useState: useStateBA, useEffect: useEffectBA, useRef: useRefBA } = React;

// ===== Before/After slider =====
const BeforeAfter = () => {
  const [pos, setPos] = useStateBA(82);
  const stageRef = useRefBA(null);
  const dragging = useRefBA(false);

  const handleMove = (clientX) => {
    if (!stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 100;
    setPos(Math.max(8, Math.min(92, x)));
  };

  useEffectBA(() => {
    const onMove = (e) => dragging.current && handleMove(e.clientX);
    const onTouch = (e) => dragging.current && e.touches[0] && handleMove(e.touches[0].clientX);
    const onUp = () => (dragging.current = false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onTouch);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('touchmove', onTouch);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchend', onUp);
    };
  }, []);

  return (
    <section className="beforeafter" id="before-after">
      <div className="container">
        <div className="ba-header">
          <div>
            <h2>From <span style={{color: 'var(--green)'}}>"don't open that"</span> to <span style={{color: 'var(--sky-deep)'}}>"smells like nothing"</span></h2>
          </div>
        </div>

        <div
          className="ba-stage"
          ref={stageRef}
          onMouseDown={(e) => { dragging.current = true; handleMove(e.clientX); }}
          onTouchStart={(e) => { dragging.current = true; e.touches[0] && handleMove(e.touches[0].clientX); }}
        >
          {/* Before */}
          <div className="ba-half before">
            <img src="assets/mascot-before.jpg" alt="Stinky bin" className="ba-image"/>
            <div className="ba-stamp ba-stamp-before">BEFORE</div>
          </div>
          {/* After */}
          <div className="ba-after-wrap" style={{clipPath: `inset(0 0 0 ${pos}%)`}}>
            <div className="ba-half after">
              <img src="assets/mascot-after.jpg" alt="Clean bin" className="ba-image"/>
              <div className="ba-stamp ba-stamp-after">AFTER</div>
            </div>
          </div>
          {/* Divider */}
          <div className="ba-handle" style={{left: `${pos}%`}}>
            <div className="ba-handle-knob">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 6 3 12 9 18"/>
                <polyline points="15 6 21 12 15 18"/>
              </svg>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

// ===== How It Works =====
const HowItWorks = ({ onBookClick }) => {
  const steps = [
    {
      icon: <Icon.Calendar size={28}/>,
      title: "Pick your day",
      body: "Book in 90 seconds online — or text us a photo of your bin and we'll handle the rest. We come the day after pickup so your bin's empty."
    },
    {
      icon: <Icon.Truck size={28}/>,
      title: "We roll up",
      body: "Our truck does the heavy lifting. Water in, water out, nothing goes down your storm drain. You don't need to be home."
    },
    {
      icon: <Icon.Bubbles size={28}/>,
      title: "Sparkle delivered",
      body: "200°F blast, plant-based deodorizer, towel-dry the rim. You get a photo when it's done. We bill the card on file."
    }
  ];

  return (
    <section className="how" id="how">
      <div className="container">
        <div style={{textAlign: 'center', maxWidth: 720, margin: '0 auto'}}>
          <h2>Three steps. Twelve minutes. Zero hassle.</h2>
          <p style={{color: 'var(--ink-2)', fontSize: 18, marginTop: 18}}>
            We meet your bin where it lives. You keep doing whatever it was you were doing.
          </p>
        </div>
        <div className="how-steps">
          {steps.map((s, i) => (
            <div className="how-step" key={i}>
              <div className="how-step-num">{i + 1}</div>
              <div className="how-step-icon">{s.icon}</div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
          ))}
        </div>
        <div style={{textAlign: 'center', marginTop: 50}}>
          <button className="btn btn-primary" onClick={onBookClick}>
            Book my first clean <Icon.Arrow size={16}/>
          </button>
        </div>
      </div>
    </section>
  );
};

// ===== Pricing =====
const Pricing = ({ tweaks, onBookClick }) => {
  const [freq, setFreq] = useStateBA('monthly');

  const plans = {
    monthly: [
      {
        name: "One-Time",
        sub: "Try us once. Smell the difference.",
        price: 49, unit: "per bin",
        features: ["1 bin · hot-water clean", "Eco-deodorize + towel dry", "Photo proof on completion", "No commitment"],
      },
      {
        name: "Monthly",
        sub: "The neighborhood favorite.",
        price: 25, unit: "per bin · monthly",
        features: ["1 bin · every 4 weeks", "Trash-day timing automatic", "Priority reschedule", "Cancel anytime, no fee", "10% off extra bins"],
        featured: true,
      },
      {
        name: "Quarterly",
        sub: "For the seasonally squeamish.",
        price: 35, unit: "per bin · quarterly",
        features: ["1 bin · 4× per year", "Spring deep-clean included", "Trash-day timing", "Cancel anytime"],
      }
    ],
    annual: [
      {
        name: "One-Time",
        sub: "Try us once. Smell the difference.",
        price: 49, unit: "per bin",
        features: ["1 bin · hot-water clean", "Eco-deodorize + towel dry", "Photo proof on completion", "No commitment"],
      },
      {
        name: "Monthly · Annual",
        sub: "Pay yearly, save the most.",
        price: 22, unit: "per bin · billed yearly",
        features: ["1 bin · every 4 weeks", "Trash-day timing automatic", "Priority reschedule", "2 months free vs. monthly", "15% off extra bins"],
        featured: true,
      },
      {
        name: "Quarterly · Annual",
        sub: "For the seasonally squeamish.",
        price: 30, unit: "per bin · billed yearly",
        features: ["1 bin · 4× per year", "Spring deep-clean included", "Trash-day timing", "$20 off vs. quarterly"],
      }
    ]
  };

  const current = plans[freq];

  return (
    <section className="pricing" id="pricing">
      <div className="container" style={{textAlign: 'center'}}>
        <h2>Honest pricing. No tier called "Platinum Plus."</h2>
        <div className="pricing-toggle">
          <button className={freq === 'monthly' ? 'active' : ''} onClick={() => setFreq('monthly')}>
            Pay monthly
          </button>
          <button className={freq === 'annual' ? 'active' : ''} onClick={() => setFreq('annual')}>
            Pay yearly · save 10%
          </button>
        </div>

        <div className="pricing-grid" style={{textAlign: 'left'}}>
          {current.map((p, i) => (
            <div className={`price-card ${p.featured ? 'featured' : ''}`} key={i}>
              {p.featured && <div className="badge">Most popular</div>}
              <h3>{p.name}</h3>
              <div style={{fontSize: 14, color: p.featured ? 'rgba(255,255,255,0.85)' : 'var(--ink-3)', marginTop: 4}}>{p.sub}</div>
              <div className="price-tag">${p.price}</div>
              <div className="price-unit">{p.unit}</div>
              <ul className="price-features">
                {p.features.map((f, j) => (
                  <li key={j}>
                    <span className="check"><Icon.Check size={12}/></span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <button
                className={p.featured ? 'btn btn-cream' : 'btn btn-primary'}
                onClick={onBookClick}
                style={p.featured ? {background: 'var(--toxic)', borderColor: 'var(--green-darker)', boxShadow: '0 4px 0 var(--green-darker)'} : {}}
              >
                {p.featured ? 'Lock it in' : 'Choose plan'}
              </button>
            </div>
          ))}
        </div>

        <p style={{marginTop: 40, color: 'var(--ink-3)', fontSize: 14}}>
          Extra bins: $12/clean. Service area within 15 miles of {tweaks.city}. Prices include tax.
        </p>
      </div>
    </section>
  );
};

window.BeforeAfter = BeforeAfter;
window.HowItWorks = HowItWorks;
window.Pricing = Pricing;
