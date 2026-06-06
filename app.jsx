/* global React, ReactDOM, Nav, Hero, BeforeAfter, HowItWorks, WhyClean, Pricing, Booking, Testimonials, FAQ, FooterCTA, Footer, TweaksPanel, useTweaks, TweakSection, TweakText, TweakColor, TweakSelect */
const { useEffect } = React;

const PALETTES = {
  shamrock: { green: '#2D7A2D', deep: '#1F5A1F', darker: '#143C14', soft: '#E8F3E0', mist: '#F2F8EC' },
  forest:   { green: '#1F6B47', deep: '#0F4D30', darker: '#0A331F', soft: '#DEEFE5', mist: '#EAF5EE' },
  meadow:   { green: '#4A9B3A', deep: '#387828', darker: '#1F4818', soft: '#E9F4DE', mist: '#F0F8E9' },
};

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "city": "Fort Saskatchewan",
  "phone": "(587) 982-8887",
  "startingPrice": 35,
  "palette": "shamrock"
}/*EDITMODE-END*/;

function App() {
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);

  // accent palette swap
  useEffect(() => {
    const root = document.documentElement;
    const p = PALETTES[tweaks.palette] || PALETTES.shamrock;
    root.style.setProperty('--green', p.green);
    root.style.setProperty('--green-deep', p.deep);
    root.style.setProperty('--green-darker', p.darker);
    root.style.setProperty('--green-soft', p.soft);
    root.style.setProperty('--green-mist', p.mist);
  }, [tweaks.palette]);

  const scrollToBook = () => {
    const el = document.getElementById('book');
    if (el) window.scrollTo({ top: el.offsetTop - 60, behavior: 'smooth' });
  };

  return (
    <div className="app">
      <Nav tweaks={tweaks} onBookClick={scrollToBook}/>
      <Hero tweaks={tweaks} onBookClick={scrollToBook}/>
      <BeforeAfter/>
      <HowItWorks onBookClick={scrollToBook}/>
      <WhyClean/>
      <Pricing tweaks={tweaks} onBookClick={scrollToBook}/>
      <Booking tweaks={tweaks}/>
      <Testimonials/>
      <FAQ tweaks={tweaks}/>
      <FooterCTA onBookClick={scrollToBook} tweaks={tweaks}/>
      <Footer tweaks={tweaks}/>

      <TweaksPanel title="Tweaks">
        <TweakSection title="Brand details">
          <TweakText
            label="City / service area"
            value={tweaks.city}
            onChange={v => setTweak('city', v)}
          />
          <TweakText
            label="Phone number"
            value={tweaks.phone}
            onChange={v => setTweak('phone', v)}
          />
        </TweakSection>
        <TweakSection title="Green palette">
          <TweakSelect
            label="Tone"
            value={tweaks.palette}
            options={['shamrock', 'forest', 'meadow']}
            onChange={v => setTweak('palette', v)}
          />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
