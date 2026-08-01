# GOLD-GAP-ANALYSIS-01

Quelle: `gold-pipeline-04b.json` (35 Docs, 161 Abweichungszeilen, PASS 0 / FAIL 35 / ERROR 0).  
Nur Analyse — keine Änderungen an OfficePilot, Expected oder PDFs.

## Kurzfazit

Die 161 Zeilen sind **keine 161 unabhängigen Bugs**. Es sind **~15 Ursachen**, davon 3 mit riesigem Hebel (Alerts, CaseMatch-Vertrag, Classification→Family-Kaskade).

| Frage | Antwort |
|-------|---------|
| Verschwinden mit echten Vorgängen / known_link? | CaseMatch `none→exact` + PrimaryAction `create→open` auf 4 Docs; **nicht** die 4× `multiple` |
| Nur fehlende TestWorld-Daten? | Teilweise: Sender/Supplier/Authority-Erkennung braucht Stammdaten- und Text-Signale; PDF-Text oft zu „flach“ |
| Echte OfficePilot-Schwächen? | Classification (Utility/Hotel/Fuel→sonstiges), Fact-Extraktion (date/supplier/sender), Subject-Fallbacks, Ambiguous Matching |
| Expected **nicht** „grün biegen“? | Classification-Fails, leere Alerts trotz `sender-uncertain`, `exact` ohne realen Match-Pfad, Fact-Werte die OCR nie liefern kann |

---

## Ursache → Abweichungszeilen (Rollup)

| ID | Bereich | ~Zeilen | Docs | Kurzursache |
|----|---------|--------:|------|-------------|
| U01 | Alerts | 30–33 | 30–33 | `sender-uncertain` vs Expected `[]` |
| U02 | CaseMatch + PrimaryAction | 16+8 | 8 | Expected `known_link`/exact; Runtime ohne `vorgangId` |
| U03 | Classification + Family | 10+9 | 10 | Kind falsch → Family falsch (Kaskade) |
| U04 | Summary | 19 | 19 | Subject-Wert ≠ Gold-Headline |
| U05 | Summary | 15 | 15 | Missing fact `date` |
| U06 | Summary | 10 | 10 | Missing fact `supplier` |
| U07 | Summary | 7 | 7 | Missing fact `sender` |
| U08 | Summary | 6 | 6 | Missing fact `authority` |
| U09 | Summary | 5+ | 5 | Site-/Adress-String nicht kanonisch |
| U10 | Alerts | 2 | 2 | `delivery-qty` (Lieferschein-Heuristik) |
| U11 | Alerts | 3 | 3 | `money-missing` (+ oft sender) |
| U12 | Summary | 3 | 3 | Missing `customer` (Folge schwacher Party-Erkennung) |
| U13 | Summary | ≤5 | ≤5 | Restfacts (project/gewerk/reference/station/vorgang) |
| U14 | Classification (Subcluster) | ⊂U03 | 5 | Utility/Hotel/Fuel → `sonstiges` statt Rechnung |
| U15 | Classification (Subcluster) | ⊂U03 | 5 | Einzel-Misses (LS/Lohn/AOK/TÜV/Ausgangs-ER) |

*(Zeilen überlappen nicht 1:1 mit Docs; eine Doc kann mehrere Ursachen tragen.)*

---

## Ursachen im Detail

### U01 — Alert `sender-uncertain` vs Expected leer
- **Anzahl Abweichungen:** 30 (+ 3 Docs wo zusätzlich `money-missing`)
- **Docs:** alle außer DOC-00003, DOC-00005 (dort anderer Alert); plus 00023/032/033 mit Kombi
- **Ursache:** Runtime setzt `sender` auf „Absender nicht eindeutig erkannt.“ → Alert. Expected `alertIds: []` stammt aus 03A-Idealwelt / 03B-Fixtures.
- **Erwartung falsch?** Für **04B-Realpipeline: ja, zu optimistisch**. Für Produkt-Ideal: nein.
- **Pipeline falsch?** Nein — konsistent mit `isSenderUncertain`.
- **TestWorld unvollständig?** Ja — Gegenparteien stehen im PDF, werden aber vom Resolver nicht angebunden (kein Stammdaten-Match im Intake).
- **OP korrekt?** Ja, gegeben ungelöster Sender.
- **Lösung:** TestWorld: Absender-Zeilen so gestalten, dass `resolveSenderFromEvidence` + Counterparty-Match greifen; **oder** Expected-Alerts nur anpassen, wenn Sender **bewusst** unklar sein soll — nicht pauschal leeren, um grün zu werden.

