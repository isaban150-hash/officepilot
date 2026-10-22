# DOKUMENTE-01 — Szenariokatalog für die unabhängige Abnahme (WEISS)

Stand 21.10.2026 · SCHWARZ · Grundlage: `02-abschlussbericht.md`, Prüfumgebung: `04-pruefumgebung.md`.

Alle Szenarien laufen gegen die **lokale** Instanz (127.0.0.1:54321) mit synthetischen Daten. Keine
Produktionsdaten, keine externe KI (`/functions/v1/ai` und der Gemini-Host abgefangen). Erwartete Texte sind
wörtlich angegeben; Datumswerte gelten bei Prüfung im Jahr 2026 (Frist = 31.12. des Bezugsjahres + 8 bzw. 6).

## A — Aufbewahrung und Löschschutz (D-017)

| Nr. | Ablauf | Erwartet |
|---|---|---|
| A1 | Eingangsrechnung (PDF mit Rechnungsnummer, USt, Gesamtbetrag) hochladen, speichern, ggf. „Als Firmendokument markieren", Ablage bestätigen, archivieren; Dokumentdetail öffnen | Karte „Aufbewahrung": „Buchungsbeleg: gesetzliche Aufbewahrung 8 Jahre, mindestens bis 31.12.2034." · „Löschen ist bis dahin gesperrt." · Einstufung „Rechnung oder Beleg" · Grundlage „§ 147 Abs. 1 Nr. 4, Abs. 3 AO, § 257 Abs. 1 Nr. 4, Abs. 4 HGB, § 14b Abs. 1 UStG." · Hinweis zum Papieroriginal |
| A2 | Im selben Detail „Mehr anzeigen" | Kein „Löschen"; stattdessen „Gesetzliche Aufbewahrung bis 31.12.2034 – Löschen ist bis dahin gesperrt." |
| A3 | Als Inhaber direkt `tombstone_workspace_document` für A1 aufrufen | HTTP 403, SQLSTATE 42501, „Keine Schreibberechtigung: Aufbewahrungsfrist laeuft bis 31.12.2034 (buchungsbeleg, 8 Jahre)"; Zeile unverändert |
| A4 | Dasselbe über `upsert_workspace_intake_entity` (archived_document, deleted=true, aktuelle row_version) | identische Abweisung; Zeile unverändert |
| A5 | Eingangsrechnung über „Ausgabe erfassen" ablegen | Einstufung „Beleg einer Ausgabe", Sperre wie A1 |
| A6 | Allgemeines Schreiben (z. B. Verbandsinformation) ablegen und öffnen | „Aufbewahrung prüfen" · „Für diese Dokumentart kennt OfficeTakt keine feste gesetzliche Frist." · „OfficeTakt schlägt keine Entsorgung vor …" |
| A7 | A6 → „Löschen" | Prüftext „Für dieses Dokument kennt OfficeTakt keine feste Aufbewahrungsfrist. Löschen Sie es nur, wenn Sie geprüft haben, dass es nicht mehr aufbewahrt werden muss." · Knopf „Aufbewahrung geprüft – endgültig löschen" |
| A8 | A7 bestätigen | Dokument weg (lokal und nach Sync), Cloud-Zeile `deleted = true` |
| A9 | Dokumentdienst ohne Prüfbestätigung aufrufen (`deleteGeneratedInvoiceDocumentWithCloud(id, actor)`) | `document.delete.retention.confirmRequired`, kein Cloud-Aufruf |
| A10 | Beleg mit rechnerisch abgelaufener Frist (Dokument-/Erfassungsjahr ≤ 2017) | „Die gesetzliche Mindestfrist von 8 Jahren endete rechnerisch am 31.12.20xx." + Hinweis auf § 147 Abs. 3 AO; Löschen nur über Prüfbestätigung (Prüftext nennt das Datum) |
| A11 | Manuelles Dokument mit Kategorie „Ausgangsrechnung" anlegen, dann im Formular auf „Sonstiges" ändern | Fehler „Während der gesetzlichen Aufbewahrungsfrist lässt sich die Einstufung als Beleg oder Geschäftsbrief nicht aufheben." · Einstufung bleibt |
| A12 | Dasselbe Dokument: nur Titel ändern | gespeichert, Frist unverändert |
| A13 | Serverseitig Nutzlast rückdatieren (alle Daten 2010) und danach löschen | Abweisung bleibt (Serveranlage zählt mit) |
| A14 | Original-Bindung bzw. Datei eines geschützten Dokuments beerdigen (Eingangsweg) | 42501 „Original eines Dokuments mit Aufbewahrungsfrist …" bzw. „Datei eines Dokuments …"; Vorschau-Bindung bleibt löschbar |
| A15 | Mitglied versucht zu löschen | Rollenhinweis „Dokumente löschen nur Inhaber und Verwaltung."; Server 42501 „Keine Schreibberechtigung" |
| A16 | Zweites Gerät (frisches Profil, derselbe Nutzer) | gleiche Einstufung und Frist; gelöschtes Dokument fehlt |

