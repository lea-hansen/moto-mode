/* Optionale Spotify-Fernsteuerung (Web API, PKCE-Flow).
   Steuert die native Spotify-App auf dem iPhone fern: Play/Pause, Titelwechsel,
   Titelanzeige. Braucht Internet, Spotify Premium und eine eigene Client-ID.
   Hinweis: Spotify erlaubt das Setzen der Gerätelautstärke nicht auf allen
   Geräten — iOS-Clients lehnen das häufig mit 403 ab. Der Mute-Button greift
   deshalb auf Pause zurück. */

import { settings, set, pushRecent } from './store.js';

const AUTH = 'https://accounts.spotify.com/authorize';
const TOKEN = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-private '
  + 'playlist-read-private playlist-read-collaborative user-read-recently-played';
const TK = 'moto.spotify.token';
const VK = 'moto.spotify.verifier';

export const spotify = {
  connected: false,
  playing: false,
  title: '',
  artist: '',
  volume: null,
  canVolume: null,    // null = noch unbekannt, false = vom Gerät abgelehnt
  device: null,       // Name des aktiven Geräts
  playlists: [],      // eigene Playlists
  error: null,
};

const listeners = new Set();
export function onSpotify(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) fn(spotify); }

/** Spotify vergleicht die Redirect-URI zeichengenau. `new URL('.', …)` liefert
    immer die Verzeichnisform mit Schrägstrich am Ende — egal ob die App unter
    „…/moto-mode/“ oder „…/moto-mode/index.html“ geöffnet wurde. Wer im Dashboard
    etwas anderes eingetragen hat, kann es im Setup überschreiben. */
export function redirectUri() {
  return settings.redirect.trim() || new URL('.', location.href).href;
}

/* ── PKCE ──────────────────────────────────────────────────────────────── */

function randomVerifier() {
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function challenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function connect() {
  const id = settings.spotifyId.trim();
  if (!id) { spotify.error = 'Client-ID fehlt (Einstellungen)'; emit(); return; }
  const verifier = randomVerifier();
  sessionStorage.setItem(VK, verifier);
  const params = new URLSearchParams({
    client_id: id,
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: await challenge(verifier),
    scope: SCOPES,
  });
  location.href = `${AUTH}?${params}`;
}

function saveToken(data) {
  const token = {
    access: data.access_token,
    refresh: data.refresh_token || readToken()?.refresh,
    expires: Date.now() + (data.expires_in - 60) * 1000,
    scope: data.scope || readToken()?.scope || '',
  };
  localStorage.setItem(TK, JSON.stringify(token));
  return token;
}

function readToken() {
  try { return JSON.parse(localStorage.getItem(TK) || 'null'); } catch { return null; }
}

export function logout() {
  localStorage.removeItem(TK);
  spotify.connected = false;
  spotify.title = '';
  spotify.artist = '';
  emit();
}

/** Nach der Rückkehr von Spotify den Code gegen ein Token tauschen. */
export async function handleRedirect() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (params.get('error')) {
    spotify.error = 'Spotify-Anmeldung abgebrochen';
    history.replaceState({}, '', redirectUri());
    emit();
    return;
  }
  if (!code) { spotify.connected = !!readToken(); emit(); return; }

  const verifier = sessionStorage.getItem(VK);
  history.replaceState({}, '', redirectUri());
  if (!verifier) return;

  try {
    const res = await fetch(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: settings.spotifyId.trim(),
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(),
        code_verifier: verifier,
      }),
    });
    if (!res.ok) throw new Error('token');
    saveToken(await res.json());
    sessionStorage.removeItem(VK);
    spotify.connected = true;
    spotify.error = null;
    set({ source: 'spotify' });
    emit();
  } catch {
    spotify.error = 'Token-Tausch fehlgeschlagen';
    emit();
  }
}

async function accessToken() {
  const t = readToken();
  if (!t) return null;
  if (Date.now() < t.expires) return t.access;
  if (!t.refresh) return null;
  try {
    const res = await fetch(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: settings.spotifyId.trim(),
        grant_type: 'refresh_token',
        refresh_token: t.refresh,
      }),
    });
    if (!res.ok) throw new Error('refresh');
    return saveToken(await res.json()).access;
  } catch {
    logout();
    return null;
  }
}

