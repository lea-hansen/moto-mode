/* Ansagetexte der App in drei Sprachen.

   Die Abbiegeanweisungen kommen fertig formuliert von Valhalla — hier stehen
   nur die Sätze, die die App selbst spricht. Beides muss dieselbe Sprache
   sprechen, sonst wechselt die Stimme mitten in der Fahrt. */

const TABLE = {
  'de-DE': {
    blocked: 'Achtung, Durchfahrt gesperrt.',
    surface: 'Achtung, unbefestigte Strecke.',
    routeStarted: (km, min) => `Route gestartet. ${km}, ${min} Minuten.`,
    offRoute: 'Route verlassen.',
    arrived: 'Ziel erreicht.',
    speedLimit: (n) => `Tempolimit ${n}.`,
    testVoice: (pct) => `Ansage. Lautstärke ${pct} Prozent.`,
    tiers: { 1: 'Innerorts', 2: 'Außerorts', 3: 'Autobahn' },
  },
  'es-ES': {
    blocked: 'Atención, paso restringido.',
    surface: 'Atención, firme sin asfaltar.',
    routeStarted: (km, min) => `Ruta iniciada. ${km}, ${min} minutos.`,
    offRoute: 'Has salido de la ruta.',
    arrived: 'Has llegado al destino.',
    speedLimit: (n) => `Límite de velocidad ${n}.`,
    testVoice: (pct) => `Aviso de voz. Volumen ${pct} por ciento.`,
    tiers: { 1: 'Zona urbana', 2: 'Carretera', 3: 'Autopista' },
  },
  'ca-ES': {
    blocked: 'Atenció, pas restringit.',
    surface: 'Atenció, ferm sense asfaltar.',
    routeStarted: (km, min) => `Ruta iniciada. ${km}, ${min} minuts.`,
    offRoute: 'Has sortit de la ruta.',
    arrived: 'Has arribat a destinació.',
    speedLimit: (n) => `Límit de velocitat ${n}.`,
    testVoice: (pct) => `Avís de veu. Volum ${pct} per cent.`,
    tiers: { 1: 'Zona urbana', 2: 'Carretera', 3: 'Autopista' },
  },
};

export const LANGS = {
  'de-DE': 'Deutsch',
  'ca-ES': 'Català',
  'es-ES': 'Español',
};

export function phrases(lang) {
  return TABLE[lang] || TABLE['de-DE'];
}
