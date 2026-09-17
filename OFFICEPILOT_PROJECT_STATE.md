# OfficePilot — Projektstatus (gemeinsame Übergabe)

Kompakte Übergabedatei zwischen Claude Code, ChatGPT und dem Nutzer.
Keine Projektdokumentation, keine Historie — nur der aktuelle Stand.

Stand: 2026-09-17

---

## 1. Produkt

- OfficePilot ist ein digitaler Büroassistent für kleine Handwerksbetriebe.
- Er nimmt Belege und Dokumente auf (Foto, PDF, Galerie, Scan), ordnet sie
  automatisch zu, führt Aufträge, Rechnungen, Ausgaben und Kunden und
  bereitet die Monatsmappe für den Steuerberater vor.
- Aktuelles Produktziel: ein hochwertiges, ruhiges B2B-Werkzeug, das auf dem
  Desktop und auf dem Handy jeweils eigenständig gut bedienbar ist und dessen
  Startseite „Heute“ den Tagesbetrieb auf einen Blick zeigt.

## 2. Aktueller Git-Stand

- Branch: `main`
- Letzter bestätigter Commit (HEAD): `0086cdc` — feat(expenses): harden cancellation and editing flows (V1-A)
- origin/main: identisch mit lokalem `main` (`0086cdc`), nichts ausstehend
- Arbeitskopie: OFFICEPILOT-V1-B1 (E-Mail-Safety-Prep) ist implementiert, aber **noch nicht committet**
  (siehe Abschnitt 3)

## 3. Aktiver Arbeitsblock

- Ausgangspunkt: OFFICEPILOT-V1-GAP-AUDIT-01A (Analyse) → V1-A Ausgaben-Härtung (committet `0086cdc`)
  → OFFICEPILOT-V1-B E-Mail-Versand/Brevo-Staging-Audit (Analyse, abgeschlossen, ohne Commit).
  Audit-Ergebnis: Rechnungs- und Korrekturversand serverseitig sauber (Edge Function `send-document`,
  Anhangprüfung, Idempotenz, Rechnungskopplung); **normaler Dokumentversand (letter/offer/other)
  existiert nicht** (RPC lehnt ab, kein UI-Einstieg) — offene Lücke; `unknown` war ohne Auflösung.
- Block: OFFICEPILOT-V1-B1 — E-Mail-Safety-Prep — **uncommittet, implementiert**
  - `unknown` (Handoff ungewiss) ist kein Retry-Zustand mehr: Contract `isDeliveryRetryable` ohne
    `unknown`, Panel bietet bei irgendeinem `unknown`-Versuch nur „Status prüfen“ (kein Senden/Retry),
    zweite Sperre im Sende-Handler; serverseitig lehnt `create_workspace_document_delivery` (additive
    Migration `20260918120000`) retry_of auf `unknown` ab → Client-Fehler `uncertain_pending`;
    Hinweistext nennt die mögliche Doppelzustellung (de/tr/bg). Technische Fehlerdetails (RPC-/Storage-
    Rohtext) erscheinen nicht mehr im Dialogtext.
    failed/rejected → „Erneut versuchen“, bounced → neuer Versand: unverändert.
  - `.env.example`: MAIL_PROVIDER (stub|brevo, fail-closed), BREVO_API_KEY (nur Server-Secret),
    VITE_MAIL_PROVIDER (nur „stub“ schaltet um, sonst implizit brevo), VITE_APP_ENVIRONMENT.
  - `supabase/config.toml`: expliziter Eintrag `[functions.send-document]` mit `verify_jwt = true`.
  - STAGING-Banner (`StagingBanner`), nur bei `VITE_APP_ENVIRONMENT=staging`.
  - Tests: Delivery-/Send-Tests, Contract, Panel-UI (neu U1/U2), StagingBanner, deployFoundation: grün; tsc grün.
- **Brevo-Live-Test: noch nicht ausgeführt.** Kein echter Provider-Aufruf bisher; Staging-Supabase,
  Brevo-Konto mit authentifizierter Absenderdomain (`rechnung@send.officepilot.de`) und Staging-Frontend
  müssen vorher manuell eingerichtet werden (siehe V1-B-Audit, Live-Testplan Tests 1/2/4/5).
- Nächster Schritt: Commit durch den Nutzer; danach Staging-Aufbau und V1-B Live-Test.

## 4. Abgeschlossene wichtige Blöcke