/* Spotify bremst bei zu vielen Anfragen mit 429 aus. Ohne Beachtung reiht
   sich Fehler an Fehler und die Bedienung stirbt still. */
let rateLimitUntil = 0;

async function api(path, { method = 'GET', query, body } = {}) {
  if (Date.now() < rateLimitUntil) return null;
  const token = await accessToken();
  if (!token) { spotify.connected = false; emit(); return null; }
  const url = `${API}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });

  if (res.status === 429) {
    // Spotify nennt hier gelegentlich sehr lange Fristen. Ungedeckelt legt das
    // die Bedienung für Stunden still, ohne dass man den Grund sieht.
    const asked = Number(res.headers.get('Retry-After') || 3);
    const wait = Math.min(asked, 30);
    rateLimitUntil = Date.now() + (wait + 1) * 1000;
    spotify.error = `Spotify bremst — ${wait + 1} s warten`;
    emit();
    return null;
  }
  if (res.status === 401) { logout(); return null; }
  if (res.status === 403) { spotify.error = 'Von Spotify abgelehnt (Premium/Gerät?)'; emit(); return null; }
  if (res.status === 404) { spotify.error = 'Kein aktives Spotify-Gerät'; emit(); return null; }
  if (res.status === 204) { spotify.error = null; return { empty: true }; }
  if (!res.ok) { spotify.error = `Spotify ${res.status}`; emit(); return null; }

  spotify.error = null;
  const text = await res.text();
  return text ? JSON.parse(text) : { empty: true };
}

/* ── Steuerung ─────────────────────────────────────────────────────────── */

/** Spotify nimmt Befehle nur für ein „aktives“ Gerät an. Steht keines bereit,
    wird das iPhone zum aktiven gemacht — sonst laufen die Tasten ins Leere,
    und das ist der mit Abstand häufigste Grund dafür. */
/** Spotifys Begriff vom „aktiven Gerät" ist wackelig: Nach dem Pausieren fällt
    die iOS-App heraus. Deshalb merken wir uns die Geräte-ID und hängen sie an
    jeden Befehl — das ist verlässlicher als auf einen Zustand zu hoffen. */
async function ensureDevice(startPlaying = false, force = false) {
  // Die Geräteliste ändert sich selten. Sie vor jedem Tastendruck abzufragen
  // hat den Anfrageschwall erzeugt, der Spotify zum Bremsen brachte.
  if (!force && deviceId && Date.now() - deviceCheckedAt < 60000) return 'active';

  const data = await api('/me/player/devices');
  const list = data?.devices || [];
  if (!list.length) { spotify.error = 'Spotify-App auf dem iPhone öffnen'; emit(); return 'none'; }

  const active = list.find((d) => d.is_active);
  const phone = active || list.find((d) => d.type === 'Smartphone') || list[0];
  deviceId = phone.id;
  deviceCheckedAt = Date.now();
  spotify.canVolume = phone.supports_volume !== false;
  if (active) return 'active';

  await api('/me/player', { method: 'PUT', body: { device_ids: [phone.id], play: startPlaying } });
  await new Promise((r) => setTimeout(r, 500));
  return startPlaying ? 'started' : 'transferred';
}

const withDevice = (q = {}) => (deviceId ? { ...q, device_id: deviceId } : q);

/** Befehl senden. Schlägt er fehl, ist meist das gemerkte Gerät weg — dann
    einmal neu suchen und wiederholen, statt still nichts zu tun. */
async function command(path, opts = {}) {
  let r = await api(path, { ...opts, query: withDevice(opts.query) });
  if (r !== null || Date.now() < rateLimitUntil) return r;

  deviceId = null;
  if (await ensureDevice(false, true) === 'none') return null;
  return api(path, { ...opts, query: withDevice(opts.query) });
}

/* Nach einem Befehl sofort das Bild aktualisieren, statt bis zum nächsten
   Abfragezyklus zu warten — sonst wirkt die Bedienung träge. */
/* Nach einem Befehl braucht Spotify einen Moment. Fragt man zu früh, meldet
   der Server noch den alten Stand und der Knopf springt zurück — genau das
   sah nach „Pause geht nicht" aus. Also sperren wir die Übernahme kurz. */
let holdUntil = 0;
function quickRefresh() {
  holdUntil = Date.now() + 1800;
  setTimeout(refresh, 900);
  setTimeout(refresh, 2000);
}

export async function play() {
  const state = await ensureDevice(true);
  if (state === 'none') return;
  spotify.playing = true; emit();                 // sofortige Rückmeldung
  const ok = state === 'started' || await command('/me/player/play', { method: 'PUT' }) !== null;
  if (!ok) revert(false);          // Befehl kam nicht an — Anzeige zurücknehmen
  quickRefresh();
}

export async function pause() {
  spotify.playing = false;
  quickRefresh();
  emit();
  if (await command('/me/player/pause', { method: 'PUT' }) === null) revert(true);
}

/** Optimistische Anzeige zurücknehmen. Ohne das bleibt `playing` nach einem
    fehlgeschlagenen Befehl stehen — und `toggle` ruft danach immer dieselbe
    Richtung auf, wodurch der Knopf tot wirkt. */
function revert(playing) {
  holdUntil = 0;
  spotify.playing = playing;
  emit();
  setTimeout(refresh, 300);
}

export async function next() {
  if (await ensureDevice() === 'none') return;
  await command('/me/player/next', { method: 'POST' });
  quickRefresh();
}

export async function prev() {
  if (await ensureDevice() === 'none') return;
  await command('/me/player/previous', { method: 'POST' });
  quickRefresh();
}

export const toggle = () => (spotify.playing ? pause() : play());

/** Eine gemerkte Playlist bzw. ein Album wieder starten. */
/** Spotify-App mit dieser Playlist öffnen. Der Rückweg, wenn die Web-API nicht
    greift: Ohne laufende Spotify-App gibt es kein Connect-Gerät, und dann kann
    keine Fernsteuerung etwas starten. Der Sprung in die App startet sie. */
/* Naht für den Ablauftest: Er kann das Öffnen ersetzen, statt die Testseite
   zu verlassen. Im Betrieb bleibt es beim schlichten Seitenwechsel. */
let opener = (url) => { location.href = url; };
export function setOpener(fn) { opener = fn; }

function openInApp(uri) {
  const [, kind, id] = uri.split(':');
  if (!id) return;
  spotify.error = 'Kein aktives Gerät — Spotify wird geöffnet';
  emit();
  const t = Date.now();
  opener(uri);                               // spotify:playlist:…
  setTimeout(() => {
    if (!document.hidden && Date.now() - t < 2500) opener(`https://open.spotify.com/${kind}/${id}`);
  }, 1200);
}

