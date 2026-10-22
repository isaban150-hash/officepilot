# DOKUMENTE-01 — Bestandsaufnahme und Arbeitsplan

> **Stand 20.10.2026:** alle Arbeitspakete umgesetzt — Ergebnis in `02-abschlussbericht.md`, Abnahme-Szenarien in
> `03-weiss-szenarien.md`, Umgebung in `04-pruefumgebung.md`. Dieser Plan bleibt als Ausgangsstand unverändert.

20.10.2026 · SCHWARZ · freigegeben vom Auftraggeber am 20.10.2026 · Grundlage: Gesamtstatus vom 20.10.2026,
`OFFICEPILOT_ROADMAP.md` (Bereiche 3 und 5), D-017.

**Arbeitsstand:**
- Branch `sicherung/finanz-core-01a`; der Finanz-Commit `ba778e8` bleibt unverändert, alle Arbeit liegt
  uncommittet darüber.
- Kein Commit, Push, Deployment, keine Remote-Migration, keine produktiven Schreibzugriffe.
- Planer pausiert, Gold-Artefakte geschützt.

## 1. Was heute funktioniert

Ausgangslauf aller 153 Dokument-Testdateien mit `vitest.safe.config.ts`: 2.031 Tests, 2.024 grün.

| Rot | Einordnung |
|---|---|
| `eingangCustomerAssignmentResume01` (5) | nur unter Last, einzeln 12/12 grün |
| `documentArchiveTruth03a1` H | veralteter Test: erwartet „Aufgaben bleiben lokal“, seit CLOUD-DURABILITY-01C synchronisiert |
| `intakeFinanceTruth01d1` Nr. 8 | Datumsfalle: Belegdatum ohne Angabe = heute = Antwortfrist 20.10.2026 |

Gold-Testwelt: 4 rote Tests. Alle betreffen die Vorgangszuordnung (6 von 36 Referenzdokumenten, „likely“ bzw.
„multiple“ statt „exact“). Dieselben sechs stehen schon im geschützten Bericht vom 10.10.

Im Code vorhanden:
- Erfassung (Upload, Kamera-Scan, Mail-Anhang), OCR, regelbasierte Klassifikation
- Fakten mit Bestätigung
- Bedeutung und Handlungsbedarf
- digitale Ablage und Papierablage
- Löschsperren für Zahlungsnachweise, Rechnungsbelege und Mitarbeiterbelege
- Dateien in der Cloud mit Nachladen auf anderen Geräten

## 2. Nachgewiesene Fehler (im Code bestätigt)

| ID | Fehler | Ursache |
|---|---|---|
| F7 | Abgelegte Dokumente: Beträge doppelt oder falsch gedeutet, React-Warnung „doppelter Schlüssel“ | `DokumentDetailPage.tsx:735` gibt als Rückfall den ganzen Archivtext an den Semantikkern: Vorspann, zweimal PDF-Text, `_pageTexts` als eine JSON-Zeile. Ein sauberer Leser (`readArchivedSourceText`) existiert, wird dort aber nur für Gutschriften genutzt |
| F8 | „ust“ innerhalb eines Worts gilt als Umsatzsteuer („August“, „Musterstraße“, „Austausch“) | `documentSemanticCoreService.ts:671`, Muster ohne Wortgrenzen |
| F9 | Mitgliedsgerät: Papierregister-Eintrag scheitert mit „Keine Schreibberechtigung“ | Einträge haben je Dokument eine feste Kennung. Die Lese-Policy zeigt Mitgliedern nur selbst angelegte Zeilen, nicht die Zeile des Inhabers zum eigenen Dokument. Die Migration verspricht dagegen „Rechte und Sichtbarkeit folgen dem Dokument“ |
| F10 | D-017 verletzt: Für jedes abgelegte Dokument empfiehlt die App „Kann nach erfolgreicher digitaler Ablage entsorgt werden“; der Assistent bejaht „Darf ich das wegwerfen?“ | `documentGuidanceService.ts:117-130` und `documentAssistantService.ts`: Entsorgungsempfehlung ohne Aufbewahrungsprüfung |

## 3. Fehlende Pflichtfunktion: D-017 und Go-Live-Liste, Abschnitt Aufbewahrung

1. Aufbewahrungskennzeichnung an Dokumenten
2. Löschschutz für aufbewahrungspflichtige Unterlagen, serverseitig auf beiden Löschwegen
   (`tombstone_workspace_document` und `upsert_workspace_intake_entity`, Zweig `archived_document`)
3. Keine Entsorgungsvorschläge ohne Prüfung; unklare Fälle werden nie automatisch gelöscht

**Regeln (nur gesetzlich abgesicherte Fristen):**

| Klasse | Frist | Rechtsgrundlage |
|---|---|---|
| Buchungsbelege und Rechnungen | 8 Jahre | § 147 Abs. 1 Nr. 4, Abs. 3 AO; § 14b Abs. 1 UStG; § 257 Abs. 1 Nr. 4, Abs. 4 HGB, jeweils in der Fassung des Vierten Bürokratieentlastungsgesetzes |
| Empfangene und abgesandte Handels- oder Geschäftsbriefe | 6 Jahre | § 147 Abs. 1 Nr. 2 und 3, Abs. 3 AO; § 257 Abs. 1 Nr. 2 und 3, Abs. 4 HGB |
| alles andere, auch Personal, Behörde, Versicherung | „Aufbewahrung prüfen“ | ohne Frist, ohne Löschvorschlag, Löschen nur nach ausdrücklicher Prüfbestätigung |

- **Fristbeginn:** Schluss des Kalenderjahres (§ 147 Abs. 4 AO, § 257 Abs. 5 HGB).
- **Nach rechnerischem Ablauf:** Hinweis auf die Ablaufhemmung (§ 147 Abs. 3 AO). Keine Entsorgungsempfehlung,
  Löschen nur nach Bestätigung.
- **Papieroriginale:** OfficeTakt empfiehlt keine Vernichtung von Originalen aufbewahrungspflichtiger Unterlagen, weil
  es kein ersetzendes Scannen zusichert. Keine Rechtsberatung (D-017).

## 4. Arbeitspakete (in dieser Reihenfolge)

| AP | Inhalt |
|---|---|
| 1 | Veraltete Tests: `documentArchiveTruth03a1` H, `intakeFinanceTruth01d1` Nr. 8 |
| 2 | F8 Wortgrenzen; F7 sauberer Originaltext für abgelegte Dokumente |
| 3 | D-017: Regelmodul mit gemeinsamen Testvektoren, Kennzeichnung im Dokumentdetail und in der Ablage, Empfehlungen und Assistent ohne Entsorgung ohne Prüfung, Löschschutz im Client und serverseitig (neue Migration, nur lokal) |
| 4 | F9: Sichtbarkeit des Papierregisters folgt dem Dokument, Mitglieder ändern keine fremden Einträge |
| 5 | Zuordnung: Ursache der sechs Gold-Abweichungen klären; beheben, wenn Rückschritt |
| 6 | Benutzerabläufe im Browser gegen den lokalen Stack: Upload, Prüfung, Ablage, Detail, Löschschutz, Mitglied, zweites Gerät. KI nur mit synthetischen Testdaten und abgefangener KI-Schnittstelle |
| 7 | WEISS-Abnahme vorbereiten: Szenariokatalog, Prüfumgebung, Abschlussbericht, BEREIT FÜR WEISS |

**Nicht im Umfang:**
- Brief-Spezifika und Postfach (BRIEFE-01)
- Vorgangsarchivierung (VORGANG-01)
- Papierkorb (STO-17, optional)
- weitere OCR-Sprachen
