# OfficePilot TestWorld

Virtuelle Referenzfirma(n) für deterministische Tests über Inbox, DocumentSummary, Matching, Vorgang, Dashboard, Suche und Mobile.

**Dieses Verzeichnis ist reine Testdaten-Infrastruktur.**  
Es ändert weder OCR, Workflow, DocumentSummary, Matching noch Domain-Code.

## Status

| Bereich | Status |
|---------|--------|
| Ordnerstruktur / Schemas / IDs | 01A |
| Stammdaten-Fundament | **01C** (erweitert) |
| Gold-Dokumente (Meta) | **01D** — 10× `DOC-00001`…`DOC-00010` |
| Dokument-Taxonomie | **02A frozen** (+ Extend `DOCTYPE-074` Newsletter) |
| Gold-Dokumente Welle 2 | **02B** — 25× `DOC-00011`…`DOC-00035` |
| Expected (Gold) | **03A** — 35×5 Dateien unter `documents/DOC-*/expected/` |
| Gold-Validator | **03B** — `src/testWorld/gold-regression.test.ts` |
| Source PDF/JPG | **04A** — 35× `source.pdf` + 35× `source.jpg` |
| PDF-Pipeline-Messung | **04B** — `src/testWorld/gold-pdf-pipeline.test.ts` |
| **Gold Suite Freeze** | **[1.0](./GOLD-SUITE-1.0.md)** — 04B **35/35** |
| OCR-Textdateien / Timelines | **noch nicht** |
| Test-Loader | **noch nicht** |
| CI-Validator | **noch nicht** (lokal: `_lib/validate-seed.mjs`) |

## Branch-Semantik (wichtig)

**Branch = Standort / Niederlassung**, nicht Gewerk.

| Konzept | Wo | Beispiel |
|---------|-----|----------|
| Branch | `branches/` | `BRANCH-001` „Hauptsitz Bad Salzuflen“ |
| Gewerk / Trade | `Company.trades`, `Project.trade` | Heizung, Sanitär, Lüftung |

Phase 1 ist bewusst die **SHK-Referenzfirma** Cirmak — das steht in den Firmen-Trades, **nicht** im Branch-Namen. Spätere weitere Standorte = weitere `BRANCH-*`, nicht „Branch = Elektro“.

## Counterparties (`suppliers/`)

Der Ordner `suppliers/` hält **alle Gegenparteien**, nicht nur Materiallieferanten:

- Einkauf: wholesale, retail, fuel, hotel, disposal, …
- Betrieb: utility, telecom, insurance, leasing, bank
- Institutionen: authority (FA, BG BAU, SOKA-BAU), health_insurance, advisor (StB, Anwalt)

## Ordner

```
test-world/
  branches/       # Standorte (nicht Gewerke)
  companies/
  customers/
  suppliers/      # Counterparties (siehe oben)
  employees/
  vehicles/
  projects/
  documents/      # DOC-00001 … (Meta)
  taxonomy/       # frozen document-taxonomy.json (02A)
  schemas/
  manifests/
  _lib/
```

## ID-System

| Entität | Prefix | Beispiel | Stellen |
|---------|--------|----------|--------:|
| Branch | `BRANCH` | `BRANCH-001` | 3 |
| Company | `COMPANY` | `COMPANY-001` | 3 |
| Customer | `CUST` | `CUST-001` | 3 |
| Counterparty | `SUP` | `SUP-001` | 3 |
| Employee | `EMP` | `EMP-001` | 3 |
| Vehicle | `VEH` | `VEH-001` | 3 |
| Project | `PRJ` | `PRJ-001` | 3 |
| Document | `DOC` | **`DOC-00001`** | **5** |
| Doc group | `DOCGROUP` | `DOCGROUP-001` | 3 |
| Doc type (leaf) | `DOCTYPE` | `DOCTYPE-006` | 3 |

### Regex (kanonisch)

```
^(BRANCH|COMPANY|CUST|SUP|EMP|VEH|PRJ|DOCGROUP|DOCTYPE)-[0-9]{3}$
^DOC-[0-9]{5}$
```

### Regeln

1. IDs sind **immutable**, sobald Testdaten existieren.
2. Referenzen nur über IDs.
3. Nummernkreise pro Prefix unabhängig; Lücken ok; keine Wiederverwendung.
4. Firm-level-Dokumente: `projectId: null`.
5. Document-IDs fünf Stellen, damit 1000–2000+ Docs ohne Renames möglich sind.
6. **Taxonomie 02A frozen:** `documentType`, `subtype`, `DOCTYPE-*`, `DOCGROUP-*` nur erweitern, nie umbenennen/löschen.

## Schemas

| Datei | Entität |
|-------|---------|
| `branch.schema.json` | Branch (Standort) |
| `company.schema.json` | Company |
| `customer.schema.json` | Customer |
| `supplier.schema.json` | Counterparty |
| `employee.schema.json` | Employee |
| `vehicle.schema.json` | Vehicle |
| `project.schema.json` | Project |
| `document.schema.json` | Document (`DOC-00001`, inkl. `taxonomyTypeId`) |
| `document-taxonomy.schema.json` | Frozen taxonomy registry |

