/* global React */
const { useState, useEffect, useRef } = React;

// ===== Inline SVG icons (originals — no branded icon sets) =====
const Icon = {
  Sparkle: ({ size = 16, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M12 2L13.8 9.4L21 10.5L13.8 11.6L12 19L10.2 11.6L3 10.5L10.2 9.4L12 2Z" fill={color}/>
    </svg>
  ),
  Star: ({ size = 16, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <path d="M12 2l3 7 7 .8-5.3 4.8 1.7 7.4L12 17.7 5.6 22l1.7-7.4L2 9.8 9 9z"/>
    </svg>
  ),
  Check: ({ size = 14, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="5 12 10 17 19 7"/>
    </svg>
  ),
  Plus: ({ size = 14, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round">
      <path d="M12 5v14M5 12h14"/>
    </svg>
  ),
  Arrow: ({ size = 16, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14M13 5l7 7-7 7"/>
    </svg>
  ),
  Calendar: ({ size = 22, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="16" rx="2"/>
      <path d="M3 10h18M8 3v4M16 3v4"/>
    </svg>
  ),
  Truck: ({ size = 26, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7h11v9H3z"/>
      <path d="M14 11h4l3 3v2h-7z"/>
      <circle cx="7" cy="18" r="2"/>
      <circle cx="17" cy="18" r="2"/>
    </svg>
  ),
  Bubbles: ({ size = 26, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <circle cx="9" cy="14" r="4"/>
      <circle cx="16" cy="9" r="2.5"/>
      <circle cx="6" cy="7" r="1.5"/>
    </svg>
  ),
  Phone: ({ size = 16, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6 19.8 19.8 0 01-3.1-8.7A2 2 0 014 2h3a2 2 0 012 1.7c.1.9.3 1.8.6 2.6a2 2 0 01-.5 2.1L8 9.6a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.5c.8.3 1.7.5 2.6.6a2 2 0 011.7 2z"/>
    </svg>
  ),
  Shield: ({ size = 18, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l8 4v6c0 5-3.5 9.4-8 10-4.5-.6-8-5-8-10V6z"/>
    </svg>
  ),
  Leaf: ({ size = 18, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 3c0 9-6 14-12 14-2 0-4-.6-5-1.5C5 7 13 3 21 3z"/>
      <path d="M4 21c2-6 5-9 12-14"/>
    </svg>
  ),
  Heart: ({ size = 18, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <path d="M12 21s-7-4.5-9.5-9C1 8.5 3 4 7 4c2 0 3.5 1 5 3 1.5-2 3-3 5-3 4 0 6 4.5 4.5 8C19 16.5 12 21 12 21z"/>
    </svg>
  ),
  Instagram: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="5"/>
      <circle cx="12" cy="12" r="4"/>
      <circle cx="17" cy="7" r="1" fill="currentColor"/>
    </svg>
  ),
  Facebook: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M13 22v-8h3l.5-4H13V7.5c0-1.2.3-2 2-2h2v-3.4C16.5 2 15.4 2 14 2c-3 0-5 1.8-5 5.1V10H6v4h3v8z"/>
    </svg>
  ),
  TikTok: ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M16 3c.5 2.5 2 4 4.5 4.5v3.2c-1.7 0-3.2-.4-4.5-1.3v6.6c0 4-3 6.5-6.5 6c-3-.4-5.4-2.9-5.5-6c0-3.5 3-6.5 6.5-6.2v3.4c-1.8-.3-3.4 1-3.4 2.8c0 1.7 1.4 3 3.2 3c1.8 0 3.2-1.3 3.2-3V3z"/>
    </svg>
  ),
  Wave: ({ size = 22, color = "currentColor" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12c2-2 4-2 6 0s4 2 6 0 4-2 6 0 4 2 6 0" />
    </svg>
  ),
  Stink: ({ size = 80, color = "#5a7a1f" }) => (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none">
      <path d="M40 70 Q30 60 35 50 Q45 40 30 30 Q20 20 35 10" stroke={color} strokeWidth="4" strokeLinecap="round"/>
      <path d="M50 72 Q40 62 50 52 Q60 42 50 32 Q45 22 55 10" stroke={color} strokeWidth="4" strokeLinecap="round" opacity="0.6"/>
    </svg>
  ),
};

// ===== Bin SVG (gleaming clean version) =====
const CleanBin = ({ size = 200 }) => (
  <svg width={size} height={size * 1.05} viewBox="0 0 200 210" fill="none">
    <defs>
      <linearGradient id="binGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#3A9A3A"/>
        <stop offset="100%" stopColor="#1F5A1F"/>
      </linearGradient>
    </defs>
    {/* lid */}
    <rect x="20" y="38" width="160" height="14" rx="4" fill="#1F5A1F"/>
    <rect x="20" y="38" width="160" height="6" rx="3" fill="#3A9A3A"/>
    {/* body */}
    <path d="M30 52 L40 200 L160 200 L170 52 Z" fill="url(#binGrad)"/>
    {/* vertical lines */}
    <path d="M70 60 L74 195" stroke="#1F5A1F" strokeWidth="2" opacity="0.4"/>
    <path d="M100 60 L100 195" stroke="#1F5A1F" strokeWidth="2" opacity="0.4"/>
    <path d="M130 60 L126 195" stroke="#1F5A1F" strokeWidth="2" opacity="0.4"/>
    {/* shine */}
    <path d="M45 60 L52 195" stroke="white" strokeWidth="6" opacity="0.25" strokeLinecap="round"/>
    {/* wheel */}
    <circle cx="42" cy="200" r="8" fill="#1F1A12"/>
    <circle cx="158" cy="200" r="8" fill="#1F1A12"/>
    {/* sparkles */}
    <g fill="#A8D8EA">
      <circle cx="60" cy="80" r="3"/>
      <circle cx="140" cy="100" r="4"/>
      <circle cx="80" cy="140" r="2.5"/>
      <circle cx="155" cy="160" r="3"/>
    </g>
  </svg>
);

// ===== Nav =====
const Nav = ({ tweaks, onBookClick }) => (
  <nav className="nav">
    <div className="nav-inner">
      <a href="#top" className="brand">
        <div className="brand-mark">
          <img src="assets/logo.png" alt="Lucky Shamrock"/>
        </div>
      </a>
      <div className="nav-links">
        <a href="#how">How it works</a>
        <a href="#pricing">Pricing</a>
        <a href="#reviews">Reviews</a>
        <a href="#faq">FAQ</a>
      </div>
      <div className="nav-cta">
        <a href={`tel:${tweaks.phone}`} className="btn btn-ghost nav-phone" aria-label={`Call ${tweaks.phone}`}>
          <Icon.Phone size={14}/>
          <span className="nav-phone-text">{tweaks.phone}</span>
        </a>
        <button className="btn btn-primary" onClick={onBookClick}>
          Book a clean
        </button>
      </div>
    </div>
  </nav>
);

// ===== Hero =====
const Hero = ({ tweaks, onBookClick }) => (
  <section className="hero" id="top">
    <div className="container">
      <div className="hero-grid">
        <div className="hero-copy">
          <h1>
            Your garbage bins,<br/>
            <span className="accent">spotlessly clean</span><br/>
            every time.
          </h1>
          <p className="hero-sub">
            Stop being mad or embarrassed at your garbage bin. We clean it on
            collection day — sanitized, deodorized, and fresh before it comes
            back to your house. Start smelling freshness.
          </p>
          <div className="hero-cta">
            <button className="btn btn-primary" onClick={onBookClick}>
              Book a clean <Icon.Arrow size={16}/>
            </button>
            <a href="#pricing" className="btn btn-cream">See plans — from ${tweaks.startingPrice}/mo</a>
          </div>
          <div className="hero-trust">
            <div className="hero-trust-item">
              <span className="stars">
                <Icon.Star size={16}/><Icon.Star size={16}/><Icon.Star size={16}/><Icon.Star size={16}/><Icon.Star size={16}/>
              </span>
              4.9 · 380+ neighbors
            </div>
            <div className="hero-trust-item">
              <Icon.Shield size={16} color="var(--green)"/> Fully insured
            </div>
            <div className="hero-trust-item">
              <Icon.Leaf size={16} color="var(--green)"/> Eco-safe formula
            </div>
          </div>
        </div>
        <div className="hero-visual">
          <div className="hero-mascot-frame">
            <video autoPlay muted loop playsInline poster="assets/mascot-after.jpg">
              <source src="assets/bin-clean.mp4" type="video/mp4" />
            </video>
          </div>
        </div>
      </div>
    </div>
  </section>
);

window.Icon = Icon;
window.CleanBin = CleanBin;
window.Nav = Nav;
window.Hero = Hero;
