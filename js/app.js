/* Moto Mode — UI-Verdrahtung.

   Drei feste Bereiche: großer Bereich links (im Hochformat mittig), Tempolimit
   fest oben rechts, Musik darunter. Der große Bereich tauscht zwischen
   Navigation, Wiedergabe und Route — die Panels wandern dafür per DOM-Umhängen
   zwischen den beiden Plätzen, damit jeder nur einmal existiert und seine
   Ereignisbindungen behält. */

import { settings, set, resetSettings, trip, resetTrip,
         rememberDest, toggleFav, isFav } from './store.js';
import { gps, onGps, startGps, headingName } from './gps.js';
import { limit, onLimit, updatePosition, clearCache, cacheSize } from './limits.js';
import * as N from './nav.js';
import { nav, onNav } from './nav.js';
import * as M from './map.js';
import * as POI from './poi.js';
import { phrases, LANGS } from './phrases.js';
import { isDaylight, sunTimes } from './sun.js';
import * as A from './audio.js';
import { audio, onAudio } from './audio.js';
import * as S from './spotify.js';
import { spotify, onSpotify } from './spotify.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const app = $('#app');

/* ── Service Worker ────────────────────────────────────────────────────── */

if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

/* ── Wake Lock ─────────────────────────────────────────────────────────── */

let wakeLock = null;

function renderWakePill() {
  const ok = !!wakeLock && !wakeLock.released;
  $('#pillWake').hidden = ok || !settings.wake;
}

async function acquireWakeLock() {
  if (!settings.wake || !('wakeLock' in navigator) || document.hidden) { renderWakePill(); return; }
  if (wakeLock && !wakeLock.released) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', renderWakePill);
  } catch {
    wakeLock = null;
  }
  renderWakePill();
}

async function releaseWakeLock() {
  try { await wakeLock?.release(); } catch {}
  wakeLock = null;
  renderWakePill();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  acquireWakeLock();
  if (settings.source === 'spotify') S.refresh();
});

/* ── Erscheinungsbild ──────────────────────────────────────────────────────
   Bei „automatisch“ entscheidet der Sonnenstand an der aktuellen Position —
   ohne Netz gerechnet, damit der Wechsel auch im Funkloch stattfindet. */

let themeNow = null;

function wantedTheme() {
  if (settings.theme !== 'auto') return settings.theme;
  return isDaylight(new Date(), gps.lat, gps.lon) ? 'light' : 'dark';
}

function applyTheme(force) {
  const next = wantedTheme();
  if (!force && next === themeNow) return;
  themeNow = next;

  document.documentElement.dataset.theme = next;
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', next === 'light' ? '#F2F2F7' : '#000000');

  const style = next === 'light' ? settings.mapStyleDay : settings.mapStyleNight;
  if (mapStarted) M.setStyle(style);
}

/** Zeit läuft weiter, auch wenn die Position steht — einmal je Minute prüfen. */
setInterval(() => applyTheme(false), 60000);

/* ── Statusleiste — zeigt nur, was nicht in Ordnung ist ────────────────── */

function tickClock() {
  const d = new Date();
  $('#clock').textContent = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}
tickClock();
setInterval(tickClock, 10000);

function renderNet() { $('#pillNet').hidden = navigator.onLine; }
addEventListener('online', renderNet);
addEventListener('offline', renderNet);
renderNet();

/* ── Bereichswechsel ───────────────────────────────────────────────────── */

const mainSlot = $('#mainSlot');
const sideSlot = $('#sideSlot');
const P = {
  nav: $('#panelNav'),
  music: $('#panelMusic'),
  player: $('#panelPlayer'),
};

// Welcher Bereich bei welcher Ansicht wo liegt.
const LAYOUT = {
  default: { main: P.nav,    side: P.music },
  music:   { main: P.player, side: P.nav },
};

let backTimer = null;

function setView(view) {
  const plan = LAYOUT[view] || LAYOUT.default;
  if (mainSlot.firstElementChild !== plan.main) mainSlot.replaceChildren(plan.main);
  if (sideSlot.firstElementChild !== plan.side) sideSlot.replaceChildren(plan.side);
  app.dataset.view = view;

  if (view === 'music') {
    renderPlaylists();
    if (isSpotify() && spotify.connected) S.loadPlaylists().catch(() => {});
  }
  requestAnimationFrame(() => M.resize());   // Platz gewechselt → Karte neu vermessen
  armAutoBack();
}

/** Nach der eingestellten Ruhezeit zurück in die Standardansicht. Jede
    Berührung im Bedienbereich stellt die Uhr zurück, damit die Anzeige nicht
    mitten im Tippen wegspringt. */
function armAutoBack() {
  clearTimeout(backTimer);
  const away = app.dataset.view !== 'default' || planSheet.classList.contains('open');
  if (!away || !settings.back) return;
  backTimer = setTimeout(() => { openPlan(false); setView('default'); }, settings.back * 1000);
}

