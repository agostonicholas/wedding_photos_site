(() => {
  // This runs in the head, before the page can flash the uploader.
  let savedName = '';
  try { savedName = (localStorage.getItem('weddingUploaderName') || '').trim(); }
  catch { /* Without saved browser data, treat this as a first visit. */ }
  if (savedName) return;

  const root = document.documentElement;
  root.classList.add('intro-active');
  const preload = document.createElement('link');
  preload.rel = 'preload';
  preload.as = 'image';
  preload.href = 'logo_large.png';
  document.head.append(preload);
  const reducedMotion = Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  let intro;
  let logo;
  let holdTimer;
  let fadeTimer;
  let safetyTimer;
  let leaving = false;
  let finished = false;
  const content = () => [document.getElementById('upload-card'), document.getElementById('welcome-overlay')].filter(Boolean);
  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(holdTimer);
    clearTimeout(fadeTimer);
    clearTimeout(safetyTimer);
    if (intro) { intro.hidden = true; intro.removeEventListener('transitionend', onTransitionEnd); }
    root.classList.remove('intro-active', 'intro-leaving');
    content().forEach(element => { element.inert = false; });
    preload.remove();
    document.dispatchEvent(new Event('wedding:intro-finished'));
  }
  function onTransitionEnd(event) {
    if (event.target === intro && event.propertyName === 'opacity') finish();
  }
  function fadeOut() {
    if (leaving || finished) return;
    leaving = true;
    clearTimeout(holdTimer);
    clearTimeout(safetyTimer);
    root.classList.add('intro-leaving');
    document.dispatchEvent(new Event('wedding:intro-reveal'));
    if (!intro || reducedMotion) { finish(); return; }
    intro.addEventListener('transitionend', onTransitionEnd);
    fadeTimer = setTimeout(finish, 650);
  }
  function ready() {
    if (leaving || finished || holdTimer !== undefined) return;
    intro.classList.add('logo-ready');
    holdTimer = setTimeout(fadeOut, 1600);
  }
  function start() {
    intro = document.getElementById('brand-intro');
    logo = document.getElementById('intro-logo');
    if (!intro || !logo) { finish(); return; }
    intro.hidden = false;
    content().forEach(element => { element.inert = true; });
    logo.addEventListener('load', ready, { once: true });
    logo.addEventListener('error', fadeOut, { once: true });
    // Do not trap the visitor on a loading screen if the image never arrives.
    safetyTimer = setTimeout(fadeOut, 4500);
    logo.src = logo.dataset.src;
    if (logo.complete && logo.naturalWidth > 0) ready();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
