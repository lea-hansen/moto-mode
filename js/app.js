/* Moto Mode — UI-Verdrahtung.

   Drei feste Bereiche: großer Bereich links (im Hochformat mittig), Tempolimit
   fest oben rechts, Musik darunter. Der große Bereich tauscht zwischen
   Navigation, Wiedergabe und Route — die Panels wandern dafür per DOM-Umhängen
   zwischen den beiden Plätzen, damit jeder nur einmal existiert und seine
   Ereignisbindungen behält. */

import { settings, set, resetSettings, trip, resetTrip } from './store.js';
import { gps, onGps, startGps, headingName } from './gps.js';
import { limit, onLimit, updatePosition, clearCache, cacheSize } from './limits.js';
import * as N from './nav.js';
import { nav, onNav } from './nav.js';
import * as M from './map.js';
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
  route: $('#panelRoute'),
};

// Welcher Bereich bei welcher Ansicht wo liegt.
const LAYOUT = {
  default: { main: P.nav,    side: P.music },
  music:   { main: P.player, side: P.nav },
  route:   { main: P.route,  side: P.music },
};

let backTimer = null;

function setView(view) {
  const plan = LAYOUT[view] || LAYOUT.default;
  if (mainSlot.firstElementChild !== plan.main) mainSlot.replaceChildren(plan.main);
  if (sideSlot.firstElementChild !== plan.side) sideSlot.replaceChildren(plan.side);
  app.dataset.view = view;

  if (view === 'music') renderPlaylists();
  if (view === 'route') renderRoute();
  requestAnimationFrame(() => M.resize());   // Platz gewechselt → Karte neu vermessen
  armAutoBack();
}

/** Nach der eingestellten Ruhezeit zurück in die Standardansicht. Jede
    Berührung im Bedienbereich stellt die Uhr zurück, damit die Anzeige nicht
    mitten im Tippen wegspringt. */