/** Playlist starten — auf Wunsch in zufälliger Reihenfolge.
    Reihenfolge der Aufrufe ist nicht beliebig: Zufallswiedergabe lässt sich auf
    einem Gerät, das noch nie gespielt hat, oft nicht setzen. Deshalb erst
    versuchen, und falls das misslingt, nach dem Start nachholen. */
export async function playContext(uri, shuffle = true) {
  const device = await ensureDevice();

  if (device !== 'none') {
    let shuffled = false;
    if (shuffle) {
      shuffled = await command('/me/player/shuffle', { method: 'PUT', query: { state: 'true' } }) !== null;
    }
    const started = await command('/me/player/play', { method: 'PUT', body: { context_uri: uri } });
    if (started !== null) {
      if (shuffle && !shuffled) await command('/me/player/shuffle', { method: 'PUT', query: { state: 'true' } });
      spotify.playing = true;
      spotify.error = null;
      quickRefresh();
      emit();
      return true;
    }
  }

  openInApp(uri);                            // stumm scheitern ist keine Option
  return false;
}

/** Eigene Playlists. Werden gespeichert, damit sie auch ohne Netz erscheinen. */
const PL = 'moto.spotify.playlists';
try { spotify.playlists = JSON.parse(localStorage.getItem(PL) || '[]'); } catch {}

