# OfficeTakt — Projektstatus (gemeinsame Übergabe)

Kompakte Übergabedatei zwischen Claude Code, ChatGPT und dem Nutzer.
Keine Projektdokumentation, keine Commit-Chronik — nur der aktuelle Stand.

Stand: 2026-09-18 (Cloud-Durability-Bereich abgeschlossen, noch nicht committet)

> Produktname ist **OfficeTakt**. Repository, Pfade, Supabase-Projekt und
> Codebezeichner heißen technisch weiterhin `officepilot` — das bleibt so und
> wird nicht umbenannt.

---

## 1. Produkt

- OfficeTakt ist ein digitaler Büroassistent für kleine Handwerksbetriebe.
- Er nimmt Belege und Dokumente auf (Foto, PDF, Galerie, Scan), ordnet sie
  automatisch zu, führt Aufträge, Rechnungen, Ausgaben und Kunden und bereitet
  die Monatsmappe für den Steuerberater vor.
- Produktziel: ein hochwertiges, ruhiges B2B-Werkzeug, das auf Desktop und Handy
  jeweils eigenständig gut bedienbar ist; Startseite „Heute“ zeigt den
  Tagesbetrieb auf einen Blick.

## 2. Git- und Migrationsstand

- Branch: `main`, HEAD **`3bd0f98`** — feat(sync): make vorgang notes cloud durable
- origin/main identisch mit `main`.
- **Arbeitskopie enthält fertige, noch nicht committete Arbeit:** die Blöcke
  CLOUD DURABILITY CORE 01C (Aufgaben), 01D (Mahndokumentation) und 01E
  (Transparenz) — jeweils als commit-reif bewertet. Dazu unverändert die drei
  geschützten Testartefakte (Abschnitt 8). Commit und Push macht der Nutzer.
- Migrationen: keine doppelten Versionen. **Remote angewandt bis
  `20260923120000`** (Vorgangsnotizen, mit `3bd0f98` committet). Die beiden neuen
  Migrationen `20260924120000_workspace_tasks_cloud.sql` und
  `20260925120000_workspace_invoice_dunning_documentations.sql` sind **nur lokal
  angewandt** (Docker) und müssen nach dem Commit noch auf die entfernte
  Datenbank gebracht werden. Neue Migrationen nur additiv und nur mit
  ausdrücklichem Auftrag.

## 3. Zuletzt abgeschlossene Produktblöcke

| Block | Commit | Fachlicher Stand |
| --- | --- | --- |
| Ausgaben-Härtung (V1-A) | `0086cdc` | Ausgaben-Storno mit Pflichtgrund, Beträge nach Zahlung fest, Detail mit Status und nächster Aktion |
| E-Mail-Safety (V1-B1) | `4514bc3` | `unknown` ist kein Retry-Zustand (Client **und** Server), Env-Doku, `send-document`-Config, STAGING-Banner |
| Dokument-/Briefversand (V1-B2) | `eeea050` | Versand archivierter PDF-Dokumente (letter/offer/other) mit Server-Validierung, `DocumentDeliveryPanel` |
| Absenderadresse konfigurierbar | `46e6162` | `MAIL_SENDER_EMAIL` als Server-Secret, fail-closed, keine hartcodierte Domain |
| Migrations-Kollisionen | `5321e7f` | eindeutige Versionsnummern, Delivery-Migrationen auf 20260921/20260922 |
| Zahlungserinnerung ohne Auftrag | `42d2c3e` | siehe unten |
| Auftragskosten / Ausgabenzuordnung | `4bc716b` | siehe unten |
| Cloud-Durability 01B — Vorgangsnotizen | `3bd0f98` | Notizen am Auftrag sind cloud-dauerhaft, inkl. Grabstein und Altbestand |
| Cloud-Durability 01C — Aufgaben | **noch nicht committet** | siehe unten |
| Cloud-Durability 01D — Mahndokumentation | **noch nicht committet** | siehe unten |
| Cloud-Durability 01E — Transparenz | **noch nicht committet** | siehe unten |

**Zahlungserinnerung ohne Auftrag (`42d2c3e`)**
- Zahlungserinnerung funktioniert auch für manuell erstellte Rechnungen ohne Vorgang.
- Der Kommunikationskontext einer Rechnung braucht keine künstliche `vorgangId`;
  Kunde, Nummer, Datum, Fälligkeit, Beträge kommen aus dem Rechnungssnapshot.
