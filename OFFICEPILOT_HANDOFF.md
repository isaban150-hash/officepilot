# OfficePilot – Handoff

Kurzer Übergabestand für den Einstieg. Alles Ausführlichere gehört in
[MASTER](OFFICEPILOT_MASTER.md), [ROADMAP](OFFICEPILOT_ROADMAP.md) oder
[DECISIONS](OFFICEPILOT_DECISIONS.md) — diese Datei soll **eine Bildschirmseite** bleiben.

---

## Stand

- **Dokumentationsstand:** 2026-08-30
- **Repository:** `C:\Users\Lenovo-ThinkPad-E590\Desktop\officepilot`
- **Branch:** `main`
- **Letzter abgeschlossener technischer Commit:** `1a297c7` —
  *feat(ai): secure Gemini behind edge function*
- **Zustand bei Beginn von MASTER-DOCS-01B:** `main` und `origin/main` synchron,
  Arbeitsbaum sauber

> **Vor jeder Übergabe den echten Git-Stand prüfen:**
> `git log -1` und `git status -sb`.
> Der hier notierte Commit ist der letzte abgeschlossene **Produktblock**, nicht
> zwingend der neueste Commit — Dokumentationsänderungen kommen danach.

---

## Letzter abgeschlossener Block

**SECURITY-GEMINI-KEY-01B** — der Gemini-Schlüssel liegt nicht mehr im Browser.

Browser → `aiProxyClient` → Supabase Edge Function `/functions/v1/ai` →
Sitzung, Kontostatus, Lizenz, Workspace, Rate Limit → Gemini.
Fünf erlaubte Operationen, Modell serverseitig bestimmt, kein Retry, Zeitlimit,
fail closed bei technischen Fehlern.

---

## Remote angewendete Migrationen

Zuletzt angewendet (KI-Block):

- `20250901120000_ai_usage_rate_limit.sql`
- `20250901123000_ai_service_role_read_access.sql`
- `20250901130000_ai_usage_counter_security_definer.sql`

Alle übrigen: siehe `supabase/migrations/` — die Reihenfolge im Verzeichnis entspricht
der Anwendungsreihenfolge.

## Aktive Edge Functions

- `ai` (`supabase/functions/ai/`)

---

## Realtest

*Extern bestätigter Projektstand — nicht allein aus dem Repository ableitbar.*

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

`MASTER-DOCS-01B` — Erstellung dieser Master-Dokumentation.

## Nächster technischer Produktblock

**`BRANDING-01E-0`** — den Schreibvertrag von `company_profile` so härten, dass ein
älterer Client einen neuen `branding`-Block nicht löschen kann.

Danach: `01E-1` (Branding im Cloud-Vertrag) → `01E-2` (produktiver Logo-Upload auf
Storage) → `01F` (BrandingSnapshot in Rechnung und PDF).

`BRANDING-01E` ist **noch nicht begonnen**.

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