| Block | Commit | Inhalt |
| --- | --- | --- |
| Navy Trust UI (UIUX-FOUNDATION-01A–01H) | `d0f210a`, `44ebf71` | Design-Tokens, Primitives, App-Shell, alle Bereiche auf Navy Trust |
| WebKit Input Hardening (MANUAL-INVOICE-IOS-NUMERIC-INPUT-01B) | `c37b7d8` | E2E-Helfer `fillVerified` gegen verlorene Eingaben in WebKit |
| Delivery SHA256 (DELIVERY-SHA256-GUARD-01A) | `7e2b0a8` | sicherer Digest mit Fallback für den Dokumentversand |
| Document Kind Catalog (DOCUMENT-KIND-CATALOG-01A) | `8e6dc88` | Rechnungskorrektur als klassifizierte Dokumentart |
| Steuerberater Monatsmappe (REAL-PRODUCT-TEST-01B) | `13e6510` | Monatsübersicht aus dem Monatsmappen-Modell, Status leer/offen/vollständig |
| Generated Invoice Document Explanation (REAL-PRODUCT-TEST-01C) | `ad65461` | eigene Ausgangsrechnung in der Dokumentansicht erklärt |
| Real Product Test Hardening (REAL-PRODUCT-TEST-01D) | `6cb1611` | Sync-Status, Aufgaben heute/überfällig, Scroll-Wiederherstellung, Aufträge-Hauptaktion, Rechnungsidentifikation, Kunden-Unterscheidung |
| Visual Polish Analyse (VISUAL-POLISH-01A) | ohne Commit (Analyse) | Zielbilder und Drei-Block-Plan A/B/C |
| Visual Polish Block A (VISUAL-POLISH-01B) | `0886002` | Heute + Shell/Header/Suche + Kennzahlen/Prioritäten + kompakter Wiederaufnahme-Hinweis |
| Visual Polish Block B (VISUAL-POLISH-01C) | `990a2d2` | Listen als Zeilen, Kennzahlenflächen (Rechnungen/Finanzen/Ausgaben), Dokumentdetail nach fünf Fragen, Rechnungs-/Auftrags-/Kundendetail zweispaltig |
| Visual Polish Block C (VISUAL-POLISH-01D) | `04441e1` | Sekundärbereiche: Finanzen, Steuerberater, Einstellungen, Assistent, Wissen, Sync, Mehr |
| Product Acceptance Fix D1 (PRODUCT-ACCEPTANCE-FIX-01B) | `eddb70d` | Kernabläufe vervollständigt, u. a. „Als Ausgabe speichern“ aus dem Eingang (F-15) |
| Product Acceptance Fix D2 (PRODUCT-ACCEPTANCE-FIX-01C) | `65542e8` | Assistent ohne Rohschlüssel, Tankbeleg keine Materialrechnung, Kommunikation ohne Sackgasse, Wissen einfach anlegen |
| V1-Gap-Audit (OFFICEPILOT-V1-GAP-AUDIT-01A) | ohne Commit (Analyse) | V1-Matrix A/B/C/D, Restlücken, Rest-Roadmap V1-A…V1-E |
| V1-A Ausgaben-Härtung (OFFICEPILOT-V1-A) | `0086cdc` | Ausgaben-Storno mit Grund, sichere Bearbeitung vor/nach Zahlung, Detail mit Status und nächster Aktion |
| V1-B E-Mail-/Brevo-Staging-Audit | ohne Commit (Analyse) | Versandarchitektur, Brevo-Pfad, Sicherheit, Staging-Voraussetzungen, Live-Testplan; Dokumentversand fehlt |
| V1-B1 E-Mail-Safety-Prep | noch nicht committet | unknown-Retry-Sperre, Env-Doku, send-document config, STAGING-Banner |

## 5. Verbindliche Produkt-/Designregeln

- Navy Trust: Navy `#1f3c88` als Führungsfarbe, Teal als Zweitfarbe, Tokens aus
  `src/styles/tokens.css`; keine Verläufe, kein Glow, kein „KI-Lila“, keine Emojis.
- Anmutung: hochwertiger B2B-Büroassistent, ruhig und verlässlich.
- Keine Kartenwand: keine Karte in der Karte, Flächen mit 1px Rand und ~12px
  Radius, Listen statt Kachelstapel.
- Keine technischen Entwicklerbegriffe in der Nutzeroberfläche (kein „Sync-Queue“,
  „Outbox“, „Snapshot“, „Draft-ID“ usw.); Sprache des Handwerksbetriebs.
- Eine dominante Hauptaktion pro Seite; auf dem Desktop keine Vollbreiten-Buttons.
- Desktop und Mobile eigenständig gestalten: Desktop zweispaltig und dicht,
  Mobile mit eigener Reihenfolge — kein gestapelter Desktop.
- Typografie-Stufen 28/22/16/14/12.
- Sichtbarer Visual-Polish muss im Browser erkennbar sein — ein Block gilt
  nur als fertig, wenn der Unterschied auf den ersten Blick zu sehen ist.

## 6. Verbindliche Entwicklungsregeln

- Nur ein implementierender Agent gleichzeitig im Repository.
- Agenten committen und pushen nicht selbst; keine Git-Schreibbefehle
  (kein add/restore/checkout/reset/stash/clean). Der Nutzer macht Commit und Push.
- Einen Fachbereich vollständig fertigstellen, dann committen — keine
  halbfertigen Zwischenstände.
