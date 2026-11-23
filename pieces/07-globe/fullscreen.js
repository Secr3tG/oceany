// Full-screen button under the zoom controls. Uses the Fullscreen API where the browser has it (desktop, Android, iPad).
// iPhone Safari has no full screen for pages, so there the button explains the one way that works: Add to Home Screen
// (manifest.webmanifest has "display": "standalone", which opens the globe without the browser bars).
const btn = document.getElementById('fullscreen');
const root = document.documentElement;
const can = !!(root.requestFullscreen || root.webkitRequestFullscreen);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isOn = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

if (!btn || standalone) {
  if (btn) btn.hidden = true;   // already full screen from the home screen
} else {
  const sync = () => {
    const on = isOn();
    btn.setAttribute('aria-pressed', String(on));
    btn.title = btn.ariaLabel = on ? 'Leave full screen' : 'Full screen';
    btn.classList.toggle('on', on);
  };
  btn.addEventListener('click', async () => {
    if (!can) { showTip(); return; }
    try {
      if (isOn()) await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else await (root.requestFullscreen || root.webkitRequestFullscreen).call(root, { navigationUI: 'hide' });
    } catch (e) { console.info('Oceany globe: full screen refused by the browser:', e && e.message); }
  });
  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);
  sync();
}

function showTip() {
  let tip = document.getElementById('fullscreen-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'fullscreen-tip';
    tip.setAttribute('role', 'status');
    tip.textContent = 'For full screen on iPhone: tap Share, then Add to Home Screen, and open the globe from there.';
    tip.onclick = () => (tip.hidden = true);
    document.body.appendChild(tip);
  }
  tip.hidden = false;
  clearTimeout(showTip.t);
  showTip.t = setTimeout(() => (tip.hidden = true), 6000);
}