function armAutoBack() {
  clearTimeout(backTimer);
  if (app.dataset.view === 'default' || !settings.back) return;
  backTimer = setTimeout(() => setView('default'), settings.back * 1000);
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
  $('#volFill').style.width = `${settings.muted ? 0 : Math.min(100, eff)}%`;
  $('#volTxt').textContent = settings.muted
    ? 'STUMM'
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
    if (on) { wasPlaying = spotify.playing; if (spotify.playing) S.pause(); }
    else if (wasPlaying) S.play();
    S.setVolume(on ? 0 : settings.mediaVol * A.getAutoFactor()).catch(() => {});
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

const TIER_NAME = { 1: 'Innerorts', 2: 'Außerorts', 3: 'Autobahn' };
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
function areaLabel() {
  if (limit.area) return { text: limit.area, src: 'osm' };
  if (gps.fix) return { text: TIER_NAME[gps.tier], src: 'tempo' };
  return { text: '—', src: 'none' };
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

  const area = areaLabel();
  $('#areaTxt').textContent = area.text;
  $('#areaTxt').dataset.src = area.src;

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

  if (gps.fix) updatePosition(gps.lat, gps.lon, gps.heading);

  // Warnung gegen das gültige Limit — mit Hysterese, Ansage höchstens alle 20 s.
  const cap = limit.free ? null : limit.kmh;
  if (settings.warn && cap != null && gps.fix) {
    if (!warnActive && gps.raw > cap + settings.tol) {
      warnActive = true;
      if (Date.now() - warnSpoken > 20000) {
        warnSpoken = Date.now();
        A.speak(`Tempolimit ${Math.round(cap)}`);
      }
    } else if (warnActive && gps.raw < cap) {
      warnActive = false;
    }
  } else warnActive = false;
  $('#limitTile').dataset.warn = warnActive ? '1' : '0';

  if (gps.tier !== lastTier) {
    if (lastTier && settings.tierSpeak && settings.smart) A.speak(TIER_NAME[gps.tier]);
    lastTier = gps.tier;
  }

  applySmart();
  renderLimit();
  if (app.dataset.view === 'route') renderRoute();

  if (gps.fix) {
    N.update(gps.lat, gps.lon, gps.raw / 3.6);
    M.follow(gps.lat, gps.lon, gps.heading, gps.raw, settings.courseUp);
  }
}

onGps(renderTelemetry);
onLimit(renderLimit);

/* ── Route ─────────────────────────────────────────────────────────────── */

function renderRoute() {
  const conv = settings.unit === 'mph' ? 0.6213712 : 1;
  const area = areaLabel();

  $('#routeRoad').textContent = limit.road || (gps.fix ? 'Straße unbekannt' : 'warte auf Position');
  $('#routeSub').textContent = [
    area.text !== '—' ? area.text : null,
    limit.free ? 'Limit frei' : (limit.kmh != null ? `Limit ${Math.round(limit.kmh)}` : null),
    limit.source || null,
  ].filter(Boolean).join(' · ') || 'keine Straßendaten';

  $('#rDist').textContent = (trip.dist / (settings.unit === 'mph' ? 1609.34 : 1000)).toFixed(1);
  $('#rTime').textContent = fmtDuration(trip.movingMs);
  $('#rAvg').textContent = trip.samples ? Math.round((trip.sumKmh / trip.samples) * conv) : 0;
  $('#rMax').textContent = Math.round(trip.maxKmh * conv);
  $('#rHead').textContent = headingName(gps.heading);
  $('#rAcc').textContent = gps.accuracy != null ? `${gps.accuracy} m` : '--';

  $('#routeDest').textContent = settings.dest ? `Ziel: ${settings.dest}` : '';
}

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

function renderNav() {
  const running = N.isActive();
  $('#navIdle').hidden = running;
  $('#navRun').hidden = !running;
  $('#turnBanner').hidden = !running;

  const go = $('#btnGo');
  if (nav.state === 'geocoding') go.textContent = 'ZIEL SUCHEN …';
  else if (nav.state === 'routing') go.textContent = 'ROUTE RECHNEN …';
  else if (nav.state === 'error') go.textContent = 'ERNEUT';
  else if (nav.state === 'arrived') go.textContent = 'ANGEKOMMEN';
  else go.textContent = 'ROUTE';
  go.disabled = !settings.dest || nav.state === 'geocoding' || nav.state === 'routing';

  if (running) {
    const turn = nav.maneuvers[nav.idx];
    $('#turnArrow').textContent = TURN_ARROW[turn?.type] || '↑';
    $('#turnDist').textContent = N.fmtKm(nav.distToTurn);
    $('#turnStreet').textContent = nav.state === 'offroute'
      ? 'Route verlassen'
      : (turn?.street_names?.join(', ') || turn?.instruction || '');
    $('#turnBanner').dataset.off = nav.state === 'offroute' ? '1' : '0';

    const min = Math.round(nav.remainingS / 60);
    const eta = new Date(Date.now() + nav.remainingS * 1000);
    $('#navSum').textContent = `${N.fmtKm(nav.remainingM)} · ${min} min · an ${eta.getHours()}:${String(eta.getMinutes()).padStart(2, '0')}`;
  } else if (nav.state === 'error') {
    $('#navSum').textContent = nav.error;
  }

  if (!running) M.clearRoute();
}

let routeDrawn = null;
onNav(() => {
  renderNav();
  if (nav.shape.length && routeDrawn !== nav.shape) {
    routeDrawn = nav.shape;
    M.setRoute(nav.shape);
    M.fitRoute(nav.shape);
  }
  if (nav.state === 'error' || nav.state === 'arrived') setTimeout(renderNav, 50);
});

$('#btnGo').addEventListener('click', () => {
  A.unlock();
  if (!settings.dest) return;
  if (!gps.fix) { nav.state = 'error'; nav.error = 'Warte auf GPS-Position'; renderNav(); return; }
  N.start({ lat: gps.lat, lon: gps.lon }, settings.dest);
});

$('#btnNavStop').addEventListener('click', () => { N.stop(); renderNav(); });

/** Karte erst aufbauen, wenn sie gebraucht wird — WebGL kostet sonst umsonst. */
let mapStarted = false;
function ensureMap() {
  if (mapStarted) return;
  mapStarted = true;
  M.initMap($('#map'), settings.mapStyle).then(() => M.resize());
}

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
        || (spotify.connected ? 'Wiedergabe in der Spotify-App starten' : 'Im Setup verbinden'))
    : (audio.artist || 'Titel im Setup laden');

  $('#btnPlay').textContent = (sp ? spotify.playing : audio.playing) ? '❚❚' : '▶';
  $('#btnSpotifyConnect').textContent = spotify.connected ? 'Spotify neu verbinden' : 'Spotify verbinden';
  renderVolume();
}

