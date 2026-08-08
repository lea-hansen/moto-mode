/* Auswertung von Straßeneigenschaften aus OpenStreetMap: Belag, Maut und
   zeitbedingte Durchfahrtsverbote.

   Die Daten stammen aus derselben Overpass-Abfrage, die ohnehin für das
   Tempolimit läuft — es kostet also keine zusätzliche Anfrage.

   Was in Katalonien tatsächlich zu erwarten ist (an echten Daten geprüft):
   `surface` ist fast überall `asphalt`, unbefestigte Abschnitte sind die
   Ausnahme. `smoothness` ist zu selten gesetzt, um darauf zu bauen. Zeitbedingte
   Verbote gibt es fast nur in Stadtzentren als Sperrzeiten für Fußgängerzonen.
   `toll=yes` fehlt an den katalanischen Mautstrecken meist ganz. */

/* Beläge, auf denen ein Motorrad nichts zu befürchten hat. Alles andere gilt
   als Hinweis wert — lieber einmal zu viel als einmal im Schotter. */
const PAVED = new Set([
  'asphalt', 'paved', 'concrete', 'concrete:plates', 'concrete:lanes',
  'paving_stones', 'sett', 'metal', 'wood',
]);

const LOOSE = new Set(['gravel', 'fine_gravel', 'pebblestone', 'sand', 'dirt', 'earth', 'mud', 'ground', 'grass']);

/** Belag bewerten. `null` heißt: kein Hinweis nötig oder nichts bekannt. */
export function surfaceWarning(tags = {}) {
  const s = String(tags.surface || '').toLowerCase();
  if (!s || PAVED.has(s)) return null;
  return {
    level: LOOSE.has(s) ? 'loose' : 'rough',
    surface: s,
    text: LOOSE.has(s) ? 'Loser Belag' : 'Unbefestigt',
  };
}

export function isToll(tags = {}) {
  return String(tags.toll || '').toLowerCase() === 'yes';
}

/* ── Zeitbedingte Beschränkungen ──────────────────────────────────────────
   OSM schreibt sie als `wert @ (bedingung)`, mehrere durch Semikolon getrennt,
   etwa `no @ (Mo-Sa 11:00-15:00, 17:00-20:30)`.

   Umgesetzt ist die Teilmenge, die in der Praxis vorkommt: Wochentagsbereiche,
   Feiertage als `PH`, Uhrzeitspannen und Monatsbereiche. Nicht umgesetzt sind
   Sonderfälle wie „letzter Sonntag im Monat“ oder Sonnenstandsangaben — trifft
   die Auswertung darauf, meldet sie lieber nichts, als falsch zu warnen. */

const DAYS = { su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6 };
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function parseValue(raw) {
  // `no @ (…)` → { value: 'no', condition: '…' }
  const out = [];
  for (const part of String(raw).split(';')) {
    const m = part.match(/^\s*(.+?)\s*@\s*\((.+)\)\s*$/);
    if (m) out.push({ value: m[1].trim().toLowerCase(), condition: m[2].trim() });
  }
  return out;
}

function dayMatches(token, date) {
  const day = date.getDay();
  const range = token.match(/^([a-z]{2})\s*-\s*([a-z]{2})$/);
  if (range) {
    const a = DAYS[range[1]], b = DAYS[range[2]];
    if (a === undefined || b === undefined) return null;
    return a <= b ? day >= a && day <= b : day >= a || day <= b;
  }
  if (DAYS[token] !== undefined) return day === DAYS[token];
  return null;                                    // kein Wochentagsausdruck
}

function monthMatches(token, date) {
  const month = date.getMonth() + 1;
  const range = token.match(/^([a-z]{3})\s*-\s*([a-z]{3})$/);
  if (range) {
    const a = MONTHS[range[1]], b = MONTHS[range[2]];
    if (a === undefined || b === undefined) return null;
    return a <= b ? month >= a && month <= b : month >= a || month <= b;
  }
  if (MONTHS[token] !== undefined) return month === MONTHS[token];
  return null;
}

function timeMatches(token, date) {
  const m = token.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const now = date.getHours() * 60 + date.getMinutes();
  const from = +m[1] * 60 + +m[2];
  const to = +m[3] * 60 + +m[4];
  return from <= to ? now >= from && now < to : now >= from || now < to;
}

/** Gilt die Bedingung gerade? `null`, wenn sie nicht sicher zu deuten war.

    Wichtig ist der Umgang mit Unbekanntem: Ein übersprungenes Wort kann den
    Sinn umkehren. `last Su of Mar` besteht aus einem Wochentag und einem Monat,
    die beide zutreffen können — wer `last` und `of` überliest, sperrt jeden
    Sonntag im März. Deshalb gilt: Sobald ein Wort nicht verstanden wurde, wird
    die Bedingung verworfen statt geraten. */
function conditionActive(condition, date) {
  // Kommagetrennte Abschnitte sind Alternativen: einer reicht.
  let understood = false;
  let unknownSeen = false;

  for (const alt of condition.split(',')) {
    const tokens = alt.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let all = true;
    let any = false;
    let unknown = false;

    for (const tok of tokens) {
      if (tok === 'ph') { any = true; all = false; continue; }   // Feiertage sind uns nicht bekannt
      const r = dayMatches(tok, date) ?? monthMatches(tok, date) ?? timeMatches(tok, date);
      if (r === null) { unknown = true; continue; }
      any = true;
      if (!r) all = false;
    }

    if (unknown) { unknownSeen = true; continue; }               // Alternative nicht verwertbar
    if (any) understood = true;
    if (any && all) return true;
  }

  if (unknownSeen) return null;
  return understood ? false : null;
}

const KEYS = ['motorcycle:conditional', 'motor_vehicle:conditional', 'vehicle:conditional', 'access:conditional'];

/** Aktuell geltende Durchfahrtsbeschränkung, oder `null`. */
export function accessRestriction(tags = {}, date = new Date()) {
  for (const key of KEYS) {
    if (!tags[key]) continue;
    for (const { value, condition } of parseValue(tags[key])) {
      if (value === 'yes') continue;                       // ausdrücklich erlaubt
      if (conditionActive(condition, date) !== true) continue;
      return {
        key,
        value,
        condition,
        text: value === 'no' ? 'Gesperrt' : `Nur ${value}`,
      };
    }
  }
  return null;
}
