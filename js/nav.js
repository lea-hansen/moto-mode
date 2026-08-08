/* Abbiegenavigation.

   Route und Ansagetexte kommen von Valhalla mit Motorrad-Kostenmodell; die
   Ansagen sind dort bereits auf Deutsch formuliert. Alles danach — Position auf
   die Route projizieren, Restweg, Abstand zum nächsten Manöver, Auslösen der
   Ansagen, Erkennen einer verlassenen Route — rechnet die App selbst.

   Wichtig: Die Berechnung braucht Netz, das Abfahren nicht. Ist die Route
   einmal geholt, laufen Führung und Ansagen offline weiter. Wer im Funkloch
   falsch abbiegt, bekommt allerdings keine neue Route — dafür müsste ein
   Routing-Graph auf dem Gerät liegen, und der ist zu groß fürs Telefon. */

import { settings } from './store.js';
import { speak } from './audio.js';
import { phrases } from './phrases.js';

export const nav = {
  state: 'idle',        // idle | geocoding | routing | planned | active | offroute | arrived | error
  error: '',
  stops: [],            // Zwischenziele und Ziel, in Reihenfolge
  dest: null,           // letztes Ziel der Kette
  routes: [],           // Hauptroute und Alternativen
  legEnds: [],          // Punktindizes, an denen ein Abschnitt endet
  passed: 0,            // erreichte Zwischenziele
  selected: 0,
  shape: [],            // Geometrie der gewählten Route, [[lat, lon], …]
  maneuvers: [],
  idx: 0,               // Manöver, auf das gerade zugefahren wird
  distToTurn: 0,        // Meter
  remainingM: 0,
  remainingS: 0,
  offRouteM: 0,
};

const listeners = new Set();
export function onNav(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) fn(nav); }

/* ── Geometrie ─────────────────────────────────────────────────────────── */

/** Valhalla liefert die Streckengeometrie als Polyline mit sechs Nachkommastellen. */
function decodePolyline(str, precision = 6) {
  const factor = 10 ** precision;
  let index = 0, lat = 0, lon = 0;
  const out = [];
  while (index < str.length) {
    let result = 1, shift = 0, b;
    do { b = str.charCodeAt(index++) - 63 - 1; result += b << shift; shift += 5; } while (b >= 0x1f);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    result = 1; shift = 0;
    do { b = str.charCodeAt(index++) - 63 - 1; result += b << shift; shift += 5; } while (b >= 0x1f);
    lon += (result & 1) ? ~(result >> 1) : (result >> 1);
    out.push([lat / factor, lon / factor]);
  }
  return out;
}

let xy = [];          // Route in Metern, lokal eben projiziert
let cum = [];         // aufsummierte Länge bis zum jeweiligen Punkt
let lat0 = 0;

function project(lat, lon) {
  return [lon * 111320 * Math.cos((lat0 * Math.PI) / 180), lat * 110540];
}

function prepare() {
  lat0 = nav.shape.length ? nav.shape[0][0] : 0;
  xy = nav.shape.map(([la, lo]) => project(la, lo));
  cum = new Array(xy.length).fill(0);
  for (let i = 1; i < xy.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
  }
}

/** Lotfußpunkt auf einem Streckenabschnitt: Abstand und Anteil t. */
function projectOnSegment(p, a, b) {
  const abx = b[0] - a[0], aby = b[1] - a[1];
  const len = abx * abx + aby * aby;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len)) : 0;
  const dx = p[0] - (a[0] + t * abx), dy = p[1] - (a[1] + t * aby);
  return { dist: Math.hypot(dx, dy), t };
}

let lastSeg = 0;

/** Position auf die Route setzen — bewusst nur im Fenster um den letzten
    Treffer. Ein globaler Suchlauf würde bei Routen, die sich kreuzen oder
    parallel zurückführen, auf einen ganz anderen Abschnitt springen und den
    Restweg verfälschen. Wer wirklich daneben ist, gilt lieber als „Route
    verlassen“ und bekommt eine neue Route. */
