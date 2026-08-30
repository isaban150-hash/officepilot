# OfficePilot – Go-Live-Checkliste

Release-Gate, kein Marketingtext. Ein Punkt wird nur abgehakt, wenn er **belegbar**
nachgewiesen ist. Bei Unsicherheit bleibt er offen.

`[ ]` offen · `[x]` nachgewiesen

Stand der Durchsicht: 2026-08-30, Repository-Stand `1a297c7`.
Dieses Dokument trifft **keine** rechtliche Bewertung und ersetzt keine Rechtsberatung.

---

## Schlüssel / Secrets

> ### PFLICHTBLOCKER – Gemini-Schlüssel rotieren
>
> Der aktuell serverseitig genutzte Gemini-Schlüssel wurde zuvor **clientseitig
> ausgeliefert** und ist damit als kompromittiert zu behandeln. Ob ihn jemand ausgelesen
> hat, lässt sich nicht feststellen — deshalb ist die Annahme der Kompromittierung die
> einzig vertretbare.
>
> **Diese Rotation hat noch nicht stattgefunden.**
>
> Vor dem ersten echten Kunden beziehungsweise vor öffentlichem Einsatz:
>
> - [ ] neuen Gemini-Schlüssel erzeugen
> - [ ] `GEMINI_API_KEY` als Edge-Function-Secret ersetzen
> - [ ] alten Schlüssel bei Google widerrufen
> - [ ] `VITE_GEMINI_API_KEY` aus Vercel entfernen
> - [ ] `VITE_GEMINI_MODEL` aus Vercel entfernen
> - [ ] alte `VITE_GEMINI_*`-Einträge aus lokalen `.env`-Dateien entfernen
> - [ ] prüfen, dass kein produktives Browser-Bundle den alten Schlüssel enthält
> - [ ] produktiven KI-Endpunkt danach erneut real testen
>
> **Reihenfolge beachten:** erst den neuen Schlüssel setzen und ausliefern, dann den
> alten widerrufen — sonst brechen noch geöffnete Browser-Tabs.

- [ ] Keine Geheimnisse mit `VITE_`-Präfix in irgendeiner Umgebung
- [ ] Service-Role-Schlüssel nirgends im Frontend
- [ ] Getrennte Schlüssel für Vorschau- und Produktionsumgebung

---

## Security

- [x] Workspace-Isolation über RLS auf allen Workspace-Tabellen
- [x] Schreiben ausschließlich über Security-Definer-RPCs
- [x] Storage-Policies mit pfadbasierter Workspace-Prüfung; Assets unveränderlich
- [x] KI-Endpunkt mit serverseitigem Gate und Rate Limit
- [ ] Fremd-Workspace-Zugriff für **alle** Wege real geprüft
- [ ] Audit-Log für sicherheitsrelevante Vorgänge
- [ ] Rate Limits außerhalb des KI-Endpunkts

## Datenbank

- [x] Migrationen versioniert und nachvollziehbar in `supabase/migrations/`
- [ ] Migrations-Dry-Run vor jedem Rollout dokumentiert
- [ ] Rollback-Weg je sicherheitsrelevanter Migration beschrieben

## Auth / Lizenz

- [x] Registrierung, Freigabe durch Administrator, Sperre
- [x] Lizenzfelder (`status`, `license_status`, `license_expires_at`) vorhanden
- [x] **KI-Endpunkt** prüft Kontostatus und Lizenz serverseitig
- [ ] **Allgemeiner serverseitiger Lizenzschutz** — offen und release-relevant

> **Wichtige Trennung:** Der KI-Endpunkt ist geschützt. Die App insgesamt ist es
> **nicht**. Sync-RPCs und Storage-Policies prüfen Zugehörigkeit und Berechtigung, aber
> nicht `license_status`. Ein gesperrter oder lizenzloser Nutzer behält mit gültigem
> Token vollen Lese- und Schreibzugriff auf seine Cloud-Daten.
>
> Vor einem bezahlten Zugang muss festgelegt und umgesetzt werden, welche serverseitigen
> Aktionen bei inaktiver oder abgelaufener Lizenz erlaubt und welche blockiert sind.
> Eigener Block: **`LICENSE-SERVER-GATE-01`**.

## Zahlungszugang

- [ ] Bezahlanbieter angebunden
- [ ] Abo, Trial, Kündigung, Zahlungsverzug
- [ ] Serverseitige Freischaltung von Funktionen
- [ ] Rechnungsstellung für OfficePilot selbst

## Dokumente

- [x] Upload, Erkennung, Klassifikation, Ablage
- [ ] **Dokumentdateien in der Cloud** — liegen heute nur lokal, auf einem zweiten Gerät
      nicht verfügbar
- [ ] Gerätewechsel ohne Dokumentverlust nachgewiesen

## Rechnungen