[mainSlot, sideSlot].forEach((slot) =>
  slot.addEventListener('pointerdown', () => { if (app.dataset.view !== 'default') armAutoBack(); }));

$$('[data-open]').forEach((btn) =>
  btn.addEventListener('click', () => { A.unlock(); setView(btn.dataset.open); }));

/* ── Lautstärke ────────────────────────────────────────────────────────── */

function renderVolume() {
  const pct = Math.round(settings.mediaVol * 100);
  const eff = Math.round(settings.mediaVol * A.getAutoFactor() * 100);
  const meter = $('.meter');
  meter.dataset.muted = settings.muted ? '1' : '0';
  meter.dataset.auto = settings.smart && !settings.muted ? '1' : '0';

  // Bei Spotify auf dem iPhone lässt sich die Lautstärke nicht fernsteuern —
  // das sagt Spotify selbst über `supports_volume`. Dann lieber sagen, wo sie
  // sich einstellen lässt, statt einen wirkungslosen Regler zu zeigen.
  const remote = isSpotify() && !spotify.canVolume;
  $('#btnVolUp').disabled = remote;
  $('#btnVolDown').disabled = remote;
  $('#volFill').style.width = remote ? '0%' : `${settings.muted ? 0 : Math.min(100, eff)}%`;
  $('#volTxt').textContent = remote
    ? 'LAUTSTÄRKE AM IPHONE'
    : settings.muted ? 'STUMM'
    : (settings.smart && eff !== pct ? `${pct}→${eff}%` : `${pct}%`);
}

function changeVolume(delta) {
  set({ mediaVol: Math.max(0, Math.min(1, settings.mediaVol + delta)) });
  if (settings.muted) setMuted(false);
  A.refreshGain();
  if (settings.source === 'spotify') pushSpotifyVolume();
  renderVolume();
}

$('#btnVolUp').addEventListener('click', () => { A.unlock(); changeVolume(0.05); });
$('#btnVolDown').addEventListener('click', () => { A.unlock(); changeVolume(-0.05); });

/* ── Mute ──────────────────────────────────────────────────────────────── */

let wasPlaying = false;

function setMuted(on) {
  set({ muted: on });
  A.refreshGain(true);

  if (settings.source === 'spotify') {
    // Lässt das Gerät sich fernregeln, wird leise gedreht; sonst bleibt nur
    // Pause — auf dem iPhone ist das der Normalfall.
    if (spotify.canVolume) {
      S.setVolume(on ? 0 : settings.mediaVol * A.getAutoFactor()).catch(() => {});
    } else if (on) {
      S.pause();
    } else {
      // Beim Aufheben immer starten: Wer Mute löst, will Ton — sich auf einen
      // gemerkten Vorzustand zu verlassen, hat genau hier geklemmt.
      S.play();
    }
  } else if (on) {
    wasPlaying = audio.playing;
    setTimeout(() => { if (settings.muted) A.pause(); }, 140);   // erst ausblenden, dann anhalten
  } else if (wasPlaying) {
    A.play();
  }

  $('#btnMute').dataset.on = on ? '1' : '0';
  $('#muteLabel').textContent = on ? 'TON AN' : 'MUTE';
  renderVolume();
}

$('#btnMute').addEventListener('click', () => { A.unlock(); setMuted(!settings.muted); });

/* ── Smart Volume ──────────────────────────────────────────────────────── */

const tierName = (t) => phrases(settings.navLang).tiers[t];
let lastTier = 0;
let lastSpotifyPush = 0;

function tierFactor() {
  if (!settings.smart) return 1;
  return { 1: settings.g1, 2: settings.g2, 3: settings.g3 }[gps.tier] / 100;
}

function pushSpotifyVolume() {
  if (settings.source !== 'spotify' || settings.muted) return;
  const now = Date.now();
  if (now - lastSpotifyPush < 1500) return;
  lastSpotifyPush = now;
  S.setVolume(settings.mediaVol * A.getAutoFactor()).catch(() => {});
}

function applySmart() {
  const f = tierFactor();
  if (Math.abs(f - A.getAutoFactor()) > 0.001) {
    A.setAutoFactor(f);
    renderVolume();
    pushSpotifyVolume();
  }
}

/* ── Tempolimit & Ortslage ─────────────────────────────────────────────── */

let warnActive = false;
let warnSpoken = 0;

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Ortslage: bevorzugt aus den OSM-Tags, sonst notdürftig aus dem Tempo. */
const PICTO = { Innerorts: 'town', 'Außerorts': 'rural', Autobahn: 'motorway' };
const TIER_PICTO = { 1: 'town', 2: 'rural', 3: 'motorway' };

function areaLabel() {
  if (limit.area) return { text: limit.area, picto: PICTO[limit.area], src: 'osm' };
  if (gps.fix) return { text: tierName(gps.tier), picto: TIER_PICTO[gps.tier], src: 'tempo' };
  return { text: '—', picto: 'none', src: 'none' };
}

