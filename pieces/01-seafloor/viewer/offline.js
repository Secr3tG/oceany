// Opt-in offline mode for the reef viewer (the same switch as the globe): ?offline=1 registers sw.js, ?offline=0 removes it and its
// caches. Without the parameter nothing changes (an earlier opt-in stays until ?offline=0). When the worker serves saved data
// because the network is gone, a small calm line says so.
(function () {
  const q = new URLSearchParams(location.search).get('offline');
  const sw = 'serviceWorker' in navigator ? navigator.serviceWorker : null;
  const mine = r => new URL(r.scope).pathname.endsWith('/01-seafloor/viewer/');
  if (sw && q === '1') sw.register('./sw.js', { scope: './' }).catch(e => console.info('Oceany viewer: offline mode not available:', e && e.message));
  if (sw && q === '0') {
    sw.getRegistrations().then(rs => rs.forEach(r => { if (mine(r)) r.unregister(); }));
    if (window.caches) caches.keys().then(ks => ks.forEach(k => { if (k.startsWith('reefviewer-')) caches.delete(k); }));
  }
  let line = null;
  async function show() {
    let t = Date.now();
    try { const r = await caches.match('./saved', { cacheName: 'reefviewer-meta-1' }); if (r) t = (await r.json()).t; } catch (e) { /* undated */ }
    const d = new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    if (!line) {
      line = document.createElement('div'); line.id = 'offline-note'; line.setAttribute('role', 'status');
      document.body.appendChild(line);
    }
    line.textContent = 'Offline: showing saved data from ' + d;
  }
  function hide() { if (line) { line.remove(); line = null; } }
  if (!sw || !window.caches) return;
  sw.addEventListener('message', e => { if (e.data && e.data.type === 'reefviewer-offline') show(); });
  window.addEventListener('offline', () => { if (sw.controller) show(); });
  window.addEventListener('online', hide);
  if (!navigator.onLine && sw.controller) show();
})();
