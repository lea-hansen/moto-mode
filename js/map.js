/* Karte auf MapLibre GL.

   Die Bibliothek liegt lokal unter vendor/ — ein CDN würde die Offline-Fähigkeit
   der App aushebeln. Die Vektorkacheln kommen von OpenFreeMap (kein API-Schlüssel)
   und werden vom Service Worker mitgecacht, sodass gefahrene Gegenden auch ohne
   Netz erscheinen.

   Fährt eine Route, dreht sich die Karte in Fahrtrichtung und zoomt nach Tempo —
   im Stadtverkehr näher, auf der Autobahn weiter heraus. */

const STYLE_URL = (name) => `https://tiles.openfreemap.org/styles/${name}`;

/* Reicht das Netz nicht für den Stil, bleibt wenigstens die Route sichtbar. */
const FALLBACK_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#1C1C1E' } }],
};

let map = null;
let ready = false;
let marker = null;
let holdUntil = 0;        // nach einer Handbewegung kurz nicht nachführen

export function isReady() { return ready; }

export async function initMap(container, styleName) {
  if (map) return map;
  if (!window.maplibregl) return null;

  let style = FALLBACK_STYLE;
  try {
    const res = await fetch(STYLE_URL(styleName || 'positron'));
    if (res.ok) style = await res.json();
  } catch { /* offline: Rückfallstil */ }

  try {
    map = new maplibregl.Map({
      container,
      style,
      center: [10.45, 51.16],
      zoom: 5,
      attributionControl: false,   // eigene, feste Zeile — die eingebaute bläht sich im kleinen Platz auf
      dragRotate: false,
      pitchWithRotate: false,
      keyboard: false,
    });
  } catch {
    map = null;            // z. B. wenn WebGL nicht zur Verfügung steht
    return null;
  }

  map.on('load', () => {
    map.addSource('route', { type: 'geojson', data: emptyLine() });
    // Zwei Linien: dunkle Fassung darunter, damit die Route auf jedem
    // Untergrund steht — auch auf hellen Straßenflächen.
    map.addLayer({
      id: 'route-casing', type: 'line', source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#003a75', 'line-width': 14 },
    });
    map.addLayer({
      id: 'route-line', type: 'line', source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#0A84FF', 'line-width': 8 },
    });
    ready = true;
  });

  // Eigene Position als DOM-Element: bei Fahrtrichtung-oben zeigt der Pfeil
  // immer nach oben, die Karte dreht sich darunter.
  const el = document.createElement('div');
  el.className = 'me';
  marker = new maplibregl.Marker({ element: el, rotationAlignment: 'map' })
    .setLngLat([10.45, 51.16]).addTo(map);

  ['dragstart', 'zoomstart', 'touchstart'].forEach((ev) =>
    map.on(ev, () => { holdUntil = Date.now() + 6000; }));

  return map;
}

function emptyLine() {
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: {} };
}

export function resize() { if (map) map.resize(); }

export function setStyle(name) {
  if (!map) return;
  ready = false;
  fetch(STYLE_URL(name))
    .then((r) => (r.ok ? r.json() : FALLBACK_STYLE))
    .catch(() => FALLBACK_STYLE)
    .then((style) => {
      map.setStyle(style);
      map.once('styledata', () => {
        if (!map.getSource('route')) {
          map.addSource('route', { type: 'geojson', data: lastLine || emptyLine() });
          map.addLayer({
            id: 'route-casing', type: 'line', source: 'route',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#003a75', 'line-width': 14 },
          });
          map.addLayer({
            id: 'route-line', type: 'line', source: 'route',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#0A84FF', 'line-width': 8 },
          });
        }
        ready = true;
      });
    });
}

let lastLine = null;

/** shape: [[lat, lon], …] — GeoJSON will die umgekehrte Reihenfolge. */
export function setRoute(shape) {
  lastLine = {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: shape.map(([la, lo]) => [lo, la]) },
    properties: {},
  };
  if (map && map.getSource('route')) map.getSource('route').setData(lastLine);
}

export function clearRoute() { setRoute([]); }

function zoomForSpeed(kmh) {
  if (kmh < 25) return 16.4;
  if (kmh < 60) return 15.6;
  if (kmh < 100) return 14.8;
  return 14.0;
}

export function follow(lat, lon, heading, kmh, courseUp) {
  if (!map) return;
  marker?.setLngLat([lon, lat]);
  if (heading != null) marker?.setRotation(heading);
  if (Date.now() < holdUntil) return;

  map.easeTo({
    center: [lon, lat],
    zoom: zoomForSpeed(kmh || 0),
    bearing: courseUp && heading != null ? heading : 0,
    pitch: courseUp ? 45 : 0,
    duration: 900,
    essential: true,
  });
}

/** Ganze Route ins Bild rücken — nach der Berechnung, vor der Abfahrt. */
export function fitRoute(shape) {
  if (!map || !shape.length) return;
  const lons = shape.map((p) => p[1]), lats = shape.map((p) => p[0]);
  map.fitBounds(
    [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
    { padding: 40, bearing: 0, pitch: 0, duration: 800 },
  );
  holdUntil = Date.now() + 4000;
}