function renderLimit() {
  const sign = $('#sign');
  const num = $('#limitNum');

  if (limit.free) {
    sign.dataset.state = 'free';
    num.textContent = 'frei';
  } else if (limit.kmh != null) {
    sign.dataset.state = 'ok';
    num.textContent = String(Math.round(limit.kmh * (settings.unit === 'mph' ? 0.6213712 : 1)));
  } else {
    sign.dataset.state = 'unknown';
    num.textContent = '—';
  }

  // Ortslage als Piktogramm statt Wort.
  const area = areaLabel();
  $('#areaSign').dataset.area = area.picto || 'none';

  const parts = [];
  if (limit.road) parts.push(limit.road);
  if (limit.source) parts.push(limit.cached ? `${limit.source} · Cache` : limit.source);
  if (area.src === 'tempo') parts.push('Lage aus Tempo');

  const status = {
    idle: 'warte auf Position',
    loading: parts.length ? parts.join(' · ') : 'suche Straße …',
    offline: parts.length ? `${parts.join(' · ')} · offline` : 'offline — kein neues Limit',
    busy: parts.length ? `${parts.join(' · ')} · Server ausgelastet` : 'Kartenserver ausgelastet',
    error: parts.length ? `${parts.join(' · ')} · Abruf fehlgeschlagen` : 'Abruf fehlgeschlagen',
    aus: 'Limit-Abruf im Setup aus',
  }[limit.state];

  $('#limitSub').textContent = status || (parts.length ? parts.join(' · ') : 'kein Limit hinterlegt');
}

/* ── Telemetrie ────────────────────────────────────────────────────────── */

function renderTelemetry() {
  const unit = settings.unit === 'mph' ? 'mph' : 'km/h';
  $('#speedChip').textContent = gps.fix ? `${Math.round(gps.kmh)} ${unit}` : `– ${unit}`;
  $('#pillGps').hidden = gps.fix;

  if (gps.fix) { updatePosition(gps.lat, gps.lon, gps.heading); applyTheme(false); }

  // Warnung gegen das gültige Limit — mit Hysterese, Ansage höchstens alle 20 s.
  const cap = limit.free ? null : limit.kmh;
  if (settings.warn && cap != null && gps.fix) {
    if (!warnActive && gps.raw > cap + settings.tol) {
      warnActive = true;
      if (Date.now() - warnSpoken > 20000) {
        warnSpoken = Date.now();
        A.speak(phrases(settings.navLang).speedLimit(Math.round(cap)));
      }
    } else if (warnActive && gps.raw < cap) {
      warnActive = false;
    }
  } else warnActive = false;
  $('#limitTile').dataset.warn = warnActive ? '1' : '0';

  if (gps.tier !== lastTier) {
    if (lastTier && settings.tierSpeak && settings.smart) A.speak(tierName(gps.tier));
    lastTier = gps.tier;
  }

  applySmart();
  renderLimit();

  if (gps.fix) {
    N.update(gps.lat, gps.lon, gps.raw / 3.6);
    M.follow(gps.lat, gps.lon, gps.heading, gps.raw, settings.courseUp);
  }
}

onGps(renderTelemetry);
onLimit(renderLimit);

/* ── Navigation ────────────────────────────────────────────────────────── */

function openExternal(scheme, fallback) {
  const t = Date.now();
  location.href = scheme;
  setTimeout(() => {
    if (!document.hidden && Date.now() - t < 2500) location.href = fallback;
  }, 1200);
}

function launch(which) {
  const q = settings.dest.trim();
  const e = encodeURIComponent(q);
  if (which === 'apple') {
    openExternal(q ? `maps://?daddr=${e}&dirflg=d` : 'maps://',
                 q ? `https://maps.apple.com/?daddr=${e}&dirflg=d` : 'https://maps.apple.com/');
  } else if (which === 'google') {
    openExternal(q ? `comgooglemaps://?daddr=${e}&directionsmode=driving` : 'comgooglemaps://',
                 q ? `https://www.google.com/maps/dir/?api=1&destination=${e}&travelmode=driving`
                   : 'https://www.google.com/maps');
  } else {
    openExternal('calimoto://', 'https://www.calimoto.com/');
  }
}

$$('.launch').forEach((b) => b.addEventListener('click', () => launch(b.dataset.app)));

/* ── Abbiegenavigation ─────────────────────────────────────────────────── */

// Valhalla-Manövertypen auf Pfeile. Unbekanntes bleibt geradeaus.
const TURN_ARROW = {
  1: '↑', 2: '↑', 3: '↑', 4: '⚑', 5: '⚑', 6: '⚑',
  7: '↑', 8: '↑', 9: '↗', 10: '↱', 11: '⤴', 12: '↻', 13: '↻', 14: '⤵',
  15: '↰', 16: '↖', 17: '↑', 18: '↗', 19: '↰', 20: '↱', 21: '↑', 22: '↑',
  23: '↗', 24: '↖', 25: '↱', 26: '↻', 27: '↻', 37: '↑',
};

function fmtMin(sec) { return `${Math.round(sec / 60)} min`; }

