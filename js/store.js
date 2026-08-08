/* Persistente Einstellungen + Tourdaten (localStorage, funktioniert offline). */

const KEY = 'moto.settings.v1';
const TRIP_KEY = 'moto.trip.v1';

const DEFAULTS = {
  unit: 'kmh',          // kmh | mph
  wake: true,           // Screen Wake Lock
  dim: false,           // Nacht-Dämpfung

  mediaVol: 0.70,       // Basis-Lautstärke Musik
  voiceVol: 1.00,       // Ansagen (TTS)
  duck: 0.60,           // Absenkung der Musik während einer Ansage
  muted: false,

  smart: false,         // Geschwindigkeits-Automatik
  t1: 60,               // Stadt bis … km/h
  t2: 100,              // Landstraße bis … km/h
  g1: 85,               // Pegel Stadt %
  g2: 100,              // Pegel Landstraße %
  g3: 115,              // Pegel Autobahn %
  tierSpeak: false,     // Zonenwechsel ansagen

  limits: true,         // Tempolimit über Overpass abrufen (braucht Netz)
  overpass: 'https://overpass-api.de/api/interpreter',
  warn: false,          // Warnen bei Überschreitung des Limits
  tol: 5,               // Toleranz in km/h

  back: 10,             // Sekunden bis zum Rücksprung in die Standardansicht (0 = aus)
  dest: '',             // Ziel für Route und Navi-Apps

  routeStyle: 'country',    // fast | country | avoidHighway
  navVoice: true,
  courseUp: true,
  mapStyle: 'positron',
  valhalla: 'https://valhalla1.openstreetmap.de/route',
  photon: 'https://photon.komoot.io/api/',

  source: 'local',      // local | spotify
  spotifyId: '',
  recent: [],           // zuletzt gehört, max. 3
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
  } catch {
    return { ...fallback };
  }
}

export const settings = read(KEY, DEFAULTS);

const listeners = new Set();

export function onSettings(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function set(patch) {
  Object.assign(settings, patch);
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch {}
  for (const fn of listeners) fn(settings, patch);
}

/** Zuletzt gehörte Quelle vormerken — genau drei, ohne Dubletten. */
export function pushRecent(entry) {
  const id = entry.uri || entry.name;
  const list = [entry, ...settings.recent.filter((r) => (r.uri || r.name) !== id)].slice(0, 3);
  set({ recent: list });
}

export function resetSettings() {
  try { localStorage.removeItem(KEY); } catch {}
  Object.keys(settings).forEach((k) => delete settings[k]);
  Object.assign(settings, DEFAULTS);
  for (const fn of listeners) fn(settings, settings);
}

/* ── Tourdaten ─────────────────────────────────────────────────────────── */

export const trip = read(TRIP_KEY, { dist: 0, maxKmh: 0, movingMs: 0, sumKmh: 0, samples: 0 });

let tripDirty = false;
export function markTripDirty() { tripDirty = true; }

setInterval(() => {
  if (!tripDirty) return;
  tripDirty = false;
  try { localStorage.setItem(TRIP_KEY, JSON.stringify(trip)); } catch {}
}, 5000);

export function resetTrip() {
  Object.assign(trip, { dist: 0, maxKmh: 0, movingMs: 0, sumKmh: 0, samples: 0 });
  try { localStorage.setItem(TRIP_KEY, JSON.stringify(trip)); } catch {}
}
