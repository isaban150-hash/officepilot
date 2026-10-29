# OfficePilot – Deployment (geschlossene Beta)

Produktionsbereitstellung auf Vercel als SPA mit Auth-Gates und ohne Demo-Modus.

## Build & Runtime

| Einstellung | Wert |
|-------------|------|
| Build-Befehl | `npm run build` |
| Output-Verzeichnis | `dist` |
| Node-Version | 20 (`.nvmrc`, `engines.node >= 20`) |
| Framework | Vite + React (SPA) |
| SPA-Routing | `vercel.json` → Rewrite auf `/index.html` |

## Vercel einrichten

1. Repository mit Vercel verbinden (Import Project).
2. Framework Preset: **Vite** (automatisch erkannt).
3. Build Command: `npm run build`
4. Output Directory: `dist`
5. Node.js Version: **20.x** (Project Settings → General → Node.js Version)
6. Environment Variables (siehe unten) setzen.
7. Deploy auslösen.

### SPA-Routing

`vercel.json` leitet alle Pfade (außer `/assets/*`, `favicon.ico`, `robots.txt`) auf `index.html` um.  
Damit funktionieren Direktaufrufe und Browser-Refresh auf Unterseiten (z. B. `/dokumente/upload`, `/login`).

## Environment Variables

### Production (geschlossene Beta)

| Variable | Production | Beschreibung |
|----------|------------|--------------|
| `VITE_BETA_TEST_MODE` | **leer / nicht gesetzt** | Demo-Modus, Auto-Login, Musterbetrieb – darf in Production nicht aktiv sein |
| `VITE_ALLOW_DEFAULT_ADMIN` | **nicht setzen** | ohne Funktion (es gibt kein Standardkonto); in Production erscheint nur der Konfigurationshinweis |

Weitere Variablen und Server-Secrets, die mit EINRICHTUNG-01 hinzukommen (Antwortadresse, Löschungen, Versandstatus,
erlaubte Ursprünge), stehen mit Reihenfolge und Prüfungen in
[RELEASE_01_EINRICHTUNG.md](./RELEASE_01_EINRICHTUNG.md).

> **`VITE_GEMINI_API_KEY` und `VITE_GEMINI_MODEL` werden nicht mehr verwendet.**
> Sie dürfen in Vercel und in lokalen `.env`-Dateien **nicht** gesetzt sein – siehe
> „KI-Zugang" weiter unten.

### Lokale Entwicklung / Staging-Beta

```env
# .env.local (nicht committen)
VITE_BETA_TEST_MODE=true
```

### Sicherheits-Hinweise

- `VITE_*` Variablen landen im Browser-Bundle – keine Server-Geheimnisse dort ablegen.
- Bei aktivem `VITE_BETA_TEST_MODE` in Production zeigt die App einen roten Konfigurations-Hinweis.
- Production-Build entfernt `console.*` und `debugger` (Vite/esbuild `drop`).

## KI-Zugang (Gemini)

Der Gemini-Schlüssel ist ein **Server-Secret** und wird nie an den Browser ausgeliefert.

```
Browser  →  Supabase Edge Function  ai  →  Gemini
            (Sitzung, Kontostatus, Lizenz,
             Workspace, Rate Limit)
```

Die Function liegt unter `supabase/functions/ai/`. Ihre Secrets werden **nicht** in
Vercel gesetzt, sondern beim Supabase-Projekt:

```bash
npx supabase secrets set GEMINI_API_KEY=...
npx supabase secrets set AI_RATE_LIMIT_SHORT_WINDOW_SECONDS=...
npx supabase secrets set AI_RATE_LIMIT_SHORT=...
npx supabase secrets set AI_RATE_LIMIT_DAILY=...
```

Die drei Rate-Limit-Werte sind **Pflicht**: Fehlt oder ungültig ist einer davon,
antwortet der Endpunkt bewusst mit `server_misconfigured`, statt still mit einer Grenze
zu laufen, die niemand gewählt hat.

`SUPABASE_URL` und `SUPABASE_SERVICE_ROLE_KEY` stellt Supabase der Function automatisch
bereit – nicht selbst setzen und niemals im Frontend verwenden.

Kein Schlüssel, Token oder Service-Role-Wert gehört in diese Dokumentation.

