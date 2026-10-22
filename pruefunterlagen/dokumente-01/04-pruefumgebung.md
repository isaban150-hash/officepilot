# DOKUMENTE-01 — Prüfumgebung

Stand 21.10.2026 (Restkorrektur `08-restkorrektur-r1-start-loeschung.md`) · SCHWARZ · nur lokal, nichts remote. Die
Prüf-App für die WEISS-Abnahme läuft seit
2026-10-20T10:03:33Z auf Port 5232 (Abschnitt 4). Sie liefert seit der Nacharbeit den korrigierten Client aus (kein
Neustart nötig; Vite lädt geänderte Module beim nächsten Seitenaufruf). Das gilt auch für die N-Nacharbeit
(Kontotrennung N1, Abmeldemenü N2, `06-nacharbeit-n1-n2.md`); vor der Browserprüfung am Ausliefern der geänderten
Module geprüft. Ein Browserprofil aus der Zeit davor wird beim ersten Laden umgestellt (`06`, Abschnitt 7).

## 1. Code und Datenbank

- Repository `officepilot`, Branch `sicherung/finanz-core-01a`, HEAD `ba778e8` (Finanz-Commit, unverändert).
  DOKUMENTE-01 liegt **uncommittet** im Arbeitsbaum (Dateiliste: `02-abschlussbericht.md`, Abschnitt 7).
- Lokale Supabase (Docker, nur Loopback: 127.0.0.1/::1, Ports 54321/54322).
- Die Migrationen `20261125120000_dokumente01_aufbewahrung.sql` und `20261126120000_dokumente01_papierregister.sql`
  sind lokal eingespielt: zuerst 2026-10-20T02:23:58Z, in der überarbeiteten Fassung der Nacharbeit (W1/W2,
  `05-nacharbeit-weiss.md`) erneut **2026-10-20T11:40:59Z**, jeweils per psql in **einer** Transaktion nach
  Trockenlauf (die lokale Migrationshistorie wird wie seit 20261023 nicht geführt). Die Altbestandsumstellung hat
  beide Male 0 Zeilen geändert. Neu seit der Nacharbeit: Trigger `workspace_documents_paper_register_owner`
  (`AFTER INSERT`) und die interne Prüfspur `workspace_paper_register_owner_changes`.
- Rücknahme (nur lokal): `lokal/ruecknahme-20261125-20261126-lokal.sql`. Sie stellt zuerst die früheren Anleger der
  Papierregister-Einträge aus der Prüfspur wieder her und entfernt dann alle Trigger, Funktionen und die Prüfspur.
  Probe: `belege/nacharbeit-w/gegenproben/ruecknahme-probe.sql`.
- Remote: nichts angewendet. Planer (lokal pg_cron 1 `officetakt-mailbox-auto-sync`, 2
  `officetakt-mailbox-oauth-state-purge`) weiter `active = false`.

## 2. Tests

Client (Vitest, immer `vitest.safe.config.ts`; nie `InvoiceDocumentView.test.tsx`):

```
node node_modules/vitest/vitest.mjs run --config vitest.safe.config.ts \
  src/services/document/documentRetention.test.ts \
  src/services/document/documentRetentionDeleteDokumente01.test.ts \
  src/pages/dokumentDetailAufbewahrungDokumente01.test.tsx \
  src/services/inboxCompanyDocumentKindDokumente01.test.tsx \
  src/services/document/archivedMeaningTextDokumente01.test.ts \
  src/services/document/documentSemanticCoreUstWortgrenzeDokumente01.test.ts \
  src/services/document/vorschauCloudDubletteDokumente01.test.ts
```

Gezielter Lauf der Nacharbeit (27 Dateien, Schutzartefakte vor/nach gehasht):
`node pruefunterlagen/dokumente-01/belege/nacharbeit-w/werkzeuge/gezielt-lauf.mjs <ausgabe.json> pruefunterlagen/dokumente-01/belege/nacharbeit-w/client-ziele.txt`.

