# DOKUMENTE-01 — Nacharbeit nach der WEISS-Endabnahme

Stand 20.10.2026 · SCHWARZ · nur lokal, nichts remote.
Grundlage: `WEISS-DOKUMENTE-01-Endabnahme-2026-10-20.md` und `WEISS-DOKUMENTE-01-Abschluss-mit-Browser-2026-10-20.md`
(beide BLOCKIERT). Belege: `belege/nacharbeit-w/` (Abschnitt 11).

## 1. Ergebnis

| Befund | Ergebnis | Geändert |
|---|---|---|
| DOK01-W1 (P1) Originalbindung austauschbar | behoben, serverseitig | `20261125120000_dokumente01_aufbewahrung.sql` |
| DOK01-W2 (P2) Papierregister vor Archivdokument | behoben, serverseitig, mit Prüfspur | `20261126120000_dokumente01_papierregister.sql` |
| Vorschaufehler `pdf-preview-encode` / `pdf-thumbnail-encode` | Produktfehler nachgewiesen und behoben (nicht die Testumgebung) | `src/services/documentFileStoreService.ts` |
| Fünf endgültige Rechteabweisungen | geklärt: 5 × `paper_register_entry`; Ursache belegt; **kein Code geändert** (Entwurfsentscheidung nötig, Abschnitt 5) | — |
| N1 (neu) lokaler Betriebsbestand wird über Konten hinweg geladen | nachgewiesen, **nicht behoben** (Gesamtentwicklung, Entscheidung) — *inzwischen behoben, siehe `06-nacharbeit-n1-n2.md`* | — |
| N2 (Nebenbefund) Benutzermenü unter der Karte „Weiterarbeiten" | nachgewiesen, nicht behoben — *inzwischen behoben, siehe `06-nacharbeit-n1-n2.md`* | — |

Die beiden überarbeiteten Migrationen sind lokal eingespielt (2026-10-20T11:40:59Z, eine Transaktion). Die Prüf-App
auf Port 5232 läuft weiter und liefert den korrigierten Client aus.

## 2. DOK01-W1 — Originalbindung

**Ursache.** Der Bindungswächter lief nur beim Setzen des Löschflags (`when not old.deleted and new.deleted`), der
Dateiwächter sah nur aktuell aktive Originalbindungen. Der reguläre Dispatcher (`upsert_workspace_intake_entity`,
`document_file_binding`) ersetzt bei bestehender Bindung `client_file_ref_id`. Damit ließ sich das Original erst auf
eine andere Datei umhängen und die bisherige Datei danach beerdigen.

**Korrektur.** Bei laufender Aufbewahrung des Dokuments weist der Server jede Änderung einer aktiven Originalbindung
ab, die nicht eine identische Wiederholung ist. Geschützt sind Datei, Dokument, Betrieb, Art und Teil der Bindung
sowie das Beerdigen. An der Originaldatei sind zusätzlich Inhalt (`content_sha256`), Ablageort (`storage_path`),
Betrieb und Kennung geschützt. Abweisung wie bisher mit „Keine Schreibberechtigung: Original … / Datei eines
Dokuments mit Aufbewahrungsfrist bis …", SQLSTATE 42501.

Frei bleiben:

- die identische Wiederholung (gleiche Zuordnung, nicht beerdigt); Herkunft, Version und Bearbeiter dürfen sich
  ändern;
- Vorschau, Vorschaubild, Archiv-PDF und E-Rechnungs-XML (keine Originalbindung), auch Umhängen und Aufräumen;
- Metadaten der Originaldatei (Name, Typ, Herkunft);
- alles ohne laufende Frist („prüfen", abgelaufen, gelöschtes Dokument).

Nach Codelesung hängt kein regulärer Clientablauf das Original eines bestehenden Dokuments um: Die
Sicherungs-Wiederherstellung legt die Bytes nur zwischen und stellt sie unter den ursprünglichen Kennungen wieder
her; die Konfliktauflösung übernimmt das Cloud-Original.

**Nachweis.** Vertragstest Abschnitt H (H1–H8): WEISS' zweistufige Umgehung (H1 Umhängen, H2 danach die alte Datei
beerdigen) und dasselbe als Admin werden abgewiesen, Zuordnung, Versionen und Datei bleiben unverändert (H4).
Identische Wiederholung, Archiv-PDF- und Vorschaupflege laufen (H5). Direkte UPDATEs auf Datei, Dokument, Betrieb,
Art und Teil (H6a–e) sowie stimmiger Tausch von Inhalt und Pfad und Umbenennen der Datei (H7a–b) werden abgewiesen;
Metadaten bleiben änderbar (H7c). Ohne Frist ist das Umhängen frei (H8).

