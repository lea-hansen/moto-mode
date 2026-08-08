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
  t1: 55,               // Zona urbana bis … km/h
  t2: 95,               // Carretera bis … km/h
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
  recentDest: [],       // zuletzt angefahrene Ziele
  favDest: [],          // gemerkte Ziele

  avoid: { highway: false, toll: false, ferry: false, unpaved: false },
  navVoice: true,
  navLang: 'de-DE',     // de-DE | ca-ES | es-ES
  country: 'es',        // bestimmt die Vorgabewerte für Tempolimits
  courseUp: true,
  mapStyle: 'positron',
  valhalla: 'https://valhalla1.openstreetmap.de/route',
  photon: 'https://photon.komoot.io/api/',

  source: 'local',      // local | spotify
  spotifyId: '',
  redirect: '',         // abweichende Redirect-URI; leer = automatisch
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

/** Ein angefahrenes Ziel vormerken — acht Stück, ohne Dubletten. */
export function rememberDest(dest) {
  if (!dest?.name) return;
  const key = (d) => `${d.name}|${d.lat?.toFixed(4)}|${d.lon?.toFixed(4)}`;
  const list = [dest, ...settings.recentDest.filter((d) => key(d) !== key(dest))].slice(0, 8);
  set({ recentDest: list });
}

/** Ziel als Favorit an- oder abwählen. */
export function toggleFav(dest) {
  if (!dest?.name) return;
  const same = (d) => d.name === dest.name;
  const on = settings.favDest.some(same);
  set({ favDest: on ? settings.favDest.filter((d) => !same(d)) : [dest, ...settings.favDest].slice(0, 12) });
}

export function isFav(dest) {
  return !!dest?.name && settings.favDest.some((d) => d.name === dest.name);
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