function renderNav() {
  const running = N.isActive();
  $('#turnBanner').hidden = !running;

  // Restweg, Restzeit und Ankunft stehen oben in der Statusleiste.
  const chip = $('#routeChip');
  chip.hidden = !running;
  if (running) {
    const eta = new Date(Date.now() + nav.remainingS * 1000);
    chip.textContent = `${N.fmtKm(nav.remainingM)} · ${fmtMin(nav.remainingS)} · ${eta.getHours()}:${String(eta.getMinutes()).padStart(2, '0')}`;

    const turn = nav.maneuvers[nav.idx];
    $('#turnArrow').textContent = TURN_ARROW[turn?.type] || '↑';
    $('#turnDist').textContent = N.fmtKm(nav.distToTurn);
    $('#turnStreet').textContent = nav.state === 'offroute'
      ? 'Route verlassen'
      : (turn?.street_names?.join(', ') || turn?.instruction || '');
    $('#turnBanner').dataset.off = nav.state === 'offroute' ? '1' : '0';
  }

  $('#btnPlan').textContent = running ? 'ROUTE' : 'ZIEL';
  $('#btnNavStop').hidden = !running;
  renderPlan();
}

/** Karte erst aufbauen, wenn sie gebraucht wird — WebGL kostet sonst umsonst. */
let mapStarted = false;
function ensureMap() {
  if (mapStarted) return;
  mapStarted = true;
  const style = wantedTheme() === 'light' ? settings.mapStyleDay : settings.mapStyleNight;
  M.initMap($('#map'), style).then(() => M.resize());
}

let drawnRoutes = null;
onNav(() => {
  if (nav.routes.length && nav.routes !== drawnRoutes) {
    drawnRoutes = nav.routes;
    M.setRoutes(nav.routes, nav.selected);
    M.fitRoute(nav.shape);
  } else if (nav.routes.length) {
    M.setRoutes(nav.routes, nav.selected);
  } else {
    drawnRoutes = null;
    M.clearRoute();
  }
  renderNav();
});

/* ── Zweite Seite: Ziel, Treffer, Alternativen, Optionen ───────────────── */

const planSheet = $('#planSheet');
let results = [];              // Trefferliste aus Suche oder Umkreis
let listMode = 'recent';       // recent | fav | results | routes
let busy = '';

function openPlan(on) {
  planSheet.classList.toggle('open', on);
  planSheet.setAttribute('aria-hidden', on ? 'false' : 'true');
  if (on) {
    renderPlan();
    requestAnimationFrame(() => renderPlan());   // jetzt steht die Höhe fest
    armAutoBack();
  } else armAutoBack();
}

$('#btnPlan').addEventListener('click', () => { A.unlock(); openPlan(true); });
$('#planBack').addEventListener('click', () => openPlan(false));
planSheet.addEventListener('pointerdown', () => armAutoBack());

function here() {
  return gps.fix ? { lat: gps.lat, lon: gps.lon } : null;
}

const ROW_MIN = 56;     // darunter wird eine Zeile mit Name und Zusatz unleserlich

/** Zeilen, die ohne Abschneiden in die Liste passen. */
function fittingRows(box) {
  const h = box.getBoundingClientRect().height;
  if (!h) return 3;                        // Blatt noch zu, später neu gerechnet
  const gap = 8;
  return Math.max(1, Math.min(4, Math.floor((h + gap) / (ROW_MIN + gap))));
}

function renderStops() {
  const row = $('#stopsRow');
  row.textContent = '';
  nav.stops.forEach((p, i) => {
    if (i) {
      const a = document.createElement('span');
      a.className = 'stop-arrow';
      a.textContent = '→';
      row.appendChild(a);
    }
    const c = document.createElement('span');
    c.className = 'stop-chip';
    c.innerHTML = '<span class="sc-name"></span><button class="sc-x" aria-label="Punkt entfernen">×</button>';
    c.querySelector('.sc-name').textContent = p.name;
    c.querySelector('.sc-x').addEventListener('click', () => {
      N.removeStop(i);
      renderPlan();
      if (N.isActive()) refreshRoute();
    });
    row.appendChild(c);
  });
}

/** Eine Zeile der Trefferliste — mit Stern zum Merken. */
function listRow(entry, badge, onPick) {
  const b = document.createElement('button');
  b.className = 'plan-item';
  b.innerHTML = '<span class="pi-badge"></span><span class="pi-text">'
    + '<span class="pi-name"></span><span class="pi-meta"></span></span>'
    + '<span class="pi-star">★</span>';
  b.querySelector('.pi-badge').textContent = badge;
  b.querySelector('.pi-name').textContent = entry.name;
  b.querySelector('.pi-meta').textContent =
    [entry.meta, entry.dist != null ? N.fmtKm(entry.dist) : null].filter(Boolean).join(' · ');

  const star = b.querySelector('.pi-star');
  star.dataset.on = isFav(entry) ? '1' : '0';
  star.addEventListener('click', (e) => {
    e.stopPropagation();            // Stern soll das Ziel nicht setzen
    toggleFav(entry);
    star.dataset.on = isFav(entry) ? '1' : '0';
    if (listMode === 'fav') renderPlan();
  });

  b.addEventListener('click', () => { A.unlock(); onPick(); });
  return b;
}