## 3. DOK01-W2 — Papierregister vor Archivdokument

**Ursache.** Die Zuordnung (`created_by`) wurde nur beim Einfügen des Eintrags aus dem dann vorhandenen
Archivdokument ermittelt. Kam der Eintrag zuerst, blieb der Schreibende Eigentümer, auch nachdem das Dokument
eintraf.

**Korrektur** (Migration 20261126, überarbeitet):

1. **Prüfspur** `workspace_paper_register_owner_changes`: jeder Zuordnungswechsel mit vorher, nachher, Grund
   (`anlage`, `dokument_nachgereicht`, `altbestand`) und Zeitpunkt. Nur intern: RLS an, keine Rechte für anon,
   authenticated und service_role.
2. **Beide Reihenfolgen:**
   - Ist das Dokument schon da, wird der Eintrag beim Anlegen zugeordnet, wie bisher, jetzt mit Prüfspur.
   - Kommt das Archivdokument später, ordnet ein `AFTER INSERT`-Trigger auf `workspace_documents` den Eintrag
     dem Dokumentanleger zu (`workspace_documents_paper_register_owner`).
   - Inhalt, Version, Grabstein, `updated_by` und `created_at` bleiben. Nur `updated_at` zeigt als
     Server-Änderungszeit den Wechsel an.
3. **Altbestand** einmalig, jetzt ebenfalls mit Prüfspur. Lokal waren es 0 Zeilen.

**Keine Freigabe fremder Dokumente.** Die Zuordnung folgt allein dem Server-Anleger des Archivdokuments, in beiden
Reihenfolgen gleich. Ein Mitglied bekommt nur Einträge zu Dokumenten, die es selbst angelegt hat. In der umgekehrten
Reihenfolge wandert ein Eintrag zum Inhaber und verschwindet für das Mitglied. Andere Betriebe und andere
Dokumentarten bleiben unberührt. Geschützte Belege bleiben verborgen (unverändert). Unverändert gilt auch: Wer eine
Dokumentkennung zuerst auf dem Server anlegt, ist ihr Anleger. Das regelt W2 nicht neu.

**Nachweis.** Vertragstest P7a–P7l: WEISS-Reihenfolge (Inhaber schreibt, Mitglied liefert sein Dokument über den
regulären Eingangsweg), frischer Abzug und RLS sichtbar, Version-0-Erstversand = lösbarer „Versionskonflikt", Abhaken
mit Version 1 geht, Grabstein nicht, Prüfspur genau ein Nachzug; umgekehrte Reihenfolge; anderer Betrieb; erzeugter
Beleg. P5 baut den Altbestand jetzt mit kurz ruhendem Nachzug auf (sonst stellte ihn der Trigger sofort um) und prüft
die Prüfspur (P5f).

**Rücknahme.** Das lokale Rücknahmeskript stellt jetzt zuerst je Eintrag den Anleger vor dem ersten Wechsel aus der
Prüfspur wieder her und entfernt dann Trigger, Funktionen und Prüfspur — damit ist WEISS' Hinweis (frühere
`created_by`-Werte nicht wiederherstellbar) für alle Wechsel ab dieser Fassung erledigt. Probe R0–R3 grün.

## 4. Vorschau- und Vorschaubildfehler (WEISS Abschnitt 4)

**Nachgestellt** in einem frischen, sichtbaren Edge-Profil als DOK01-Inhaber (Sitzung per lokalem Admin-Magic-Link,
Kennwörter unverändert; jeder schreibende Serveraufruf im Browser abgefangen): Die echten Orchestratoren scheitern für
WEISS' Archivkopie **und** für die AP6-Rechnung mit genau WEISS' Meldungen. Einzelschritte: Bytes lesen ok,
JPEG-Kodierung ok (38 757 Byte), **eine hashgleiche Datei existiert bereits, Bytes nur in der Cloud**, Speichern wirft
`DocumentBlobStorageError: blob_read_failed` → Orchestrator `unexpected_failure`.

