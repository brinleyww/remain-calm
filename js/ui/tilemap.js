// Area picker on OpenStreetMap raster tiles: drag the square (or the map), wheel or buttons to zoom.
// Tiles load only for the visible view (light interactive use, per the tile usage policy).
import { h } from './dom.js';
import { OSM_ATTRIBUTION, OSM_ATTRIBUTION_URL } from '../map/osm.js';

const TILE = 256, Z_MIN = 3, Z_MAX = 18;
const TILE_URL = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const mpp = (lat, z) => 156543.03392 * Math.cos(lat * Math.PI / 180) / 2 ** z;
const toPx = (lat, lon, z) => {
  const s = TILE * 2 ** z, la = Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180;
  return [(lon + 180) / 360 * s, (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * s];
};
const toLL = (x, y, z) => {
  const s = TILE * 2 ** z;
  return [Math.atan(Math.sinh(Math.PI * (1 - 2 * y / s))) * 180 / Math.PI, x / s * 360 - 180];
};

// tileMap({ lat, lon, sizeKm, onChange(lat, lon) }) -> { el, set({lat, lon, sizeKm, fit}), lock(on), destroy }
export function tileMap({ lat = 51.5, lon = -0.12, sizeKm = 2, onChange = () => {}, label = 'Area map' } = {}) {
  const tiles = h('div.tmap-tiles');
  const square = h('div.tmap-square', h('span.tmap-tag'));
  const scale = h('div.tmap-scale', h('i'), h('span'));
  const zin = h('button.tmap-zoom', { type: 'button', title: 'Zoom in', 'aria-label': 'Zoom in' }, '+');
  const zout = h('button.tmap-zoom', { type: 'button', title: 'Zoom out', 'aria-label': 'Zoom out' }, '−');
  const coords = h('span.tmap-coords');
  const empty = h('div.tmap-empty', h('span.label', 'Search for a place to see the map'));
  const el = h('div.tmap', { tabIndex: 0, role: 'application', 'aria-label': label + '. Drag the square or use the arrow keys to move it.' },
    tiles, square, empty,
    h('div.tmap-tools', zin, zout),
    h('div.tmap-foot', coords, scale),
    h('a.tmap-attrib', { href: OSM_ATTRIBUTION_URL, target: '_blank', rel: 'noopener' }, OSM_ATTRIBUTION));

  const st = { lat, lon, sizeKm, vlat: lat, vlon: lon, z: 14, shown: false, locked: false };
  const imgs = new Map();
  let W = 0, H = 0, raf = 0;

  const fitZoom = () => {
    const w = W || 400;
    const z = Math.floor(Math.log2(156543.03392 * Math.cos(st.lat * Math.PI / 180) * w * 0.62 / (st.sizeKm * 1000)));
    return Math.max(Z_MIN, Math.min(Z_MAX - 1, z));
  };

  function draw() {
    raf = 0;
    W = el.clientWidth; H = el.clientHeight;
    empty.hidden = st.shown;
    tiles.hidden = square.hidden = !st.shown;
    if (!st.shown || !W || !H) return;
    const z = st.z, n = 2 ** z;
    const [cx, cy] = toPx(st.vlat, st.vlon, z);
    const tlx = cx - W / 2, tly = cy - H / 2;
    const want = new Set();
    for (let ty = Math.floor(tly / TILE); ty <= Math.floor((tly + H) / TILE); ty++) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = Math.floor(tlx / TILE); tx <= Math.floor((tlx + W) / TILE); tx++) {
        const key = `${z}/${tx}/${ty}`;
        want.add(key);
        let img = imgs.get(key);
        if (!img) {
          img = h('img.tmap-tile', { alt: '', draggable: false, decoding: 'async' });
          img.src = TILE_URL(z, ((tx % n) + n) % n, ty);
          imgs.set(key, img);
          tiles.appendChild(img);
        }
        img.style.transform = `translate(${Math.round(tx * TILE - tlx)}px, ${Math.round(ty * TILE - tly)}px)`;
      }
    }
    for (const [k, img] of imgs) if (!want.has(k)) { if (!img.complete) img.removeAttribute('src'); img.remove(); imgs.delete(k); }
    const [sx, sy] = toPx(st.lat, st.lon, z);
    const side = st.sizeKm * 1000 / mpp(st.lat, z);
    square.style.width = square.style.height = side + 'px';
    square.style.transform = `translate(${sx - tlx - side / 2}px, ${sy - tly - side / 2}px)`;
    square.firstChild.textContent = `${st.sizeKm} km`;
    coords.textContent = `${st.lat.toFixed(4)}, ${st.lon.toFixed(4)}`;
    const m = mpp(st.vlat, z), nice = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000].find(v => v / m >= 60) || 50000;
    scale.firstChild.style.width = Math.round(nice / m) + 'px';
    scale.lastChild.textContent = nice >= 1000 ? nice / 1000 + ' km' : nice + ' m';
  }
  const redraw = () => { if (!raf) raf = requestAnimationFrame(draw); };

  function zoomAt(dz, px = W / 2, py = H / 2) {
    const z2 = Math.max(Z_MIN, Math.min(Z_MAX, st.z + dz));
    if (z2 === st.z) return;
    const [cx, cy] = toPx(st.vlat, st.vlon, st.z);
    const [ax, ay] = [cx - W / 2 + px, cy - H / 2 + py];
    const [alat, alon] = toLL(ax, ay, st.z);
    const [bx, by] = toPx(alat, alon, z2);
    [st.vlat, st.vlon] = toLL(bx - px + W / 2, by - py + H / 2, z2);
    st.z = z2;
    redraw();
  }

  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    if (!st.shown || e.button !== 0 || e.target.closest('.tmap-tools, .tmap-attrib')) return;
    const onSquare = !st.locked && e.target.closest('.tmap-square');
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, mode: onSquare ? 'square' : 'pan', lat: st.lat, lon: st.lon, vlat: st.vlat, vlon: st.vlon, moved: false };
    el.setPointerCapture(e.pointerId);
    el.classList.add(onSquare ? 'is-moving' : 'is-panning');
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    if (drag.mode === 'square') {
      const [x, y] = toPx(drag.lat, drag.lon, st.z);
      [st.lat, st.lon] = toLL(x + dx, y + dy, st.z);
    } else {
      const [x, y] = toPx(drag.vlat, drag.vlon, st.z);
      [st.vlat, st.vlon] = toLL(x - dx, y - dy, st.z);
    }
    redraw();
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    el.classList.remove('is-moving', 'is-panning');
    if (d.mode === 'square' && d.moved) onChange(st.lat, st.lon);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', (e) => {
    if (!st.shown || st.locked || e.target.closest('.tmap-tools, .tmap-attrib')) return;
    const r = el.getBoundingClientRect();
    const [cx, cy] = toPx(st.vlat, st.vlon, st.z);
    [st.lat, st.lon] = toLL(cx - W / 2 + e.clientX - r.left, cy - H / 2 + e.clientY - r.top, st.z);
    redraw();
    onChange(st.lat, st.lon);
  });
  // One level per wheel notch, at most one per 150 ms: a trackpad swipe sends dozens of small events,
  // and each level it flew through would request a screenful of tiles.
  let wheelAcc = 0, wheelLast = 0, wheelStep = 0;
  el.addEventListener('wheel', (e) => {
    if (!st.shown) return;
    e.preventDefault();
    const t = performance.now();
    if (t - wheelLast > 300) wheelAcc = 0;
    wheelLast = t;
    wheelAcc += e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
    if (Math.abs(wheelAcc) < 50 || t - wheelStep < 150) return;
    const r = el.getBoundingClientRect();
    zoomAt(wheelAcc < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
    wheelAcc = 0; wheelStep = t;
  }, { passive: false });
  el.addEventListener('keydown', (e) => {
    if (!st.shown || st.locked) return;
    const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (k) {
      e.preventDefault();
      e.stopPropagation();
      const step = st.sizeKm * 1000 / mpp(st.lat, st.z) * (e.shiftKey ? 0.5 : 0.1);
      const [x, y] = toPx(st.lat, st.lon, st.z);
      [st.lat, st.lon] = toLL(x + k[0] * step, y + k[1] * step, st.z);
      redraw();
      onChange(st.lat, st.lon);
    } else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomAt(1); } else if (e.key === '-') { e.preventDefault(); zoomAt(-1); }
  });
  zin.addEventListener('click', () => zoomAt(1));
  zout.addEventListener('click', () => zoomAt(-1));

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(redraw) : null;
  if (ro) ro.observe(el);

  return {
    el,
    // fit: re-centre the view and choose a zoom that frames the square
    set({ lat: la, lon: lo, sizeKm: s, fit = false } = {}) {
      if (Number.isFinite(la) && Number.isFinite(lo)) { st.lat = la; st.lon = lo; st.shown = true; }
      if (Number.isFinite(s)) st.sizeKm = s;
      if (fit) { W = el.clientWidth || W; st.vlat = st.lat; st.vlon = st.lon; st.z = fitZoom(); }
      else if (Number.isFinite(s)) {
        const side = st.sizeKm * 1000 / mpp(st.lat, st.z);
        if (W && (side > W * 0.9 || side < W * 0.12)) st.z = fitZoom();
      }
      redraw();
    },
    lock(on) { st.locked = !!on; el.classList.toggle('is-locked', st.locked); },
    get centre() { return { lat: st.lat, lon: st.lon }; },
    get shown() { return st.shown; },
    redraw,
    destroy() { if (ro) ro.disconnect(); cancelAnimationFrame(raf); for (const img of imgs.values()) img.removeAttribute('src'); imgs.clear(); },
  };
}
