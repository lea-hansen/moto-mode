/* GPS-Tacho. Läuft vollständig offline — Geolocation braucht kein Mobilfunknetz,
   nur eine sichere Herkunft (HTTPS oder localhost). */

import { settings, trip, markTripDirty } from './store.js';

const STOP_MS = 1.4;      // < 5 km/h gilt als Stillstand (GPS-Rauschen)
const SMOOTH = 0.4;       // EMA-Faktor
const MAX_ACC = 40;       // Fixes mit schlechterer Genauigkeit fließen nicht in die Tour ein
const HYST = 4;           // km/h Hysterese beim Zonenwechsel

const DIRS = ['N','NNO','NO','ONO','O','OSO','SO','SSO','S','SSW','SW','WSW','W','WNW','NW','NNW'];

export const gps = {
  kmh: 0,
  raw: 0,
  lat: null,
  lon: null,
  heading: null,
  accuracy: null,
  tier: 1,          // 1 Stadt, 2 Landstraße, 3 Autobahn
  fix: false,
  error: null,
};

const listeners = new Set();
export function onGps(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) fn(gps); }

let watchId = null;
let last = null;          // { lat, lon, t }
let smoothed = 0;

function haversine(a, b) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const la1 = a.lat * toRad, la2 = b.lat * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function headingName(deg) {
  if (deg == null || Number.isNaN(deg)) return '--';
  return DIRS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

/** Aktuelle Zone anhand der Schwellen — mit Hysterese, damit sie nicht flattert. */
function computeTier(kmh, current) {
  const { t1, t2 } = settings;
  const lo = current > 1 ? t1 - HYST : t1;
  const hi = current > 2 ? t2 - HYST : t2;
  if (kmh < lo) return 1;
  if (kmh < hi) return 2;
  return 3;
}

function onPosition(pos) {
  const c = pos.coords;
  const now = pos.timestamp || Date.now();

  // 1) Geschwindigkeit: bevorzugt vom Empfänger, sonst aus der Distanz rechnen.
  let ms = typeof c.speed === 'number' && c.speed >= 0 && Number.isFinite(c.speed) ? c.speed : null;
  const here = { lat: c.latitude, lon: c.longitude, t: now };

  if (ms === null && last) {
    const dt = (now - last.t) / 1000;
    if (dt > 0.3 && dt < 10) ms = haversine(last, here) / dt;
  }
  if (ms === null) ms = 0;
  if (ms < STOP_MS) ms = 0;

  // 2) Glätten
  smoothed = ms === 0 ? 0 : smoothed + (ms - smoothed) * SMOOTH;

  const factor = settings.unit === 'mph' ? 2.2369363 : 3.6;
  gps.raw = smoothed * 3.6;                    // intern immer km/h
  gps.kmh = smoothed * factor;                 // angezeigter Wert in der gewählten Einheit
  gps.lat = c.latitude;
  gps.lon = c.longitude;
  gps.accuracy = c.accuracy != null ? Math.round(c.accuracy) : null;
  gps.heading = typeof c.heading === 'number' && !Number.isNaN(c.heading) && ms > STOP_MS ? c.heading : gps.heading;
  gps.fix = true;
  gps.error = null;
  gps.tier = computeTier(gps.raw, gps.tier);

  // 3) Tourdaten
  if (last && (c.accuracy == null || c.accuracy <= MAX_ACC)) {
    const dt = now - last.t;
    if (dt > 0 && dt < 15000 && smoothed > 0) {
      trip.dist += haversine(last, here);
      trip.movingMs += dt;
      trip.sumKmh += gps.raw;
      trip.samples += 1;
      if (gps.raw > trip.maxKmh) trip.maxKmh = gps.raw;
      markTripDirty();
    }
  }
  last = here;
  emit();
}

function onError(err) {
  gps.fix = false;
  gps.error = err.code === 1 ? 'Standort nicht erlaubt'
            : err.code === 2 ? 'Kein GPS-Signal'
            : 'GPS-Zeitüberschreitung';
  emit();
}

export function startGps() {
  if (watchId !== null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(onPosition, onError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 20000,
  });
}

export function stopGps() {
  if (watchId === null) return;
  navigator.geolocation.clearWatch(watchId);
  watchId = null;
  last = null;
}

/** Ohne Fix nach kurzer Zeit auf 0 zurückfallen, statt den letzten Wert einzufrieren. */
setInterval(() => {
  if (!last) return;
  if (Date.now() - last.t > 6000 && gps.kmh !== 0) {
    smoothed = 0;
    gps.kmh = 0;
    gps.raw = 0;
    gps.tier = computeTier(0, gps.tier);
    emit();
  }
}, 2000);