## B — Keine Entsorgungsempfehlung ohne Prüfung (F10)

| Nr. | Ablauf | Erwartet |
|---|---|---|
| B1 | Abgelegte Rechnung: Eingang öffnen, „Warum diese Empfehlung?" | „Empfehlung: Original aufbewahren – wichtig für Steuer und Buchhaltung. (Dauerhaft speichern dringend empfohlen)"; kein „entsorg…" auf der Seite |
| B2 | Abgelegtes Schreiben ohne feste Regel | „Empfehlung: Original aufbewahren, bis geklärt ist, ob eine Aufbewahrungspflicht besteht." |
| B3 | Ablageentscheidung einer Rechnung | „Bitte Original abheften in: …" (nie „Entsorgen") |
| B4 | Dokument ohne Papierordner (Ablage-Karte) | „Kein Papierordner zugewiesen" (früher „… – Entsorgen oder manuell ablegen") |
| B5 | Werbung | einziger Fall mit „Kann nach erfolgreicher digitaler Ablage entsorgt werden." |
| B6 | Assistentenfrage „Darf ich das wegwerfen?" (regelbasiert, KI aus) an Rechnung bzw. unklarem Dokument | `disposeKeepTax` bzw. `disposeUncertain` — nie `disposeOk` |

## C — Deutung (F7, F8)

| Nr. | Ablauf | Erwartet |
|---|---|---|
| C1 | Rechnung mit „Leistungsdatum: August 2026" und Position „Austausch …" | Bedeutung nennt keine dieser Zeilen als Umsatzsteuer; Beträge ohne Doppel |
| C2 | Quittung „Auslagenerstattung … 12,50" ablegen, Detail öffnen | keine „Gutschrift zu Ihren Gunsten", kein doppelter Betrag, keine Konsolenwarnung „doppelter Schlüssel" |

## D — Zuordnung beim Markieren als Firmendokument (im Browser gefunden)

