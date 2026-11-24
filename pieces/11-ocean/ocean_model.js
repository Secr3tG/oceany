// The GFS / ECMWF switch for the wind and wave-height layers. GFS at load; ECMWF is opt-in (or ?ocean_model=ecmwf).
// Plumbing, mostly: wind.js and waves.js call mountModelSwitch(layer) once; it waits for the globe to give the layer
// its row in the layers panel (globe.js sets layer.userData.row after createLayer returns) and puts a small two-button
// group under it, styled like the globe's own mode switch (.layer-modes in index.html). Both rows share one choice:
// pressing ECMWF under wind also switches the wave layer, because comparing wind from one model with waves from the
// other would mislead. The swell fronts stay on GFS-Wave (ECMWF's open data has no swell partitions).
// The part worth understanding: setModel() in ocean_data.js clears nothing; it tells each ocean layer to reload, and
// each model keeps its own cache, so flipping back and forth costs no download after the first.
import { MODELS, getModel, setModel } from './ocean_data.js';

const groups = new Set();
const TITLE = {
  gfs: 'NOAA GFS (wind) and GFS-Wave / WAVEWATCH III (waves): hourly steps, public domain',
  ecmwf: 'ECMWF IFS (wind) and ecWAM (waves): 3-hourly steps, open data under CC BY 4.0',
};

// The row's own title (from layers.json, e.g. "Wind at 10 m (GFS model)") names the model too: follow the switch.
const titles = new Map();         // title element -> its layers.json text
const retitle = (t) => getModel() === 'gfs' ? t : t.replace(/\((GFS|WAVEWATCH III|GFS-Wave)[^)]*\)/, `(${MODELS[getModel()].label} model)`);

function sync() {
  for (const [el, t] of titles) el.textContent = retitle(t);
  for (const g of groups) for (const b of g.querySelectorAll('button')) {
    const on = b.dataset.model === getModel();
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
}

export function mountModelSwitch(layer) {
  let tries = 0;
  const attach = () => {
    const row = layer.userData && layer.userData.row;
    if (!row || !row.parentElement) { if (++tries < 200) setTimeout(attach, 100); return; }
    const g = document.createElement('div');
    g.className = 'layer-modes ocean-model';
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', 'Model');
    g.style.margin = '0 0 4px 22px';
    const lab = document.createElement('span');
    lab.textContent = 'Model';
    lab.style.cssText = 'font-size:11px;opacity:.7;align-self:center;margin-right:2px';
    g.appendChild(lab);
    for (const id of Object.keys(MODELS)) {
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.model = id; b.textContent = MODELS[id].label; b.title = TITLE[id] || '';
      b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); setModel(id); sync(); };
      g.appendChild(b);
    }
    row.after(g);                                  // straight under the layer's checkbox row
    groups.add(g);
    const title = row.querySelector('span');
    if (title && !titles.has(title)) titles.set(title, title.textContent);
    const box = row.querySelector('input[type=checkbox]');
    const show = () => { g.style.display = box && !box.checked ? 'none' : 'flex'; };
    if (box) box.addEventListener('change', show);
    show(); sync();
  };
  if (typeof document !== 'undefined') attach();
}
