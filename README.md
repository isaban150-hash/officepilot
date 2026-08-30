# OfficePilot

Digitaler Büromitarbeiter für kleine Handwerksbetriebe. Mobile-First Web-App.

OfficePilot erkennt Dokumente, organisiert Vorgänge und Kunden, erstellt Rechnungen,
erfasst Belege und hilft dabei, eingehende Post zu verstehen. Für KI-Funktionen,
Synchronisation und die verbindliche Freigabe von Rechnungen und Nachträgen wird eine
Internetverbindung benötigt.

## Starten

```bash
npm install
npm run dev
```

App öffnen: http://localhost:5173

## Entwicklungsbefehle

```bash
npm test            # Kernauswahl der Tests
npm run test:watch  # Kernauswahl im Watch-Modus
npm run test:full   # vollständige Regression
npm run build       # tsc -b + Production-Build
npx tsc --noEmit    # reine Typprüfung
```

Für einzelne Bereiche laufen gezielt nur die betroffenen Testdateien — siehe
[OFFICEPILOT_DECISIONS.md](OFFICEPILOT_DECISIONS.md), D-007.

## Architektur (Kurzüberblick)

```
src/
├── types/          # Datenmodell (models.ts, sync.ts, branding.ts, presentation.ts …)
├── services/       # Fachlogik, getrennt von der UI
├── components/     # UI-Bausteine
├── pages/          # Seiten
├── context/        # App- und Auth-Zustand
├── lib/            # Supabase-Client
├── styles/         # Design-Tokens und Layout
├── i18n/           # Mehrsprachigkeit (Deutsch vollständig)
└── test/           # Testinfrastruktur und Fixtures

supabase/
├── migrations/     # Datenbank- und Storage-Migrationen
└── functions/      # Edge Functions (ai)

test-world/         # Referenzfirma und eingefrorene Gold-Suite
docs/               # Deployment, Ersteinrichtung, Pilotunterlagen
```

Die Anwendung ist eine React-SPA mit lokaler Persistenz (`localStorage`, IndexedDB) und
Supabase für Authentifizierung, Cloud-Sync und Storage. Der einzige Serverbestandteil ist
die Edge Function `ai`.

## Sicherheitsregeln

- Keine automatische Löschung von Dokumenten
- Keine automatische Rechnungsversendung
- Keine automatische Preis- oder Mengenänderung
- Vorschau und Nutzerbestätigung bei wichtigen Aktionen
- Der Gemini-Schlüssel ist ein **Server-Secret** und wird nie im Browser verwendet

Ausführlich: [OFFICEPILOT_DECISIONS.md](OFFICEPILOT_DECISIONS.md)

## Projektwissen und Weiterentwicklung

Neue Entwickler und Coding-Agenten lesen in dieser Reihenfolge:

1. **[OFFICEPILOT_HANDOFF.md](OFFICEPILOT_HANDOFF.md)** — wo das Projekt gerade steht und
   was als Nächstes ansteht
2. **[OFFICEPILOT_DECISIONS.md](OFFICEPILOT_DECISIONS.md)** — welche Regeln verbindlich
   gelten
3. **[OFFICEPILOT_MASTER.md](OFFICEPILOT_MASTER.md)** — Produkt und Architektur
4. **[OFFICEPILOT_ROADMAP.md](OFFICEPILOT_ROADMAP.md)** — die 16 Produktbereiche
5. **[OFFICEPILOT_GO_LIVE.md](OFFICEPILOT_GO_LIVE.md)** — bei release-relevanten Arbeiten

HANDOFF steht zuerst, weil es am schnellsten zeigt, ob das übrige Lesen überhaupt nötig
ist. DECISIONS steht vor MASTER, weil Regeln häufiger unwissentlich gebrochen werden, als
die Architektur missverstanden wird.

## Weitere Dokumentation

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Deployment und Umgebungsvariablen
- [docs/FIRST_ADMIN.md](docs/FIRST_ADMIN.md) — Ersteinrichtung des Administrators
- [docs/pilot/README.md](docs/pilot/README.md) — begleiteter Pilotbetrieb
- [test-world/README.md](test-world/README.md) — Referenzfirma und Gold-Suite