## Dokument-Taxonomie 02A (frozen)

Quelle: `taxonomy/document-taxonomy.json`  
Regenerieren: `node test-world/_lib/seed-02a-taxonomy.mjs`

| Ebene | Anzahl | IDs |
|-------|-------:|-----|
| Gruppen | 31 | `DOCGROUP-001` … `DOCGROUP-031` |
| Haupttypen (`documentType`) | 29 | z. B. `contract`, `utility`, `hr` |
| Leaf-Typen | **74** | `DOCTYPE-001` … `DOCTYPE-074` (+ Newsletter) |

Jedes Dokument-Meta braucht: `taxonomyTypeId` + passendes `documentType`/`subtype`.  
Beziehungen, Pflicht-/Verbotsfelder stehen im Leaf (`relations`, `fields`).

## Seed 01C (Stammdaten)

| Entität | Anzahl | Hinweise |
|---------|-------:|----------|
| Company | 1 | COMPANY-001 Cirmak Haustechnik GmbH |
| Branch | 1 | BRANCH-001 Hauptsitz Bad Salzuflen |
| Customers | 20 | CUST-001 … CUST-020 |
| Counterparties | **24** | SUP-001 … SUP-024 (HWK/Gericht/Inkasso/Werkstatt in 02B) |
| Employees | 10 | EMP-001 … EMP-010 |
| Vehicles | 5 | VEH-001 … VEH-005 |
| Projects | 18 | siehe Multi-Projekt-Kunden |
| Documents (Meta) | **35** | `DOC-00001`…`00010` (01D) + `00011`…`00035` (02B) |

### Gold-Dokumente 01D

| ID | Typ | Projekt | Kunde | Counterparty (`supplierId`) | Extra |
|----|-----|---------|-------|-------------------------------|-------|
| DOC-00001 | Werkvertrag | PRJ-001 | CUST-001 | — (Kunde) | |
| DOC-00002 | Angebot | PRJ-005 | CUST-005 | — (Kunde) | |
| DOC-00003 | ER Material | PRJ-001 | CUST-001 | SUP-001 | |
| DOC-00004 | Ausgangsrechnung | PRJ-001 | CUST-001 | — (Kunde) | |
| DOC-00005 | Lieferschein | PRJ-001 | CUST-001 | SUP-002 | |
| DOC-00006 | Tankbeleg | **null** | — | SUP-005 | VEH-001, EMP-003 |
| DOC-00007 | Hotelrechnung | **null** | — | SUP-006 | EMP-004 |
| DOC-00008 | Finanzamt | **null** | — | SUP-011 | nur Firma |
| DOC-00009 | BG BAU | **null** | — | SUP-012 | nur Firma |
| DOC-00010 | Werbung (`DOCTYPE-060`) | **null** | — | — | keine fachliche Zuordnung |

Ablage: `documents/DOC-xxxxx/meta.json`. Schema-Feld für Gegenpartei: **`supplierId`** (Counterparty-ID).  
Regenerieren: `node test-world/_lib/seed-01d-documents.mjs`

### Gold-Dokumente 02B

| ID | Typ | Taxonomie | Zuordnung |
|----|-----|-----------|-----------|
| DOC-00011 | Krankenkasse | DOCTYPE-024 | Firma + SUP-014 |
| DOC-00012 | StB-Rechnung | DOCTYPE-036 | Firma + SUP-016 |
| DOC-00013 | StB-Schreiben | DOCTYPE-037 | Firma + SUP-016 |
| DOC-00014–016 | Strom/Gas/Wasser | DOCTYPE-040…042 | Firma + SUP-007 |
| DOC-00017 | Mobilfunk | DOCTYPE-043 | Firma + SUP-008 + EMP-003 |
| DOC-00018 | Internet | DOCTYPE-044 | Firma + SUP-008 |
| DOC-00019 | Kfz-Versicherung | DOCTYPE-045 | Firma + VEH-002 + SUP-009 |
| DOC-00020 | Betriebshaftpflicht | DOCTYPE-029 | Firma + SUP-009 |
| DOC-00021 | Leasing | DOCTYPE-046 | Firma + VEH-003 + SUP-010 |
| DOC-00022 | TÜV | DOCTYPE-047 | Firma + VEH-001 + SUP-024 |
| DOC-00023 | Werkstatt | DOCTYPE-048 | Firma + VEH-004 + SUP-024 |
| DOC-00024 | Arbeitsvertrag | DOCTYPE-051 | Firma + EMP-007 |
| DOC-00025 | Krankmeldung | DOCTYPE-054 | Firma + EMP-004 + SUP-014 |
| DOC-00026 | Urlaub | DOCTYPE-055 | Firma + EMP-005 |
| DOC-00027 | Lohnabrechnung | DOCTYPE-056 | Firma + EMP-002 + SUP-016 |
| DOC-00028 | HWK | DOCTYPE-026 | Firma + SUP-021 |
| DOC-00029 | RA-Schreiben | DOCTYPE-039 | Firma + SUP-017 |
| DOC-00030 | Inkasso eingehend | DOCTYPE-063 | Firma + SUP-023 |
| DOC-00031 | Gericht | DOCTYPE-062 | **PRJ-001** + CUST-001 + SUP-022 |
| DOC-00032 | Gutschrift Lieferant | DOCTYPE-018 | PRJ-001 + SUP-001 |
| DOC-00033 | Gutschrift Kunde | DOCTYPE-017 | PRJ-001 + CUST-001 |
| DOC-00034 | Spam | DOCTYPE-061 | unzugeordnet |
| DOC-00035 | Newsletter | DOCTYPE-074 | unzugeordnet |

