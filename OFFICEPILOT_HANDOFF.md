# OfficePilot – Handoff

Kurzer Übergabestand für den Einstieg. Alles Ausführlichere gehört in
[MASTER](OFFICEPILOT_MASTER.md), [ROADMAP](OFFICEPILOT_ROADMAP.md) oder
[DECISIONS](OFFICEPILOT_DECISIONS.md) — diese Datei soll **eine Bildschirmseite** bleiben.

---

## Stand

- **Dokumentationsstand:** 2026-08-30
- **Repository:** `C:\Users\Lenovo-ThinkPad-E590\Desktop\officepilot`
- **Branch:** `main`
- **Letzter abgeschlossener Produktblock:** `BRANDING-01E-0`

> **Der tatsächliche Git-Stand ist bei jeder Übergabe zu verifizieren:**
> `git log --oneline -1` und `git status -sb`.
> Diese Datei beschreibt den **fachlichen** Stand und nennt bewusst keinen Commit —
> welcher Commit gerade HEAD ist, sagt allein das Repository.

---

## Letzter abgeschlossener Block

**BRANDING-01E-0** — Altclient-Schutz für `company_profile.branding`, serverseitig.

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

Keiner. `BRANDING-01E-0` ist abgeschlossen, remote angewendet und bestätigt.

## Nächster geplanter Produktblock

**`BRANDING-01E-1` — CompanyProfile / Branding Cloud Contract.** Das `branding`-Feld in
den `CompanyProfile`-Typ und in den Cloud-Vertrag aufnehmen. Wichtig dabei: `branding`
muss ein abgegrenzter Unterblock bleiben — als flache Einzelfelder wäre der Schutz aus
01E-0 wirkungslos.

Danach: `01E-2` (produktiver Logo-Upload auf Storage) → `01F` (BrandingSnapshot in
Rechnung und PDF).

`01E-1`, `01E-2` und `01F` sind **noch nicht begonnen**.

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