**Ursache (Produkt).** Vorschau- und Vorschaubild-Dateien gehen in die Cloud, ihre Bindungen nicht (lokal sind 10
solcher JPEG-Dateien ohne Bindung; eine davon hat genau 38 757 Byte, angelegt 02:49:09Z in AP6). Ein zweites Gerät
zieht die Dateizeilen ohne Bytes (FINANZ-CORE-DURABILITY-01B). Erzeugt es dieselbe Ableitung bytegleich neu (Dublette
mit „Neu speichern" oder „Erneut erstellen"), findet `storeDocumentFileFromCachedPayload` die hashgleiche Referenz,
sucht die Bytes nur lokal und im Gastbereich und bricht ab. Das trifft jedes zweite Gerät, ist unabhängig von WEISS'
Umgebung und kein DOKUMENTE-01-Rückschritt (Code vom 15.07.).

**Korrektur.** Im Treffer-Zweig: Ist die vorhandene Referenz eine reine Cloud-Referenz gleicher Größe, werden die eben
erzeugten, per Hash identischen Bytes unter ihr abgelegt und wie jeder Schreibvorgang geprüft; danach ist sie lokal
(wie nach einem Download, ohne Netz). Alle anderen Fälle werfen weiter `blob_read_failed`.

**Nachweis.**

- Test `vorschauCloudDubletteDokumente01.test.ts`, 4 Fälle: Speicher, Größen-Gegenfall, PDF-Vorschau, PDF-Vorschaubild.
- Gegenprobe in der isolierten Kopie: Gegen den alten Dateispeicher sind V1, V3 und V4 rot, mit WEISS' Meldungen.
  Gegen den neuen sind alle 4 grün.
- Browser nachher: Für Kopie und Original sind Vorschau und Vorschaubild `persisted`, ohne Konsolenfehler. Die
  Detailseite zeigt das Vorschaubild.

## 5. Die fünf endgültigen Rechteabweisungen (WEISS Abschnitt 4)

**Entitätsart: 5 × `paper_register_entry`.** Belege:

- **Serverprotokoll:** fünf Abweisungen 10:37:10Z, alle aus `upsert_workspace_sync_entity` Zeile 1834, Zweig
  `paper_register_entry`, Prüfung „fremde Zeile ändern nur Inhaber und Admin".
- **Serverbestand:** genau fünf aktive Einträge gehören dem Inhaber (`paper-reg-doc-ed292cf7…`, `…b370e7cd…`,
  `…94d044af…`, `…758956bf…`, `…65fa2410…`).
- **Nachstellung:** Nach normaler Abmeldung des Inhabers und Anmeldung des Mitglieds im selben Profil sendet die
  Mitgliedssitzung genau diese fünf Einträge (Version 1, nicht gelöscht). Die Sendungen wurden abgefangen.

**Ursache.**

1. Der lokale Bestand ist je Betrieb abgelegt (`officepilot-state:workspace:<id>`), nicht je Konto. *(Korrektur
   bei der N-Nacharbeit: Die Erstfassung nannte den Schlüssel falsch als `officetakt:workspace:<id>`.)*
2. Die Abmeldung leert nur den Arbeitsspeicher. Die nächste Anmeldung im selben Betrieb lädt den Bestand des
   Vorgängers.
3. Der Abzug des Mitglieds enthält nur seine eigenen Einträge.
4. Der Altbestand-Abgleich (`planPaperRegisterEntryBackfill`, Aufruf `workspaceProvisioningService.ts:1561`)
   vergleicht nur die Kennungen. Für ihn fehlen die fünf Inhaber-Einträge auf dem Server.
5. Er reiht sie als „create" mit Version 0 ein. Der Server weist sie zu Recht ab, der Client wertet das als
   endgültig.

**Folgen.** Kein Datenverlust, die Serverzeilen sind unverändert. Die fünf Fehler bleiben im Profil stehen. Ich habe
sie weder wiederholt noch gelöscht.

**Warum kein Code geändert wurde.** Der bestehende Test `paperRegisterCloudSyncS1.test.ts` I2 legt bewusst fest, dass
ein Eintrag mit Serverversion, der im Abzug fehlt, erneut hochgeladen wird (etwa nach Neuanlage des Arbeitsbereichs).
Der Client kann aus dem Abzug nicht unterscheiden, ob ein Eintrag fehlt oder nur für ihn unsichtbar ist. Eine
Korrektur braucht eine Entscheidung:

- **a) Datentrennung je Konto.** Lokaler Speicherbereich je Nutzer und Betrieb, oder Bereinigung bzw. Quarantäne
  beim Kontowechsel. Behebt auch N1. **Empfohlen**, als eigener Block vor der Veröffentlichung.
