# Referenztests (Goldstandard)

**TEST-ARCHITECTURE-01** — vollständige fachliche Journeys statt ticketorientierter Einzeltests.

Bestehende Unit-/UI-/Storage-Tests bleiben erhalten. Referenztests **ergänzen** sie und werden künftig zur Entscheidungsgrundlage, welche Suite-Teile unverzichtbar sind.

## Ziel

Ein Referenzfall schützt einen **echten Schaden** (`damagePrevented`) über den gesamten Kernpfad — nicht nur einen Service-Return.

## Drei Ebenen

| Ebene | Name | Was geprüft wird |
|------:|------|------------------|
| **1** | Document Case | PDF/OCR → Klassifikation → Business Interpretation → Soll-Ist |
| **2** | Accept Journey | Analyse → Auftragskarte-Daten → Auftrag annehmen → Vorgang → Archiv → Soll-Ist |
| **3** | UI Visibility | Gewerk, Hauptleistungen, Nachweise, Abrechnung, Archiv, Dokumentverknüpfung sichtbar |

Ebene 1 lebt weiter unter `src/test/document-cases/`.  
Ebenen 2–3 leben unter `src/test/reference-tests/<CASE_ID>/` und **wiederverwenden** Document-Cases (OCR, `assertDocumentCase`, Stable-Pipeline).

```
Document Case (Ebene 1)
        ↓
Accept Journey (Ebene 2)
        ↓
UI Visibility (Ebene 3)
```

## Aufbau eines Referenzfalls

```
src/test/reference-tests/
  README.md
  _lib/                    # gemeinsame Runner & Asserts (keine doppelte Fachlogik)
  WV-LV-01/
    contract.pdf           # optionaler Placeholder / später echtes PDF
    contract.source.json   # Verweis auf Document-Case / OCR-Quelle
    expected.json          # damagePrevented + Accept-/UI-Soll
    journey.test.ts        # Ebene 1+2
    ui.test.ts             # Ebene 3
```

### `expected.json`

- `documentCaseId` — bestehende Case-ID (Pflicht; keine OCR-Kopie)
- `damagePrevented[]` — kurze, prüfbare Schadenbeschreibungen
- `acceptJourney` — fachliche Fakten nach Accept
- `uiVisibility` — sichtbare UI-Anker
- `knownGaps` — ehrliche Lücken (nicht durch leere Erwartungen verstecken)

### `_lib`

| Modul | Rolle |
|-------|--------|
| `runAcceptJourney` | Document-Case laden → Stable-Pipeline → `assertDocumentCase` → Accept-Orchestrator |
| `assertAcceptJourney` | Vorgang/Archiv/Gewerk/Nachweise/Billing/DOC-LINK |
| `assertUiVisibility` | Auftragskarte + Vorgang-Panels Markup |
| `loadReferenceCase` | `expected.json` laden |

## Referenzfälle

### WV-LV-01 (`kind: contract-accept`)

Werkvertrag mit LV (Isobautec / BV Sägewerk Fisch).

- OCR: Document-Case `WV-LV-01` (`textFixture: werkvertragMultiSection`)
- Accept: `acceptContractOrderFromProposal` (Production-Orchestrator)
- UI: Auftragskarte, Scope, Nachweise, Abrechnung-Hinweis/Panel, Archiv-Link

### NT-01 (`kind: order-amendment`)

Nachtrag auf bestätigtem Auftrag (Confirm-first).

- Seed: bestätigter Vorgang (`contractConfirmation`) — siehe `amendment.source.json`
- Journey: `createOrderAmendmentDraft` → Position → `confirmOrderAmendmentWithCloud`
- UI: `VorgangOrderAmendmentPanel`, `ConfirmedOrderAmendmentList`, `OrderSummaryPanel`

### ER-01 (`kind: incoming-invoice`)

Eingangsrechnung → Archiv → Ausgabe.

- OCR/Soll: Document-Case `ER-01`
- Journey: Stable-Pipeline → Filing-Confirm → `importInboxDocument` → `addExpense` (+ `archiveDocumentId`)
- UI: `DocumentIntakeUnderstandingPanel`, `ExpenseOverviewCard`

### FA-FRIST-01 (`kind: authority-letter`)

Behördenpost mit Frist → Archiv; **kein** Auftrag / **keine** Ausgabe / **keine** Vertragswirkung.

