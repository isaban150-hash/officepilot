# DOKUMENTE-01 — Abschlussbericht

20.10.2026 · SCHWARZ · Freigabe des Auftraggebers vom 20.10.2026 · Grundlage: Gesamtstatus 20.10.2026, Roadmap
(Bereiche 3 und 5), D-017, Go-Live-Liste (Abschnitt Aufbewahrung/Löschung).

**Ergebnis: BEREIT FÜR WEISS.** Alle Arbeitspakete aus `01-bestandsaufnahme-und-plan.md` sind umgesetzt und
geprüft. Nichts ist committet, gepusht, ausgeliefert oder remote angewendet.

> **Nachtrag 20.10.2026:** Die WEISS-Endabnahme ergab BLOCKIERT (DOK01-W1, DOK01-W2, zwei Browserbefunde). Die
> Nacharbeit steht in `05-nacharbeit-weiss.md`. Sie ändert beide Migrationen, `documentFileStoreService.ts` und die
> beiden SQL-Vertragstests und ergänzt einen Clienttest. Wo dieser Bericht davon abweicht, gilt `05`.

## 1. Was jetzt gilt

| Ziel des Auftrags | Stand |
|---|---|
| Dokumenteneingang und Upload | Bestand funktioniert (Upload, Erkennung, Vorschau, Speichern, Ablage, Archiv). Im Browser gefunden und behoben: „Als Firmendokument markieren" überschrieb die erkannte Art mit „Sonstiges" (Abschnitt 4) |
| Dokumentenerkennung und KI-Verständnis | F7 und F8 behoben; KI-Kontext abgelegter Dokumente ohne Seiten-JSON und ohne doppelten Text. KI nur mit abgefangener Schnittstelle geprüft |
| Die zwei nachgewiesenen Deutungsfehler | F7 (falsche „Gutschrift", doppelte Beträge, doppelter React-Schlüssel) und F8 („ust" in „August", „Austausch") behoben |
| Richtige Zuordnung und Archivierung | Art bleibt beim Markieren erhalten; F9 (Papierregister auf Mitgliedsgeräten) behoben; die sechs Gold-Abweichungen geklärt: kein Rückschritt (Abschnitt 5) |
| Gesetzliche Aufbewahrungsfristen und Löschschutz | D-017 umgesetzt: Regel, Kennzeichnung, Löschschutz in App und Server, keine Entsorgungsempfehlung ohne Prüfung (Abschnitt 2) |
| Vollständige Benutzerabläufe | Im echten Browser gegen den lokalen Stack geprüft: Inhaber, zweites Gerät, Mitglied (`belege/browser/PROTOKOLL.md`) |

## 2. Aufbewahrung und Löschschutz (D-017)

**Regel** (`src/services/document/documentRetention.ts`, serverseitig gleich in `workspace_retention_rule`):

| Klasse | Frist | Welche Dokumente | Rechtsgrundlage |
|---|---|---|---|
| Buchungsbeleg | 8 Jahre | Rechnungen aller Art, Gutschriften, Rechnungskorrekturen, Quittungen, Kassen-/EC-/Kreditkartenbelege, Kontoauszüge, Tank- und Reparaturbelege; Kategorie „Ausgangsrechnung"; Beleg einer Ausgabe; Nachweis einer Zahlung oder Quittung einer Mitarbeiterzahlung; festgeschriebener Rechnungs- oder Korrekturbeleg | § 147 Abs. 1 Nr. 4, Abs. 3 AO; § 257 Abs. 1 Nr. 4, Abs. 4 HGB; § 14b Abs. 1 UStG (Fassung BEG IV) |
| Geschäftsbrief | 6 Jahre | Auftrag, Auftragsbestätigung, Werk-, Sub- und Nachunternehmervertrag, Nachtrag, Mahnung, Zahlungserinnerung | § 147 Abs. 1 Nr. 2 und 3, Abs. 3 AO; § 257 Abs. 1 Nr. 2 und 3, Abs. 4 HGB |
| Aufbewahrung prüfen | keine | alles andere, bewusst auch Angebote, Lieferscheine, Personal-, Behörden-, Versicherungsunterlagen, Bescheide, Verträge ohne erkannte Art, Rechnungsbelege von Entwürfen | — |