N-Nacharbeit, mit demselben Läufer:

- die drei neuen Testdateien: `pruefunterlagen/dokumente-01/belege/nacharbeit-n/client-ziele-neu.txt`;
- gezielt und angrenzend, 64 Dateien: `…/nacharbeit-n/client-ziele-n.txt`.

Die Dateiliste besteht aus den neuen Tests, den angrenzenden Gate- und Bootstrap-Tests und allen Testdateien, die
ein geändertes Speicher-, Bootstrap- oder Gate-Modul direkt importieren.

R-Nacharbeit (`07-nacharbeit-r1-r2.md`), Läufer `belege/nacharbeit-r/werkzeuge/portionen.cjs` (Portionen zu 30,
sichere Konfiguration, 2 Worker, JSON-Bericht je Portion):

- die drei neuen Testdateien: `belege/nacharbeit-r/tests/ziele-neu.txt`;
- angrenzend, 90 Dateien (alle Tests, die einen Sync-Lauf, das Laden oder Übernehmen eines Bestands, die
  Sync-Anzeige oder die genannten Finanzverträge berühren): `belege/nacharbeit-r/tests/ziele-angrenzend.txt`;
- Aufruf: `node belege/nacharbeit-r/werkzeuge/portionen.cjs <liste> <ausgabeordner> 30` aus dem Repo.

Restkorrektur (`08-restkorrektur-r1-start-loeschung.md`), derselbe Läufer (Kopie in `belege/nacharbeit-r2/werkzeuge/`):

- die vier neuen bzw. angepassten Testdateien: `belege/nacharbeit-r2/tests/ziele-neu.txt` (44 Tests);
- angrenzend, 80 Dateien: `belege/nacharbeit-r2/tests/ziele-angrenzend.txt`. Aufgenommen ist jede Testdatei, die
  Laufidentität, Adapter, Koordinator, Synchronisationsseite oder Löschdienst direkt importiert, `identityChanged`
  prüft oder den Löschweg bedient.
- Gegenproben: `node belege/nacharbeit-r2/werkzeuge/mutationen.cjs <isolierte Kopie> <ausgabeordner> [S1,D2,…]`. Das
  Werkzeug verweigert jeden anderen Pfad als die isolierte Kopie
  (`Documents/OfficeTakt-Sicherungen/DOK01-GEGENPROBEN-20261020T021008Z/repo`, vorher mit `robocopy src … /E`
  abgleichen).
- WEISS-Proben: als bytegleiche Kopien außerhalb des WEISS-Ordners, in derselben Ordnerstruktur.
  - Die Startprobe lädt `./originalproben/WEISS-DOK01-N1N2-2026-10-20/probe/adapter-bundle.mjs`. Diese Datei entsteht,
    wenn I1 (`originalproben/dok01-n1n2-sendekonto.mjs`) in der Kopie läuft.
  - I2/I4 im Ordner `originalproben` starten; sie schreiben relativ zum Arbeitsverzeichnis.
  - Varianten zu I2/I4: `belege/nacharbeit-r2/weiss-proben/varianten/`.

Breite UI-Läufe sind lastempfindlich (Zeitüberschreitungen unter Volllast): mit `--maxWorkers=2` laufen lassen,
rote Dateien einzeln wiederholen.

SQL (nur lokal; mit eingespielter Migration direkt, sonst Migration in derselben Transaktion voranstellen):

```
docker exec -i supabase_db_officepilot psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/dokumente01_aufbewahrung.sql
docker exec -i supabase_db_officepilot psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/dokumente01_papierregister.sql
```

Ohne Docker (WEISS-Umgebung): wie bisher über `POST http://127.0.0.1:54321/pg/query` mit dem lokalen Dienstschlüssel;
psql-Steuerzeilen (`\set`, `\pset`) vorher entfernen.

