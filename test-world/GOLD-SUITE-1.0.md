# Gold Suite 1.0

**Status:** eingefroren (Freeze)  
**Messlauf:** TESTWORLD-04B (`src/testWorld/gold-pdf-pipeline.test.ts`)  
**Stand:** 2026-08-01 — **PASS 35 / FAIL 0 / Abweichungen 0** (100 %)

Dieses Dokument beschreibt den eingefrorenen Gold-Stand der OfficePilot-Referenzsuite (Cirmak / TestWorld).  
Änderungen am Frozen Set nur bewusst und versioniert (siehe Regeln unten).

---

## Scope

| Bereich | Inhalt |
|---------|--------|
| Dokumente | `DOC-00001` … `DOC-00035` (je `source.pdf` + `expected/*`) |
| Messung | Classification, Family, Summary, CaseMatch, PrimaryAction, Alerts |
| Pipeline | echte PDF-Extraktion → Intake → Summary/Matching |
| Nicht im Freeze | OCR-Sonderpfade, neue Dokumente, Domain-Features außerhalb Subject/Extraktion |

Reports: `test-world/reports/gold-pipeline-04b.json` / `.md`

---

## Subject Contract

**Format:** `Absender · Dokumentinhalt`

| Regel | Beschreibung |
|-------|----------------|
| 1 | Absender zuerst, wenn eindeutig |
| 2 | Danach Dokumentinhalt (Betreff → Art → Objekt → Person → Kennzeichen → Projekt) |
| 3 | Keine internen IDs (`EMP-` / `PRJ-` / `DOC-`) |
| 4 | Absender weglassen, wenn nicht sinnvoll ermittelbar |
| 5 | Keine dokumenttypspezifischen Gold-Sonderfälle |
| 6 | Meta-Titel („Absender nicht eindeutig…“) sind kein Subject |

Runtime: `src/services/documentSubjectIntelligence.ts`  
Alert `sender-uncertain` bleibt unabhängig vom Subject (z. B. DOC-00010 Katalog ohne Absender).

---

## Expected Contract

Expected unter `test-world/documents/DOC-*/expected/` folgt dem Subject Contract und dem gemessenen Produktverhalten:

- Subject/Headline: `Absender · Inhalt` (oder nur Inhalt ohne Absender)
- Keine EMP-/PRJ-/DOC-IDs in Subjects
- Keine Meta-Titel als Expected-Subject
- Alerts nur, wenn die Runtime sie fachlich korrekt setzt (z. B. `delivery-qty`, `sender-uncertain`)
- CaseMatch/PrimaryAction an echte Signale angepasst (z. B. DOC-00031 → `exact` / `open_vorgang` bei eindeutigem Bauvorhaben)

Expected darf die Runtime nicht „schönrechnen“; Abweichungen werden über Produktfixes oder bewusste Expected-Updates gelöst.

---

## PASS / FAIL (Freeze-Messung)

| Metrik | Wert |
|--------|-----:|
| Checked | 35 |
| **PASS** | **35** |
| **FAIL** | **0** |
| Abweichungen | 0 |
| Erfolgsquote | 100 % |

Area-Gates (Freeze): Classification 35/35, Family 35/35, Summary 35/35, CaseMatch 35/35, PrimaryAction 35/35, Alerts 35/35.

---

## Bekannte Restpunkte

Keine offenen Gold-Abweichungen im 04B-Freeze.

Bewusst dokumentierte Produktgrenzen (kein FAIL):

- Tabellen-Mengen/Beträge ohne Label können weiterhin Alerts auslösen, wenn keine strukturierte Extraktion greift; in 1.0 sind die betroffenen Fälle entweder extrahiert oder Expected-aligned.
- Klassifikationstitel der Form `Sonstiges – Absender nicht…` sind Inbox-Meta und dürfen das Summary-Subject nicht überschreiben (Subject kommt aus dem Dokumentkopf).

---

## Regeln für zukünftige Gold-Dokumente

1. **Kein Gold-Fitting:** Expected an den Subject-/Produktvertrag anpassen, nicht die Runtime an einzelne DOC-IDs.
2. **Ableitbarkeit:** Jeder Expected-Wert muss aus PDF-Text oder Stammdaten-Signalen ableitbar sein.
3. **Subject:** immer `Absender · Inhalt` bzw. Inhalt allein bei unsicherem Absender.
4. **IDs:** keine internen Stammdaten-IDs im Subject.
5. **Alerts:** Expected spiegelt produktkorrektes Alert-Verhalten; leere Alerts nur wenn die Runtime keine sinnvollen Warnungen setzt.
6. **Seed:** PDF-Texte mit klaren Labels (`Bauvorhaben:`, `Kennzeichen`, Totals) wo Matching/Summary darauf angewiesen sind; quoted/parenthetical Formen sind erlaubt, wenn Extraktion sie kennt.
7. **Messung:** vor Merge immer vollständiges 04B; Classification/Family dürfen nicht regressieren.
8. **Versionierung:** Materialänderungen am Frozen Set → neue Minor/Major-Notiz in diesem Dokument (nicht still überschreiben).

---

## Empfohlene Git-Artefakte (nach Freigabe)

- **Commit:** z. B. `freeze: Gold Suite 1.0 (04B 35/35)`
- **Tag:** `gold-suite-1.0` (annotiert, auf dem Freigabe-Commit)

Kein Push ohne explizite Anweisung.
