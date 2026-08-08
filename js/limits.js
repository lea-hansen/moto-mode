/* Tempolimit aus OpenStreetMap — unabhängig von einer laufenden Navigation.

   iOS liefert Web-Apps keine Tempolimits. Die einzige nutzbare Quelle ist die
   Overpass-API: Sie liefert die Straßen im Umkreis samt Geometrie und Tags,
   daraus wird die nächstgelegene passende Straße bestimmt.

   Konsequenz: Der Abruf braucht Netz. Jede abgefragte Zelle landet dauerhaft im
   Cache, damit bekannte Strecken auch im Funkloch ein Limit zeigen — beim
   ersten Befahren einer Straße braucht es aber Empfang.

   Angezeigt wird immer die Herkunft des Werts, damit klar ist, wie belastbar er
   ist: `Schild` (getaggtes maxspeed), `Zone` (maxspeed:type/zone:maxspeed) oder
   `Annahme` (nur bei eindeutigen Straßentypen). Alles andere bleibt „—“. */

import { settings } from './store.js';

const CACHE_KEY = 'moto.limits.v1';
const MIN_INTERVAL = 12000;   // Overpass ist ein Gemeinschaftsdienst — sparsam abfragen
const MIN_MOVE = 70;          // Meter, bevor erneut gefragt wird
const RADIUS = 50;            // Suchradius: GPS streut allein schon 5–15 m
const MAX_CACHE = 800;
const BUSY_BACKOFF = 60000;   // Overpass antwortet zeitweise mit 429/504
const MAX_AGE = 180 * 864e5;  // Cache-Einträge nach ~6 Monaten erneuern

export const limit = {
  kmh: null,        // Zahl in km/h, oder null wenn unbekannt
  free: false,      // unbegrenzt (deutsche Autobahn ohne Beschilderung)
  road: '',
  area: null,       // Innerorts | Außerorts | Autobahn
  source: '',       // Schild | Zone | Annahme
  cached: false,
  state: 'idle',    // idle | loading | ok | offline | busy | error | aus
  updated: 0,
};

const listeners = new Set();
export function onLimit(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) fn(limit); }

/* ── Cache ─────────────────────────────────────────────────────────────── */

let cache = {};
try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { cache = {}; }

let cacheDirty = false;
function saveCache() {
  if (!cacheDirty) return;
  cacheDirty = false;
  const keys = Object.keys(cache);
  if (keys.length > MAX_CACHE) {
    keys.sort((a, b) => cache[a].t - cache[b].t)
        .slice(0, keys.length - MAX_CACHE)
        .forEach((k) => delete cache[k]);
  }
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {}
}
setInterval(saveCache, 10000);

/** Rasterzelle von rund 110 × 70 m. */
function cellKey(lat, lon) { return `${lat.toFixed(3)},${lon.toFixed(3)}`; }

export function clearCache() {
  cache = {};
  try { localStorage.removeItem(CACHE_KEY); } catch {}
}
export function cacheSize() { return Object.keys(cache).length; }

/* ── Tag-Auswertung ────────────────────────────────────────────────────── */

/** Zonen-Schlüssel wie „DE:urban“ — die verlässlichste Quelle nach maxspeed. */
const ZONES = {
  'de:urban': { kmh: 50 },      'de:rural': { kmh: 100 },     'de:motorway': { free: true },
  'de:living_street': { kmh: 7 }, 'de:bicycle_road': { kmh: 30 },
  'at:urban': { kmh: 50 },      'at:rural': { kmh: 100 },     'at:motorway': { kmh: 130 },
  'ch:urban': { kmh: 50 },      'ch:rural': { kmh: 80 },      'ch:motorway': { kmh: 120 },
  'it:urban': { kmh: 50 },      'it:rural': { kmh: 90 },      'it:motorway': { kmh: 130 },
  'fr:urban': { kmh: 50 },      'fr:rural': { kmh: 80 },      'fr:motorway': { kmh: 130 },
  'nl:urban': { kmh: 50 },      'nl:rural': { kmh: 80 },      'nl:motorway': { kmh: 100 },
};

/** Nur eindeutige Straßentypen. Bei primary/secondary hängt das Limit davon ab,
    ob die Straße innerorts liegt — das wird hier bewusst nicht geraten. */
const BY_TYPE = {
  motorway: { free: true }, motorway_link: { free: true },
  living_street: { kmh: 7 },
  residential: { kmh: 50 },
};

function parseMaxspeed(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (s === 'none') return { free: true };
  if (s === 'walk') return { kmh: 7 };
  const mph = s.match(/^(\d+(?:[.,]\d+)?)\s*mph$/);
  if (mph) return { kmh: Math.round(parseFloat(mph[1].replace(',', '.')) * 1.609344) };
  const kmh = s.match(/^(\d+(?:[.,]\d+)?)(?:\s*km\/h)?$/);
  if (kmh) return { kmh: Math.round(parseFloat(kmh[1].replace(',', '.'))) };
  return null;                                  // „DE:urban“, „signals“, Bedingtes …
}

/** Ortslage aus den Tags. Zone schlägt Straßentyp; bei primary/secondary ohne
    Zone bleibt es offen, weil dieselbe Straße innerorts wie außerorts verläuft. */
function areaOf(tags) {
  const hw = tags.highway;
  if (hw === 'motorway' || hw === 'motorway_link') return 'Autobahn';

  const zone = String(tags['maxspeed:type'] || tags['zone:maxspeed'] || '').toLowerCase();
  if (zone.endsWith(':urban') || zone.endsWith(':living_street') || zone.endsWith(':zone30')) return 'Innerorts';
  if (zone.endsWith(':rural')) return 'Außerorts';
  if (zone.endsWith(':motorway')) return 'Autobahn';

  if (hw === 'residential' || hw === 'living_street') return 'Innerorts';
  if (hw === 'trunk' || hw === 'trunk_link') return 'Außerorts';
  return null;
}

