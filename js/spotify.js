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
const SCOPES = 'user-read-playback-state user-modify-playback-state playlist-read-private playlist-read-collaborative';
const TK = 'moto.spotify.token';
const VK = 'moto.spotify.verifier';

export const spotify = {
  connected: false,
  playing: false,
  title: '',
  artist: '',
  volume: null,
  canVolume: false,   // iOS-Geräte lassen die Lautstärke nicht fernsteuern
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

async function api(path, { method = 'GET', query, body } = {}) {
  const token = await accessToken();
  if (!token) { spotify.connected = false; emit(); return null; }
  const url = `${API}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });

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
async function ensureDevice(startPlaying = false) {
  const data = await api('/me/player/devices');
  const list = data?.devices || [];
  if (!list.length) { spotify.error = 'Spotify-App auf dem iPhone öffnen'; emit(); return 'none'; }

  const active = list.find((d) => d.is_active);
  // Ob das Gerät überhaupt fernsteuerbare Lautstärke hat, sagt Spotify selbst.
  spotify.canVolume = !!(active || list[0])?.supports_volume;
  if (active) return 'active';

  // Nach dem Pausieren fällt die iOS-App als Gerät weg. Übertragen und dabei
  // gleich starten — zwei getrennte Aufrufe scheitern hier zuverlässig.
  const phone = list.find((d) => d.type === 'Smartphone') || list[0];
  await api('/me/player', { method: 'PUT', body: { device_ids: [phone.id], play: startPlaying } });
  await new Promise((r) => setTimeout(r, 500));
  return startPlaying ? 'started' : 'transferred';
}

/* Nach einem Befehl sofort das Bild aktualisieren, statt bis zum nächsten
   Abfragezyklus zu warten — sonst wirkt die Bedienung träge. */
function quickRefresh() { setTimeout(refresh, 350); setTimeout(refresh, 1200); }

export async function play() {
  const state = await ensureDevice(true);
  if (state === 'none') return;
  spotify.playing = true; emit();                 // sofortige Rückmeldung
  if (state !== 'started') await api('/me/player/play', { method: 'PUT' });
  quickRefresh();
}

export async function pause() {
  spotify.playing = false; emit();
  await api('/me/player/pause', { method: 'PUT' });
  quickRefresh();
}

export async function next() {
  if (await ensureDevice() === 'none') return;
  await api('/me/player/next', { method: 'POST' });
  quickRefresh();
}

export async function prev() {
  if (await ensureDevice() === 'none') return;
  await api('/me/player/previous', { method: 'POST' });
  quickRefresh();
}

export const toggle = () => (spotify.playing ? pause() : play());

/** Eine gemerkte Playlist bzw. ein Album wieder starten. */
export async function playContext(uri) {
  if (await ensureDevice() === 'none') return;
  spotify.playing = true; emit();
  await api('/me/player/play', { method: 'PUT', body: { context_uri: uri } });
  quickRefresh();
}

/** Eigene Playlists. Werden gespeichert, damit sie auch ohne Netz erscheinen. */
const PL = 'moto.spotify.playlists';
try { spotify.playlists = JSON.parse(localStorage.getItem(PL) || '[]'); } catch {}

export async function loadPlaylists() {
  const data = await api('/me/playlists', { query: { limit: '20' } });
  if (!data?.items) return spotify.playlists;
  spotify.playlists = data.items
    .filter((p) => p?.uri && p?.name)
    .map((p) => ({
      uri: p.uri,
      name: p.name,
      meta: `${p.tracks?.total ?? 0} Titel · ${p.owner?.display_name || 'Playlist'}`,
    }));
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
  if (!spotify.canVolume) return false;
  const pct = Math.round(Math.max(0, Math.min(1, v)) * 100);
  const r = await api('/me/player/volume', { method: 'PUT', query: { volume_percent: pct } });
  return r !== null;
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
    spotify.playing = !!data.is_playing;
    spotify.title = data.item.name || '';
    spotify.artist = (data.item.artists || []).map((a) => a.name).join(', ');
    spotify.volume = data.device?.volume_percent != null ? data.device.volume_percent / 100 : null;
    spotify.device = data.device?.name || null;
    if (data.device) spotify.canVolume = !!data.device.supports_volume;
    noteContext(data.context);
  } else if (data?.empty) {
    spotify.playing = false;
    spotify.title = '';
    spotify.artist = '';
  }
  emit();
}

let poll = null;
export function startPolling() {
  if (poll) return;
  refresh();
  poll = setInterval(() => { if (!document.hidden) refresh(); }, 5000);
}
export function stopPolling() { clearInterval(poll); poll = null; }
