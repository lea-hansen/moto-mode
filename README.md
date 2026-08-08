# Moto Mode

Minimalistisches Motorrad-Dashboard als PWA für das iPhone. Flaches Apple-Design,
tiefschwarzer Hintergrund, handschuhtaugliche Bedienelemente, Offline-First.

```
index.html            App-Shell
css/style.css         gesamtes Design (kein Blur, kein Glass, keine Verläufe)
js/store.js           Einstellungen + Tourdaten (localStorage)
js/gps.js             GPS: Tempo, Zonenerkennung, Tourstatistik
js/limits.js          Tempolimit aus OpenStreetMap (Overpass) mit Offline-Cache
js/nav.js             Abbiegenavigation: Route, Führung, Ansagen, Off-Route
js/map.js             Kartendarstellung auf MapLibre GL
vendor/maplibre-gl.*  Kartenbibliothek, bewusst lokal statt per CDN
js/audio.js           Web-Audio-Engine, Ducking, Ansagen
js/spotify.js         optionale Spotify-Fernsteuerung (PKCE)
js/app.js             UI-Verdrahtung
sw.js                 Service Worker (Offline-First)
manifest.webmanifest  PWA-Manifest
serve.py              HTTPS-Dev-Server für den iPhone-Test
tools/make_icons.py   erzeugt die Icons neu
tools/layout-audit.html  prüft alle Geräte×Ansichten auf überlaufenden Inhalt
tools/nav-test.html      holt eine echte Route und prüft Führung und Ansagen
```

## Auf dem iPhone installieren

**<https://lea-hansen.github.io/moto-mode/>**

1. Die Adresse am iPhone in **Safari** öffnen.
2. Teilen-Menü → **Zum Home-Bildschirm**. Nur so läuft die App im Vollbild ohne
   Safari-Leisten, und nur so greift der Wake-Lock zuverlässig.
3. Die App vom Home-Bildschirm starten. Beim ersten Tipp fragt iOS nach dem
   Standort → **Beim Verwenden erlauben**.

Danach läuft sie auch ohne Netz: Der Service Worker hält die gesamte Oberfläche
vor. Kartenkacheln, Routenberechnung und Tempolimit brauchen eine Verbindung,
gefahrene Gegenden und bereits abgefragte Limits liegen aber im Cache.

## Änderungen veröffentlichen

Das Repository ist auf GitHub Pages aufgeschaltet — jeder Push auf `main` wird
automatisch ausgeliefert:

```bash
# VERSION in sw.js hochzählen, sonst behalten installierte iPhones die alte Fassung
git add -A && git commit -m "…" && git push
```

Der Build dauert etwa eine Minute. Auf dem iPhone erscheint die neue Fassung,
sobald die App einmal im Vordergrund war und danach aus dem App-Switcher
geschlossen und neu geöffnet wurde.

## Lokal entwickeln

Geolocation, Service Worker und Wake-Lock verlangen einen *secure context*.
`localhost` genügt dafür, `http://192.168.x.x` nicht — deshalb der HTTPS-Server
für Tests am Gerät:

```bash
cd ~/Documents/MotoModeApp
python3 serve.py            # https://<LAN-IP>:8443/, selbstsigniert
python3 -m http.server 8000 # reicht für Layout- und Logikprüfung am Mac
```

Safari akzeptiert das selbstsignierte Zertifikat am iPhone nur widerwillig — für
Tests am Gerät ist der Weg über die veröffentlichte Adresse der bequemere.

## Bedienung

Drei feste Bereiche, nichts scrollt außer dem Setup.

```
Querformat                          Hochformat
┌───────────────┬──────────┐        ┌────────────────┐
│               │ Tempo-   │        │  Tempolimit    │
│  Navigation   │ limit    │        ├────────────────┤
│    (2/3)      ├──────────┤        │  Navigation    │
│               │  Musik   │        ├────────────────┤
│               │  (2/3)   │        │  Musik         │
└───────────────┴──────────┘        └────────────────┘
```