- **Fristbeginn:** Schluss des Kalenderjahres (§ 147 Abs. 4 AO, § 257 Abs. 5 HGB). Als Jahr gilt das späteste aus
  Dokumentdatum, Ausstellung, Erfassung und Anlage; der Server zählt zusätzlich seine eigene Anlage. Die Frist wird
  dadurch eher länger als nötig, nie kürzer als bei korrekten Daten. Berliner Kalender.
- **Laufende Frist:** kein Löschen — weder in der App noch auf einem der beiden Serverwege
  (`tombstone_workspace_document`, Eingangsweg `archived_document`), auch nicht per direktem UPDATE. Original-Bindung
  und Datei eines geschützten Dokuments bleiben ebenfalls. Während der Frist lässt sich die Einstufung nicht
  abschwächen (Kategorie/Art; analog FINANZ-CORE-01A STO-03).
- **„Prüfen" und rechnerisch abgelaufen:** Löschen nur nach ausdrücklicher Bestätigung im Löschdialog
  („Aufbewahrung geprüft – endgültig löschen"); nach Fristende mit Hinweis auf die Ablaufhemmung (§ 147 Abs. 3 AO).
  Es gibt keine automatische Löschung.
- **Kennzeichnung:** Karte „Aufbewahrung" im Dokumentdetail direkt unter der Ablage (Klasse, Mindestfrist, Grund,
  Grundlage, Hinweis zum Papieroriginal, „keine Rechtsberatung").
- **Keine Entsorgung ohne Prüfung (F10):** „Kann nach erfolgreicher digitaler Ablage entsorgt werden" nur noch bei
  erkannter Werbung. Abgelegte Belege: „Original aufbewahren – wichtig für Steuer und Buchhaltung"; unklare Fälle:
  „Original aufbewahren, bis geklärt ist, ob eine Aufbewahrungspflicht besteht"; „Kein Papierordner – Entsorgen oder
  manuell ablegen" → „Kein Papierordner zugewiesen" (de/tr/bg; Assistentenantworten ebenso).
- **Grenzen (bewusst):** Die E-Rechnungs-XML-Bindung bleibt beim Aufräumen frei (20261106; das XML entsteht
  byte-gleich aus der festgeschriebenen Rechnung neu). Speicherobjekte werden nirgends gelöscht. Keine Rechtsberatung.

## 3. Server (nur lokal)

| Migration | Inhalt |
|---|---|
| `20261125120000_dokumente01_aufbewahrung.sql` | `workspace_retention_year`, `workspace_retention_rule`, `workspace_document_retention`; Trigger auf `workspace_documents` (kein Grabstein, keine Abschwächung während der Frist), auf `workspace_document_file_bindings` (Original) und `workspace_files`. Additiv, keine bestehende Funktion geändert, alle neuen Funktionen intern |
| `20261126120000_dokumente01_papierregister.sql` | F9: neuer Papierregister-Eintrag gehört dem Anleger seines Archivdokuments (`created_by`), wer schrieb steht in `updated_by`; Altbestand per Funktion (lokal 0 Zeilen) |

Abweisungen tragen „Keine Schreibberechtigung" und 42501: Alte Clients stufen sie als endgültig ein, und die
bestehende Wiederherstellung abgewiesener Archivlöschungen holt ein lokal schon gelöschtes Dokument zurück
(Test „ein alter App-Stand löscht einen geschützten Beleg nur scheinbar").
Lokal eingespielt am 2026-10-20T02:23:58Z; Rücknahme `lokal/ruecknahme-20261125-20261126-lokal.sql`.

## 4. Behobene Fehler

| ID | Fehler | Behebung |
|---|---|---|
| F7 | Bedeutung abgelegter Dokumente aus dem ganzen Archivtext (Seiten-JSON als eine Zeile): „Auslagenerstattung" machte Beträge zur „Gutschrift zu Ihren Gunsten", Beträge doppelt, doppelter React-Schlüssel | `resolveArchivedMeaningText` (Originaltext statt Archivtext) für Detail und KI-Kontext; Beträge entdoppelt; Schlüssel mit Index |
| F8 | „ust" ohne Wortgrenze → „August", „Musterstraße", „Austausch" galten als Umsatzsteuer | Wortgrenzen im Semantikkern |
| F9 | Mitgliedsgerät: Papierregister-Eintrag „Keine Schreibberechtigung", Haken unsichtbar | Migration 20261126 (Eintrag gehört dem Dokument) |
| F10 | Für jedes abgelegte Dokument „Kann … entsorgt werden"; Assistent bejahte „Darf ich das wegwerfen?" | Empfehlung folgt der Aufbewahrung (Abschnitt 2) |
| neu | „Als Firmendokument markieren" überschrieb die erkannte Art mit der stillen Vorauswahl „Sonstiges" → eine Rechnung lag als `sonstiges` im Archiv und wäre ohne Ausgabe nur „prüfen" (löschbar) gewesen | ohne Wahl bleibt die erkannte Art; Panel zeigt „Erkannt: … Ohne andere Auswahl bleibt diese Dokumentart erhalten." |
| Testdrift | `documentArchiveTruth03a1` H (Aufgaben werden seit 01C synchronisiert), `intakeFinanceTruth01d1` Nr. 8 (Datumsfalle am 20.10.) | Tests angepasst |

## 5. Gold-Abweichungen (AP5): geklärt, kein Rückschritt

Die sechs Referenzdokumente (DOC-00001/2/4/31/33/36) erwarten seit dem Einfrieren der Gold-Suite am 01.08.2026
`exact`, erhalten aber `likely` bzw. bei DOC-00033 `multiple`. Ursache ist die bewusste Härtung **EINGANG-01C-1
(P1-A)** vom 30.09.2026 (`3f4745f`, `documentCaseMatchService.ts`): Treffer nur über Kunde und Baustelle oder Projekt
und Kunde sind höchstens ein Vorschlag (`likely`), nie `exact`; mehrere starke Kandidaten sind `multiple`. Exakt ist
nur noch eine eigene Auftrags-/Angebotsnummer oder eine bestätigte Verknüpfung. Bei fünf Dokumenten wird weiter
der erwartete Vorgang vorgeschlagen (`likely` mit richtigem Vorgang); bei DOC-00033 erkennt die App mehrere gleich
starke Kandidaten (`multiple`). Zugeordnet wird ohnehin nur nach Bestätigung.
**Kein Code geändert.** Die geschützten Gold-Berichte und die eingefrorenen Erwartungen sind unverändert; ob die
Erwartungen an EINGANG-01C-1 angepasst werden, entscheidet der Auftraggeber.

## 6. Tests und Nachweise

| Prüfung | Ergebnis |
|---|---|
| Neue Tests | Regel 38 (davon 32 gemeinsame Vektoren), Löschschutz/Empfehlungen 11 (inkl. Rückholung nach Serverabweisung), Dokumentseite 3, Firmendokument 3, F7 8, F8 5 — alle grün |
| SQL-Vertragstests | `dokumente01_aufbewahrung.sql` (32 Vektoren + 25 Zusicherungen), `dokumente01_papierregister.sql` (18 Zusicherungen) — grün mit, rot ohne Migration |
| SQL-Regression | 51 nicht parallele Tests ohne/mit beiden Migrationen: 0 Befunde; 3 lokal datenabhängig rot, in beiden Modi gleich (`belege/gegenproben/sql-regression-ergebnis.txt`) |
| Vitest-Regression | 320 Dateien (153 Dokumentdateien der Ausgangsbasis + 167 angrenzende): unter Volllast 89 rot, bei 2 Workern 12 rot in 5 Dateien; davon 3 Dateien Testvorbedingungen (angepasst, Absicht unverändert), 2 lastbedingt (einzeln grün). Eingangsweg nach der letzten Korrektur (225 Dateien, 2.572 Tests): 14 rot in 7 Dateien — 4 vorbestehend rot (Altliste, gleiche Fehlerbilder an HEAD), 3 lastbedingt (einzeln grün), **kein Befund** (`belege/tests/`) |
| Gegenproben | 13/13 Client-Mutationen (isolierte Kopie) und 11/11 Server-Mutationen erkannt; unmutiert grün |
| Endlauf | alle DOKUMENTE-01-Tests und angepassten Bestandstests (16 Dateien): 200/200 grün |
| Typprüfung | `tsc --noEmit` ohne Fehler |
| Browser | 12 Belege, alle Abläufe wie erwartet (`belege/browser/PROTOKOLL.md`) |
| Schutzartefakte | Gold-Berichte und Snapshot prüfsummengleich (vorher/nachher jedes Laufs) |

Angepasste Bestandstests (Absicht unverändert, Grund jeweils im Test kommentiert): `browserAcceptanceFix01a`,
`dokumentDetailRolleGls01`, `dokumentDetailMitarbeiterquittungP1ma`, `archivRolleGls01`,
`generatedInvoiceDocumentCloudWiring05c1b`, `paymentProofDeleteGuard01`, `archiveTruthOrphanGuardR02`,
`officePilotMemoryNacharbeit1S4`, `documentArchiveTruth03a1`, `intakeFinanceTruth01d1`; SQL:
`document_archive_guard_baf01` (Altbestand ohne den neuen Wächter, nur in der zurückgerollten Transaktion),
`go_live_security_01_finalization` (D7b nimmt nur den Rechnungsbezug, nicht die Einstufung — wie der echte Client).

## 7. Geänderte und neue Dateien

Neu: `src/services/document/documentRetention.ts`, `documentRetentionVectors.ts`,
`src/components/documents/DocumentRetentionCard.tsx`, `src/i18n/locales/de/documentRetention.ts`, die zwei
Migrationen, die zwei SQL-Tests und sechs Testdateien. Geändert: `documentService.ts`,
`generatedInvoiceDocumentDeleteService.ts`, `DokumentDetailPage.tsx`, `EingangDetailPage.tsx`,
`CompanyRelevancePanel.tsx`, `inboxService.ts`, `documentGuidanceService.ts`, `documentAssistantService.ts`,
`documentExplanationService.ts`, `syncOutboxDescriptionService.ts`, `documentAiContextService.ts`,
`documentMeaningPresentationService.ts`, `documentSemanticCoreService.ts`, `DocumentMeaningPanel.tsx`, i18n
(`index.ts`, `locales/de/index.ts`, `locales/bg/docAssistant.ts`) sowie die genannten Tests.

## 8. Offen — Entscheidungen des Auftraggebers

1. **Gold-Erwartungen** an EINGANG-01C-1 anpassen (sechs Dokumente `likely`/`multiple`) — eigene Freigabe.
2. **Remote-Anwendung** von 20261125/20261126 nur mit der Gesamtveröffentlichung. Hinweis: Ab dann weist der Server
   Löschversuche alter App-Stände für geschützte Dokumente ab (die App holt sie zurück).
3. **Account-Löschung und Aufbewahrung** (Go-Live-Liste) — eigener Block, nicht Teil von DOKUMENTE-01.
4. Beobachtet, nicht geändert: Das Archiv übernimmt als Belegdatum das Eingangsdatum (bewusst, für die Frist
   konservativ; das erkannte Rechnungsdatum steht in den erkannten Angaben). Das manuelle Formular schlägt als
   Papierordner „Behörden & Versicherungen" vor, auch für eine Ausgangsrechnung. Kennzeichnung auch in der
   Dokumentliste wäre möglich.

## 9. Einhaltung

Kein Commit, kein Push, kein Deployment, keine Remote-Migration, keine produktiven Schreibzugriffe. HEAD
`ba778e8` unverändert. Planer lokal `active = false`. Gold-Berichte und Snapshot unverändert. KI nur mit
abgefangener Schnittstelle und synthetischen Daten. WEISS-/T8-Dienste und versiegelte Ordner nicht angefasst.

**STOPP — BEREIT FÜR WEISS.**