/** Zuletzt gehörte Playlists und Alben, neueste zuerst. */
export async function loadRecent() {
  const data = await api('/me/player/recently-played', { query: { limit: '50' } });
  const seen = new Map();
  for (const it of data?.items || []) {
    const uri = it?.context?.uri;
    if (!uri || seen.has(uri)) continue;
    if (!uri.includes(':playlist:') && !uri.includes(':album:')) continue;
    seen.set(uri, it.played_at);
  }
  const out = [];
  for (const [uri] of seen) {
    const name = await contextName(uri);
    if (name) out.push({ uri, name, meta: uri.includes(':album:') ? 'Album · zuletzt gehört' : 'Playlist · zuletzt gehört' });
    if (out.length >= 10) break;
  }
  return out;
}

export async function loadPlaylists() {
  const [own, recent] = await Promise.all([
    api('/me/playlists', { query: { limit: '20' } }),
    loadRecent().catch(() => []),
  ]);
  if (!own?.items && !recent.length) return spotify.playlists;

  const mine = (own?.items || [])
    .filter((p) => p?.uri && p?.name)
    .map((p) => ({
      uri: p.uri,
      name: p.name,
      meta: `${p.tracks?.total ?? 0} Titel · ${p.owner?.display_name || 'Playlist'}`,
    }));

  // Zuletzt Gehörtes zuerst, dann die eigenen Playlists ohne Dubletten.
  const seen = new Set(recent.map((r) => r.uri));
  spotify.playlists = [...recent, ...mine.filter((p) => !seen.has(p.uri))];
  try { localStorage.setItem(PL, JSON.stringify(spotify.playlists)); } catch {}
  emit();
  return spotify.playlists;
}

/* Namen von Playlists/Alben einmal auflösen und behalten — /me/player liefert
   nur die URI des laufenden Kontexts. */
const NAMES = 'moto.spotify.names';
let names = {};
try { names = JSON.parse(localStorage.getItem(NAMES) || '{}'); } catch {}

async function contextName(uri) {
  if (names[uri]) return names[uri];
  const [, kind, id] = uri.split(':');
  if (!id || (kind !== 'playlist' && kind !== 'album')) return null;
  const data = await api(`/${kind}s/${id}`);
  if (!data?.name) return null;
  names[uri] = data.name;
  try { localStorage.setItem(NAMES, JSON.stringify(names)); } catch {}
  return data.name;
}

let lastContext = null;
let deviceId = null;
let deviceCheckedAt = 0;

async function noteContext(ctx) {
  if (!ctx?.uri || ctx.uri === lastContext) return;
  lastContext = ctx.uri;
  const name = await contextName(ctx.uri);
  if (!name) return;
  pushRecent({
    kind: 'spotify',
    uri: ctx.uri,
    name,
    meta: ctx.uri.includes(':album:') ? 'Album · Spotify' : 'Playlist · Spotify',
  });
}

/** Gerätelautstärke 0…1. iOS-Geräte melden `supports_volume: false` und lehnen
    das ab — dann gar nicht erst fragen, statt still zu scheitern. */
export async function setVolume(v) {
  if (spotify.canVolume === false) return false;
  const pct = Math.round(Math.max(0, Math.min(1, v)) * 100);
  const r = await command('/me/player/volume', { method: 'PUT', query: { volume_percent: pct } });
  if (r === null) {                      // abgelehnt — dann nicht weiter fragen
    spotify.canVolume = false;
    spotify.error = null;
    emit();
    return false;
  }
  spotify.volume = pct / 100;
  return true;
}

export async function refresh() {
  if (!readToken() || !navigator.onLine) {
    spotify.connected = !!readToken();
    emit();
    return;
  }
  const data = await api('/me/player');
  spotify.connected = !!readToken();
  if (data && !data.empty && data.item) {
    if (Date.now() >= holdUntil) spotify.playing = !!data.is_playing;
    spotify.title = data.item.name || '';
    spotify.artist = (data.item.artists || []).map((a) => a.name).join(', ');
    spotify.volume = data.device?.volume_percent != null ? data.device.volume_percent / 100 : null;
    spotify.device = data.device?.name || null;
    if (data.device) spotify.canVolume = !!data.device.supports_volume;
    noteContext(data.context);
  } else if (data === null) {
    // Abfrage fehlgeschlagen: lieber nichts behaupten, als eine falsche
    // Anzeige stehen zu lassen, an der `toggle` dann falsch entscheidet.
    holdUntil = 0;
  } else if (data?.empty) {
    spotify.playing = false;
    spotify.title = '';
    spotify.artist = '';
  }
  emit();
}