- Keine breite Testspirale: während der Implementierung gezielte Tests
  (betroffene Vitest-Dateien + `tsc`), größere Regression nur an echten Gates.
- Volle Vitest-Suite nie parallel zu Playwright (Gold-Pipeline-Test schreibt
  geschützte Berichte).
- Nach größeren UI-/Funktionsblöcken Browser-Selbstabnahme mit Playwright
  (lokale Docker-Supabase, synthetische Nutzer, Screenshots außerhalb des Repos).
- Danach unabhängiger Produkttest mit ChatGPT Work auf dem committeten Stand.
- Desktop + Android (Galaxy S24) + iOS (WebKit) berücksichtigen, sobald mobil relevant.
- Nur lokale Supabase (`http://127.0.0.1:54321`), nie `--linked`/Produktion.
- Passwörter werden nie gelesen, gespeichert oder protokolliert; der Agent
  trägt nur die E-Mail ein, der Nutzer tippt das Passwort.

## 7. Geschützte Artefakte

Diese drei Dateien sind **geschützt**. Sie erscheinen als `M` im Arbeitsbaum und
gelten als bekannt:

- `src/components/invoice/__snapshots__/InvoiceDocumentView.test.tsx.snap`
- `test-world/reports/gold-pipeline-04b.json`
- `test-world/reports/gold-pipeline-04b.md`

Regel: nicht automatisch stagen, nicht restoren, nicht löschen, nicht
committen. Nur der Nutzer entscheidet ausdrücklich darüber.

## 8. Offene Roadmap (Weg zur ersten verkaufbaren Version)

V1-A Ausgaben-Härtung — committet (`0086cdc`)
V1-B Versand live: Audit erledigt, V1-B1 Safety-Prep implementiert (Commit offen); offen: Staging-Aufbau (Supabase,
     Brevo-Domain-Authentifizierung, Staging-Frontend) und Live-Test Rechnung/Korrektur/Fehler/Retry — noch nicht ausgeführt.
     Dokumentversand letter/offer/other ist nicht vorhanden (eigener Block nach dem Live-Test).
V1-C Mehrgerät ehrlich: Aufgaben in die Cloud-Allowlist oder sichtbar „nur dieses Gerät“; Konflikthinweise abnehmen
V1-D Navigation/Betrieb: technische Seiten (`/mail-import`, `/papierarchiv`, `/synchronisation`, `/admin/users`)
     aus der Kern-Navigation, Aufträge-Statuswechsel abnehmen, optional „Auftrag ohne Dokument“
V1-E Pilot-Belegtest: 20–30 echte Belege eines Betriebs durch Eingang → Ausgabe → Monatsmappe; Fehlerliste, dann Freigabe

Nach V1: Mahnwesen, DATEV/Kontenrahmen, XRechnung/ZUGFeRD, Kontaktpersonen, Mail-Import, Konfliktdialoge, native Apps.

## 9. Aktuelles visuelles Ziel (freigegebenes Zielbild aus VISUAL-POLISH-01A)

- „Heute“ ist die Referenzseite für alle weiteren Bereiche.
- Desktop ≥ 1024 px zweispaltig (≈ 7/5): links „Heute wichtig“ als eine
  ruhige Prioritätenfläche, „Offene Arbeit“ als Zeilenliste, kompakter
  Assistent-Eingang; rechts „Ihr Betrieb heute“ mit vier Kennzahlen,
  Steuerberater-Zeile und „Schnell erledigen“ als Symbolaktionen.
- Kompakter Kopf: Begrüßung, Datum/Betrieb, Suche im Header (kein zweiter
  Suchbalken), eine Hauptaktion „Dokument hinzufügen“ in normaler Breite.
- Keine Kartenwand, keine Mehr-Karte, keine große Assistentenkarte, keine
  graue Kachelleiste, keine Erledigt/Weitere-Buttonpaare.
- Mobile eigene Anordnung: Kopf → max. drei Prioritäten + „Alle anzeigen“ →
  horizontal scrollbare Kennzahlen → Offene Arbeit → Schnell erledigen →
  kompakter Assistent → Bottom-Navigation; kein horizontaler Überlauf.
- Wiederaufnahme-Hinweis („Zuletzt hier gearbeitet“) kompakt in einer Zeile.
- Sichtbarer Qualitätsunterschied ist Pflicht.

## 10. Update-Regel

Diese Datei wird nur aktualisiert:

- nach einem abgeschlossenen größeren Arbeitsblock
- nach einem Commit, der den Projektstand relevant verändert
- wenn sich Roadmap oder verbindliche Regeln ändern

Nicht nach jeder kleinen Änderung.

Bei jeder Aktualisierung:

- alten Stand ersetzen statt endlos anhängen
- HEAD aktualisieren
- aktiven Block aktualisieren
- abgeschlossene Blöcke aktualisieren
- nächste Schritte aktualisieren
