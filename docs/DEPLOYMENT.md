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
| `VITE_ALLOW_DEFAULT_ADMIN` | **nur Ersteinrichtung** | Legt `admin@officepilot.local` an; nach erstem Admin-Login wieder entfernen |
| `VITE_GEMINI_API_KEY` | optional | KI-Funktionen (wird ins Frontend gebündelt – nur setzen wenn gewünscht) |
| `VITE_GEMINI_MODEL` | optional | Modell-Override |

### Lokale Entwicklung / Staging-Beta

```env
# .env.local (nicht committen)
VITE_BETA_TEST_MODE=true
VITE_ALLOW_DEFAULT_ADMIN=true
VITE_GEMINI_API_KEY=...
```

### Sicherheits-Hinweise

- `VITE_*` Variablen landen im Browser-Bundle – keine Server-Geheimnisse dort ablegen.
- Bei aktivem `VITE_BETA_TEST_MODE` in Production zeigt die App einen roten Konfigurations-Hinweis.
- Production-Build entfernt `console.*` und `debugger` (Vite/esbuild `drop`).

## Auth & Zugang (geschlossene Beta)

Vor jedem App-Zugriff:

| Status | Weiterleitung |
|--------|---------------|
| Nicht angemeldet | `/login` |
| `pending` | `/waiting-approval` |
| `blocked` | `/access-blocked` |
| Lizenz abgelaufen | `/license-expired` |
| Aktiv + Setup | App |

Öffentlich erreichbar (ohne Login): `/impressum`, `/datenschutz`, `/agb`, `/lizenzbedingungen`.

### Ersteinrichtung Admin (Production)

1. `VITE_ALLOW_DEFAULT_ADMIN=true` in Vercel setzen und redeployen.
2. Als Admin anmelden: `admin@officepilot.local` / `OfficePilot-Admin-2026`
3. Benutzer unter `/admin/users` freischalten.
4. `VITE_ALLOW_DEFAULT_ADMIN` wieder entfernen und redeployen.

**Hinweis:** Auth ist aktuell ein lokaler Stub (localStorage pro Browser). Freischaltungen gelten nur im jeweiligen Browser/Profil, bis ein Backend-Sync existiert.

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

- Auth & Daten: clientseitig (localStorage/sessionStorage), nicht geräteübergreifend
- Rechtstexte: Draft-Platzhalter
- Upload: Base64 in localStorage (Größenlimit)
- Build-Warnungen: große Chunks, CSS-Minify (P2, nicht blockierend)

## Begleiteter Pilot

Checklisten und Vorlagen für den ersten begleiteten Pilot: [pilot/README.md](./pilot/README.md)
