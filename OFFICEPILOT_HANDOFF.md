# OfficePilot – Handoff

Kurzer Übergabestand für den Einstieg. Alles Ausführlichere gehört in
[MASTER](OFFICEPILOT_MASTER.md), [ROADMAP](OFFICEPILOT_ROADMAP.md) oder
[DECISIONS](OFFICEPILOT_DECISIONS.md) — diese Datei soll **eine Bildschirmseite** bleiben.

---

## Stand

- **Dokumentationsstand:** 2026-08-30
- **Repository:** `C:\Users\Lenovo-ThinkPad-E590\Desktop\officepilot`
- **Branch:** `main`
- **Letzter abgeschlossener Produktblock:** `BRANDING-01E-1`

> **Der tatsächliche Git-Stand ist bei jeder Übergabe zu verifizieren:**
> `git log --oneline -1` und `git status -sb`.
> Diese Datei beschreibt den **fachlichen** Stand und nennt bewusst keinen Commit —
> welcher Commit gerade HEAD ist, sagt allein das Repository.

---

## Letzter abgeschlossener Block

**BRANDING-01E-1** — der CompanyProfile-/Branding-Cloud-Contract.

`CompanyProfile` trägt jetzt `branding?: BrandingProfile` und transportiert den Block
durch die bestehende Sync-Kette. Der Contract ist **geschlossen**: erlaubt sind genau
`branding.logo.assetId`, `branding.logo.mimeType` und `branding.primaryColor`. Dieselbe
Regel läuft in **beide** Richtungen — Read wie Write —, weil ein Typ kein Laufzeitschutz
ist. Sanitisiert wird feldweise: Ein kaputter Farbwert reißt keine gültige Logo-Referenz
mit, und unbekannte Unterfelder (Speicherpfad, signierte URL, Zusatzfarben) werden
verworfen statt stillschweigend mitgeführt.

Löschen ausschließlich über `branding: {}`; fehlender Schlüssel, `undefined` und `null`
bedeuten alle „bewahren" (**D-022**).

`logoDataUrl` bleibt unverändert Legacy und **rein lokal** — nicht migriert, nicht
hochgeladen, nicht gelöscht, nicht priorisiert.

**Rechnungs-Regressionsschutz:** `branding` wird an denselben zwei Grenzen aus
`companySnapshot` geschnitten wie `logoDataUrl` — sonst hätten die strengen
Invoice-Validatoren jeden Push mit `companySnapshot.branding:unknown_field` abgelehnt.

**Keine Migration nötig** — der Server behandelt `branding` seit 01E-0 vollständig.

**Prüfstand — die beiden Teile sind unterschiedlich abgesichert:**

- **CompanyProfile-Cloud-Contract: produktiv realgetestet, PASS.** Der echte
  App-/Cloud-Roundtrip hat den geschlossenen Read-/Write-Contract bestätigt (siehe
  Realtest-Abschnitt).
- **Invoice-Regressionsschutz: fokussiert automatisiert getestet.** Ein separater
  produktiver Finalisierungs-Realtest mit gesetztem Branding wurde **nicht** durchgeführt.
  Das ist **kein Blocker und kein offener Fehler** — der Schnitt an beiden
  Rechnungs-Payload-Grenzen ist durch Tests abgedeckt, inklusive der Zusicherung, dass
  beide Grenzen denselben Schnitt führen.

Davor: **BRANDING-01E-0** — Altclient-Schutz für `company_profile.branding`, serverseitig.

Der `company_profile`-UPDATE-Zweig der RPC `upsert_workspace_sync_entity` bewahrt ein
serverseitig vorhandenes `branding`-Objekt, wenn der eingehende Payload dort kein Objekt
liefert. Nur dieser eine Schlüssel, kein allgemeines Deep-Merge; alle übrigen Felder
behalten die vollständige Replace-Semantik.

Migration `20250902120000_company_profile_branding_preserve.sql` ist **remote angewendet**
und per **isoliertem Runtime-Test bestätigt** (siehe Realtest).

Davor: **SECURITY-GEMINI-KEY-01B** — der Gemini-Schlüssel liegt nicht mehr im Browser.
Browser → `aiProxyClient` → Supabase Edge Function `/functions/v1/ai` →
Sitzung, Kontostatus, Lizenz, Workspace, Rate Limit → Gemini.

---

## Remote angewendete Migrationen

Zuletzt angewendet:

- `20250902120000_company_profile_branding_preserve.sql` (BRANDING-01E-0)
- `20250901130000_ai_usage_counter_security_definer.sql`
- `20250901123000_ai_service_role_read_access.sql`
- `20250901120000_ai_usage_rate_limit.sql`

Anschließender Dry-Run: **Remote database is up to date.** — lokaler Migrationsstand und
Remote-Datenbank sind synchron.

Alle übrigen: siehe `supabase/migrations/` — die Reihenfolge im Verzeichnis entspricht
der Anwendungsreihenfolge.

**Lokal erstellt, remote noch nicht angewendet:** keine.

## Aktive Edge Functions

- `ai` (`supabase/functions/ai/`)

---

## Realtest

*Extern bestätigter Projektstand — nicht allein aus dem Repository ableitbar.*

### BRANDING-01E-1 — Branding-Cloud-Contract (echter App-Roundtrip)

Serverseitig wurde ein Branding-Testwert gesetzt, der neben einer gültigen Farbe zwei
ausdrücklich verbotene Metadatenfelder trug — `storagePath` und `signedUrl`. Danach lief
ein echter OfficePilot-App-/Cloud-Roundtrip.

Ergebnis in `workspace_company_profiles`:

- `primaryColor` (`#13579B`) blieb **erhalten**
- `storagePath` und `signedUrl` wurden beim produktiven Write **entfernt**
- der Server-Write lief regulär, `row_version` stieg wie erwartet

Damit ist der geschlossene Write-Contract nicht nur im Test, sondern **produktiv**
belegt: Unbekannte Branding-Metadaten erreichen die Cloud nicht.

Der Testwert wurde anschließend kontrolliert entfernt; das Firmenprofil steht wieder ohne
`branding`-Schlüssel — **keine Testdaten zurückgeblieben**.

*Hinweis zum Testaufbau:* Weil der Testwert direkt per SQL gesetzt wurde, stieg
`row_version` an geöffneten Browserzuständen vorbei, was zunächst Sync-Konflikte auslöste.
Das war ein Artefakt des Testaufbaus und **kein Fehler von BRANDING-01E-1**; der
anschließende erfolgreiche Cloud-Write hat den Contract bestätigt.

### BRANDING-01E-0 — Branding-Preserve (Remote-Datenbank)

Die Remote-Funktionsprüfung bestätigte Branding-Typprüfung, Branding-Preserve-Code und
weiterhin aktives `row_version`-Inkrement. Der isolierte Runtime-Test lief in einem
**ausschließlich für den Test erzeugten Workspace**; **kein echtes Firmenprofil wurde
verändert**.

Alle sieben Laufzeitfälle bestanden, kein FAIL:

1. bestehendes Branding + Incoming ohne `branding` → Branding blieb erhalten
2. `branding: {}` → als bewusst leer übernommen
3. neues gültiges Branding → übernommen
4. `branding: null` → Branding blieb erhalten
5. `branding` mit falschem Typ → Branding blieb erhalten
6. serverseitig kein Branding + Incoming ohne Branding → kein Branding erfunden
7. falsche `row_version` → Versionskonflikt weiterhin aktiv, Payload unverändert

SQL-Ergebnis: `Success. No rows returned`.

Aufräumkontrolle: Die Suche nach dem Workspace `BRANDING-01E-0 ROLLBACK TEST` lieferte
`Success. No rows returned` — **keine Testdaten zurückgeblieben**.

### SECURITY-GEMINI-KEY-01B — KI-Weg

Vollständiger Weg getestet: Browser → Edge Function → Auth/Lizenz → Workspace →
Rate Limit → Gemini → Browser.

- Testantwort: `OFFICEPILOT_AI_OK`
- Browser-Netzwerkanalyse, Filter `generativelanguage`: **0 direkte Anfragen**

---

## Aktuelle technische Risiken

1. **Der serverseitig genutzte Gemini-Schlüssel war zuvor clientseitig ausgeliefert.**
   Er gilt als kompromittiert und **muss vor dem ersten echten Kunden rotiert werden.**
2. **Alte `VITE_GEMINI_*`-Einträge** in Vercel und lokalen `.env`-Dateien müssen entfernt
   werden.
3. **Der allgemeine Lizenzschutz der App ist nicht serverseitig.** Nur der KI-Endpunkt
   prüft die Lizenz; Sync-RPCs und Storage tun es nicht (siehe ROADMAP, Bereich 15).
4. **Dokumentdateien liegen ausschließlich lokal** — auf einem zweiten Gerät fehlen sie.
5. **Kein Fehler-Monitoring und kein CI** — Produktionsfehler bleiben unbemerkt, Tests
   laufen nur lokal.

---

## Aktuell offener Block

Keiner. `BRANDING-01E-1` ist abgeschlossen: CompanyProfile-Cloud-Contract produktiv
realgetestet, Invoice-Regressionsschutz fokussiert automatisiert getestet.

## Nächster geplanter Produktblock

**`BRANDING-01E-2` — produktiver Logo-Upload.** Datei validieren → unveränderliches
Branding-Asset hochladen → `LogoAssetReference` erhalten → in
`CompanyProfile.branding.logo` speichern → synchronisieren. Dort gehört auch die
Anzeigepriorität `branding.logo` vor `logoDataUrl` hin; in 01E-1 wäre sie wirkungslos
gewesen, weil noch kein Asset entstehen kann.

Danach: `01F` (BrandingSnapshot in Rechnung und PDF).

`01E-2` und `01F` sind **noch nicht begonnen**.

---

## Nicht zu verwechselnde Altstände

- `CompanyProfile.logoDataUrl` ist der **Legacy-Weg** und weiterhin aktiv. Er verlässt
  das Gerät nie. Branding-Assets (01D) sind vorbereitet, aber **ohne produktiven
  Aufrufer**.
- `deleteVorgang` existiert vollständig, wird aber von **keiner Oberfläche** aufgerufen.
- Der `SharedPresentationContext` ist gebaut, aber **noch nicht angebunden**.

---

## Testhinweise

- **Keine Full Suite nach jedem Block.** Nur die direkt betroffenen Tests (D-007).
- `npm test` läuft gegen die Kernauswahl (`vitest.core.config.ts`);
  `npm run test:full` ist die vollständige Regression.
- Bei Codeänderungen als günstige Grundprüfung: `npx tsc --noEmit` und `git diff --check`.
- Realgerätetests nur bei relevantem Risiko.
- **Bekannter Altfehler:** `src/services/workspace/cloudData01.test.ts` erwartet eine
  Allowlist-Größe von 6, tatsächlich sind es 7 (seit der Customer-Cloud-Anbindung).
  Nicht beiläufig reparieren.
- **Bekannte Altfehler bei Rechnungsrouten:** `src/companySession01.test.ts` und
  `src/handwerkKnowledge01.test.ts` erwarten Routen ohne `?type=`.
- Tests werden nicht durch Git-Schreibvorgänge des Agenten abgeschlossen (D-008).