> ### Offener Sicherheitspunkt: Schlüsselrotation
>
> Der Gemini-Schlüssel wurde früher clientseitig ausgeliefert und ist deshalb als
> kompromittiert zu behandeln. **Diese Rotation hat noch nicht stattgefunden.**
>
> Vor dem ersten echten Kundeneinsatz: neuen Schlüssel erzeugen, `GEMINI_API_KEY`
> ersetzen, alten Schlüssel widerrufen, alte `VITE_GEMINI_*`-Einträge in Vercel und
> lokal entfernen. Vollständige Liste in
> [../OFFICEPILOT_GO_LIVE.md](../OFFICEPILOT_GO_LIVE.md).

## Auth & Zugang (geschlossene Beta)

Vor jedem App-Zugriff (Reihenfolge wie in `src/App.tsx`):

| Zustand | Ansicht |
|---------|---------|
| Nicht angemeldet | `/login` (Registrierung, Passwort vergessen, Einladungslink) |
| Konto wartet auf Freigabe (`pending`) | `/waiting-approval` — prüft alle 30 s, zeigt offene Einladungen, Selbstlöschung |
| Konto gesperrt (`blocked`) | `/access-blocked` |
| Zustimmung zur geltenden Fassung der Rechtstexte fehlt | Zustimmungsseite |
| Unbekannter Kontostatus | `/license-expired` (Rückfallseite) |
| Einrichtung des Betriebs offen | `/setup` |
| Sonst | App |

Die Lizenz gehört zum Betrieb (E3): Läuft sie ab, wechselt der Betrieb in den Nur-Lesen-Betrieb mit Hinweis; es gibt
keinen Sperrbildschirm; Lesen, Export und Abmelden bleiben möglich.

Öffentlich erreichbar (ohne Login): `/impressum`, `/datenschutz`, `/agb`, `/lizenzbedingungen`, die Bestätigung der
Antwortadresse (`/antwortadresse-bestaetigen`) und die Notfallseiten (`/local-recovery`).

### Erster Plattform-Admin

Es gibt **kein Standardkonto und kein Standardpasswort**. Der erste Plattform-Admin wird vom Betreiber einmalig per SQL
aus einem normal registrierten Konto gemacht: [FIRST_ADMIN.md](./FIRST_ADMIN.md). Weitere Freigaben, Sperren und
Lizenzen erfolgen danach in der Plattform-Verwaltung (`/admin/users`, Einstieg über das Benutzermenü).

## Fehlerseiten

| Fall | Verhalten |
|------|-----------|
| 404 (unbekannte App-Route) | `NotFoundPage` |
| 500 (React-Fehler) | `AppErrorBoundary` → `ServerErrorPage` |
| Bootstrap-Fehler | `BootstrapError` mit Retry |
| Offline | `NetworkStatusBanner` |
| Falsche Production-Env | `ProductionConfigBanner` |

Kein leerer Bildschirm beim Start: `BootstrapLoading` während Initialisierung.

## Lokale Production-Prüfung

```bash
npm ci
npm test
npm run build
npm run preview
```

Preview: http://localhost:4173 – Routen direkt aufrufen und Refresh testen.

## Vercel CLI (optional)

```bash
npx vercel login
npx vercel --prod
```

## Bekannte Einschränkungen

- Dokumentdateien liegen nur lokal (IndexedDB / Base64) – auf einem zweiten Gerät sind
  sie nicht verfügbar
- Rechtstexte: Draft-Platzhalter
- Kein E-Mail-Versand
- Kein Fehler-Monitoring, kein automatisierter Testlauf
- Serverseitiger Lizenzschutz in der veröffentlichten Fassung nur für den KI-Endpunkt. EINRICHTUNG-01 (lokal umgesetzt,
  Veröffentlichung mit RELEASE-01) prüft die Betriebslizenz auch in Sync, Storage und den Edge Functions — siehe
  [../OFFICEPILOT_ROADMAP.md](../OFFICEPILOT_ROADMAP.md), Bereich 15
- Build-Warnungen: große Chunks, CSS-Minify (P2, nicht blockierend)

Auth und Fachdaten werden über Supabase synchronisiert (Konten, Workspace-Isolation,
Cloud-Sync). Die frühere Angabe „nur clientseitig, nicht geräteübergreifend" gilt nicht
mehr.

## Begleiteter Pilot

Checklisten und Vorlagen für den ersten begleiteten Pilot: [pilot/README.md](./pilot/README.md)
