/* global React, Icon, CleanBin */

// ===== How It Works =====
const HowItWorks = ({ onBookClick }) => {
  const steps = [
    {
      icon: <Icon.Calendar size={28}/>,
      title: "Pick your day",
      body: "Book in 90 seconds online — or text us a photo of your garbage bin and we'll handle the rest. We come the day after pickup so your garbage bin's empty."
    },
    {
      icon: <Icon.Truck size={28}/>,
      title: "We roll up",
      body: "Our truck does the heavy lifting. Water in, water out, nothing goes down your storm drain. You don't need to be home."
    },
    {
      icon: <Icon.Bubbles size={28}/>,
      title: "Sparkle delivered",
      body: "190°F blast, plant-based deodorizer, towel-dry the rim. You get a photo when it's done. We bill the card on file."
    }
  ];

  return (
    <section className="how" id="how">
      <div className="container">
        <div style={{textAlign: 'center', maxWidth: 720, margin: '0 auto'}}>
          <h2>Three steps. Twelve minutes. Zero hassle.</h2>
          <p style={{color: 'var(--ink-2)', fontSize: 18, marginTop: 18}}>
            We meet your garbage bin where it lives. You keep doing whatever it was you were doing.
          </p>
        </div>
        <div className="how-steps">
          {steps.map((s, i) => (
            <div className="how-step" key={i}>
              <div className="how-step-clover" aria-label={`Step ${i + 1}`}>
                <span className="clover-glyph">🍀</span>
                <span className="clover-num">{i + 1}</span>
              </div>
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
  // Prices from the single client source (window.LS_PRICING / pricing.js,
  // guarded against lib/pricing.ts). Inline fallback only if the script fails.
  const P = (typeof window !== 'undefined' && window.LS_PRICING) ||
    { oneoff: 45, monthly: 35, seasonalSeason: 105, seasonalPerWash: 35, extraBinPerClean: 12 };
  const current = [
    {
      name: "One-Time",
      sub: "Try us once. Smell the difference.",
      price: P.oneoff, unit: "per first garbage bin",
      features: ["1 garbage bin · hot-water clean", "Eco-deodorize + towel dry", "Photo proof on completion", "No commitment"],
    },
    {
      name: "Monthly",
      sub: "The neighborhood favorite.",
      price: P.monthly, unit: "per first garbage bin · monthly",
      features: ["1 garbage bin · every 4 weeks", "Trash-day timing automatic", "Priority reschedule", "Cancel anytime, no fee", `Extra bins $${P.extraBinPerClean}/clean`],
      featured: true,
    },
    {
      name: "Three Wash Season",
      sub: "Fresh through every season.",
      price: P.seasonalSeason, unit: "per first garbage bin · 3 washes/yr",
      features: [
        "May — kick off the season fresh",
        "July — keep clean through the heat",
        "September — finish the season strong",
        "Trash-day timing · cancel anytime",
      ],
    }
  ];

  return (
    <section className="pricing" id="pricing">
      <div className="container" style={{textAlign: 'center'}}>
        <h2>Honest pricing. No tier called "Platinum Plus."</h2>

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
          {`Extra bins are $${P.extraBinPerClean} each per clean.`} Service area: {tweaks.city}. Prices include tax.
        </p>
        {/* Said here rather than discovered on a card statement. Deliberately
            promises we ask first — the operator's extra charge always carries a
            written reason onto the receipt. */}
        <p style={{marginTop: 8, color: 'var(--ink-3)', fontSize: 13}}>
          * Bins in an unusually bad state (heavy build-up, maggots, spills that need
          a second pass) may cost a little extra. We'll show you the reason on your
          receipt, and it's always the same crew doing the work — never a surprise fee.
        </p>
      </div>
    </section>
  );
};

// ===== Why it matters (health / bacteria) =====
const WhyClean = () => {
  const nasties = [
    { name: "E. coli & Salmonella", body: "Raw-meat juices and food scraps let these gut bacteria multiply in the warm, damp bottom of your garbage bin." },
    { name: "Listeria", body: "Survives and grows even in cool weather — it thrives in the sticky residue left behind after pickup day." },
    { name: "Mold & spores", body: "Rotting organics grow mold that puffs spores into the air every time you lift the lid." },
    { name: "Flies & maggots", body: "Flies lay eggs in the gunk; a single missed week can hatch hundreds of maggots in a dirty garbage bin." },
    { name: "Rodents & raccoons", body: "Lingering food smell is an open invitation — a clean garbage bin doesn't advertise dinner." },
    { name: "That smell", body: "The stench is bacteria off-gassing. Kill the bacteria and the smell goes with it." },
  ];

  return (
    <section className="how" id="why" style={{paddingTop: 0}}>
      <div className="container">
        <div style={{textAlign: 'center', maxWidth: 760, margin: '0 auto'}}>
          <h2>What's actually living in your garbage bin.</h2>
          <p style={{color: 'var(--ink-2)', fontSize: 18, marginTop: 18}}>
            A garbage bin is the perfect incubator — food, warmth, and moisture. Curbside pickup
            takes the trash, not the bacteria film coating the inside. That's what we blast away.
          </p>
        </div>
        <div className="how-steps">
          {nasties.map((n, i) => (
            <div className="how-step" key={i}>
              <div className="how-step-num" aria-hidden="true" style={{fontSize: 24, lineHeight: 1}}>🦠</div>
              <h3 style={{marginTop: 8}}>{n.name}</h3>
              <p>{n.body}</p>
            </div>
          ))}
        </div>
        <p style={{textAlign: 'center', marginTop: 30, color: 'var(--ink-3)', fontSize: 14}}>
          Our 190°F hot-water blast plus a plant-based, kid- and pet-safe deodorizer sanitizes the
          whole garbage bin — inside, rim, and lid.
        </p>
      </div>
    </section>
  );
};

window.HowItWorks = HowItWorks;
window.WhyClean = WhyClean;
window.Pricing = Pricing;