### U02 — CaseMatch Expected `exact`/`known_link` ohne Runtime-Link
- **Anzahl:** 8 CaseMatch-Docs → ~16 Zeilen + 8 PrimaryAction = **~24**
- **Sub-A `none ≠ exact`:** DOC-00001, 00002, 00004, 00031 → PA `create_vorgang`
- **Sub-B `multiple ≠ exact`:** DOC-00003, 00005, 00032, 00033 → PA `select_vorgang`
- **Ursache:** 03A Expected + 03B `goldLoader` setzen `vorgangId = projectId` → `known_link`. 04B echte Intake setzt das **nicht**. Sub-B zusätzlich: Baustellen-Tokens matchen mehrere Vorgänge.
- **Erwartung falsch?** Für 04B-Messung: Expected beschreibt den **Fixture-Vertrag**, nicht den Real-Intake-Vertrag.
- **Pipeline falsch?** Nein für Sub-A (kein Link → none/create). Sub-B: Matching-Verhalten prüfenswert, aber nicht „kaputt“.
- **TestWorld unvollständig?** Ja — kein Mechanismus, echte Vorgangsverknüpfung nach Intake zu setzen; Stammdaten-Vorgänge sind hydriert, Link fehlt.
- **OP korrekt?** Sub-A: ja. Sub-B: plausibel (ambiguous).
- **Lösung:** TestWorld-Harness: nach Intake optional `projectId`→Link nur wenn Produkt das so vorsieht; besser: Expected für 04B auf **textuelles Matching** umstellen **ohne** known_link zu fingieren. PrimaryAction folgt CaseMatch — nicht separat „fixen“.

### U03 / U14 / U15 — Classification falsch → Family falsch
- **Anzahl:** 10 Kind + 9 Family (+ Summary-family-Zeilen)
- **Docs:** 00003, 00004, 00011, 00012, 00014–18, 00022
- **U14 Utility-Cluster (5):** 00014–18 Strom/Gas/Wasser/Hotel/Fuel → Expected `rechnung`/`eingangsrechnung`, Runtime `sonstiges`/`generic`
- **U15 Einzel:**
  - 00003: ER → `lieferschein` (PDF wirkt als Lieferschein)
  - 00004: Ausgangsrechnung → `werkvertrag`
  - 00011: AOK → `brief`
  - 00012: Lohnnebenkosten-ER → `lohnabrechnung`
  - 00022: TÜV → `pruefprotokoll`
- **Erwartung falsch?** Nur wenn Meta/Taxonomy und Klassifikator bewusst divergieren sollen — hier: Expected = Fachintention, Runtime = Heuristik.
- **Pipeline falsch?** Classification-Heuristik zu schwach für Utility/Behörden/Grenzfälle.
- **TestWorld unvollständig?** PDF-Triggerworte ggf. zu dünn — aber **nicht** durch Expected-Anpassung „lösen“.
- **OP korrekt?** Nein — echte Produktlücke.
- **Lösung:** Classifier/Keywords/Taxonomy-Mapping verbessern; PDF-Signale verstärken **nur** wenn realistisch. Expected grünbiegen = **verboten**.

### U04 — Subject-Fact ≠ Gold-Titel
- **Anzahl:** 19
- **Ursache:** Runtime-Subjects sind generisch („Dokument“, „Gerade erfasst: … Absender nicht…“) oder Typ-Labels; Expected = redaktionelle Gold-Headlines.
- **Erwartung falsch?** Zu streng / Idealtext.
- **Pipeline falsch?** Teilweise schwache Subject-Builder.
- **TW unvollständig?** Wenig steuert Subject außer Klassifikation/Sender.
- **OP korrekt?** Fallback oft korrekt; Abweichung = Qualitätslücke, kein Crash.
- **Lösung:** Subject-Builder härten; Expected nur lockern, wenn Subject bewusst nicht deterministisch ist — **nicht** pauschal auf Runtime-Müll setzen.

### U05 — Missing `date`
- **15 Docs** — Extraktion findet Datumsfacts nicht trotz Datum im PDF.
- **OP-Schwäche** (primär). TW: Datumsformat in PDF prüfen.
- Expected nicht leeren.

### U06 — Missing `supplier`
- **10 Docs** — oft zusammen mit U14 (sonstiges/invoice) und U01.
- Party-Auflösung fehlt → Fact entfällt.
- OP + TW.

### U07 — Missing `sender`
- **7 Docs** — parallel zu U01.
- OP Resolver / TW Textlayout.

### U08 — Missing `authority`
- **6 Docs** — Behörden/Versicherungen erkannt als Kind, aber Authority-Fact fehlt.
- OP Summary-Fact-Builder.