function matchToRoute(lat, lon) {
  const p = project(lat, lon);
  let best = { dist: Infinity, seg: lastSeg, t: 0 };
  const from = Math.max(0, lastSeg - 10);
  const to = Math.min(xy.length - 1, lastSeg + 600);   // ~12 km — überbrückt auch eine GPS-Lücke im Tunnel
  for (let i = from; i < to; i++) {
    const r = projectOnSegment(p, xy[i], xy[i + 1]);
    if (r.dist < best.dist) best = { dist: r.dist, seg: i, t: r.t };
  }
  lastSeg = best.seg;

  const segLen = cum[best.seg + 1] - cum[best.seg];
  return { dist: best.dist, along: cum[best.seg] + segLen * best.t, seg: best.seg };
}

/* ── Route holen ───────────────────────────────────────────────────────── */

/** Kostenmodell aus den „Vermeiden“-Schaltern. Valhalla kennt keine harten
    Verbote, sondern Vorlieben zwischen 0 und 1 — 0 heißt „nur wenn es gar nicht
    anders geht“. Echtes Kurvenrouting kann es nicht. */
function costingOptions() {
  const a = settings.avoid || {};
  return {
    use_highways: a.highway ? 0.05 : 0.6,
    use_tolls: a.toll ? 0.0 : 0.5,
    use_ferry: a.ferry ? 0.0 : 0.5,
    use_trails: a.unpaved ? 0.0 : 0.2,
    ...(a.unpaved ? { avoid_bad_surfaces: 1.0 } : {}),
  };
}

export async function geocode(query, near) {
  const params = new URLSearchParams({ q: query, limit: '1', lang: 'de' });
  if (near) { params.set('lat', String(near.lat)); params.set('lon', String(near.lon)); }
  const res = await fetch(`${settings.photon}?${params}`);
  if (!res.ok) throw new Error('Ziel nicht gefunden');
  const data = await res.json();
  const f = data.features?.[0];
  if (!f) throw new Error('Ziel nicht gefunden');
  const [lon, lat] = f.geometry.coordinates;
  const p = f.properties || {};
  return { lat, lon, name: [p.name, p.city || p.town || p.village].filter(Boolean).join(', ') || query };
}

/** Valhalla liefert je Punktepaar einen Abschnitt. Für die Führung brauchen wir
    eine durchgehende Linie, also werden Geometrie und Manöver aneinandergehängt
    und die Manöverindizes mitverschoben. `legEnds` merkt sich, wo ein Abschnitt
    endet — daran erkennen wir später erreichte Zwischenziele. */
function tripToRoute(trip) {
  const legs = trip?.legs || [];
  if (!legs.length) return null;

  const shape = [];
  const maneuvers = [];
  const legEnds = [];

  for (const leg of legs) {
    const offset = shape.length;
    const pts = decodePolyline(leg.shape);
    const skipFirst = offset > 0 ? 1 : 0;   // Anschlusspunkt nicht doppelt führen
    shape.push(...pts.slice(skipFirst));
    const shift = offset - skipFirst;
    for (const m of leg.maneuvers || []) {
      maneuvers.push({
        ...m,
        begin_shape_index: m.begin_shape_index + shift,
        end_shape_index: m.end_shape_index + shift,
      });
    }
    legEnds.push(shape.length - 1);
  }

  return {
    shape,
    maneuvers,
    legEnds,
    length: (trip.summary?.length || 0) * 1000,
    time: trip.summary?.time || 0,
  };
}

/** Hauptroute plus bis zu zwei Alternativen. Alternativen liefert Valhalla nur
    für Strecken ohne Zwischenziele. */