function renderPlan() {
  const running = N.isActive();
  const planned = nav.state === 'planned';
  $('#planTitle').textContent = running ? 'Route' : 'Ziel';

  $$('[data-avoid]').forEach((c) => { c.dataset.on = settings.avoid[c.dataset.avoid] ? '1' : '0'; });
  $$('[data-list]').forEach((c) => { c.dataset.on = listMode === c.dataset.list ? '1' : '0'; });
  renderStops();

  const box = $('#planList');
  box.textContent = '';

  const show = (txt) => {
    const d = document.createElement('div');
    d.className = 'plan-empty';
    d.textContent = txt;
    box.appendChild(d);
  };

  if (busy) {
    show(busy);
  } else if (nav.state === 'error') {
    show(nav.error);
  } else if (listMode === 'routes' && nav.routes.length) {
    nav.routes.forEach((r, i) => {
      const b = document.createElement('button');
      b.className = 'plan-item';
      b.dataset.on = i === nav.selected ? '1' : '0';
      b.innerHTML = '<span class="pi-badge"></span><span class="pi-text">'
        + '<span class="pi-name"></span><span class="pi-meta"></span></span>';
      b.querySelector('.pi-badge').textContent = i === 0 ? '★' : String(i + 1);
      b.querySelector('.pi-name').textContent = `${N.fmtKm(r.length)} · ${fmtMin(r.time)}`;
      b.querySelector('.pi-meta').textContent = i === 0 ? 'schnellste Route' : 'Alternative';
      // Während der Fahrt nicht umschalten — das würde die Führung zerreißen.
      if (!running) b.addEventListener('click', () => { N.chooseRoute(i); renderPlan(); });
      box.appendChild(b);
    });
  } else {
    const stored = listMode === 'fav' ? settings.favDest : listMode === 'recent' ? settings.recentDest : null;
    const items = stored || results;
    if (!items.length) {
      show(listMode === 'fav' ? 'Noch keine Favoriten. Stern in einer Trefferzeile antippen.'
        : listMode === 'recent' ? 'Noch keine Ziele angefahren.'
        : 'Ziel eingeben oder eine Kategorie wählen.');
    } else {
      // Wie viele Zeilen passen wirklich? Auf dem kleinsten Display sind es
      // zwei, auf einem Pro Max vier — geraten wurde das vorher, jetzt gemessen.
      items.slice(0, fittingRows(box)).forEach((r, i) =>
        box.appendChild(listRow(r, String(i + 1), () => pickTarget(r))));
    }
  }

  $('#btnCalc').hidden = running;
  $('#btnStart').hidden = !(planned && !running);
  $('#btnCalc').disabled = busy !== '' || (!nav.stops.length && !$('#destInput').value.trim());
  $('#btnCalc').textContent = nav.stops.length > 1 ? 'ROUTE ÜBER ALLE PUNKTE' : 'ROUTE BERECHNEN';
}

async function withBusy(text, fn) {
  busy = text;
  renderPlan();
  try { await fn(); } finally { busy = ''; renderPlan(); }
}

/** Ein Treffer wird als Routenpunkt angehängt und die Route neu gerechnet.
    Beim ersten Punkt ist das schlicht das Ziel, bei weiteren ein Zwischenziel. */
async function pickTarget(target) {
  const from = here();
  if (!from) { nav.error = 'Warte auf GPS-Position'; nav.state = 'error'; renderPlan(); return; }
  const point = { lat: target.lat, lon: target.lon, name: target.name };
  N.addStop(point);
  rememberDest(point);
  set({ dest: point.name });
  $('#destInput').value = '';
  results = [];
  await refreshRoute();
}

/** Mit den aktuellen Punkten und Optionen neu rechnen — während der Fahrt
    setzt sie die Führung selbst fort. */
async function refreshRoute() {
  const from = here();
  if (!from) return;
  await withBusy('Route wird berechnet …', async () => {
    const ok = N.isActive() ? await N.recalculate(from) : await N.calculate(from, null);
    if (ok) listMode = 'routes';
  });
}