Gesamter SQL-Vergleich (alle nicht parallelen Tests ohne und mit beiden Migrationen):
`belege/gegenproben/sql-regression.mjs` (Aufruf aus dem Repo). Erwartung: 0 Befunde; drei Tests sind lokal
datenabhängig rot, in beiden Modi gleich (`inbound_email_07e`, `mailbox_auto_sync_07eauto`,
`document_delivery_bulk_list_b6` — Letzterer zählt Zustellungen global).

## 3. Browser (AP6)

- Eigener Vite-Server Port 5232 mit Prozess-Env: `VITE_SUPABASE_URL=http://127.0.0.1:54321`, lokaler Demo-anon-Schlüssel,
  `VITE_GEMINI_API_KEY=""`, `VITE_MAIL_PROVIDER=stub` (geprüft: ausgelieferte Umgebung ohne Gemini-Schlüssel und ohne
  `supabase.co`). WEISS-/T8-Dienste (5203–5229, 54396/54397/54399) wurden nicht angefasst. Der AP6-Prüfserver
  wurde nach der Prüfung beendet; für die WEISS-Abnahme läuft die Prüf-App jetzt über `werkzeug/` (Abschnitt 4).
- Edge über playwright-core, je Gerät ein frisches Profil; `/functions/v1/ai` und `generativelanguage.googleapis.com`
  per Route abgewiesen.
- Synthetische lokale Nutzer `dok01-inhaber-…@example.invalid` und `dok01-mitglied-…@example.invalid` (GoTrue-Admin,
  Kennwort je Lauf nur im Speicher). Testbetrieb „DOK01 Testbetrieb GmbH".
- Testdaten: frei erfundene PDFs (Rechnungen „Holzhandel Beispiel GmbH", „Baustoffe Beispiel KG", Quittungen,
  Verbandsschreiben); dauerhaft im lokalen Testbetrieb: 4 Archivdokumente des Inhabers, 1 des Mitglieds,
  1 gelöschtes Schreiben (Grabstein), 1 Ausgabe.
- Isolierte Kopie für Client-Gegenproben: `Documents\OfficeTakt-Sicherungen\DOK01-GEGENPROBEN-20261020T021008Z\repo`
  (node_modules als Verknüpfung, `.env.local` nur mit unerreichbaren Platzhaltern — keine echten Schlüssel).

## 4. Prüf-App für die WEISS-Abnahme (Port 5232)

Läuft seit 2026-10-20T10:03:33Z (Starter-PID und Vite-PID in `werkzeug/laufzeit/dienst.json`).

| | |
|---|---|
| Adresse | `http://localhost:5232` (ebenso `http://127.0.0.1:5232` und `http://[::1]:5232`) |
| Supabase-Ziel | nur die lokale Supabase `http://127.0.0.1:54321` mit dem lokalen Demo-anon-Schlüssel (iss `supabase-demo`, kein Projekt-ref) |
| KI | nicht erreichbar: Der Client ruft KI nur über `<VITE_SUPABASE_URL>/functions/v1/ai` auf (den Gemini-Schlüssel liest er seit SECURITY-GEMINI-KEY-01B nicht mehr); lokal gibt es keinen Edge-Runtime-Container, das Gateway antwortet mit 503 „name resolution failed“. `VITE_GEMINI_API_KEY` ist zusätzlich leer |
| Mail | Stub (`VITE_MAIL_PROVIDER=stub`); auch `send-document`/`send-email` sind lokale Edge-Funktionen und damit nicht erreichbar |
| Kennzeichen | `VITE_PRUEFUMGEBUNG=DOKUMENTE-01` |
| .env-Dateien | keine (envDir = leerer Ordner `werkzeug/leer-env`; `.env.local` wird nicht geladen, geerbte `VITE_*` entfernt) |
| HMR | aus; eigener Vite-Cache `%TEMP%\officetakt-dok01-vite-cache` |

Werkzeuge in `werkzeug/`:

- `dok01-pruefapp.mjs` ist der Starter. Er liest den lokalen Demo-anon-Schlüssel aus der Konfiguration des lokalen
  Kong-Containers (oder aus `--schluessel <datei>`), prüft die lokale Supabase und bricht ohne Änderung ab, wenn
  Port 5232 auf 127.0.0.1 oder ::1 belegt ist. Danach startet er Vite (bis zu 5 Neustarts) und leitet `[::1]:5232` auf
  `127.0.0.1:5232` weiter. Protokolle: `laufzeit/dienst.log`, `laufzeit/vite-5232.log`, `laufzeit/starter-konsole.log`.
- `vite.dok01.config.mjs` übernimmt die Repository-Konfiguration unverändert; anders sind nur envDir, cacheDir,
  Host/Port, `strictPort` und `hmr: false`.
- `dok01-zugaenge.mjs` stellt die synthetischen Zugänge bereit (unten).

Start (über WMI, damit der Dienst die Sitzung überdauert; die Konsolenumleitung ist nötig, ohne sie beendet sich
Node still). So wurde der laufende Dienst gestartet:

```powershell
$w = 'C:\Users\Lenovo-ThinkPad-E590\Desktop\officepilot\pruefunterlagen\dokumente-01\werkzeug'
$zeile = 'cmd.exe /d /c ""C:\Program Files\nodejs\node.exe" "' + $w + '\dok01-pruefapp.mjs" > "' + $w + '\laufzeit\starter-konsole.log" 2>&1"'
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $zeile; CurrentDirectory = 'C:\Users\Lenovo-ThinkPad-E590\Desktop\officepilot' }
```

Beenden (Starter und Vite zusammen; nicht Vite allein beenden, sonst startet der Starter es nach 3 s neu; der
cmd-Mantel endet von selbst):

```powershell
$d = Get-Content -Raw -Encoding utf8 'C:\Users\Lenovo-ThinkPad-E590\Desktop\officepilot\pruefunterlagen\dokumente-01\werkzeug\laufzeit\dienst.json' | ConvertFrom-Json
taskkill /PID $d.pid /T /F
Get-NetTCPConnection -LocalPort 5232 -State Listen -ErrorAction SilentlyContinue   # leer = beendet
```

### Zugänge (synthetisch, nur lokal)

| Rolle | Konto | Zugangsdatei (nur für WEISS) |
|---|---|---|
| Inhaber (`owner`) | `dok01-inhaber-…@example.invalid` | `C:\Users\Lenovo-ThinkPad-E590\AppData\Local\Temp\officetakt-weiss-recheck\ZUGANG-DOK01\inhaber.json` |
| Mitarbeiter (`member`, im Betrieb des Inhabers) | `dok01-mitglied-…@example.invalid` | `C:\Users\Lenovo-ThinkPad-E590\AppData\Local\Temp\officetakt-weiss-recheck\ZUGANG-DOK01\mitglied.json` |

- Betrieb „DOK01 Testbetrieb GmbH“ mit den AP6-Testdaten (Abschnitt 3). Keine echten Konten, keine
  Produktionszugänge; die Konten gibt es nur in der lokalen Supabase.
- Bereitgestellt am 2026-10-20T10:04Z durch SCHWARZ mit
  `node pruefunterlagen/dokumente-01/werkzeug/dok01-zugaenge.mjs --schluessel <lokale Demo-Schlüsseldatei>`. Das
  Werkzeug nimmt nur Konten nach dem Muster `dok01-<rolle>-…@example.invalid` (genau eines je Rolle), setzt je Konto
  ein neues Zufallskennwort per GoTrue-Admin, meldet sich damit an, prüft über `ensure_personal_workspace` Rolle und
  Betrieb und schreibt dann die Zugangsdatei (Felder `rolle`, `email`, `passwort`, `app`, `betrieb`, `hinweis`,
  `erstellt`). Ausgegeben werden nur Rolle und Ergebnis.