async function fetchRoutes(from, stops) {
  const body = {
    locations: [{ lat: from.lat, lon: from.lon }, ...stops.map((p) => ({ lat: p.lat, lon: p.lon }))],
    costing: 'motorcycle',
    alternates: stops.length > 1 ? 0 : 2,
    costing_options: { motorcycle: costingOptions() },
    directions_options: { language: settings.navLang || 'de-DE', units: 'kilometers' },
  };
  const res = await fetch(settings.valhalla, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Routing ${res.status}`);
  const data = await res.json();

  const list = [tripToRoute(data.trip), ...(data.alternates || []).map((a) => tripToRoute(a.trip))]
    .filter(Boolean);
  if (!list.length) throw new Error('Keine Route gefunden');
  return list;
}

/** Route über alle gesetzten Punkte berechnen, aber noch nicht führen.
    `target` darf ein Suchtext, ein Punkt oder nichts sein — dann gelten die
    bereits gesetzten Zwischenziele. */
export async function calculate(from, target) {
  if (!navigator.onLine) { fail('Für die Routenberechnung fehlt die Verbindung'); return false; }

  try {
    if (target) {
      nav.state = 'geocoding'; nav.error = ''; emit();
      const point = typeof target === 'string' ? await geocode(target, from) : target;
      nav.stops = [point];
    }
    if (!nav.stops.length) { fail('Kein Ziel gesetzt'); return false; }

    nav.state = 'routing'; nav.error = ''; emit();
    const list = await fetchRoutes(from, nav.stops);

    nav.dest = nav.stops[nav.stops.length - 1];
    nav.routes = list;
    nav.passed = 0;
    applySelection(0);
    nav.state = 'planned';
    emit();
    return true;
  } catch (e) {
    fail(e.message || 'Routing fehlgeschlagen');
    return false;
  }
}

/** Zwischenziel anhängen. Die Reihenfolge ist die der Eingabe. */
export function addStop(point) {
  nav.stops = [...nav.stops, point];
  nav.dest = point;
  emit();
}

export function removeStop(i) {
  nav.stops = nav.stops.filter((_, k) => k !== i);
  nav.dest = nav.stops[nav.stops.length - 1] || null;
  if (!nav.stops.length) { nav.routes = []; nav.shape = []; nav.maneuvers = []; }
  emit();
}

/** Neu rechnen mit den aktuellen Optionen — auch mitten in der Fahrt. Bereits
    erreichte Zwischenziele fallen dabei weg, sonst würde die Route zurückführen. */
export async function recalculate(from) {
  const wasActive = isActive();
  const remaining = nav.stops.slice(nav.passed);
  if (!remaining.length) return false;

  const keep = nav.stops;
  nav.stops = remaining;
  const ok = await calculate(from, null);
  if (!ok) { nav.stops = keep; return false; }
  if (wasActive) begin();
  return true;
}

function applySelection(i) {
  nav.selected = Math.max(0, Math.min(nav.routes.length - 1, i));
  const r = nav.routes[nav.selected];
  nav.shape = r.shape;
  nav.maneuvers = r.maneuvers;
  nav.legEnds = r.legEnds || [];
  nav.remainingM = r.length;
  nav.remainingS = r.time;
  totalTime = r.time;
  nav.idx = 1;
  lastSeg = 0;
  spoken.clear();
  prepare();
}

/** Andere Alternative wählen — nur solange nicht gefahren wird. */
export function chooseRoute(i) {
  if (!nav.routes.length) return;
  applySelection(i);
  emit();
}

/** Führung aufnehmen. */
export function begin() {
  if (!nav.routes.length) return;
  nav.state = 'active';
  offRouteCount = 0;
  emit();
  if (settings.navVoice) {
    speak(phrases(settings.navLang).routeStarted(fmtKm(nav.remainingM), Math.round(nav.remainingS / 60)));
  }
}

function fail(msg) {
  nav.state = 'error';
  nav.error = msg;
  emit();
}

export function stop() {
  nav.state = 'idle';
  nav.stops = [];
  nav.legEnds = [];
  nav.passed = 0;
  nav.routes = [];
  nav.selected = 0;
  nav.shape = [];
  nav.maneuvers = [];
  nav.dest = null;
  nav.error = '';
  spoken.clear();
  emit();
}

export function isActive() { return nav.state === 'active' || nav.state === 'offroute'; }

/* ── Führung ───────────────────────────────────────────────────────────── */

const spoken = new Set();
let offRouteCount = 0;
let lastReroute = 0;
let totalTime = 0;

function fmtKm(m) {
  return m >= 10000 ? `${Math.round(m / 1000)} km`
       : m >= 1000  ? `${(m / 1000).toFixed(1)} km`
       : `${Math.round(m / 10) * 10} m`;
}
export { fmtKm };

/** Wird bei jedem GPS-Fix aufgerufen. */
export function update(lat, lon, speedMs) {
  if (!isActive() || xy.length < 2) return;

  const m = matchToRoute(lat, lon);
  nav.offRouteM = m.dist;
  nav.remainingM = Math.max(0, cum[cum.length - 1] - m.along);

  // Restzeit über den verbleibenden Streckenanteil — genauer wäre die Summe der
  // Restmanöver, aber deren Zeiten passen zu einem Motorrad ohnehin nur grob.
  const total = cum[cum.length - 1] || 1;
  nav.remainingS = Math.round(totalTime * (nav.remainingM / total));

  // Nächstes Manöver: das erste, dessen Startpunkt noch vor uns liegt.
  let next = nav.maneuvers.findIndex((mv) => mv.begin_shape_index > m.seg);
  if (next < 0) next = nav.maneuvers.length - 1;
  nav.idx = next;

  const turn = nav.maneuvers[next];
  nav.distToTurn = turn ? Math.max(0, cum[Math.min(turn.begin_shape_index, cum.length - 1)] - m.along) : 0;

  // Wie viele Zwischenziele liegen schon hinter uns?
  nav.passed = nav.legEnds.filter((end) => end <= m.seg).length;

  // Ziel erreicht?
  if (nav.remainingM < 25) {
    nav.state = 'arrived';
    if (settings.navVoice) speak(phrases(settings.navLang).arrived);
    emit();
    return;
  }

  announce(turn, next, speedMs || 0);
  checkOffRoute(lat, lon, m.dist);
  emit();
}

/** Zwei Ansagen je Manöver: früh der Hinweis, kurz davor die Anweisung.
    Die Auslöseabstände wachsen mit dem Tempo — bei 100 km/h sind 200 m zu spät. */
function announce(turn, i, speedMs) {
  if (!turn || !settings.navVoice) return;

  const alertAt = Math.max(300, speedMs * 13);
  const preAt = Math.max(70, speedMs * 5);

  const alert = turn.verbal_transition_alert_instruction;
  const pre = turn.verbal_pre_transition_instruction || turn.instruction;

  if (alert && nav.distToTurn <= alertAt && !spoken.has(`a${i}`)) {
    spoken.add(`a${i}`);
    speak(alert);
    return;
  }
  if (pre && nav.distToTurn <= preAt && !spoken.has(`p${i}`)) {
    spoken.add(`p${i}`);
    spoken.add(`a${i}`);            // Hinweis überspringen, wenn er zu spät käme
    speak(pre);
  }
}

function checkOffRoute(lat, lon, dist) {
  if (dist < 60) {
    offRouteCount = 0;
    if (nav.state === 'offroute') nav.state = 'active';
    return;
  }

  // Drei Fixes hintereinander daneben — ein Ausreißer ist noch kein Verfahren.
  if (++offRouteCount < 3) return;
  if (nav.state !== 'offroute') {
    nav.state = 'offroute';
    if (settings.navVoice) speak(phrases(settings.navLang).offRoute);
  }

  if (!navigator.onLine || !nav.dest) return;
  if (Date.now() - lastReroute < 15000) return;
  lastReroute = Date.now();
  recalculate({ lat, lon });
}
