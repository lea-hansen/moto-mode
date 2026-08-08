/* Audio-Engine für die App-eigene Wiedergabe.
   Wichtig für iOS: `HTMLAudioElement.volume` ist auf iPhones schreibgeschützt.
   Echte Lautstärkeregelung geht nur über einen Web-Audio-GainNode — genau das
   passiert hier. Deshalb läuft alle Musik durch den Graph
   <audio> → MediaElementSource → gain → destination. */

import { settings, pushRecent } from './store.js';

const el = document.getElementById('player');

let ctx = null;
let gain = null;
let ducking = false;

export const audio = {
  playing: false,
  tracks: [],
  index: -1,
  title: '',
  artist: '',
};

const listeners = new Set();
export function onAudio(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) fn(audio); }

/* ── Audio-Sitzung ─────────────────────────────────────────────────────────
   iOS senkt fremden Ton von sich aus ab, wenn eine Webseite kurz etwas
   abspielt. Genau davon lebt die Absenkung bei Ansagen, auch bei Spotify.

   Wer hier eingreift, kann das kaputtmachen: `ambient` heißt ausdrücklich
   „andere nicht absenken“ — damit war die Absenkung weg. Deshalb wird die
   Sitzungsart standardmäßig gar nicht angefasst, das Standardverhalten ist
   das bessere. Nur wer den Schalter im Setup umlegt, bekommt zusätzlich den
   ausdrücklichen Hinweis `transient` während einer Ansage. */

function setSession(type) {
  if (!settings.duckHint) return;             // aus: Systemverhalten unberührt
  try {
    if (navigator.audioSession) navigator.audioSession.type = type;
  } catch { /* ältere Fassung ohne diese Schnittstelle */ }
}

export function hasAudioSession() { return !!navigator.audioSession; }

/** Zurück auf die Vorgabe des Browsers — nicht auf `ambient`. */
function baseSession() {
  return audio.playing ? 'playback' : 'auto';
}

/* ── Graph ─────────────────────────────────────────────────────────────── */

/** Sprachausgabe freischalten. Kostet keine Audio-Session und darf deshalb bei
    jeder Berührung laufen — anders als der AudioContext. */
export function primeSpeech() {
  if (!('speechSynthesis' in window) || primeSpeech.done) return;
  primeSpeech.done = true;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  try { speechSynthesis.speak(u); } catch {}
}

/** AudioContext anlegen und wecken. Nur aufrufen, wenn die App gleich selbst
    Ton macht: Auf iOS hält eine Seite mit laufendem Context eine Audio-Session,
    und die kann fremde Wiedergabe — etwa Spotify — unterbrechen oder absenken.
    Muss aus einer Nutzergeste heraus geschehen (iOS-Autoplay-Policy). */
export function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      ctx = new AC();
      gain = ctx.createGain();
      gain.gain.value = targetGain();
      ctx.createMediaElementSource(el).connect(gain);
      gain.connect(ctx.destination);
    } catch {
      ctx = null; gain = null;
      return false;
    }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  setSession(baseSession());
  primeSpeech();
  return true;
}

/** Audio-Session wieder freigeben, damit fremde Wiedergabe ungestört läuft. */
export function releaseAudio() {
  if (!ctx || audio.playing) return;
  ctx.suspend().catch(() => {});
}

export function hasContext() { return !!ctx; }

let autoFactor = 1;

function targetGain() {
  if (settings.muted) return 0;
  let g = settings.mediaVol * autoFactor;
  if (ducking) g *= 1 - settings.duck;
  return Math.max(0, Math.min(1.5, g));
}

function applyGain(fast = false) {
  const t = targetGain();
  if (gain && ctx) {
    gain.gain.setTargetAtTime(t, ctx.currentTime, fast ? 0.02 : 0.12);
  } else {
    // Fallback für Plattformen ohne Web Audio (auf iOS wirkungslos).
    try { el.volume = Math.min(1, t); } catch {}
  }
}

/** Faktor der Geschwindigkeits-Automatik (1 = neutral). */
export function setAutoFactor(f) {
  if (Math.abs(f - autoFactor) < 0.001) return;
  autoFactor = f;
  applyGain();
}
export function getAutoFactor() { return autoFactor; }