- SCHWARZ hat die Zugangsdateien nicht gelesen. Die Rechte sind vom Ordner geerbt, die Codex-SID hat Ändern-Recht.
- Ein erneuter Aufruf setzt neue Kennwörter: Die Dateien werden überschrieben, die alten Kennwörter gelten nicht mehr.

### Prüfstand bei Bereitstellung (20.10.2026)

- `127.0.0.1`, `[::1]` und `localhost` antworten mit HTTP 200. Die ausgelieferte Umgebung enthält nur
  `VITE_SUPABASE_URL` (lokal), `VITE_SUPABASE_ANON_KEY` (Demo), `VITE_GEMINI_API_KEY` (leer), `VITE_MAIL_PROVIDER`
  (`stub`) und `VITE_PRUEFUMGEBUNG`; `supabase.co` kommt nicht vor.
- Anmeldeseite ohne Anmeldung in einem frischen, kopflosen Edge: erscheint auf `localhost` und `127.0.0.1` mit
  E-Mail- und Kennwortfeld. Angefragt werden nur `localhost:5232`/`127.0.0.1:5232` und die Google-Schriften der
  Seite (`fonts.googleapis.com`, `fonts.gstatic.com`).
- Konsolenmeldung „404 … favicon.ico“: gab es schon vorher, das Repository hat kein Favicon (kein Verweis in
  `index.html`, kein Ordner `public/`). Nicht Teil von DOKUMENTE-01.
- Anmeldung beider Konten auf API-Ebene geprüft: Inhaber `owner`, Mitglied `member` im Betrieb des Inhabers.
- Andere Dienste (5203/5204/5213/5220/5222–5229, 54396/54397/54399) unberührt; Planer weiter pausiert.

### Stand nach der R-Nacharbeit (20.10.2026)

- Die Prüf-App liefert den R-Stand aus (ohne HMR; ein Neuladen genügt). Sie lief durchgehend weiter.
- Browserprofile aus früheren Phasen: Beim nächsten Laden werden offene Aufträge ohne Ursprungsangabe zurückgehalten
  (`07`, Abschnitt 7) und erscheinen auf der Synchronisationsseite unter „Zurückgehaltene Aufträge“.
- Browserprüfung R1/R2: `belege/nacharbeit-r/browser/abnahme-r.mjs` (eigene, danach gelöschte Profile; Sitzungen per
  Magic-Link nur im Speicher, am Ende mit `scope=local` widerrufen; Pfade `HIER` und Schlüsseldatei vor dem Aufruf
  anpassen).

### Stand nach der Restkorrektur (21.10.2026)

**Auslieferung**
- Die Prüf-App liefert den neuen Stand aus. Per GET geprüft für die sieben geänderten Module mit Laufzeitcode.
- Ein Neuladen genügt. Die App lief durchgehend weiter.

**Neues Verhalten**
- Ein Synchronisationslauf im Kontobereich ohne nachweisbare Anmeldung hält beim Start an. Das betrifft: Sitzung nicht
  lesbar, keine Sitzung, Token ohne Konto.
  - Die Synchronisationsseite zeigt dann „Synchronisation angehalten: …“, der Status lautet „Fehler“.
  - Nach erneuter Anmeldung setzt der nächste Lauf fort.
- Eine direkte Dokumentlöschung bricht ab, wenn während ihrer Rückfragen das Konto, der Betrieb oder die Sicht
  wechselt. Hinweis: „Löschen abgebrochen: Inzwischen ist ein anderes Konto oder ein anderer Betrieb aktiv. Es wurde
  nichts gelöscht.“
- Ohne bestätigte Anmeldung löscht der Dienst Rechnungsdokumente nicht. Hinweis: „Löschen abgebrochen: Ihre Anmeldung
  ließ sich nicht bestätigen. …“

**Unverändert**
- Bestände, Warteschlangen, Server und lokale Datenbank. Keine Migration.