$('#btnSearch').addEventListener('click', () => doSearch());
$('#destInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.target.blur(); doSearch(); } });
$('#destInput').addEventListener('change', (e) => set({ dest: e.target.value.trim() }));

async function doSearch() {
  const q = $('#destInput').value.trim();
  if (!q) return;
  set({ dest: q });
  listMode = 'results';
  await withBusy('Ziel wird gesucht …', async () => {
    try {
      const hit = await N.geocode(q, here());
      results = [{ ...hit, meta: 'Adresse' }];
      nav.state = 'idle';
      nav.error = '';
    } catch (e) {
      results = [];
      nav.state = 'error';
      nav.error = e.message || 'Ziel nicht gefunden';
    }
  });
}

$$('[data-poi]').forEach((c) => c.addEventListener('click', async () => {
  A.unlock();
  const from = here();
  if (!from) { nav.state = 'error'; nav.error = 'Warte auf GPS-Position'; renderPlan(); return; }
  listMode = 'results';
  await withBusy(`${POI.POI_LABELS[c.dataset.poi]} wird gesucht …`, async () => {
    try {
      results = await POI.search(c.dataset.poi, from);
      nav.state = 'idle';
      nav.error = '';
      if (!results.length) { nav.state = 'error'; nav.error = 'Nichts in der Nähe gefunden'; }
    } catch (e) {
      results = [];
      nav.state = 'error';
      nav.error = e.message || 'Suche fehlgeschlagen';
    }
  });
}));

$$('[data-avoid]').forEach((c) => c.addEventListener('click', () => {
  const key = c.dataset.avoid;
  set({ avoid: { ...settings.avoid, [key]: !settings.avoid[key] } });
  renderPlan();
  // Auch mitten in der Fahrt neu rechnen — die Führung läuft danach weiter.
  if (nav.stops.length) refreshRoute();
}));

$$('[data-list]').forEach((c) => c.addEventListener('click', () => {
  listMode = c.dataset.list;
  results = [];
  nav.error = '';
  renderPlan();
}));

$('#btnCalc').addEventListener('click', async () => {
  A.unlock();
  const from = here();
  if (!from) { nav.state = 'error'; nav.error = 'Warte auf GPS-Position'; renderPlan(); return; }
  const typed = $('#destInput').value.trim();
  if (!nav.stops.length && !typed) return;
  await withBusy('Route wird berechnet …', async () => {
    const ok = await N.calculate(from, nav.stops.length ? null : typed);
    if (ok) { listMode = 'routes'; if (nav.dest) rememberDest(nav.dest); }
  });
});

$('#btnStart').addEventListener('click', () => { A.unlock(); N.begin(); openPlan(false); });
$('#btnNavStop').addEventListener('click', () => { N.stop(); results = []; listMode = 'recent'; openPlan(false); });

/* ── Musik ─────────────────────────────────────────────────────────────── */

function isSpotify() { return settings.source === 'spotify'; }

function renderMusic() {
  const sp = isSpotify();
  $('#musicHead').textContent = sp ? 'Musik · Spotify' : 'Musik';

  $('#npTitle').textContent = sp
    ? (spotify.title || (spotify.connected ? 'Spotify bereit' : 'Nicht verbunden'))
    : (audio.title || 'Keine Wiedergabe');
  $('#npArtist').textContent = sp
    ? (spotify.error || spotify.artist
        || (spotify.connected ? (spotify.device ? `Bereit auf ${spotify.device}` : 'Spotify-App auf dem iPhone öffnen') : 'Im Setup verbinden'))
    : (audio.artist || 'Titel im Setup laden');

  // Der Knopf zeigt, was er tut: läuft etwas, bietet er Pause an.
  const playing = sp ? spotify.playing : audio.playing;
  const hasSource = sp ? spotify.connected : audio.tracks.length > 0;
  $('#btnPlay').textContent = playing ? '❚❚' : '▶';
  $('#eq').dataset.state = playing ? 'playing' : (hasSource ? 'paused' : 'idle');
  $('#btnSpotifyConnect').textContent = spotify.connected ? 'Spotify neu verbinden' : 'Spotify verbinden';
  renderVolume();
}

function renderPlaylists() {
  const box = $('#plList');
  box.textContent = '';

  // Bei Spotify die zuletzt gehörten und eigenen Playlists — hier darf
  // gescrollt werden, die Ansicht ist für den Stand gedacht.
  const items = isSpotify() ? spotify.playlists : settings.recent;

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'pl-empty';
    empty.textContent = isSpotify()
      ? (spotify.connected ? 'Playlists werden geladen …' : 'Im Setup mit Spotify verbinden.')
      : 'Noch nichts geladen. Titel im Setup vom iPhone laden.';
    box.appendChild(empty);
    return;
  }

  items.forEach((r, i) => {
    const b = document.createElement('button');
    b.className = 'pl-item';
    b.innerHTML = '<span class="pl-num"></span>'
      + '<span class="pl-text"><span class="pl-name"></span><span class="pl-meta"></span></span>';
    b.querySelector('.pl-num').textContent = String(i + 1);
    b.querySelector('.pl-name').textContent = r.name;
    // Lokale Dateien kann iOS nicht von selbst wieder öffnen — nur der Picker hilft.
    b.querySelector('.pl-meta').textContent =
      (isSpotify() || r.kind === 'spotify') ? r.meta : `${r.meta} · erneut wählen`;
    b.addEventListener('click', () => {
      A.unlock();
      if (isSpotify() || r.kind === 'spotify') S.playContext(r.uri, true);   // zufällige Reihenfolge
      else $('#filePick').click();
    });
    box.appendChild(b);
  });
}

