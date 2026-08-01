# OfficePilot V1 – Foundation MVP

KI-Büromitarbeiter für kleine Betriebe. Mobile-First Web-App.

OfficePilot benötigt eine Internetverbindung für KI-Funktionen, Synchronisation sowie die verbindliche Freigabe von Rechnungen und Nachträgen.

## Starten

```bash
npm install
npm run dev
```

App öffnen: http://localhost:5173

## Tests

```bash
npm test
npm run test:watch
npm run build
```

`npm test` führt alle Vitest-Service-Regressionstests einmal aus. `test:watch` startet Vitest im Watch-Modus während der Entwicklung.

## Screens

- **Setup** – Sprache, Firmenname, Branche, Steuerstatus, Material-Standard
- **Eingang** – Upload-Mock, Dokument erfassen
- **Analysekarte** – Mock-Dokumentanalyse mit Bestätigen/Ändern/Später klären
- **Zu erledigen** – Aufgabenliste
- **Vorgänge** – Vorgangsliste und Detailansicht
- **Papierarchiv** – Ordnerregeln
- **Rechnung vorbereiten** – Mock-Rechnung mit editierbaren Positionen
- **Assistent** – Chat-Mock mit Beispielfragen

## Architektur

```
src/
├── types/models.ts      # Datenmodell
├── data/mockData.ts     # Mock-Daten
├── services/            # Businesslogik (getrennt von UI)
├── i18n/                # Mehrsprachigkeit (DE vollständig)
├── context/             # App-State (Setup, Analyse)
├── components/          # UI-Komponenten
└── pages/               # Screens
```

## Sicherheitsregeln (MVP)

- Keine automatische Löschung von Dokumenten
- Keine automatische Rechnungsversendung
- Keine automatische Preis-/Mengenänderung
- Vorschau + Nutzerbestätigung bei wichtigen Aktionen

## Begleiteter Pilot

Betriebspaket (Checklisten, Routinen, Vorlagen): [docs/pilot/README.md](docs/pilot/README.md)