- **b) Rollenbewusster Abgleich.** Mitglieder gleichen nur eigene Einträge ab. Behebt nur die Abweisungen, nicht N1.

**Nebenbeobachtung.** Die Mitgliedssitzung ruft alle 1,5 min `pull_workspace_expenses`,
`pull_workspace_employee_data` und `pull_workspace_accounting_assignments` auf. Der Server antwortet jeweils
„Kein Zugriff auf Workspace". Das sind nur Lesezugriffe, die Oberfläche zeigt nichts davon. Vorbestehend.

## 6. N1 — lokaler Betriebsbestand über Konten hinweg (neu, nicht behoben)

Im selben Browserprofil zeigt das Archiv des Mitglieds nach dem Kontowechsel fünf Archivdokumente des Inhabers
(beide Baustoffe-Rechnungen, Holzhandel, Quittung 12,50 €, „Sonstiges") neben seiner eigenen Tankquittung
(`belege/nacharbeit-w/browser/rollenwechsel/b3-mitglied-archiv.png`). Die Server-Policy erlaubt einem Mitglied nur
eigene Archivdokumente. Ursache wie in Abschnitt 5, Punkte 1 und 2. Dasselbe ist bei einem Rollenwechsel
(Admin → Mitglied) auf demselben Gerät zu erwarten; das ist abgeleitet, nicht nachgestellt. Betroffen ist die
Rollentrennung auf gemeinsam genutzten Geräten. Das ist kein DOKUMENTE-01-Rückschritt, sondern eine vorbestehende
Architekturfrage. **Entscheidung des Auftraggebers** (Option a in Abschnitt 5).

## 7. N2 — Benutzermenü unter der Karte „Weiterarbeiten"

Ist die Karte „Du hast zuletzt hier gearbeitet" sichtbar, liegt sie über dem aufgeklappten Benutzermenü. Ein Klick auf
„Abmelden" trifft die Karte (Playwright: „intercepts pointer events"; Bild
`rollenwechsel/menue-verdeckt-weiterarbeiten-karte.png`). Nicht behoben (Oberfläche, nicht DOKUMENTE-01).

## 8. Prüfung (nur gezielt)

| Prüfung | Ergebnis |
|---|---|
| `supabase/tests/dokumente01_aufbewahrung.sql` (eingespielt, ohne vorangestellte Migration) | 39 Zusicherungen grün (A–H, G) |
| `supabase/tests/dokumente01_papierregister.sql` (ebenso) | 31 Zusicherungen grün (P1–P7, P6) |
| WEISS `originalbindung-gegenreproduktion.sql`, unverändert | vorher: Fehler reproduziert; nachher: scheitert beim Umhängen mit „Original eines Dokuments mit Aufbewahrungsfrist bis 31.12.2034" |
| WEISS `papierregister-reihenfolge.sql`, unverändert | vorher: reproduziert; nachher: scheitert an WEISS' Zusicherung „Papierregister trotz eigenem Dokument unsichtbar" (er ist jetzt sichtbar) |
| SQL-Mutationen M1–M11 (`sql-mutationen.mjs`) | 11/11 an der zuständigen Zusicherung erkannt, beide Kontrollen grün |
| Angrenzende SQL-Tests (Bindungen, Dateien, Papierregister) | 12/12 grün: account_block_enforcement_01, document_delivery_context_07c, document_delivery_send_hardening_07b, einvoice_binding_security_01, employee_payments_privacy_p1ma, go_live_security_01, …_completion, …_finalization, communication_events_s2, knowledge_facts_s3, paper_register_entries_s1, document_archive_guard_baf01 |
| Rücknahme-Probe R0–R3 | grün; danach zurückgerollt, alles wieder aktiv |
| Client gezielt: alle Testdateien mit `storeDocumentFileFromCachedPayload` + Cloud-Abgleich | 27/27 Dateien, 281 Tests grün, 0 übersprungen; Schutzartefakte unverändert |
| Vorschau-Gegenprobe in der isolierten Kopie | vorher 3 rot (V1, V3, V4), nachher 4/4 |
| `tsc --noEmit -p tsconfig.json` | ohne Befund |
| Browser | Vorschau vorher/nachher; Rollenwechsel zweimal nachgestellt |

Die 200 Clienttests der Erstabgabe wurden nicht erneut gefahren. Keiner ihrer Prüfgegenstände außer dem
Dateispeicher wurde geändert, und dessen direkte Nutzer sind in den 27 Dateien enthalten.