| Nr. | Ablauf | Erwartet |
|---|---|---|
| D1 | Rechnung ohne erkannten Empfänger hochladen → Technische Angaben | Hinweis „Erkannt: Eingangsrechnung. Ohne andere Auswahl bleibt diese Dokumentart erhalten." |
| D2 | „Als Firmendokument markieren" ohne Kategoriewahl, dann archivieren | Archiv: Art `eingangsrechnung`, Buchungsbeleg (vorher: `sonstiges` → nur „prüfen") |
| D3 | Kategorie bewusst wählen (z. B. „Brief") und markieren | gewählte Art gilt |

## E — Papierregister im Mitgliedsbetrieb (F9)

| Nr. | Ablauf | Erwartet |
|---|---|---|
| E1 | Mitglied legt eigenes Dokument ab; Inhaber hakt „Papieroriginal abgeheftet" | Mitgliedsgerät zeigt „Papieroriginal abgeheftet (TT.MM.JJJJ)", Sync „Synchronisiert" |
| E2 | Server: Inhaber legt Eintrag zum Mitgliedsdokument an (`supabase/tests/dokumente01_papierregister.sql` P1–P3) | Zeile gehört dem Mitglied (`created_by`), Mitglied sieht und ändert sie; sein Version-0-Versand ist „Versionskonflikt", nicht „Keine Schreibberechtigung" |
| E3 | Eintrag zum Dokument des Inhabers bzw. zu einem geschützten Beleg | für das Mitglied weder sichtbar noch änderbar |
| E4 | Altbestand (`workspace_paper_register_entries_assign_document_owner()`) | stellt genau die abweichenden Zeilen um; Version und Inhalt bleiben; Wiederholung 0 |

## F — Gegenproben

| Nr. | Ablauf | Erwartet |
|---|---|---|
| F1 | SQL-Vertragstests ohne Migration | `dokumente01_aufbewahrung.sql` scheitert (Funktion fehlt), `dokumente01_papierregister.sql` an P1 |
| F2 | Server-Mutationen (`belege/gegenproben/mutationen-server.mjs`, Stand Erstabgabe; für den überarbeiteten Stand `belege/nacharbeit-w/gegenproben/mutationen-server-v2.mjs`, nur Anker S10 angepasst) | 11/11 an der erwarteten Stelle erkannt |
| F3 | Client-Mutationen in isolierter Kopie (`belege/gegenproben/mutationen-client.mjs`) | 13/13 erkannt, unmutiert grün |

## G — Nacharbeit nach der Endabnahme (`05-nacharbeit-weiss.md`)

Für die Wiederholung von G je Rolle ein **eigenes** Browserprofil verwenden. In einem Profil aus der Zeit vor N1
stehen die fünf alten Abweisungen. Seit N1 (Abschnitt H) ist der Wechsel im **gemeinsamen** Profil selbst Prüfziel.

| Nr. | Ablauf | Erwartet |
|---|---|---|
| G1 | W1: `belege/nacharbeit-w/gegenproben/weiss-originalbindung-gegenreproduktion-*.log` bzw. WEISS' eigenes `originalbindung-gegenreproduktion.sql` gegen den eingespielten Stand | scheitert beim Umhängen: „Keine Schreibberechtigung: Original eines Dokuments mit Aufbewahrungsfrist bis 31.12.2034" (42501); keine Reste |
| G2 | W1: `dokumente01_aufbewahrung.sql` Abschnitt H | Umhängen und danach Datei beerdigen abgewiesen (auch Admin, auch direkt auf Datei, Dokument, Betrieb, Art, Teil, Inhalt+Pfad, Dateikennung); identische Wiederholung, Archiv-PDF- und Vorschaupflege und „prüfen" frei |
| G3 | W2: WEISS' `papierregister-reihenfolge.sql` gegen den eingespielten Stand | scheitert an WEISS' Zusicherung „trotz eigenem Dokument unsichtbar" — der Eintrag ist jetzt sichtbar |
| G4 | W2: `dokumente01_papierregister.sql` P7 | beide Reihenfolgen; frischer Abzug und RLS; Version-0-Erstversand = „Versionskonflikt"; Abhaken ja, Grabstein nein; Inhalt, Version, Schreiber bleiben; Prüfspur; umgekehrte Reihenfolge, anderer Betrieb, erzeugter Beleg ohne Freigabe |
| G5 | Prüfspur und Rücknahme: `belege/nacharbeit-w/gegenproben/ruecknahme-probe.sql` (Aufruf im Kopf) | früherer Anleger wiederhergestellt, Version und Inhalt unverändert, alles entfernt; zurückgerollt |
| G6 | Vorschau im Browser: frisches Profil als Inhaber → WEISS' Archivkopie öffnen | Vorschau erscheint, wenn sie (z. B. über „Erneut erstellen" auf dem archivierenden Gerät oder eine neue Dublette mit „Neu speichern") erzeugt wird; keine Konsolenmeldung `pdf-preview-encode`/`pdf-thumbnail-encode … unexpected_failure` |
| G7 | Vorschau-Test: `src/services/document/vorschauCloudDubletteDokumente01.test.ts` | 4/4; gegen den alten `documentFileStoreService.ts` (HEAD) V1, V3, V4 rot |
| G8 | *(überholt durch H — N1 ist behoben)* Rollenwechsel im selben Profil | vorher: Mitglied sendet die Inhaber-Einträge und sieht Inhaber-Dokumente; jetzt siehe H1–H3 |
| G9 | Mutationen: `belege/nacharbeit-w/gegenproben/sql-mutationen.mjs` | 11/11 erkannt, Kontrollen grün |

## H — Kontotrennung und Abmeldemenü (`06-nacharbeit-n1-n2.md`)

Ein **frisches, gemeinsames** Browserprofil für Inhaber und Mitglied. Für H1–H3 Schreibaufrufe an
`127.0.0.1:54321/rest/v1/rpc/upsert_*` im Browser blockieren oder offline gehen, damit die Aktion ungesendet bleibt.
In einem Profil aus der Zeit vor N1 gilt zusätzlich `06`, Abschnitt 7.

| Nr. | Ablauf | Erwartet |
|---|---|---|
| H1 | Inhaber anmelden; Archiv öffnen; ein Dokument mit Papierordner öffnen und „Papieroriginal abgeheftet“ wählen (Versand blockiert) | Hinweis „Nur Papierstatus aktualisiert – digitales Dokument bleibt gespeichert“; Synchronisation zeigt den Auftrag als offen |
| H2 | Dokument kurz geöffnet lassen, dann `/` neu laden, bis „Du hast zuletzt hier gearbeitet“ erscheint; Benutzermenü öffnen, „Abmelden“ klicken (Desktop und 390 px Breite) | Menü liegt über der Karte; der Klick meldet ab (Anmeldeseite) |
| H3 | Im selben Profil das Mitglied anmelden | Archiv nur mit Dokumenten, die der Server dem Mitglied liefert (eigene); Detailadresse eines Inhaberdokuments zeigt nichts; Synchronisation ohne Inhaber-Aufträge; kein Versand von `paper_register_entry` für Inhaber-Einträge, keine neuen Abweisungen „Keine Schreibberechtigung“ |
| H4 | Mitglied abmelden, Inhaber erneut anmelden | eigene Dokumente vollständig; „Papieroriginal abgeheftet“ gesetzt; der Auftrag aus H1 ist weiter offen und geht nach Freigabe des Netzes unter dem Inhaberkonto hinaus; Vorschau eines PDF-Dokuments lädt |
| H5 | Kontowechsel ohne Abmelden (zweiter Tab: als anderes Konto anmelden), dann im ersten Tab weiterarbeiten | erster Tab wechselt auf das neue Konto; keine Inhalte und kein Dokumentkontext des Vorgängers |
| H6 | Rollenentzug: Admin → Mitglied (lokal per SQL oder Verwaltung), dann neu laden; später Rolle zurückgeben und neu laden | als Mitglied nur Mitgliedssicht, nichts aus der Admin-Zeit, kein Versand von Admin-Aufträgen; nach Rückgabe Admin-Bestand samt offener Aufträge wieder da |
| H7a | Mitgliedschaft entfernen (lokal), dann neu laden | wie seit 20261124: der Server legt dem Konto einen eigenen Betrieb an, die App öffnet dessen Einrichtung; nichts aus dem Betrieb des Inhabers sichtbar, kein Versand; der frühere Mitgliedsbereich bleibt unverändert liegen |
| H7b | Widersprüchliche Antworten: Provisionierung meldet aktive Mitgliedschaft, der Abzug `removed` (nur im Browser durch Umschreiben der Antwort nachstellbar) | „Ihre Firmendaten konnten nicht geladen werden“ mit „Erneut versuchen“ und „Mit anderem Konto anmelden“; kein Betriebsbereich aktiv, nichts gesendet, lokale Bestände unverändert |
| H8 | Tests: `src/services/storage/kontoTrennungDokumente01.test.ts`, `src/kontoTrennungGateDokumente01.test.tsx`, `src/abmeldeMenueN2Dokumente01.test.ts` | 17 + 8 + 3 grün |
| H9 | Gegenproben in der isolierten Kopie: `belege/nacharbeit-n/gegenproben/mutationen-n1.mjs`, `mutation-n2.mjs` | 18/18 erkannt; N2 ohne `z-index: auto` rot; unmutiert grün |
| H10 | Laufender Abgleich über den Wechsel: als Inhaber etwas ändern, „Jetzt synchronisieren“ und sofort (während der Lauf läuft) in einem zweiten Tab als Mitglied anmelden; im ersten Tab neu laden | beim Mitglied keine Inhaberdokumente und -aufträge; Inhaberbestand beim nächsten Inhaber-Login unverändert (gezielt belegt durch G7; im Browser vom Zeitpunkt abhängig — zeitunabhängig siehe I5) |
| H11 | „Zurück“ nach dem Kontowechsel im selben Tab: als Inhaber einen Antwortbrief vorbereiten lassen („Antwort als Brief“), abmelden, Mitglied anmelden, mit der Zurück-Taste bis zum Briefeditor | Editor ohne Betreff und Text des Inhabers; unterwegs keine Inhaberdokumente. Kommt eine Seite aus dem Seiten-Cache zurück (vor allem Safari), lädt sie neu |

## I — Laufender Versand und Altaufträge (`07-nacharbeit-r1-r2.md`)

Für I5–I9 Schreibaufrufe an `127.0.0.1:54321` im Browser abfangen (wie bei H): `upsert_workspace_intake_entity` lokal
mit Erfolg beantworten, damit der Lauf weitergeht, alles andere abbrechen; `/auth/v1/logout` lokal mit 204. So
erreicht kein Versand den Server, und an jeder abgefangenen Anfrage ist der Zugang (Konto im Token) ablesbar.

| Nr. | Ablauf | Erwartet |
|---|---|---|
| I1 | WEISS-Reproduktion `dok01-n1n2-sendekonto.mjs` unverändert | `calls`: genau einer, Identität A; `completed` nur `out-0`; `failed` leer; `wrongIdentity: false` |
| I2 | WEISS-Reproduktion `dok01-n1n2-sdk.mjs` unverändert (echtes SDK, eigener Token-Lieferant) | **seit `08` geändert:** das undurchsichtige Token `synthetic-account-A` nennt kein Konto → Halt beim Start (`start_unbestaetigt`), kein Aufruf; die Probe endet nach 15 s mit „Kein RPC“. Variante „beobachtet“: `calls: []`. Variante „jwt“ (Token mit Konto): genau ein Aufruf mit dem Token von A, `wrongIdentity: false` (`belege/nacharbeit-r2/weiss-proben/varianten/`) |
| I3 | WEISS-Reproduktion `dok01-n1n2-sendekonto-und-altbestand.mjs` unverändert | erster Teil wie I1; Altwarteschlange: `adopted_legacy`, `pendingAfterAdoption: 2`, `calls: []`, `completed: []` |
| I4 | Strengere Variante von I2: nur der Token-Lieferant wechselt, der Speicherbereich bleibt (`belege/nacharbeit-r/weiss-proben/r1-variante-nur-token.mjs`, eine Zeile anders; WEISS-Fassung `variante-nur-token.mjs`) | **seit `08` geändert,** wie I2: kein Aufruf, „Kein RPC“. Variante „jwt“: genau ein Aufruf mit dem Token von A, danach Halt `sitzung`, `wrongIdentity: false` |
| I5 | Zwei Tabs, ein Profil: Inhaber legt drei Dokumente an; die erste Sendung anhalten; im zweiten Tab das Mitglied anmelden; Sendung freigeben | genau eine Sendung, mit Inhaberzugang; danach aus dem ersten Tab nichts mehr; keine Sendung der Inhaberdokumente unter dem Mitglied; beim Inhaber alle drei Aufträge offen, die eine Bestätigung im Journal `…:full:sync-confirmed` |
| I6 | Danach Inhaber erneut anmelden | gesendet werden genau die zwei übrigen, mit Inhaberzugang; das bestätigte nicht erneut; alle drei erledigt, Journal entfernt |
| I7 | Abmelden während eines laufenden Sendens (Sendung anhalten, abmelden, freigeben) | danach geht nichts mehr hinaus; Aufträge offen beim Inhaber |
| I8 | Frisches Profil mit altem Betriebsbestand `officepilot-state:workspace:<betrieb>` (offene Aufträge ohne `origin`), Inhaber anmelden; dann neu laden | nichts davon gesendet; Anzeige „Aktion erforderlich“; Synchronisation zeigt „Zurückgehaltene Aufträge“ mit Datensatz, Vorgang und Herkunft; nach Neuladen weiter gesperrt; Prüfspur `…:full:outbox-origin-log` mit `held`/`legacy_adoption` |
| I9 | In I8 einen Auftrag auswählen, „Ausgewählte freigeben“, im Dialog bestätigen, „Jetzt synchronisieren“ | genau dieser Auftrag geht hinaus, mit Inhaberzugang; der andere bleibt gesperrt; Prüfspur `released` durch den Inhaber. Ist ein anderes Konto angemeldet: Freigabe abgelehnt, nichts verändert |
| I10 | Profil aus der N1-Zeit (Kontobestand mit offenen Aufträgen ohne `origin`) neu laden | diese Aufträge werden beim Laden gesperrt (Herkunft „nicht nachweisbar“) und erscheinen unter „Zurückgehaltene Aufträge“; endgültig abgewiesene bleiben unverändert und gehen nie automatisch hinaus |
| I11 | Tests: `src/services/sync/sendekontoR1Dokumente01.test.ts`, `src/services/sync/altwarteschlangeR2Dokumente01.test.ts`, `src/pages/syncHeldOrdersR2Dokumente01.test.tsx` | 17 + 10 + 3 grün (seit `08`: S12 nur mit JWT, S12b neu, S9a/S9b: Halt zählt als Fehler) |
| I12 | Gegenproben in der isolierten Kopie: `belege/nacharbeit-r/gegenproben/mutationen.cjs` | 16/16 erkannt, unmutiert grün |

## J — Startidentität und direkte Löschung (`08-restkorrektur-r1-start-loeschung.md`)

WEISS-Proben als bytegleiche Kopien außerhalb des WEISS-Ordners laufen lassen. Ihre Ausgaben schreiben sie neben
sich: Die Startprobe braucht `./originalproben/WEISS-DOK01-N1N2-2026-10-20/probe/adapter-bundle.mjs` (entsteht beim
Lauf von I1 in der Kopie von `originalproben/`); I2/I4 schreiben relativ zum Arbeitsverzeichnis.

| Nr. | Ablauf | Erwartet |
|---|---|---|
| J1 | WEISS-Probe `WEISS-DOK01-R1R2-2026-10-20/unlesbare-startsitzung.mjs` unverändert (erste Sitzungslesung wirft, danach B) | `sessionReads: 1`, `calls: []`, `completed: []`, `identityChanged: true`, `runIdentity.consistent: false`, `startProblem: start_unbestaetigt`, `wrongIdentity: false` |
| J2 | WEISS-Probe `dok01-r1r2-direktaktion.mjs` unverändert (Nachweisrückfrage angehalten, Wechsel zu B/member) | `result: { ok: false, errorKey: document.delete.identityChanged }`; nur `is_workspace_document_payment_proof`; Dokument von B `deleted: false`; `outbox: []`; `controlDirectAsB`: `document.delete.forbidden` |
| J3 | Start ohne nachweisbare Identität: Sitzung nicht lesbar, keine Sitzung, Tokenquelle wirft, Tokenquelle ohne Token, Token ohne Konto, leere Warteschlange | jeweils keine Anfrage, Grund `start_unbestaetigt`, Warteschlange unverändert, kein Erfolg (Tests T1–T4, S12b) |
| J4 | Danach: Koordinator und Seite | kein Erfolg; Haltbericht mit `errorCount: 1`; Status `error` mit „…ließ sich beim Start nicht bestätigen – nichts gesendet, nichts übernommen.“; Planer: `retryable`; Seite: „Synchronisation angehalten: Das Konto dieses Laufs ließ sich nicht bestätigen oder wurde gewechselt. …“ (T5, U1, U2) |
| J5 | Anmeldung von A wieder lesbar, neuer Lauf | genau die A-Aufträge, mit dem Zugang von A (T6) |
| J6 | Token-Erneuerung desselben Kontos mitten im Lauf | kein Halt; die nächste Anfrage trägt das erneuerte Token (T7) |
| J7 | Prüfung liest das richtige Konto, aber keinen Zugang | keine Anfrage, `sitzung_unlesbar`; das SDK liest die Sitzung nicht selbst nach (T8) |
| J8 | Direkte Löschung: ohne Wechsel; mit Wechsel (Sitzung und Bereich, nur Sitzung, neue Anmeldung ohne Sitzung beim Aufruf); Abmeldung; Rückkehr zu A | ohne Wechsel gelöscht mit Auftrag der Herkunft A; sonst Abbruch ohne Erfolg, nichts bei B, kein Auftrag; nach Rückkehr Bestand von A unverändert, neue Löschung gelingt (L1–L6) |
| J9 | Rechnungsdokument: Grabstein; B meldet sich genau beim Senden an; ohne bestätigte Anmeldung; Wechsel während des Grabsteins | Grabstein mit geprüftem Zugang von A an den Betrieb des Aufrufs; danach Abbruch ohne lokales Löschen; ohne Anmeldung kein Grabstein (`document.delete.identityUnconfirmed`) (L7–L9) |
| J10 | Veraltete Oberfläche (Handelnder ≠ Konto des Bereichs); Aufbewahrung; Zahlungsnachweis | kein Vorgang, keine Rückfrage; Sperren wie bisher (L10, L11) |
| J11 | Tests: `src/services/sync/startidentitaetR1Dokumente01.test.ts`, `src/services/document/loeschvorgangBindungDokumente01.test.ts`, `src/pages/syncHaltMeldungR1Dokumente01.test.tsx`, `src/services/sync/sendekontoR1Dokumente01.test.ts` | 9 + 16 + 2 + 17 grün |
| J12 | Gegenproben in der isolierten Kopie: `belege/nacharbeit-r2/werkzeuge/mutationen.cjs` | 15/16 erkannt (D3 allein nicht, erwartet; zusammen mit D2 als D4 erkannt), unmutiert 44/44 grün |