- OCR/Soll: Document-Case `FA-FRIST-01`
- Journey: Stable-Pipeline → Filing-Confirm → `importInboxDocument` + Negativassertions
- UI: `OperationalOverview`, `DocumentIntakeUnderstandingPanel`

### BG-SOKA-01 (`kind: authority-letter`)

BG BAU / SOKA-Nachweispflichten → Archiv; **kein** Auftrag / **keine** Expense / **keine** Vertragswirkung.

- OCR/Soll: Document-Case `BG-SOKA-01`
- Journey: **derselbe** `runAuthorityJourney` wie FA-FRIST-01 (kein neuer `kind`)
- UI: `OperationalOverview`, `DocumentIntakeUnderstandingPanel`

### LS-01 (`kind: delivery-note`)

Lieferschein → Archiv → Confirm-first Vorgangs-Zuordnung; **keine** Plan-/Mengen-/Rechnungsänderung.

- OCR/Soll: Document-Case `LS-01`
- Seed: Auftrag mit Materialposition (`delivery-note.source.json`)
- Journey: Stable-Pipeline → Filing-Confirm → `importInboxDocument` → `linkInboxToExistingVorgang`
- UI: `OperationalOverview`, `DocumentIntakeUnderstandingPanel`, `OrderSummaryPanel`

## Neuen Referenzfall ergänzen

### Contract-Accept (wie WV-LV-01)

1. **Document-Case anlegen** unter `src/test/document-cases/<category>/<CASE_ID>/`.
2. Ordner `src/test/reference-tests/<CASE_ID>/` mit `kind: contract-accept`.
3. `expected.json` mit `documentCaseId`, `damagePrevented`, `acceptJourney`, `uiVisibility`.
4. `journey.test.ts` / `ui.test.ts` — `runAcceptJourney` / `assertUiVisibility`.

### Order-Amendment (wie NT-01)

1. Ordner `src/test/reference-tests/<CASE_ID>/` mit `kind: order-amendment`.
2. `expected.json` mit `amendmentJourney`, `amendmentUiVisibility`, `damagePrevented`.
3. `journey.test.ts` / `ui.test.ts` — `runAmendmentJourney` / `assertAmendmentUiVisibility`.
4. `amendment.source.json` für Quellenangabe.

### Incoming-Invoice (wie ER-01)

1. Document-Case unter `document-cases/invoices/<CASE_ID>/`.
2. Ordner `src/test/reference-tests/<CASE_ID>/` mit `kind: incoming-invoice`.
3. `expected.json` mit `invoiceJourney`, `invoiceUiVisibility`, `damagePrevented`.
4. `journey.test.ts` / `ui.test.ts` — `runInvoiceJourney` / `assertInvoiceUiVisibility`.

### Authority-Letter (wie FA-FRIST-01 / BG-SOKA-01)

1. Document-Case unter `document-cases/authorities/<CASE_ID>/` (falls noch nicht vorhanden).
2. Ordner `src/test/reference-tests/<CASE_ID>/` mit `kind: authority-letter` — **kein neuer kind**.
3. `expected.json` mit `authorityJourney` (inkl. forbid*-Flags), `authorityUiVisibility`.
4. `journey.test.ts` / `ui.test.ts` — `runAuthorityJourney` / `assertAuthorityUiVisibility`.

### Delivery-Note (wie LS-01)

1. Document-Case unter `document-cases/delivery/<CASE_ID>/`.
2. Ordner `src/test/reference-tests/<CASE_ID>/` mit `kind: delivery-note`.
3. `expected.json` mit `deliveryJourney` (inkl. forbid*-Flags), `deliveryUiVisibility`.
4. `journey.test.ts` / `ui.test.ts` — `runDeliveryJourney` / `assertDeliveryUiVisibility`.
5. `delivery-note.source.json` für OCR- und Seed-Quellenangabe.

```bash
npm test -- src/test/reference-tests
npm test -- src/test/document-cases
```

## Was hier nicht passiert

- Keine bestehenden Tests löschen
- Keine Suite-Reduktion in diesem Schritt
- Kein Umbau von Storage-/Design-Tests

Das folgt erst, wenn Referenzfälle stabil grün sind und als Goldstandard gelten.

## Befehle

```bash
# Nur WV-LV-01 Referenz
npm test -- src/test/reference-tests/WV-LV-01

# Alle Referenzfälle
npm test -- src/test/reference-tests
```