- Mahndokumentation funktioniert für Rechnungen mit und ohne Vorgang
  (`vorgangId: string | null`), Duplikate derselben Übergabe werden verhindert.
- Mahnstand ist im Rechnungsdetail und in der Offene-Rechnungen-Übersicht sichtbar;
  bei überfälligen Zeilen als sichtbare Aktion, sonst im vorhandenen „Weitere“-Menü.
- Vollständig bezahlte, stornierte und nicht versendete Rechnungen sind nicht mahnbar.
- Mahndokumentation ist weiterhin **lokal** und nicht cloud-durable.

**Cloud-Durability 01C — Aufgaben (noch nicht committet)**
- Aufgaben sind cloud-dauerhaft; Kennungen bleiben zufällige Client-IDs.
- Geräteübergreifende Identität ist der vorhandene fachliche `dedupeKey`, und zwar
  **nur** für automatisch erzeugte, offene/in Arbeit befindliche Aufgaben.
  Manuelle Aufgaben werden nie entdoppelt — zwei gleichnamige bleiben zwei.
- Erledigte und archivierte Aufgaben blockieren keine spätere neue Episode
  desselben Schlüssels (partieller Eindeutigkeitsindex).
- Konkurrierende Anlage auf zwei Geräten ist ein serverseitiges Replay: Die RPC
  gibt die kanonische Zeile zurück, der Client verwirft seine eigene Kennung, der
  Sendeauftrag wird abgeschlossen — kein Dauerfehler, keine zweite Aufgabe.
- Versionsvertrag repariert: Anlegen ohne erfundene Serverversion, Erledigen und
  Wiederöffnen lassen die bestätigte Version unberührt.
- Demo-Aufgaben `t-001…t-003` erreichen die Cloud nie (ID-Guard).

**Cloud-Durability 01D — Mahndokumentation (noch nicht committet)**
- Der Nachweis einer übergebenen Zahlungserinnerung/Mahnung ist cloud-dauerhaft
  und bleibt **append-only**: kein Bearbeiten, kein Löschen, kein Grabstein.
- Fachliche Identität unverändert aus dem Produkt: Rechnung, Auftragsbezug, Art,
  Datum, Weg. Die Notiz gehört nicht dazu. Zwei Geräte, die dieselbe Übergabe
  festhalten, ergeben einen Nachweis.
- Funktioniert für die freie Rechnung ohne Auftrag (`vorgangId = null`); die
  historische Rechnungsnummer reist als Kopie mit.
- Keine Fremdschlüssel auf Rechnung oder Auftrag: Storno und gelöschter Auftrag
  vernichten den Nachweis nicht.
- Neue Kennungen kommen aus `generateEntityId` statt aus einem Zeitstempel;
  Bestandskennungen bleiben unverändert.

**Cloud-Durability 01E — Transparenz (noch nicht committet)**
- Wo heute noch benutzersichtbare Daten nur auf einem Gerät liegen, sagt das
  Produkt es ruhig: Wissen, Kommunikationsverlauf und der Haken für die
  Papierablage tragen je einen kurzen Hinweis (de/tr/bg).
- Die Synchronisationsseite benennt Notizen und dokumentierte
  Zahlungserinnerungen jetzt verständlich statt als „Eintrag".
- Keine neue Cloud-Tabelle, keine Migration, keine Allowlist-Erweiterung.

**Auftragskosten / Ausgabenzuordnung (`4bc716b`)**
- `Expense.allocations` wird produktiv verwendet; Bezug ist `vorgangId`.
- Kostenbasis dieser Auswertung ist **netto**; Teilzuordnung möglich,
  Überzuordnung (Summe > Nettobetrag) wird abgelehnt, max. eine Zuordnung je Auftrag.
- Stornierte Ausgaben bleiben historisch zugeordnet, zählen aber nicht zu den
  aktiven Auftragskosten und sind nicht mehr änderbar.
- Auftrag zeigt: **Abgerechnet (netto) · Zugeordnete Kosten (netto) · Verbleibt**,
  dazu die Belegliste und den Hinweis „Arbeitszeit und Löhne sind hier nicht enthalten.“
