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
- Letzter bestätigter Commit (HEAD): `0886002` — feat(ui): polish today dashboard and shell (Block A)
- origin/main: identisch mit lokalem `main` (`0886002`), nichts ausstehend
- Arbeitskopie: VISUAL-POLISH-01C (Block B) ist implementiert, aber **noch nicht committet**
  (siehe Abschnitt 3)

## 3. Aktiver Arbeitsblock

- Block: VISUAL-POLISH-01C — Block B (Kernarbeitsseiten, Listen und Details) — **uncommittet**
- Ziel: Eingang, Aufträge, Rechnungen, Dokumente, Finanzen, Kunden, Ausgaben sowie
  Dokument-, Rechnungs-, Auftrags-, Eingangs- und Kundendetail auf das Niveau von „Heute"
  (Zeilenlisten, Kennzahlenflächen, Zweispalten-Details, eine Hauptaktion, keine Kartenwand)
- Status: implementiert (neues `src/styles/workpages.css` + gezielte Markup-Umbauten);
  gezielte Tests grün, tsc grün; Browser-Selbstabnahme Desktop 1280 / Galaxy 360 / iOS ohne
  horizontalen Überlauf
- Noch offene Abnahme: Commit durch den Nutzer; danach unabhängiger Produkttest (ChatGPT Work)

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
| Visual Polish Block B (VISUAL-POLISH-01C) | noch nicht committet | Listen als Zeilen, Kennzahlenflächen (Rechnungen/Finanzen/Ausgaben), Dokumentdetail nach fünf Fragen, Rechnungs-/Auftrags-/Kundendetail zweispaltig |

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

## 8. Offene Roadmap

A. Visual Polish Block A — committet (`0886002`)
B. Visual Polish Block B — Listen- und Detailseiten (implementiert, Commit offen)
C. Visual Polish Block C — Sekundärbereiche (Finanzen, Steuerberater,
   Einstellungen, Assistent, Wissen, Sync, Mehr)
D. Erneuter echter Browser-Produkttest (ChatGPT Work) auf dem polierten Stand
E. Danach Produktfertigstellung / verbleibende Fachbereiche

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
