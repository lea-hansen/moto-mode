/* Umkreissuche nach Zielen: Tankstelle, Essen, Hotel, Parken, Werkstatt.

   Bewusst über Overpass und nicht über den Geocoder: Photon sucht nach Namen,
   nicht nach Art — eine Suche nach „Tankstelle“ liefert dort Bushaltestellen,
   die so heißen. Overpass fragt die Kategorie direkt ab und ist ohnehin schon
   fürs Tempolimit eingebunden. */

import { askRetry } from './overpass.js';

const FILTERS = {
  fuel:    { tag: '["amenity"="fuel"]',                                   radius: 10000, label: 'Tankstelle' },
  food:    { tag: '["amenity"~"^(restaurant|fast_food|cafe|biergarten)$"]', radius: 8000,  label: 'Essen' },
  hotel:   { tag: '["tourism"~"^(hotel|guest_house|motel|hostel)$"]',      radius: 15000, label: 'Übernachten' },
  parking: { tag: '["amenity"="parking"]',                                radius: 5000,  label: 'Parken' },
  repair:  { tag: '["shop"~"^(motorcycle|car_repair|motorcycle_repair)$"]', radius: 20000, label: 'Werkstatt' },
};

export const POI_LABELS = Object.fromEntries(Object.entries(FILTERS).map(([k, v]) => [k, v.label]));

function distance(a, b) {
  const k = Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((b.lat - a.lat) * 110540, (b.lon - a.lon) * 111320 * k);
}

/** Bis zu sechs Treffer der gewählten Art, nach Luftlinie sortiert. Die
    Anfrage geht über die gemeinsame Warteschlange, damit sie der laufenden
    Tempolimit-Abfrage nicht den Platz wegnimmt. */
export async function search(kind, from) {
  const f = FILTERS[kind];
  if (!f) throw new Error('Unbekannte Kategorie');
  if (!navigator.onLine) throw new Error('Ohne Verbindung keine Umkreissuche');

  const ql = `[out:json][timeout:25];nwr(around:${f.radius},${from.lat},${from.lon})${f.tag};out center tags 60;`;

  const data = await askRetry(ql);

  return (data.elements || [])
    .map((e) => {
      const lat = e.lat ?? e.center?.lat;
      const lon = e.lon ?? e.center?.lon;
      if (lat == null || lon == null) return null;
      const t = e.tags || {};
      return {
        lat,
        lon,
        name: t.name || t.brand || t.operator || f.label,
        meta: [t.brand && t.brand !== t.name ? t.brand : null, t['addr:street'], t['addr:city']]
          .filter(Boolean).join(' · '),
        dist: distance(from, { lat, lon }),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 6);
}