function resolve(tags) {
  const direct = parseMaxspeed(tags.maxspeed);
  if (direct) return { ...direct, source: 'Schild' };

  const zone = String(tags['maxspeed:type'] || tags['zone:maxspeed'] || '').toLowerCase();
  if (ZONES[zone]) return { ...ZONES[zone], source: 'Zone' };

  const byType = BY_TYPE[tags.highway];
  if (byType) return { ...byType, source: 'Annahme' };

  return null;
}

/* ── Geometrie ─────────────────────────────────────────────────────────── */

function project(lat, lon, lat0) {
  const k = Math.cos((lat0 * Math.PI) / 180);
  return [lon * 111320 * k, lat * 110540];
}

/** Abstand Punkt→Strecke in Metern (lokal eben gerechnet, hier völlig genug). */
function segmentDistance(p, a, b) {
  const abx = b[0] - a[0], aby = b[1] - a[1];
  const apx = p[0] - a[0], apy = p[1] - a[1];
  const len = abx * abx + aby * aby;
  const t = len ? Math.max(0, Math.min(1, (apx * abx + apy * aby) / len)) : 0;
  const dx = apx - t * abx, dy = apy - t * aby;
  return Math.hypot(dx, dy);
}

function bearing(a, b) {
  return (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
}

function angleDelta(a, b) {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}

/** Nächstgelegene Straße; Fahrtrichtung entscheidet bei Parallelstraßen mit. */
function pickWay(ways, lat, lon, heading) {
  const p = project(lat, lon, lat);
  let best = null;

  for (const way of ways) {
    const g = way.geometry;
    if (!g || g.length < 2) continue;
    const pts = g.map((n) => project(n.lat, n.lon, lat));

    let dist = Infinity, dir = null;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = segmentDistance(p, pts[i], pts[i + 1]);
      if (d < dist) { dist = d; dir = bearing(pts[i], pts[i + 1]); }
    }

    // Straßen quer zur Fahrtrichtung werden abgewertet, nicht ausgeschlossen.
    let score = dist;
    if (heading != null && dir != null) {
      const off = angleDelta(heading, dir);
      if (off > 50 && off < 130) score += 30;
    }
    if (!best || score < best.score) best = { way, dist, score };
  }
  return best;
}

/* ── Abfrage ───────────────────────────────────────────────────────────── */

const ROAD_TYPES = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|'
                 + 'living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';

let lastQuery = null;      // { lat, lon, t }
let inFlight = false;
let backoffUntil = 0;

async function query(lat, lon, heading) {
  inFlight = true;
  limit.state = 'loading';
  emit();

  const ql = `[out:json][timeout:10];`
    + `way(around:${RADIUS},${lat},${lon})["highway"~"^(${ROAD_TYPES})$"];`
    + `out tags geom 40;`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);

  try {
    const res = await fetch(settings.overpass, { method: 'POST', body: ql, signal: ctrl.signal });
    // 429/504 heißt „Server gerade überlastet“, nicht „kaputt“ — kurz aussetzen.
    if (res.status === 429 || res.status === 504) { backoffUntil = Date.now() + BUSY_BACKOFF; throw new Error('busy'); }
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    const hit = pickWay(data.elements || [], lat, lon, heading);

    if (!hit) {
      apply({ kmh: null, free: false, road: '', area: null, source: '' }, false);
    } else {
      const tags = hit.way.tags || {};
      const resolved = resolve(tags) || {};
      const entry = {
        kmh: resolved.kmh ?? null,
        free: !!resolved.free,
        road: tags.name || tags.ref || '',
        area: areaOf(tags),
        source: resolved.source || '',
        t: Date.now(),
      };
      cache[cellKey(lat, lon)] = entry;
      cacheDirty = true;
      apply(entry, false);
    }
    limit.state = 'ok';
  } catch (err) {
    if (!navigator.onLine) limit.state = 'offline';
    else if (err && err.message === 'busy') limit.state = 'busy';
    else { backoffUntil = Date.now() + BUSY_BACKOFF; limit.state = 'error'; }
  } finally {
    clearTimeout(timer);
    inFlight = false;
    emit();
  }
}

function apply(entry, fromCache) {
  limit.kmh = entry.kmh ?? null;
  limit.free = !!entry.free;
  limit.road = entry.road || '';
  limit.area = entry.area || null;
  limit.source = entry.source || '';
  limit.cached = fromCache;
  limit.updated = Date.now();
}

/** Wird bei jedem GPS-Fix aufgerufen. */
export function updatePosition(lat, lon, heading) {
  if (lat == null || lon == null) return;

  if (!settings.limits) {
    if (limit.state !== 'aus') { limit.state = 'aus'; limit.kmh = null; emit(); }
    return;
  }

  const hit = cache[cellKey(lat, lon)];
  if (hit && Date.now() - hit.t < MAX_AGE) {
    apply(hit, true);
    if (limit.state !== 'loading') limit.state = 'ok';
    emit();
  }

  if (inFlight) return;
  if (!navigator.onLine) {
    if (limit.state !== 'offline' && !hit) { limit.state = 'offline'; emit(); }
    return;
  }

  const now = Date.now();
  if (now < backoffUntil) return;
  if (lastQuery) {
    if (now - lastQuery.t < MIN_INTERVAL) return;
    const [x1, y1] = project(lat, lon, lat);
    const [x2, y2] = project(lastQuery.lat, lastQuery.lon, lat);
    if (Math.hypot(x1 - x2, y1 - y2) < MIN_MOVE && hit) return;
  }
  lastQuery = { lat, lon, t: now };
  query(lat, lon, heading);
}