/* Kommt die App aus dem Hintergrund zurück, kann Spotify zwischendurch
   geschlossen worden sein. Dann ist das gemerkte Gerät wertlos. */
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) deviceCheckedAt = 0;
  });
}

/* ── Diagnose ──────────────────────────────────────────────────────────────
   Am Gerät ausführbar, weil sich nur dort zeigt, was Spotify wirklich
   antwortet. Bewusst an `api()` vorbei: Diese Aufrufe sollen auch dann
   durchgehen, wenn die Sperrfrist gerade greift, und den echten Statuscode
   melden statt `null`. */

export async function diagnose() {
  const L = [];
  const t = readToken();
  L.push(t ? `Anmeldung: vorhanden, gültig noch ${Math.max(0, Math.round((t.expires - Date.now()) / 1000))} s`
            : 'Anmeldung: FEHLT — im Setup verbinden');
  L.push(`Berechtigungen: ${t?.scope || 'unbekannt (vor der Umstellung erteilt → neu verbinden)'}`);
  if (Date.now() < rateLimitUntil) {
    L.push(`GEBREMST: noch ${Math.round((rateLimitUntil - Date.now()) / 1000)} s gesperrt`);
  }
  if (!t) return L.join('\n');

  const token = await accessToken();
  if (!token) return [...L, 'Token konnte nicht erneuert werden — neu verbinden'].join('\n');

  const call = async (method, path, body) => {
    try {
      const res = await fetch(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const txt = await res.text();
      return { status: res.status, data: txt ? JSON.parse(txt) : null };
    } catch (e) {
      return { status: 0, data: { error: e.message } };
    }
  };

  const me = await call('GET', '/me');
  L.push(`Konto: HTTP ${me.status}${me.data?.product ? ` · ${me.data.product}` : ''}`);
  if (me.data?.product && me.data.product !== 'premium') {
    L.push('  → Ohne Premium lehnt Spotify jede Fernsteuerung ab. Das ist die Ursache.');
  }

  const dev = await call('GET', '/me/player/devices');
  const list = dev.data?.devices || [];
  L.push(`Geräte: HTTP ${dev.status} · ${list.length} gefunden`);
  list.forEach((d) => L.push(`  ${d.is_active ? '▶' : '·'} ${d.name} (${d.type}) Lautstärke ${d.supports_volume ? 'ja' : 'nein'}`));
  if (!list.length) L.push('  → Spotify-App auf dem iPhone öffnen und einen Titel starten.');

  const target = list.find((d) => d.is_active) || list[0];
  const q = target ? `?device_id=${target.id}` : '';

  const st = await call('GET', '/me/player');
  L.push(`Zustand: HTTP ${st.status}${st.status === 200 ? ` · ${st.data?.is_playing ? 'läuft' : 'pausiert'}` : ''}`);

  const pause = await call('PUT', `/me/player/pause${q}`);
  L.push(`Pause senden: HTTP ${pause.status}${pause.status >= 400 ? ` · ${pause.data?.error?.message || ''}` : ' · angenommen'}`);

  await new Promise((r) => setTimeout(r, 600));
  const play = await call('PUT', `/me/player/play${q}`);
  L.push(`Play senden: HTTP ${play.status}${play.status >= 400 ? ` · ${play.data?.error?.message || ''}` : ' · angenommen'}`);

  L.push('');
  L.push('403 = abgelehnt (meist kein Premium) · 404 = kein aktives Gerät');
  L.push('401 = Anmeldung abgelaufen · 429 = zu viele Anfragen');
  return L.join('\n');
}

let poll = null;
export function startPolling() {
  if (poll) return;
  refresh();
  poll = setInterval(() => { if (!document.hidden) refresh(); }, 8000);
}
export function stopPolling() { clearInterval(poll); poll = null; }
