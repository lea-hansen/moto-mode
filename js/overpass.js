/* Gemeinsamer Zugang zu Overpass.

   Overpass erlaubt zwei gleichzeitige Anfragen je IP. Tempolimit und POI-Suche
   würden sich sonst gegenseitig die Plätze wegnehmen — die Limitabfrage läuft
   im Fahrbetrieb ohnehin alle paar Sekunden. Deshalb geht hier alles durch eine
   Warteschlange: immer nur eine Anfrage unterwegs, der Rest wartet.

   429 und 504 heißen „gerade ausgelastet“, nicht „kaputt“. Sie werden als
   `busy` gekennzeichnet, damit die Aufrufer selbst entscheiden können, ob sie
   es später erneut versuchen. */

import { settings } from './store.js';

let queue = Promise.resolve();

function busyError() {
  const e = new Error('Kartenserver ausgelastet');
  e.busy = true;
  return e;
}

async function run(ql, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(settings.overpass, { method: 'POST', body: ql, signal: ctrl.signal });
    if (res.status === 429 || res.status === 504) throw busyError();
    if (!res.ok) throw new Error(`Overpass ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw busyError();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Eine Abfrage einreihen. Läuft erst, wenn die vorherige durch ist. */
export function ask(ql, timeout = 20000) {
  const next = queue.then(() => run(ql, timeout), () => run(ql, timeout));
  // Die Kette darf nie mit einem abgelehnten Promise stehenbleiben, sonst
  // reißt sie alle folgenden Anfragen mit.
  queue = next.catch(() => {});
  return next;
}

/** Wie `ask`, versucht es bei Auslastung aber noch einmal. */
export async function askRetry(ql, timeout = 20000, waitMs = 4000) {
  try {
    return await ask(ql, timeout);
  } catch (err) {
    if (!err.busy) throw err;
    await new Promise((r) => setTimeout(r, waitMs));
    try {
      return await ask(ql, timeout);
    } catch (again) {
      if (again.busy) throw new Error('Kartenserver ausgelastet — gleich nochmal versuchen');
      throw again;
    }
  }
}