$('#btnPlay').addEventListener('click', () => { A.unlock(); isSpotify() ? S.toggle() : A.toggle(); });
$('#btnNext').addEventListener('click', () => { A.unlock(); isSpotify() ? S.next() : A.next(); });
$('#btnPrev').addEventListener('click', () => { A.unlock(); isSpotify() ? S.prev() : A.prev(); });

onAudio(() => { renderMusic(); if (app.dataset.view === 'music') renderPlaylists(); });
onSpotify(() => { renderMusic(); if (app.dataset.view === 'music') renderPlaylists(); });

/* ── Regler im Setup ───────────────────────────────────────────────────── */

const SLIDERS = { voice: { key: 'voiceVol', out: '#valVoice' }, duck: { key: 'duck', out: '#valDuck' } };

function renderSlider(name) {
  const { key, out } = SLIDERS[name];
  const bar = $(`.bar[data-bar="${name}"]`);
  const pct = Math.round(settings[key] * 100);
  bar.querySelector('.fill').style.width = `${pct}%`;
  bar.querySelector('.knob').style.left = `${pct}%`;
  bar.setAttribute('aria-valuenow', String(pct));
  $(out).textContent = `${pct}%`;
}

Object.keys(SLIDERS).forEach((name) => {
  const bar = $(`.bar[data-bar="${name}"]`);
  const apply = (v) => {
    set({ [SLIDERS[name].key]: Math.max(0, Math.min(1, v)) });
    A.refreshGain();
    renderSlider(name);
  };
  const fromX = (clientX) => {
    const r = bar.getBoundingClientRect();
    apply((clientX - r.left) / r.width);
  };

  bar.addEventListener('pointerdown', (e) => { bar.setPointerCapture(e.pointerId); fromX(e.clientX); });
  bar.addEventListener('pointermove', (e) => { if (bar.hasPointerCapture(e.pointerId)) fromX(e.clientX); });

  $$(`.step[data-vol="${name}"]`).forEach((b) =>
    b.addEventListener('click', () => apply(settings[SLIDERS[name].key] + parseFloat(b.dataset.step))));

  renderSlider(name);
});

/* ── Setup ─────────────────────────────────────────────────────────────── */

const sheet = $('#sheet');
const openSheet = (on) => {
  sheet.classList.toggle('open', on);
  sheet.setAttribute('aria-hidden', on ? 'false' : 'true');
  if (on) clearTimeout(backTimer); else armAutoBack();
};
$('#btnSettings').addEventListener('click', () => { A.unlock(); openSheet(true); });
$('#sheetClose').addEventListener('click', () => openSheet(false));

const NUMS = { setT1: 't1', setT2: 't2', setG1: 'g1', setG2: 'g2', setG3: 'g3', setTol: 'tol', setBack: 'back' };
const CHECKS = { setWake: 'wake', setDim: 'dim', setSmart: 'smart', setTierSpeak: 'tierSpeak',
                 setWarn: 'warn', setLimits: 'limits', setNavVoice: 'navVoice', setCourseUp: 'courseUp' };

function renderSettings() {
  Object.entries(NUMS).forEach(([id, key]) => { $(`#${id}`).value = settings[key]; });
  Object.entries(CHECKS).forEach(([id, key]) => { $(`#${id}`).checked = settings[key]; });
  $('#setUnit').value = settings.unit;
  $('#setSource').value = settings.source;
  $('#setSpotifyId').value = settings.spotifyId;
  $('#setMapStyleDay').value = settings.mapStyleDay;
  $('#setMapStyleNight').value = settings.mapStyleNight;
  $('#setTheme').value = settings.theme;
  $('#setNavLang').value = settings.navLang;
  $('#setCountry').value = settings.country;
  $('#destInput').value = settings.dest;
  $('#limitCacheCount').textContent = String(cacheSize());
  // Ob iOS fremden Ton für uns absenkt, hängt an der Audio-Sitzungs-
  // Schnittstelle. Ehrlich anzeigen statt stillschweigend nichts zu tun.
  $('#duckOthers').textContent = A.hasAudioSession()
    ? 'ja, während Ansagen'
    : 'nicht möglich auf diesem Gerät';
  app.dataset.dim = settings.dim ? '1' : '0';
}

Object.entries(NUMS).forEach(([id, key]) => {
  $(`#${id}`).addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v)) set({ [key]: v });
    applySmart();
    renderVolume();
  });
});

Object.entries(CHECKS).forEach(([id, key]) => {
  $(`#${id}`).addEventListener('change', (e) => {
    set({ [key]: e.target.checked });
    if (key === 'wake') e.target.checked ? acquireWakeLock() : releaseWakeLock();
    if (key === 'dim') app.dataset.dim = settings.dim ? '1' : '0';
    if (key === 'smart') { applySmart(); renderVolume(); }
    if (key === 'limits') renderLimit();
  });
});

