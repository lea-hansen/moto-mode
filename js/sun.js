/* Sonnenauf- und -untergang für die aktuelle Position.

   Bewusst selbst gerechnet statt über einen Dienst geholt: Die Formel ist
   kurz, braucht kein Netz und funktioniert damit auch im Funkloch — genau
   dort, wo der Wechsel auf die Nachtkarte am ehesten gebraucht wird.

   Verfahren nach der üblichen Näherung (Meeus/NOAA), Genauigkeit rund eine
   Minute. Das reicht, um Tag von Nacht zu unterscheiden. */

const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = 23.4397 * RAD;      // Schiefe der Ekliptik
const HORIZON = -0.833 * RAD;         // Sonnenmitte inkl. Refraktion und Radius

const toJulian = (date) => date.valueOf() / DAY_MS - 0.5 + J1970;
const fromJulian = (j) => new Date((j + 0.5 - J1970) * DAY_MS);
const toDays = (date) => toJulian(date) - J2000;

function solarMeanAnomaly(d) { return RAD * (357.5291 + 0.98560028 * d); }

function eclipticLongitude(M) {
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const P = RAD * 102.9372;           // Perihel der Erde
  return M + C + P + Math.PI;
}

function declination(L) { return Math.asin(Math.sin(OBLIQUITY) * Math.sin(L)); }

function julianCycle(d, lw) { return Math.round(d - 0.0009 - lw / (2 * Math.PI)); }
function approxTransit(Ht, lw, n) { return 0.0009 + (Ht + lw) / (2 * Math.PI) + n; }
function solarTransitJ(ds, M, L) { return J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L); }

function hourAngle(h, phi, dec) {
  const x = (Math.sin(h) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (x <= -1) return Math.PI;        // Polartag: Sonne geht nicht unter
  if (x >= 1) return 0;               // Polarnacht
  return Math.acos(x);
}

/** Auf- und Untergang für einen Tag. Gibt `null` zurück, wenn es beides an
    diesem Ort gerade nicht gibt (Polarregionen). */
export function sunTimes(date, lat, lon) {
  const lw = -lon * RAD;
  const phi = lat * RAD;
  const d = toDays(date);

  const n = julianCycle(d, lw);
  const ds = approxTransit(0, lw, n);
  const M = solarMeanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = declination(L);

  const Jnoon = solarTransitJ(ds, M, L);
  const w0 = hourAngle(HORIZON, phi, dec);
  if (w0 === 0 || w0 === Math.PI) return null;

  const Jset = solarTransitJ(approxTransit(w0, lw, n), M, L);
  const Jrise = Jnoon - (Jset - Jnoon);

  return { sunrise: fromJulian(Jrise), sunset: fromJulian(Jset), noon: fromJulian(Jnoon) };
}

/** Ist es an dieser Stelle gerade hell? Ohne Position bleibt es beim Tag —
    eine hell gestaltete Karte ist der harmlosere Fehlgriff. */
export function isDaylight(date, lat, lon) {
  if (lat == null || lon == null) return true;
  const t = sunTimes(date, lat, lon);
  if (!t) return true;
  return date >= t.sunrise && date < t.sunset;
}