Regenerieren: `node test-world/_lib/seed-02b-documents.mjs`

### Expected 03A

Pro Gold-Dokument unter `documents/DOC-xxxxx/expected/`:

| Datei | Inhalt |
|-------|--------|
| `classification.json` | Taxonomie + `classifiedKind` + Summary-`family` |
| `summary.json` | Headline, kanonische `factOrder`, ableitbare Facts (≤6) |
| `caseMatch.json` | Text-Match ohne `known_link`; `meta.projectId` ≠ `vorgangId` (U02) |
| `primaryAction.json` | aus CaseMatch: exact→`open_vorgang`, none→`create_vorgang` |
| `alerts.json` | `alertIds: []` (clean Gold) |

Zusätzlich Sync: `meta.expected` (Schema-Feld).  
Regenerieren: `node test-world/_lib/seed-03a-expected.mjs`

### Gold-Validator 03B

| Baustein | Pfad |
|----------|------|
| Loader | `src/testWorld/goldLoader.ts` |
| Validator | `src/testWorld/goldValidator.ts` |
| Regression | `src/testWorld/gold-regression.test.ts` |

```bash
npx vitest run src/testWorld/gold-regression.test.ts --project default
```

Prüft alle 35 Gold-Docs gegen OfficePilot `buildInboxDocumentSummary` / `buildDocumentCaseMatch` (keine Domain-Änderungen).  
Fehlerbericht ist dokumentbezogen (`DOC-00017` …).

### PDF-Pipeline 04B (Messung)

Lädt jede `source.pdf` über die echte Preview/Intake-Pipeline (pdf.js-Text / ggf. OCR), erzeugt Summary/CaseMatch/Primäraktion/Alerts und vergleicht mit `expected/`.

```bash
npx vitest run src/testWorld/gold-pdf-pipeline.test.ts --project default
```

Bericht: `test-world/reports/gold-pipeline-04b.md` (+ `.json`)  
Keine Änderung an OCR/Workflow/Summary/Matching/UI/Expected/PDFs — nur Ist-Zustand.

Vitest nutzt `goldPdfJsVitestBridge.ts` (legacy pdf.js-Entry), weil der Browser-Worker unter happy-dom mit `pdf_corrupt` scheitert. Klassifikation/Summary/Matching bleiben die echte Pipeline. Der Test verlangt `ERROR=0` (alle PDFs durchgelaufen); PASS/FAIL gegen Expected ist der Messwert im Bericht.

**U02 (GOLD-FIX-01):** `meta.projectId` setzt kein `InboxItem.vorgangId` / kein künstliches `known_link`. Expected CaseMatch = Text-Match gegen hydrierte Vorgänge (`exact`/`open_vorgang` nur bei eindeutigem Treffer).

### Kunden-Besonderheiten

| Thema | IDs |
|-------|-----|
| Mehrere Projekte | CUST-001 (3), CUST-003 (2), CUST-004 (2) |
| Ohne Projekt | CUST-017, CUST-018, CUST-019, CUST-020 |
| Matching-Stress (ähnlich) | CUST-001 ↔ CUST-015 (Flisch); CUST-008 ↔ CUST-016 (Meyer) |

### Neue Counterparties (Auszug 01C)

Finanzamt, BG BAU, SOKA-BAU, AOK, Sparkasse (Hausbank), Steuerberater, Rechtsanwalt, Entsorgung, 2. Tankstelle, 2. Hotel — neben bestehendem Großhandel/Baumarkt/Hotel/Tank/Versorger/Telco/Versicherung/Leasing.

Regenerieren: `node test-world/_lib/seed-01c.mjs`  
Schema-Check: `node test-world/_lib/validate-seed.mjs` (benötigt `ajv` lokal)

## Abgrenzung

- Keine Produktions-Domain-Stores.
- Keine automatische Vorgangs-Zuordnung in der App.
- Noch keine Dokumente, Timelines oder Expected-Dateien.

### Source-Dateien 04A

Pro Gold-Dokument:

```
documents/DOC-xxxxx/
  source.pdf
  source.jpg
  meta.json          # sourceKind=pdf, sourceFile=source.pdf
  expected/…
```

Regenerieren: `node test-world/_lib/seed-04a-sources.mjs`  
(benötigt `@pdf-lib/fontkit`, `@napi-rs/canvas`)

## Nächste Schritte

1. OCR-Texte / ocrTextFile (noch keine Massenproduktion)
2. Timelines an Projekten
3. Manifeste / CI-Anbindung des Gold-Validators