- Der Begriff „Deckungsbeitrag“ wird bewusst **nicht** verwendet.
- Abgerechnet nutzt die bestehende Billing-Semantik (`isBillingEffective`) und
  rechnet Abschläge + Schlussrechnung ohne Doppelzählung
  (`subtotal − Σ previousAbschlagDeductions.subtotal`); Zahlungen ändern den Wert nicht.
- Zuordnungen reisen über den vorhandenen Expense-Payload/Fingerprint/Cloud-Sync;
  keine Migration nötig.
- Zuordnung erfolgt im **Ausgabendetail**; `ExpenseForm` hat bewusst noch kein
  Auftragsfeld. `orderPositionId` bleibt für spätere Nachkalkulation ungenutzt.

## 4. Produktfunktionen — heutiger Stand

| Bereich | Stand |
| --- | --- |
| Dokumenteingang / Dokumentverständnis | Foto/PDF/Scan, Klassifikation, Prüfung in fünf Fragen, Ablageentscheidung, „Als Ausgabe speichern“ |
| Archiv | Dokumentdetail mit Originaldatei, Papier-/Digitalablage, Dokumentbezug zu Vorgang/Rechnung/Ausgabe |
| Kunden | Kundenstamm, Zuordnung, Dubletten- und Altbestandsbehandlung |
| Vorgänge/Aufträge | Auftrag aus Auftragsdokument, Positionen, Nachträge, Statuslebenszyklus |
| Manuelle Rechnung | vollständig unabhängig von Vertrag/Dokument (Kunde → Positionen → Details → Freigabe) |
| Abschlag/Schlussrechnung | Abschläge mit Abzügen in der Schlussrechnung, Mengen-/Überzahlungsprüfungen |
| Rechnungskorrektur/Storno | Storno mit Grund, Korrekturbeleg, Originalbeleg bleibt unverändert |
| Zahlungen / offene Posten | append-only mit Reversal, Teilzahlung, Skonto, eigene Übersichten für Rechnungen und Ausgaben |
| Ausgaben | Erfassen, Kategorien, Zahlungen, Storno mit Grund, Bearbeitungsregeln nach Zahlung |
| Auftragskosten-Zuordnung | Ausgabe → Auftrag (netto, Teilzuordnung), Kostenabschnitt im Auftrag |
| Zahlungserinnerung / Mahndokumentation | Entwurfstext, Übergabe dokumentieren, Mahnstand sichtbar (lokal gespeichert) |
| Steuerberater / Monatsmappe | Monatsübersicht mit Vollständigkeitsstatus, ZIP-Export mit CSVs, benannte Fehlausgänge |
| Einstellungen / Firmenprofil / Branding | Firmendaten, Logo, Rechnungsnummernformat, Zahlungsbedingungen, Kommunikationsstandards |
| Kommunikation | Antwortentwürfe je Anlass, Vorschläge statt Sackgasse, Kopieren/Übergeben, Verlauf (lokal) |
| Assistent | Tagesüberblick, Workflow-/Finanzhinweise in verständlichem Deutsch, keine Rohschlüssel |
| Sync | Cloud-Durability für Workspace, Firmenprofil, Kunden, Vorgänge, Eingang, Dokumente, Dateien, Bindings, Work-Results, Ausgaben, Ausgabenzahlungen, Rechnungen, **Vorgangsnotizen, Aufgaben, Mahndokumentation** (Matrix in Abschnitt 6) |
| E-Mail-Versand | Rechnung, Korrekturbeleg und archivierte PDF-Dokumente über Edge Function `send-document`; produktiv **blockiert** (Abschnitt 5) |

## 5. E-Mail / Brevo — externer Blocker

- Versandkette implementiert: Client → Edge Function `send-document` → Provider.
- Authentifizierter Absender: `rechnung@send.officetakt.de`; Domain
  `send.officetakt.de` ist bei Brevo authentifiziert (DKIM/DMARC).
- **Blocker:** Ein frisch erzeugter, aktiver Brevo-API-v3-Key wird von Brevos
  eigenem `/v3/account`-Endpunkt mit HTTP 401 „Key not found“ abgewiesen; die
  Function meldet entsprechend `auth` / `brevo_401_unauthorized`. Brevo-Support ist
  kontaktiert.
- Bis zur Supportantwort: keine weiteren Mail-/Provideränderungen, keine
  Secret-Änderungen, keine realen Versandversuche.