function renderPlaylists() {
  const box = $('#plList');
  box.textContent = '';

  if (!settings.recent.length) {
    const empty = document.createElement('div');
    empty.className = 'pl-empty';
    empty.textContent = isSpotify()
      ? 'Noch nichts gehört. Eine Playlist in der Spotify-App starten — sie erscheint dann hier.'
      : 'Noch nichts geladen. Titel im Setup vom iPhone laden.';
    box.appendChild(empty);
    return;
  }

  settings.recent.forEach((r, i) => {
    const b = document.createElement('button');
    b.className = 'pl-item';
    b.innerHTML = '<span class="pl-num"></span>'
      + '<span class="pl-text"><span class="pl-name"></span><span class="pl-meta"></span></span>';
    b.querySelector('.pl-num').textContent = String(i + 1);
    b.querySelector('.pl-name').textContent = r.name;
    // Lokale Dateien kann iOS nicht von selbst wieder öffnen — nur der Picker hilft.
    b.querySelector('.pl-meta').textContent = r.kind === 'spotify' ? r.meta : `${r.meta} · erneut wählen`;
    b.addEventListener('click', () => {
      A.unlock();
      if (r.kind === 'spotify') S.playContext(r.uri);
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
  $('#setOverpass').value = settings.overpass;
  $('#setRouteStyle').value = settings.routeStyle;
  $('#setMapStyle').value = settings.mapStyle;
  $('#setValhalla').value = settings.valhalla;
  $('#setPhoton').value = settings.photon;
  $('#destInput').value = settings.dest;
  $('#limitCacheCount').textContent = String(cacheSize());
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

$('#destInput').addEventListener('change', (e) => { set({ dest: e.target.value.trim() }); renderNav(); });
$('#setRouteStyle').addEventListener('change', (e) => set({ routeStyle: e.target.value }));
$('#setValhalla').addEventListener('change', (e) => set({ valhalla: e.target.value.trim() }));
$('#setPhoton').addEventListener('change', (e) => set({ photon: e.target.value.trim() }));
$('#setMapStyle').addEventListener('change', (e) => { set({ mapStyle: e.target.value }); M.setStyle(e.target.value); });
$('#setUnit').addEventListener('change', (e) => { set({ unit: e.target.value }); renderTelemetry(); });

$('#setSource').addEventListener('change', (e) => {
  A.unlock();
  set({ source: e.target.value });
  isSpotify() ? S.startPolling() : S.stopPolling();
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
  A.speak(`Ansage. Lautstärke ${Math.round(settings.voiceVol * 100)} Prozent.`);
});

$('#btnSpotifyConnect').addEventListener('click', () => S.connect());
$('#setSpotifyId').addEventListener('change', (e) => set({ spotifyId: e.target.value.trim() }));
$('#setOverpass').addEventListener('change', (e) => set({ overpass: e.target.value.trim() }));
$('#btnSpotifyLogout').addEventListener('click', () => { S.logout(); renderMusic(); });
$('#btnLimitCache').addEventListener('click', () => { clearCache(); $('#limitCacheCount').textContent = '0'; });
$('#btnTripReset').addEventListener('click', () => { resetTrip(); renderRoute(); });
$('#btnFactory').addEventListener('click', () => { resetSettings(); location.reload(); });

/* ── Start ─────────────────────────────────────────────────────────────── */

// #panels bleibt bewusst versteckt: Was in einen Platz gehängt wird, ist kein
// Kind mehr und damit sichtbar. Der Rest darf den Seitenfluss nicht verlängern.
setView('default');
$('#btnMute').dataset.on = settings.muted ? '1' : '0';
$('#muteLabel').textContent = settings.muted ? 'TON AN' : 'MUTE';
renderSettings();
renderMusic();
renderTelemetry();
renderNav();
renderWakePill();

S.handleRedirect().then(() => {
  if (isSpotify()) S.startPolling();
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

document.addEventListener('gesturestart', (e) => e.preventDefault());

// Haken fürs Screenshot-/Testwerkzeug unter tools/ — im Betrieb ungenutzt.
window.__nav = N;
window.__map = M;
