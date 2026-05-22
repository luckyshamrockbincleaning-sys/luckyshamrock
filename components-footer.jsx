/* global React, Icon */
const { useState: useStateFt } = React;

// ===== Testimonials =====
const Testimonials = () => {
  const cards = [
    {
      stars: 5,
      quote: "Honestly, I didn't know my bin could smell like nothing. I keep going out to sniff it. My husband is worried.",
      name: "Saoirse M.",
      meta: "Monthly · 18 months",
      avatar: "S",
    },
    {
      stars: 5,
      quote: "The photo they text you after is so satisfying. It's like a before/after but the after is just… a normal trash can.",
      name: "Dev P.",
      meta: "Bi-weekly · 6 months",
      avatar: "D",
    },
    {
      stars: 5,
      quote: "Showed up the morning after pickup, gone in 12 minutes, didn't even need to be home. This is the easiest money I spend each month.",
      name: "Marcus & Jen L.",
      meta: "Monthly · 2 years",
      avatar: "M",
    }
  ];

  return (
    <section className="testimonials" id="reviews">
      <div className="container">
        <div className="testimonials-header">
        </div>

        <p className="testimonial-pullquote">
          "I didn't know my bin <span className="accent">could smell like nothing.</span>"
          <span className="attr">— Saoirse M., monthly subscriber since '24</span>
        </p>

        <div className="testimonials-grid">
          {cards.map((c, i) => (
            <div className="testimonial-card" key={i}>
              <div className="stars">
                {Array(c.stars).fill(0).map((_, j) => <Icon.Star key={j} size={18}/>)}
              </div>
              <p className="quote">"{c.quote}"</p>
              <div className="author">
                <div className="avatar">{c.avatar}</div>
                <div>
                  <div className="author-name">{c.name}</div>
                  <div className="author-meta">{c.meta}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

// ===== FAQ =====
const FAQ = ({ tweaks }) => {
  const [open, setOpen] = useStateFt(0);
  const faqs = [
    {
      q: "Do I need to be home?",
      a: "Nope. Just leave the bin where we can get to it (curb, side of house, unlocked garage — your call). We'll text when we arrive and send a photo when we're done."
    },
    {
      q: "Is the cleaner safe for kids and pets?",
      a: "Yes. We use a plant-based, biodegradable deodorizer — no bleach, no harsh chemicals. The bin's safe to use immediately after we finish."
    },
    {
      q: "Where does the wastewater go?",
      a: "Back with us. Nothing goes into the storm drain. We collect every drop in our truck and dispose of it properly at a treatment facility — it's a real thing we care about."
    },
    {
      q: "What if it's raining?",
      a: "We work in light rain, no problem. For serious weather we'll text the night before to reschedule for free. Hot water doesn't mind a little drizzle."
    },
    {
      q: "Can I skip a month?",
      a: `Of course. Pause, skip, or cancel anytime from your account — no fees, no awkward phone call. Subscriptions are month-to-month always.`
    },
    {
      q: "What sizes of bin do you do?",
      a: "All standard residential sizes (32, 64, and 96 gallon). Bigger commercial dumpsters — we have a separate service, just give us a call."
    },
  ];

  return (
    <section className="faq" id="faq">
      <div className="container">
        <div className="faq-grid">
          <div className="faq-aside">
            <h2>Stuff people ask before they sign up.</h2>
            <p>If yours isn't here, text us at {tweaks.phone} — a real human answers, usually within an hour.</p>
            <a href={`tel:${tweaks.phone}`} className="btn btn-cream">
              <Icon.Phone size={14}/> Call us
            </a>
          </div>
          <div className="faq-list">
            {faqs.map((f, i) => (
              <div className={`faq-item ${open === i ? 'open' : ''}`} key={i}>
                <button className="faq-question" onClick={() => setOpen(open === i ? -1 : i)}>
                  <span>{f.q}</span>
                  <span className="faq-toggle"><Icon.Plus size={14}/></span>
                </button>
                <div className="faq-answer">
                  <p style={{paddingTop: 0}}>{f.a}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

// ===== Footer pre-CTA + Footer =====
const FooterCTA = ({ onBookClick, tweaks }) => (
  <section className="footer-pre">
    {/* decorative dots */}
    <div style={{position: 'absolute', top: 30, left: 60, opacity: 0.15}}>
      <Icon.Sparkle size={32} color="white"/>
    </div>
    <div style={{position: 'absolute', bottom: 50, left: '40%', opacity: 0.15}}>
      <Icon.Sparkle size={20} color="white"/>
    </div>
    <div style={{position: 'absolute', top: '40%', right: '38%', opacity: 0.15}}>
      <Icon.Sparkle size={26} color="white"/>
    </div>
    <div className="container">
      <div className="footer-pre-inner">
        <div>
          <h2 style={{marginTop: 20}}>Stop being mad at your bin.</h2>
          <p>
            First clean is risk-free — if it doesn't smell like nothing,
            we'll come back and re-do it. Free.
          </p>
          <div className="footer-pre-cta">
            <button className="btn btn-cream" onClick={onBookClick} style={{background: 'var(--toxic)', borderColor: 'var(--green-darker)', boxShadow: '0 4px 0 var(--green-darker)'}}>
              Book my first clean <Icon.Arrow size={16}/>
            </button>
            <a href={`tel:${tweaks.phone}`} className="btn" style={{background: 'transparent', color: 'white', border: '2px solid rgba(255,255,255,0.4)'}}>
              <Icon.Phone size={14}/> Or call {tweaks.phone}
            </a>
          </div>
        </div>
        <div className="footer-pre-visual">
          <div className="thumbsup">
            <img src="assets/logo.png" alt="Lucky Shamrock mascot" style={{width: '88%', height: '88%', objectFit: 'contain'}}/>
          </div>
          <div style={{marginTop: 20, fontFamily: "'Nunito', sans-serif", fontWeight: 800, fontSize: 18}}>
            <Icon.Wave size={20}/> Lucky says hi
          </div>
        </div>
      </div>
    </div>
  </section>
);

const Footer = ({ tweaks }) => (
  <footer>
    <div className="container">
      <div className="footer-grid">
        <div className="footer-col footer-brand">
          <div className="brand" style={{color: 'var(--cream)'}}>
            <div className="brand-mark">
              <img src="assets/logo.png" alt=""/>
            </div>
            <span>Lucky Shamrock</span>
          </div>
          <p>Residential bin cleaning. Family owned. Eco-safe. Annoyingly cheerful about trash.</p>
          <div className="service-area-row">
            <span className="area-pill">Fort Saskatchewan</span>
          </div>
        </div>
        <div className="footer-col">
          <h4>Service</h4>
          <ul>
            <li><a href="#how">How it works</a></li>
            <li><a href="#pricing">Plans & pricing</a></li>
            <li><a href="#book">Book a clean</a></li>
          </ul>
        </div>
        <div className="footer-col">
          <h4>Company</h4>
          <ul>
            <li><a href="#">About us</a></li>
            <li><a href="#reviews">Reviews</a></li>
            <li><a href="#faq">FAQ</a></li>
          </ul>
        </div>
        <div className="footer-col">
          <h4>Contact</h4>
          <ul>
            <li><a href={`tel:${tweaks.phone}`}>{tweaks.phone}</a></li>
            <li><a href="mailto:hello@luckyshamrock.co">hello@luckyshamrock.co</a></li>
            <li style={{color: 'rgba(255, 248, 232, 0.75)', fontSize: 15}}>Mon–Sat · 7am–6pm</li>
          </ul>
          <div className="socials" style={{marginTop: 14}}>
            <a href="#" aria-label="Instagram"><Icon.Instagram/></a>
            <a href="#" aria-label="Facebook"><Icon.Facebook/></a>
            <a href="#" aria-label="TikTok"><Icon.TikTok/></a>
          </div>
        </div>
      </div>
      <div className="footer-bottom">
        <div>© 2026 Lucky Shamrock Bin Cleaning · All rights reserved</div>
        <div style={{display: 'flex', gap: 18}}>
          <a href="#">Privacy</a>
          <a href="#">Terms</a>
          <a href="#">Service agreement</a>
        </div>
      </div>
    </div>
  </footer>
);

window.Testimonials = Testimonials;
window.FAQ = FAQ;
window.FooterCTA = FooterCTA;
window.Footer = Footer;