- Secrets/Key-Werte stehen nicht in dieser Datei und gehören nicht ins Repository.
  Benötigte Secret-**Namen** der Function: `MAIL_PROVIDER`, `BREVO_API_KEY`,
  `MAIL_SENDER_EMAIL`.

## 6. Offene Produktpunkte

**Cloud-/Geräte-Matrix (gegen den aktuellen Arbeitsstand geprüft):**

*A — cloud-dauerhaft über die generische Sync-Engine:* `workspace`,
`workspace_member`, `workspace_settings`, `company_setup`, `company_profile`,
`vorgang`, `customer`, `inbox_item`, `document`, `document_file`,
`document_file_binding`, `document_work_result`, `expense`, `expense_payment`,
`vorgang_note` (01B), `task` (01C), `dunning_documentation` (01D).

*B — bewusst noch nur auf diesem Gerät, mit sichtbarem Hinweis (01E):*
`knowledge_fact` (Wissen), `communication_event` (Kommunikationsverlauf),
`paper_register_entry`/Papierablage-Haken (Dokumentdetail).

*C — intern oder abgeleitet, kein eigener Benutzerhinweis nötig:*
`document_memory`, `proof_memory`, `memory_relation` (Analyse-/Gedächtnisdaten,
vom Nutzer nicht direkt gepflegt; die eine Nutzerangabe darin — der
Papierablage-Haken — ist unter B abgedeckt) und `mail_import` (Transportrecord;
das fachliche Ergebnis landet als Eingang/Dokument in der Cloud).

*D — eigene Cloud-Wege außerhalb der Allowlist:* Rechnungen und
Rechnungszahlungen (`workspace_invoices`), Rechnungsnummernformat,
Versandbelege (`workspace_document_deliveries`), Versandstatus der Rechnung,
Dateiinhalte im Storage.

Wirkung: Auf einem zweiten Gerät fehlen weiterhin Wissenseinträge,
Kommunikationsverlauf und der Papierablage-Haken — das Produkt sagt es jetzt an
Ort und Stelle, statt es dem Nutzer zu überlassen, es zu bemerken.

**Weitere Lücken:**
- Briefe/geschäftliche Schreiben: kein generierter Brief-PDF-Workflow; `letter`/`offer`
  im Versand bedeutet „empfangenes Dokument weiterleiten“.
- Auftragskosten vorhanden, aber keine vollständige Nachkalkulation
  (Arbeitszeit, Lohn, Lager, Positionsgenauigkeit).
- `ExpenseForm` ohne direkte Auftragsauswahl; `orderPositionId` ungenutzt.
- E-Mail extern blockiert (Abschnitt 5).
- Sekundärnavigation enthält weiterhin technische Ziele: `/mail-import`,
  `/papierarchiv`, `/synchronisation`, `/admin/users`.
- Product Acceptance: Im Code sind Korrekturen zu F-01…F-07 und F-15 markiert.
  Die P3-Punkte F-08…F-14 sind nirgends im Repository dokumentiert und heute
  **nicht verifizierbar** — bei Bedarf neu erheben.

## 7. Nächster empfohlener Core-Block

Der Cloud-Durability-Bereich ist fachlich abgeschlossen. Vor neuen Funktionen
stehen die Punkte, die aus 01C–01E offen geblieben sind:

1. **Commit und Push** der Blöcke 01C, 01D, 01E — danach die beiden Migrationen
   `20260924120000` und `20260925120000` auf die entfernte Datenbank bringen.
   Bis dahin läuft die Cloud-Fassung von Aufgaben und Mahndokumentation nur
   gegen die lokale Docker-Instanz.
2. **`syncMigrationService.backfillMeta`**: stempelt `sync.version = 1` auf jede
   Entität ohne Sync-Meta. Für den Insert-Zweig folgenlos, verhindert aber die
   Lost-Ack-Übernahme aus CREATE-RETRY-CONFLICT-02. Eigene Entscheidung nötig.
3. **Fachfremder Altfehler**: `manualInvoiceCustomerIdentity01b.test.ts` (T17,
   T22b) scheitert am Dubletten-Guard aus `43ff9a5`, der nach der letzten
   Änderung dieser Testdatei kam. Nicht Teil von 01C–01E.