export function refreshGain(fast) { applyGain(fast); }

/* ── Transport ─────────────────────────────────────────────────────────── */

export function loadFiles(fileList) {
  const files = Array.from(fileList).filter((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|flac|ogg)$/i.test(f.name));
  if (!files.length) return 0;
  audio.tracks.forEach((t) => URL.revokeObjectURL(t.url));
  audio.tracks = files.map((f) => ({
    url: URL.createObjectURL(f),
    title: f.name.replace(/\.[^.]+$/, ''),
    artist: 'Lokale Datei',
  }));
  audio.index = -1;
  claimMediaKeys(true);
  pushRecent({
    kind: 'local',
    name: audio.tracks[0].title,
    meta: `${audio.tracks.length} Titel · lokal`,
  });
  select(0, false);
  return audio.tracks.length;
}

function select(i, autoplay = true) {
  if (!audio.tracks.length) return;
  audio.index = (i + audio.tracks.length) % audio.tracks.length;
  const t = audio.tracks[audio.index];
  audio.title = t.title;
  audio.artist = `${t.artist} · ${audio.index + 1}/${audio.tracks.length}`;
  el.src = t.url;
  updateMediaSession();
  emit();
  if (autoplay) play();
}

export function play() {
  if (!audio.tracks.length) return;
  unlock();
  setSession('playback');
  el.play().then(() => { audio.playing = true; emit(); }).catch(() => {});
}

export function pause() {
  el.pause();
  audio.playing = false;
  setSession('auto');          // zurück zur Vorgabe, nicht auf 'ambient'
  emit();
}

export function toggle() { audio.playing ? pause() : play(); }
export function next() { select(audio.index + 1); }
export function prev() {
  if (el.currentTime > 4) { el.currentTime = 0; return; }
  select(audio.index - 1);
}

el.addEventListener('ended', () => next());
el.addEventListener('play', () => { audio.playing = true; emit(); });
el.addEventListener('pause', () => { audio.playing = false; emit(); });

/* ── Ansagen (TTS) mit Ducking ─────────────────────────────────────────── */

let duckTimer = null;

export function speak(text) {
  if (!('speechSynthesis' in window) || !text) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = settings.navLang || 'de-DE';
  u.volume = settings.voiceVol;
  u.rate = 1.05;

  // Nur absenken, wenn eigene Musik läuft. Fremden Ton senkt iOS von selbst ab.
  if (audio.playing) duckOn();
  u.onend = duckOff;
  u.onerror = duckOff;
  try { speechSynthesis.speak(u); } catch { duckOff(); }

  // Sicherheitsnetz: Falls onend auf iOS ausbleibt, spätestens nach 8 s lösen.
  clearTimeout(duckTimer);
  duckTimer = setTimeout(duckOff, 8000);
}

/* Eigene Musik über den Gain-Node absenken, fremde über die Sitzungsart. */
function duckOn() {
  ducking = true;
  applyGain(true);
  setSession('transient');
}

function duckOff() {
  clearTimeout(duckTimer);
  ducking = false;
  applyGain();
  setSession(baseSession());
}

/* ── Sperrbildschirm / AirPods-Tasten ──────────────────────────────────── */

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: audio.title || 'Moto Mode',
    artist: audio.artist || '',
    album: 'Moto Mode',
  });
}

/* Die Fernbedienungstasten — Helm-Headset, Kontrollzentrum — nur beanspruchen,
   wenn die App tatsächlich der Player ist. Sonst leitet iOS sie auf diese Seite
   um, und der leere lokale Player verschluckt sie, statt Spotify zu steuern. */
export function claimMediaKeys(on) {
  if (!('mediaSession' in navigator)) return;
  const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch {} };
  set('play', on ? play : null);
  set('pause', on ? pause : null);
  set('nexttrack', on ? next : null);
  set('previoustrack', on ? prev : null);
  try { navigator.mediaSession.playbackState = on && audio.playing ? 'playing' : 'none'; } catch {}
}