**Tempolimit** sitzt fest oben rechts und ist bewusst nicht antippbar: Schild,
darunter `INNERORTS` / `AUSSERORTS` / `AUTOBAHN`, darunter Straße und Herkunft
des Werts.

**Musik** — sechs gleich große Ziele, mehr nicht: zurück, Play/Pause, weiter,
Mute, leiser, lauter. Der Balken darunter zeigt den Pegel (grün, wenn Smart
Volume gerade eingreift; „STUMM" bei Mute).

**Navigation** zeigt die Karte, darüber das nächste Manöver mit Entfernung,
darunter eine Tastenzeile. `ROUTE` berechnet die Strecke zum Ziel aus dem Setup;
während der Fahrt stehen dort Restweg, Restzeit, Ankunftszeit und `STOPP`. Die
drei kleinen Tasten daneben übergeben dasselbe Ziel an Apple Karten, Google Maps
oder calimoto, falls du doch lieber dort fährst.

**Antippen der Kopfzeile** wechselt den großen Bereich:

| angetippt | großer Bereich zeigt | Navigation bzw. Musik rückt |
|---|---|---|
| Musik | laufender Titel und die drei zuletzt gehörten Quellen | in den kleinen Platz |
| Navigation → `ROUTE ›` | Straße, Ortslage, Limit, Strecke, Fahrzeit, ø, max, Kurs, GPS-Genauigkeit | bleibt, wo sie ist |

Nach **10 Sekunden ohne Berührung** springt die Anzeige von selbst in die
Standardansicht zurück. Jede Berührung stellt die Uhr zurück, damit nichts
mitten im Tippen wegspringt; die Zeit ist im Setup einstellbar (0 = aus).

Die gefahrene Geschwindigkeit steht klein oben links in der Statusleiste — das
Motorrad hat einen eigenen Tacho. Rechts daneben erscheinen nur Auffälligkeiten:
`GPS` bei fehlendem Signal, `DISPLAY` wenn der Wake-Lock nicht greift, `OFFLINE`
ohne Netz. Ganz rechts das Zahnrad fürs Setup.

**Zuletzt gehört:** Bei Spotify werden die drei zuletzt gespielten Playlists
bzw. Alben gemerkt; ein Tipp startet sie wieder. Lokale Titel kann iOS nicht von
sich aus erneut öffnen — dort führt der Tipp zurück in die Dateiauswahl.

**Ziel** für die Navi-Apps steht im Setup, nicht im Fahrbetrieb: Ein Textfeld
bedient man ohnehin nur im Stand.

Ansage-Lautstärke und die Absenkung während einer Ansage liegen ebenfalls im
Setup — im Fahrbetrieb bleiben die sechs Musiktasten.

**Smart Volume** passt die Musik in drei Stufen an — Stadt / Landstraße /
Autobahn. Schwellen und Pegel sind im Setup frei wählbar (Vorgabe: bis 60 km/h
85 %, bis 100 km/h 100 %, darüber 115 %), mit 4 km/h Hysterese gegen Flattern.

### Layout prüfen

Bedienelemente wachsen und schrumpfen zwischen Mindest- und Maximalgrößen;
Schild, Ziffern und Beschriftungen hängen per Container-Query an ihrem Bereich
statt am Fenster. Ob das überall aufgeht, prüft:

```bash
python3 serve.py                      # oder: python3 -m http.server 8000
open http://127.0.0.1:8000/tools/layout-audit.html
```

Die Seite lädt die App in sieben iPhone-Größen × drei Ansichten, schaltet über
die echten Bedienelemente um und meldet jedes Element, dessen Inhalt über seinen
sichtbaren Bereich hinausragt.

## Abbiegenavigation

Die Route kommt von **Valhalla** mit Motorrad-Kostenmodell, die Ansagetexte
liefert Valhalla bereits auf Deutsch. Alles danach rechnet die App selbst:
Position auf die Route projizieren, Restweg, Abstand zum nächsten Manöver,
Ansagen auslösen, verlassene Route erkennen. Die Karte zeichnet **MapLibre GL**
mit Vektorkacheln von **OpenFreeMap** (kein API-Schlüssel nötig).

Die Ansagen laufen über dieselbe Sprachausgabe wie die Tempowarnung — Musik wird
also während einer Ansage abgesenkt, und der Ansage-Regler im Setup gilt auch
hier. Ausgelöst wird zweimal je Manöver: früh der Hinweis, kurz davor die
Anweisung. Die Abstände wachsen mit dem Tempo, weil 200 m bei 100 km/h zu spät
kommen.

Im Setup einstellbar: Routenart (schnell / Landstraße bevorzugen / Autobahn
meiden), Ansagen an/aus, Karte in Fahrtrichtung, Kartenstil sowie beide
Endpunkte, falls du eigene Server nutzen willst.

**Was das kann und was nicht:**

Die **Berechnung braucht Netz, das Abfahren nicht.** Ist die Route einmal geholt,
laufen Führung und Ansagen offline weiter — das Positions-Matching rechnet im
Browser. Wer im Funkloch falsch abbiegt, bekommt aber **keine neue Route**:
Offline-Routing scheitert an der Größe des Routing-Graphen. Die App sagt dann
„Route verlassen" und zeigt weiter, wo die alte Route liegt.

Die Kacheln landen im Service-Worker-Cache, gefahrene Gegenden erscheinen also
auch ohne Verbindung. Ein Vorbehalt: OpenFreeMap legt neue Planet-Stände unter
einem neuen Pfad ab — nach einem Update sind die alten Kacheln wertlos und
werden neu geladen. Verlässliches Offline-Kartenmaterial bräuchte eine eigene
PMTiles-Datei; das wäre der nächste Ausbauschritt.

Es gibt **keinen Verkehr, keine Blitzer, keine Live-Umleitung**, und beim
Routing selbst wird das calimoto nicht schlagen — echtes Kurvenrouting kann
Valhalla nicht, „Autobahn meiden" drückt die Route aber zuverlässig auf
Landstraßen. Der Grund für die eingebaute Navigation ist ein anderer: iOS kann
calimoto und MotoMode nicht gleichzeitig anzeigen. Nur so liegen Karte, Musik
und Tempolimit auf einem Bildschirm.

Beide Dienste sind Gemeinschaftsangebote mit Fair-Use-Grenzen. Eine Route pro
Fahrt fällt dort nicht ins Gewicht; wer dauernd neu berechnet, sollte einen
eigenen Endpunkt eintragen.

### Navigation prüfen

```bash
open http://127.0.0.1:8000/tools/nav-test.html
```

Holt eine echte Route, fährt sie synthetisch ab und meldet Restweg, Manöver,
Abstand zur Route und die ausgelösten Ansagen. Genau damit ist aufgefallen, dass
ein globaler Suchlauf im Positions-Matching bei Routen, die sich kreuzen, auf
einen falschen Abschnitt springt.

## Tempolimit ohne Navigation

Das Limit kommt aus OpenStreetMap über die Overpass-API — unabhängig davon, ob
eine Navigation läuft. Bei jedem GPS-Fix werden die Straßen im Umkreis von 50 m
geholt; die nächstgelegene gewinnt, bei Parallelstraßen entscheidet die
Fahrtrichtung mit.

**Das braucht Netz.** Jede abgefragte Rasterzelle (rund 110 × 70 m) landet
dauerhaft im Cache, damit gefahrene Strecken auch im Funkloch ein Limit zeigen —
beim ersten Befahren einer Straße braucht es aber Empfang. Abgefragt wird
höchstens alle 12 Sekunden und erst nach 70 m Fahrt, weil Overpass ein
Gemeinschaftsdienst ist. Antwortet der Server mit 429 oder 504, setzt die App
eine Minute aus und zeigt „Server ausgelastet" statt eines Fehlers.

Unter dem Schild steht immer die **Herkunft** des Werts, denn nicht jeder ist
gleich belastbar:

| Herkunft | Bedeutung |
|---|---|
| `Schild` | ausgeschildertes `maxspeed` in OSM — der verlässlichste Fall |
| `Zone` | aus `maxspeed:type`/`zone:maxspeed`, z. B. `DE:urban` → 50 |
| `Annahme` | nur bei eindeutigen Typen: Autobahn → frei, Wohnstraße → 50, Spielstraße → 7 |
| `—` | kein belastbarer Wert; bei Landstraßen ohne Tag wird bewusst **nicht** geraten |
| `frei` | unbegrenzt (deutsche Autobahn ohne Beschilderung) |

Fehlt in OSM ein Wert, bleibt das Schild leer statt zu raten — ein falsches
Limit wäre schlimmer als keines. Der Cache lässt sich im Setup leeren, der
Overpass-Endpunkt dort auch auf einen Spiegel umstellen.

**Das ersetzt keine Beschilderung.** OSM-Daten können veraltet, unvollständig
oder schlicht falsch sein, und temporäre Limits (Baustellen, Wechselverkehrs-
zeichen) kennt die Datenbank ohnehin nicht. Was am Straßenrand steht, gilt.

## Was iOS zulässt — und was nicht

Vier Dinge sind Plattformgrenzen, keine Auslassungen. Sie bestimmen den Aufbau:

1. **Systemlautstärke ist für Web-Apps tabu.** Auch `audio.volume` ignoriert iOS.
   Echte Regelung gibt es nur für Audio, das *diese App selbst* abspielt —
   deshalb läuft die Wiedergabe durch einen Web-Audio-`GainNode`. Mit
   *Setup → Titel vom iPhone laden* wählst du Dateien aus der Dateien-App;
   darauf wirken Regler, Mute, Smart Volume und Ducking vollständig.
2. **Karten lassen sich nicht einbetten.** Der Navigationsbereich ist ein
   Schnellstart für Apple Karten, Google Maps und calimoto (das Ziel aus dem
   Setup wird übergeben, calimoto startet ohne Ziel). Sobald die Navi-App im
   Vordergrund ist, pausiert iOS die PWA — GPS und Wake Lock laufen beim
   Zurückwechseln automatisch weiter. Ein echtes Split-Screen aus Web-App und
   nativer Karte gibt es auf dem iPhone nicht; die Route-Ansicht zeigt deshalb
   Fahrdaten statt einer Karte. Eine Abbiegenavigation kann sie nicht liefern —
   dafür fehlt einer Web-App jeder Zugang zur laufenden Navigation.
3. **Fremd-Apps sind nicht steuerbar.** Die Navi-Ansagen von Apple Karten kann
   keine Web-App regeln. Der Ansage-Regler steuert die Sprachausgabe *dieser*
   App (Limitwarnung, Zonenwechsel, Test-Ansage) samt Musikabsenkung.
4. **Tempolimits gibt iOS nicht heraus.** Weder CarPlay- noch Karten-Daten sind
   für Web-Apps zugänglich; deshalb OpenStreetMap und deshalb der Netzbedarf.

## Spotify (optional)

Fernsteuerung der nativen Spotify-App über die Web API — braucht Internet und
Spotify Premium:

1. Auf <https://developer.spotify.com/dashboard> eine App anlegen.
2. Als **Redirect-URI** dort `https://lea-hansen.github.io/moto-mode/` eintragen —
   exakt so, wie es im Setup angezeigt wird.
3. Client-ID im Setup hinterlegen, dann *Spotify verbinden*.

Play/Pause, Titelwechsel und Titelanzeige funktionieren damit. Die
Gerätelautstärke lehnt Spotify auf iOS-Clients meist mit `403` ab — der
Mute-Button fällt dann auf Pause zurück, was praktisch dasselbe leistet.
Der Anmelde-Umweg über `accounts.spotify.com` verlässt auf iOS unter Umständen
die Vollbild-App; danach die App vom Home-Bildschirm neu öffnen, das Token bleibt
gespeichert.

## Icons neu erzeugen

```bash
python3 tools/make_icons.py
```

Reiner Python-Standard, keine Abhängigkeiten. Nach Änderungen am Cache-Inhalt
`VERSION` in `sw.js` hochzählen, damit iPhones die neue Fassung ziehen.

---

Bedienung nur im Stand. Die App zeigt Daten an und startet Apps — sie ersetzt
weder Blick noch Tacho des Motorrads.