4. Erst danach die verbleibenden Local-only-Bereiche (Wissen, Kommunikation,
   Papierablage) fachlich bewerten — cloud-fähig machen oder bewusst lokal
   lassen. Der Hinweis aus 01E macht den Zustand solange ehrlich.

Muster für spätere Cloud-Blöcke: additive Migration nach Vorbild
`workspace_vorgang_notes`/`workspace_tasks`, Versionsvertrag zuerst, Allowlist
zuletzt, Dedupe-Frage vor dem Schema klären.

## 8. Geschützte Artefakte

Diese drei Dateien erscheinen dauerhaft als `M` im Arbeitsbaum und gelten als bekannt:

- `src/components/invoice/__snapshots__/InvoiceDocumentView.test.tsx.snap`
- `test-world/reports/gold-pipeline-04b.json`
- `test-world/reports/gold-pipeline-04b.md`

Es sind lokale Test-Seiteneffekte. Regel: nicht automatisch stagen, nicht restoren,
nicht löschen, nicht committen. Nur der Nutzer entscheidet ausdrücklich darüber.

## 9. Testregeln

- Während eines Produktblocks nur gezielte Tests (betroffene Vitest-Dateien) plus
  unmittelbar angrenzende Regressionen und `npx tsc --noEmit`.
- Kein `test:full` nach kleinen Änderungen; große Gesamtregression nur an einem
  echten Release-Gate.
- Die Gold-PDF-Pipeline nie versehentlich in normalen Läufen ausführen — sie
  schreibt die geschützten Berichte.
- Volle Vitest-Suite nie parallel zu Playwright.
- Nach größeren UI-/Funktionsblöcken Browser-Selbstabnahme mit Playwright
  (lokale Docker-Supabase, synthetische Nutzer, Screenshots außerhalb des Repos),
  Desktop 1280 + Mobile 360/390.
- Nur lokale Supabase (`http://127.0.0.1:54321`), nie `--linked`/Produktion.
- Passwörter werden nie gelesen, gespeichert oder protokolliert; der Agent trägt
  nur die E-Mail ein, der Nutzer tippt das Passwort.

## 10. Design — Navy Trust v1.0 (Master)

- Navy `#1f3c88` als Führungsfarbe, Teal semantisch/sekundär; Tokens aus
  `src/styles/tokens.css`. Keine Verläufe, kein Glow, kein „KI-Lila“, keine Emojis.
- Ruhige, professionelle B2B-Anmutung; klare Hierarchie.
- Wenige Karten, keine Karte in der Karte; Listen und Tabellen für Vergleich.
- Eine dominante Hauptaktion pro Seite; auf dem Desktop keine Vollbreiten-Buttons.
- Desktop und Mobile eigenständig gestalten — kein gestapelter Desktop;
  kein horizontaler Überlauf.
- Keine technischen IDs oder Entwicklerbegriffe in der Oberfläche
  (kein „Sync-Queue“, „Outbox“, „Snapshot“, „Draft-ID“); Sprache des Handwerksbetriebs.
- Typografie-Stufen 28/22/16/14/12.
- „Heute“ bleibt die Referenzseite für alle weiteren Bereiche.

## 11. Projektarbeitsregeln

- Einen Fachbereich erst fachlich fertigstellen und prüfen, dann Commit/Push.
- Nur ein schreibender Agent gleichzeitig im Repository; Analyse darf parallel laufen.
- Agenten committen und pushen nicht selbst und führen keine Git-Schreibbefehle aus
  (kein add/restore/checkout/reset/stash/clean) — der Nutzer macht Git-Writes manuell.
- Geschützte Artefakte nie blind anfassen (Abschnitt 8).
- Keine stillen fachlichen Übernahmen bei `needs_review`/`deselected`.
- Terminal- und Git-Schritte explizit und nachvollziehbar halten.
- Nach jedem größeren Block: unabhängiger Produkttest auf dem committeten Stand.

## 12. Update-Regel

Diese Datei wird nur aktualisiert:

- nach einem abgeschlossenen größeren Arbeitsblock,
- nach einem Commit, der den Projektstand relevant verändert,
- wenn sich Roadmap oder verbindliche Regeln ändern.

Bei jeder Aktualisierung veraltete Zustandsaussagen **ersetzen** statt anhängen:
HEAD, abgeschlossene Blöcke, Produktstand, offene Punkte und nächster Block.