## 9. Lokale Einspielung

- **Einspielung:** 2026-10-20T11:40:59Z, beide überarbeiteten Migrationen in einer Transaktion.
- **Vorher geprüft:** Die Altbestandsumstellung hätte 0 Zeilen geändert, und sie hat 0 geändert.
- **Trigger danach:** `workspace_document_file_bindings_retention_guard` und `workspace_files_retention_guard` laufen
  jetzt `BEFORE UPDATE` ohne Einschränkung. `workspace_documents_paper_register_owner` läuft `AFTER INSERT`
  (nur Archivdokumente). Die Prüfspur hat 0 Zeilen, RLS ist an.
- **DOK01-Betrieb durch die Nacharbeit unverändert:** 8 Dokumente, 8 Einträge (Versionssumme 11), 18 Dateien,
  10 Bindungen; letzte Änderung 10:36Z aus WEISS' Sitzung.
- **Remote:** nichts.

## 10. Grenzen

- **Hartes Löschen:** Bindungen, Dateien und Dokumente können nur `service_role` oder `postgres` hart löschen. Der
  Grund: `authenticated` hat nur SELECT, und kein RPC löscht hart. Kontolöschung ist ein eigener Block (P-Liste).
- **Herkunft (`provenance`):** Sie bleibt an einer geschützten Originalbindung änderbar. Sie ist eine
  Metadatenangabe, keine Zuordnung. Wenn gewünscht, kann sie ebenfalls gesperrt werden.
- **W2 im Browser:** Die Reihenfolge „Eintrag vor Dokument" ist in der Oberfläche nicht durchgespielt. Belegt ist sie
  über die regulären RPCs (SQL). Die Konfliktbehandlung des Mitgliedsgeräts beim Version-0-Versand ist vorhandenes
  Verhalten (P3).
- **WEISS' Browserprofil:**
  - Die fünf alten Fehler bleiben dort stehen.
  - Für die Archivkopie liegt dort ein fehlgeschlagener Ableitungsschritt. Nach einem Neuladen sollte „Erneut
    erstellen" mit dem korrigierten Client gelingen; das ist nicht in WEISS' Profil geprüft.
  - Für die Wiederholung empfehle ich je Rolle ein eigenes Profil, sonst wirkt N1 hinein.
- **Alte Clients** bekommen die neuen Abweisungen als endgültig. Ein regulärer Ablauf löst sie nicht aus
  (Abschnitt 2).

## 11. Belegpfade (`belege/nacharbeit-w/`)

- `vorher/` — von WEISS geprüfte Fassungen (Prüfsummen = WEISS-Bericht) und die Vorfassungen von Tests, Rücknahme und Papierregister-Clientdienst
- `diffs/` — Änderungen je Datei (Migrationen, Tests, Rücknahme, Dateispeicher)
- `pruefsummen.txt` — SHA256 der geänderten und neuen Dateien
- `sql/` — Trockenläufe, Einspielprotokoll (`einspielen.log`, `einspielen-zeit.txt`), Läufe auf dem eingespielten Stand, `angrenzend/`
- `gegenproben/` — WEISS-Skripte vorher/nachher/eingespielt, `sql-mutationen.mjs` + `.json`, `ruecknahme-probe.sql` + Protokoll, Vorschau-Gegenprobe vorher/nachher
- `client/` — gezielter Lauf (`gezielt-1.json`, Protokoll), `tsc.log`; Läufer `werkzeuge/gezielt-lauf.mjs`; Dateiliste `client-ziele.txt`
- `browser/` — `nachstellung.mjs`, `vorschau-vorher/`, `vorschau-nachher/`, `rollenwechsel/`, Leseabfragen (`*.sql`)

## 12. Einhaltung

- Kein Commit, Push, Deployment, keine Remote-Migration, kein Remote-Zugriff.
- `ba778e8` unverändert; Gold-Berichte und Snapshot unverändert (vor und nach jedem Clientlauf gehasht).
- Beide Planer pausiert.
- WEISS-Dateien nur gelesen. Zugangsdateien nicht gelesen, Kennwörter nicht geändert. Die beiden eigenen
  Nachstellungssitzungen wurden mit `scope=local` widerrufen, die Profile gelöscht.
- Mutationen nur in Transaktionen bzw. in der isolierten Kopie.
- Die Prüf-App 5232 läuft seit 10:03Z weiter (Prozess und Konfiguration unverändert) und liefert den
  korrigierten Client aus.