### U09 — Site-String nicht kanonisch
- **5 Docs** — Runtime länger/verrauschter („Projektname + Baustelle + …“ oder Mülltokens), Expected Kurzadresse.
- Expected zu streng **oder** Site-Normalizer fehlt (OP).
- **Nicht** Expected auf Müll setzen.

### U10 — `delivery-qty` Alert
- DOC-00003, 00005 — Runtime als Lieferschein → Mengen-Alert. Expected leer.
- OP plausibel; Expected unrealistisch leer **wenn** Kind Lieferschein bleibt.
- Root: oft U15 (00003) bzw. korrekter Lieferschein (00005).

### U11 — `money-missing`
- DOC-00023, 00032, 00033 — Betrag nicht extrahiert.
- OP-Schwäche / PDF-Betragsformat.

### U12 — Missing `customer`
- DOC-00001, 00002, 00004 — Folge fehlender Customer-Erkennung + fehlendem Case-Link.

### U13 — Restfacts
- project/gewerk/reference/station/vorgang — Einzel-/Folgefehler aus Match + Extraktion.

---

## Bewertungsfragen

### Welche Fehler verschwinden automatisch, wenn echte Vorgänge / Links existieren?
- **U02 Sub-A** (4 Docs): CaseMatch `none→exact` + PrimaryAction `create→open`, **wenn** Produkt `vorgangId`/`known_link` setzt wie 03B.
- **Nicht** Sub-B (`multiple`) — dort helfen Links oder eindeutigere Tokens.
- Summary-Facts/Alerts verschwinden dadurch **nicht** automatisch.

### Welche Fehler entstehen nur wegen fehlender TestWorld-Daten?
- U01/U06/U07 stark: Counterparty nicht an Inbox-Item gebunden.
- U02: Fixture-Vertrag known_link vs Real-Intake.
- Schwache PDF-Signale können Classification (U14/U15) mitverursachen — aber das ist auch OP.

### Welche Fehler zeigen echte OfficePilot-Schwächen?
- **U03/U14/U15** Classification (Utility-Cluster, Grenztypen)
- **U05–U08** Fact-Extraktion
- **U04** Subject-Qualität
- **U11** money-missing
- **U02 Sub-B** Ambiguous matching ohne Disambiguierung

### Welche Fehler dürfen **nicht** durch Expected-Anpassung grün gemacht werden?
1. Classification-Fails (U14/U15) — würde Blindheit belohnen
2. `alertIds: []` trotz systematischem `sender-uncertain` **ohne** Sender-Fix
3. `exact`/`open_vorgang` beibehalten und Harness heimlich `vorgangId` setzen, **ohne** das als eigenen Testvertrag zu dokumentieren
4. Subject/Site auf Runtime-Müll oder OCR-Garbage setzen
5. Family-Fails, die nur Classification spiegeln, isoliert „wegerwarteten“

---

## Prioritäten

### Priorität A (zuerst)
1. **U02 klären** — 04B-Vertrag: Real-Matching vs known_link; Expected/Harness bewusst trennen (nicht heimlich grün).
2. **U01 Sender** — Absender stabil erkennen **oder** Alerts ehrlich erwarten (nach Fix messen).
3. **U14 Utility-Classification** — 5 Docs blockieren Family+Summary-Kaskade.

### Priorität B
4. **U15** Einzel-Classification (LS/AOK/Lohn/TÜV/ER↔LS)
5. **U05 Date** + **U06 Supplier** Extraktion
6. **U02 Sub-B** Ambiguous CaseMatch (Disambiguierung / Tokens)

### Priorität C
7. **U04 Subject**, **U08 Authority**, **U09 Site-Normalizer**
8. **U10/U11** Alert-Feintuning nach Classification/Extraktion
9. **U12/U13** Restfacts

---

## Bereichstrennung (Checkliste)

| Bereich | Haupursachen | Docs betroffen (ok=false) |
|---------|--------------|---------------------------|
| Classification | U03/U14/U15 | 10 |
| Family | Kaskade aus Classification | 9 |
| Summary | U04–U09, U12–U13 (+ Family-Zeilen) | 35 |
| CaseMatch | U02 | 8 |
| PrimaryAction | Folge U02 | 8 |
| Alerts | U01, U10, U11 | 35 |

## Nicht tun
- Expected anpassen, um 0 % Erfolgsquote zu kaschieren
- OCR/Workflow/Summary/Matching „quick-fixen“ ohne Priorität A
- 03B known_link und 04B Real-Intake vermischen ohne expliziten Vertrag