- [x] Rechnungsarten, Abschläge, Schlussrechnung, Zahlungen, Finalisierung
- [x] Historische Rechnungen sind gegen spätere Stammdatenänderungen geschützt
- [ ] Logo im erzeugten PDF
- [ ] Abschlagsabzüge und offene Beträge auf einem frischen Gerät geprüft
- [ ] Zeichensatzgrenzen der PDF-Schriften geprüft (Umlaute, Sonderzeichen)

## E-Mail

- [ ] Versandweg vorhanden — **heute kann OfficePilot keine E-Mail senden**
- [ ] Absenderdomain eingerichtet
- [ ] Zustellstatus sichtbar
- [ ] Rechnung aus dem Vorgang heraus versendbar

## Datenschutz

- [x] Impressum, Datenschutzerklärung, AGB, Lizenzbedingungen als versionierte Seiten
- [ ] Verzeichnis der eingesetzten Auftragsverarbeiter (mindestens Supabase, Google,
      Hosting)
- [ ] Hinweis, welche Daten an den KI-Anbieter übertragen werden
- [ ] Datenexport auf Anforderung
- [ ] Kontolöschung

## Backup / Restore

- [x] Lokaler Backup-Export mit Prüfung und Wiederherstellungsweg
- [ ] **Wiederherstellungstest tatsächlich durchgeführt** — das Backup ist bislang
      unbewiesen
- [ ] Sicherung der Cloud-Daten geregelt

## Monitoring

- [ ] Fehler-Monitoring in Produktion
- [ ] Logging-Konzept ohne personenbezogene Inhalte
- [ ] Kennzahlen zur KI-Nutzung ausgewertet (Grundlage: `ai_usage_counters`)

## CI

- [ ] Automatisierter Testlauf bei jeder Änderung — derzeit laufen die Tests **nur lokal**
- [ ] `npx tsc --noEmit` als Teil der Prüfstrecke
- [ ] Definierter Releaseprozess

## Fehlerbehandlung

- [x] KI-Fehler werden auf verständliche deutsche Meldungen abgebildet
- [x] Keine technischen Fremdtexte in der Oberfläche
- [ ] Verhalten bei Verbindungsverlust in allen Kernwegen geprüft
- [ ] Nutzer erfährt bei fehlgeschlagenem Sync, was zu tun ist

## Mobilgeräte

- [x] Mobile-First-Layout, Kamera-Upload, Draft-Durability für Rechnungen
- [ ] Formular-Durability für die übrigen Masken (Firmendaten verliert heute Entwürfe)
- [ ] Installierbarkeit als PWA geklärt
- [ ] Kernwege auf iOS und Android real geprüft

## Browser

- [ ] Safari (iOS), Chrome (Android), Chrome und Edge (Desktop) geprüft
- [ ] Verhalten bei App-Wechsel und Wiederaufnahme geprüft

## Gewerketests

- [x] Referenzfirma und eingefrorene Gold-Suite unter `test-world/`
- [ ] Mindestens ein zweites Gewerk als vollständige Testfirma

## UI/UX

- [ ] Schlüsselabläufe nach dem Neuaufbau: Startseite, Dokument, Vorgang, Rechnung,
      Einstellungen
- [ ] Konsistente Leer-, Lade- und Fehlerzustände
- [ ] Keine technischen Diagnoseansichten im Hauptweg

## Datenexport

- [ ] Nutzer kann seine Daten in einem lesbaren Format ausleiten

## Account-Löschung

- [ ] Konto und zugehörige Daten löschbar
- [ ] Zusammenspiel mit Aufbewahrungsanforderungen geklärt

## Aufbewahrung / Löschung

- [ ] Aufbewahrungskennzeichnung an Dokumenten
- [ ] Löschschutz für aufbewahrungspflichtige Unterlagen
- [ ] OfficePilot schlägt keine Entsorgung ohne diese Prüfung vor (D-017)

## Kostenkontrolle

- [x] Rate Limit für den KI-Endpunkt
- [ ] Grenzwerte anhand echter Nutzungsdaten nachgeschärft
- [ ] Kostenschätzung für 10, 100 und 1.000 Kunden
- [ ] Ausgabenlimit oder Warnung beim KI-Anbieter

## Support / Recovery

- [ ] Supportweg für Nutzer
- [ ] Verfahren bei Datenverlust oder verlorenem Zugang
- [ ] Notfallweg bei Ausfall der Cloud

---

## Zusammenfassung der harten Blocker

1. **Gemini-Schlüssel rotieren** und alte `VITE_GEMINI_*`-Einträge entfernen.
2. **Serverseitiger Lizenzschutz** für Sync und Storage (`LICENSE-SERVER-GATE-01`).
3. **E-Mail-Versand** — ohne ihn ist der Grundkern nicht nutzbar.
4. **Dokumentdateien in der Cloud** — sonst ist der Mehrgerätebetrieb unvollständig.
5. **Wiederherstellungstest des Backups.**
6. **Fehler-Monitoring und CI.**