$('#setNavLang').addEventListener('change', (e) => { set({ navLang: e.target.value }); renderLimit(); });
$('#setCountry').addEventListener('change', (e) => set({ country: e.target.value }));
$('#setTheme').addEventListener('change', (e) => { set({ theme: e.target.value }); applyTheme(true); });
$('#setMapStyleDay').addEventListener('change', (e) => { set({ mapStyleDay: e.target.value }); applyTheme(true); });
$('#setMapStyleNight').addEventListener('change', (e) => { set({ mapStyleNight: e.target.value }); applyTheme(true); });
$('#setUnit').addEventListener('change', (e) => { set({ unit: e.target.value }); renderTelemetry(); });

$('#setSource').addEventListener('change', (e) => {
  A.unlock();
  set({ source: e.target.value });
  if (isSpotify()) { S.startPolling(); S.loadPlaylists().catch(() => {}); } else S.stopPolling();
  renderMusic();
});

$('#filePick').addEventListener('change', (e) => {
  A.unlock();
  const n = A.loadFiles(e.target.files);
  if (n) { set({ source: 'local' }); S.stopPolling(); $('#setSource').value = 'local'; }
  renderMusic();
  openSheet(false);
});

$('#btnTestVoice').addEventListener('click', () => {
  A.unlock();
  A.speak(phrases(settings.navLang).testVoice(Math.round(settings.voiceVol * 100)));
});

$('#setRedirect').addEventListener('change', (e) => set({ redirect: e.target.value.trim() }));
$('#btnCopyRedirect').addEventListener('click', async () => {
  const uri = S.redirectUri();
  try { await navigator.clipboard.writeText(uri); $('#btnCopyRedirect').textContent = 'Kopiert ✓'; }
  catch { $('#setRedirect').select(); $('#btnCopyRedirect').textContent = 'Markiert — von Hand kopieren'; }
  setTimeout(() => { $('#btnCopyRedirect').textContent = 'Redirect-URI kopieren'; }, 2500);
});

$('#btnSpotifyConnect').addEventListener('click', () => S.connect());
$('#setSpotifyId').addEventListener('change', (e) => set({ spotifyId: e.target.value.trim() }));
$('#btnSpotifyLogout').addEventListener('click', () => { S.logout(); renderMusic(); });
$('#btnLimitCache').addEventListener('click', () => { clearCache(); $('#limitCacheCount').textContent = '0'; });
$('#btnTripReset').addEventListener('click', () => { resetTrip(); });
$('#btnFactory').addEventListener('click', () => { resetSettings(); location.reload(); });

/* ── Start ─────────────────────────────────────────────────────────────── */

// #panels bleibt bewusst versteckt: Was in einen Platz gehängt wird, ist kein
// Kind mehr und damit sichtbar. Der Rest darf den Seitenfluss nicht verlängern.
setView('default');
$('#btnMute').dataset.on = settings.muted ? '1' : '0';
$('#muteLabel').textContent = settings.muted ? 'TON AN' : 'MUTE';
// Kartenstile aus map.js in die Auswahl füllen — eine Quelle für beides.
const langSel = $('#setNavLang');
Object.entries(LANGS).forEach(([id, label]) => {
  const o = document.createElement('option');
  o.value = id; o.textContent = label;
  langSel.appendChild(o);
});

['#setMapStyleDay', '#setMapStyleNight'].forEach((sel) => {
  Object.entries(M.STYLES).forEach(([id, def]) => {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = def.label;
    $(sel).appendChild(o);
  });
});

applyTheme(true);
renderSettings();
renderMusic();
renderTelemetry();
renderNav();
renderWakePill();

S.handleRedirect().then(() => {
  if (isSpotify()) { S.startPolling(); S.loadPlaylists().catch(() => {}); }
  renderMusic();
});

// GPS, Wake Lock und AudioContext erst bei der ersten Berührung starten —
// so kommt der Standort-Dialog im richtigen Moment und iOS lässt Audio zu.
function boot() {
  A.unlock();
  acquireWakeLock();
  startGps();
  ensureMap();
}
addEventListener('pointerdown', boot, { once: true });

/* Ohne Home-Bildschirm-Start bleibt die Safari-Adresszeile stehen — iOS bietet
   keinen Weg, das aus der Seite heraus zu erzwingen. Also sagen wir es. */
(function installHint() {
  const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const standalone = navigator.standalone === true
    || matchMedia('(display-mode: standalone)').matches
    || matchMedia('(display-mode: fullscreen)').matches;
  if (!iOS || standalone || localStorage.getItem('moto.hint.dismissed')) return;
  const hint = $('#installHint');
  hint.hidden = false;
  hint.addEventListener('click', () => {
    hint.hidden = true;
    try { localStorage.setItem('moto.hint.dismissed', '1'); } catch {}
  });
})();

document.addEventListener('gesturestart', (e) => e.preventDefault());

// Haken fürs Screenshot-/Testwerkzeug unter tools/ — im Betrieb ungenutzt.
window.__nav = N;
window.__map = M;
