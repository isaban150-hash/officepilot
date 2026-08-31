# OfficePilot – Roadmap

Die 16 Produktbereiche mit Status, offenen Lücken und nächstem sinnvollen Schritt.

**Statuswerte:** `fertig` · `teilweise` · `offen` · `blockiert`
**Prioritäten:** `P0` vor dem internen Grundkern-Test · `P1` vor dem ersten echten
Kunden · `P2` danach

**Bewusst ohne Prozentwerte.** Sie wären Schätzungen, würden aber als Messwerte gelesen.
Status und offene Lücken sagen dasselbe ehrlicher.

**Stand der Einschätzung:** 2026-08-30, Repository-Stand `1a297c7`.
„Aktueller Stand" nennt nur, was im Repository belegbar ist.

---

## 1. Kunden / Vorgänge / Baustellen
**Status:** teilweise · **Priorität:** P0

**Aktueller Stand:** Kundenstamm mit stabiler Kennung (`Customer`), Anlegen und
Bearbeiten, Cloud-Sync über die Entität `customer`, `Vorgang.customerId` als
Cloud-Relation, Kundenakte gruppiert über die Kennung (nie über den Namen),
Eigenfirmen-Guard mit diakritikfester Namensnormalisierung, Konflikt- und
Versionsvertrag, Lost-Ack-Wiederherstellung, Tombstone-Semantik. Auf zwei Geräten real
bestätigt.

**Offene Lücken:** Kein Löschweg für Kunden (V1 bewusst). `deleteVorgang` ist
implementiert, hat aber **keinen produktiven Aufrufer** — der Servicepfad ist unbenutzt.
Kein eigener Zustand „archiviert/abgeschlossen" für Vorgänge. Offline-Verhalten nicht
systematisch geprüft.

**Blocker:** keine.
**Nächster Schritt:** Vorgang abschließen/archivieren als Zustand.

---

## 2. Rechnungen / Abschläge / Schlussrechnungen / Zahlungen
**Status:** teilweise · **Priorität:** P0

**Aktueller Stand:** Sechs Rechnungsarten, mengenbasiert und Festbetrag,
Abschlagsabzüge, Leistungszeitraum, Zahlungsziel, Skonto, Teil- und Überzahlung,
Finalisierung mit Preflight, serverseitiger Guard gegen doppelte Schlussrechnungen,
Nummernvergabe, Cloud-Sync für Rechnungen, Zahlungen und erzeugte Dokumente,
Draft-Durability für die mobile Wiederaufnahme, PDF über `pdf-lib`,
`immutableInvoiceFingerprint`.

**Offene Lücken:** Kein Logo im PDF; nur Standardschriften mit WinAnsi-Grenzen. Aufmaß
ist als Feldtrio vorhanden, aber kein durchgängiger Fachprozess. **Zu prüfen:**
Abschlagsabzüge werden aus lokal vorhandenen Vorgangsrechnungen abgeleitet — bei
unvollständigem Pull auf einem frischen Gerät wäre die Abzugsbasis unvollständig;
Rechnung und Zahlungen sind getrennte Cloud-Entitäten, ein Teil-Sync könnte einen
falschen offenen Betrag zeigen. Beides ist **nicht als Fehler nachgewiesen**, aber auch
nicht ausgeschlossen.

**Blocker:** keine.
**Nächster Schritt:** Die beiden genannten Randfälle gezielt prüfen.

---

## 3. Dokumenterkennung
**Status:** teilweise · **Priorität:** P0

**Aktueller Stand:** PDF- und Fotoupload, HEIC-Normalisierung, OCR über `tesseract.js`,
Textextraktion über `pdfjs`, regelbasierte Klassifikation mit über 80 Dokumentarten,
Parteienerkennung, Confidence und Review-Kennzeichnung, Confirm-first, mehrstufige
Ableitungs- und Archivpipeline, Bildkompression und Vorschaubilder, Upload-Validierung,
umfangreiche Testabdeckung samt Referenzdokumenten und eingefrorener Gold-Suite.

**Offene Lücken:** **Dokumentdateien liegen ausschließlich lokal** (IndexedDB und
Base64). Es gibt keinen Cloud-Speicher für Dokumente — auf einem zweiten Gerät sind die
Dateien nicht verfügbar.

**Blocker:** keine.
**Nächster Schritt:** Dokumentdatei-Cloudspeicherung als eigener Block (P1).

---

## 4. Eingehende Briefe / Dokument-Q&A
**Status:** teilweise · **Priorität:** P1

**Aktueller Stand:** Frageerkennung und Antwortpfad zu einem einzelnen Dokument,
Antwortparser und Nachprüfung als Halluzinationsschutz, Entwurfserzeugung für Antworten,
Handwerkswissen-Registry, Absenderklassifikation über den Dokumentkatalog. Seit
`1a297c7` läuft der KI-Transport über die Edge Function.

**Offene Lücken:** Ob die Leitfragen — „Muss ich zahlen?", „Bis wann?", „Braucht das mein
Steuerberater?" — durchgängig beantwortet werden, ist **nicht sicher nachweisbar**.
Fristfelder und Aufgabenableitung existieren, ein geschlossenes Konzept „Was will diese
Behörde von mir" fehlt. Der Dialog läuft über eine allgemeine Assistentenseite, nicht als
Gespräch am Einzeldokument.

**Blocker:** keine.
**Nächster Schritt:** Fristen- und Handlungsbedarfserkennung als eigener Fachblock.

---

## 5. Intelligentes Archiv
**Status:** teilweise · **Priorität:** P1

**Aktueller Stand:** Zwei Ablagesysteme — digitale Ordner und Papierordner mit
15 Kategorien. Ablageentscheidung, Papierarchivseite, Archiv-Wahrheits-Snapshots, Suche.

**Offene Lücken:** **Aufbewahrungskennzeichnung und Löschschutz fehlen vollständig.**
Es gibt Signale zur Steuerberater-Relevanz, aber keine Aufbewahrungsfrist, keinen
Löschschutz und keine Bewertung „entbehrlich". Die Regel aus D-017 ist damit **nicht im
Code verankert**. Archivierung nach Vorgangsabschluss fehlt.

**Blocker:** keine.
**Nächster Schritt:** Aufbewahrungs- und Löschschutzkonzept (Retention/Delete-Protection).

---

## 6. Steuerberater / Belege / Ausgaben
**Status:** teilweise · **Priorität:** P1

**Aktueller Stand:** `Expense`-Modell mit Zeilen, Zahlungen und Steuerangaben, vier
Ausgabenseiten, Steuerberaterseite, Belegarten im Klassifikationskatalog
(`tankbeleg`, `kassenbeleg`, `ec_beleg`, `kreditkartenbeleg`, `kontoauszug`,
`eingangsrechnung`).

**Offene Lücken:** Kein Export für den Steuerberater nachweisbar. Vorsteuerbehandlung,
Monats- und Jahresstruktur, Belegnummernkreis und Doppelbelegerkennung fehlen. Die
Tankbeleg-Ablage nach D-005 ist **nicht umgesetzt**. Zuordnung einer Ausgabe zu Vorgang
und Fahrzeug ist nicht durchgängig.

**Blocker:** keine.
**Nächster Schritt:** Steuerberater-Export und Ausgabe-zu-Vorgang-Zuordnung.

---

## 7. Einkauf / Material / Baustellenkosten / Weiterberechnung
**Status:** offen · **Priorität:** P1 (schmaler Pfad) / P2 (voll)

**Aktueller Stand:** Kein Domänenmodell. Vorhanden sind `materialSource` am Vorgang,
die Dokumentarten `materialnachweis` und `lieferschein` sowie Randberührungen in der
Vertragsextraktion.

**Offene Lücken:** Materialkatalog, Artikelstamm, Lieferantenstamm, Einkaufspreise,
Aufschlagsregeln, Baustellenkosten, Deckungsbeitrag, Nachkalkulation.

**Blocker:** keine.
**Nächster Schritt:** Nur der schmale Pfad für V1 — Lieferantenrechnung als Ausgabe
erfassen, einem Vorgang zuordnen, als Position in eine Kundenrechnung übernehmen.
Katalog und Kalkulation nach dem ersten Kunden.

---

## 8. Firmenprofil / Branding / Einstellungen
**Status:** teilweise · **Priorität:** P0 / P1 gemischt

**Aktueller Stand:** `CompanyProfile` mit 20 Feldern, Cloud-Sync über `company_profile`,
Firmendatenseite mit Validierung und gehärtetem Logo-Upload (PNG/JPEG/WebP, 2 MiB,
Signaturprüfung, kein SVG, kein freier Data-URL-Weg), Branding-Typen
(`BrandingProfile`, `BrandingSnapshot`, `LogoAssetReference`), unveränderlicher
Asset-Storage mit privatem Bucket und Policies — remote getestet.

Der **Altclient-Schutz für `company_profile.branding` ist serverseitig umgesetzt, remote
angewendet und per isoliertem Runtime-Test bestätigt** (Migration
`20250902120000_company_profile_branding_preserve.sql`, BRANDING-01E-0). Der
`company_profile`-UPDATE-Zweig der RPC bewahrt ein vorhandenes `branding`-Objekt, wenn der
eingehende Payload dort kein Objekt liefert — nur dieser eine Schlüssel, kein allgemeines
Deep-Merge. Alle sieben Laufzeitfälle (fehlend, `{}`, gefüllt, `null`, falscher Typ, kein
serverseitiges Branding, falsche `row_version`) liefen ohne FAIL; der Test lief in einem
eigens erzeugten Workspace, veränderte kein echtes Firmenprofil und hinterließ keine
Testdaten.

Der **Cloud-Contract ist umgesetzt** (BRANDING-01E-1):
`CompanyProfile.branding?: BrandingProfile`, Transport durch die bestehende Sync-Kette,
feldweise Sanitisierung in **beide** Richtungen (Read und Write) und ein
**geschlossener** Contract aus genau
`logo.assetId`, `logo.mimeType` und `primaryColor` — unbekannte Unterfelder werden
verworfen. Löschen ausschließlich über `branding: {}` (D-022). Der
Rechnungs-Regressionsschutz schneidet `branding` an denselben zwei Payload-Grenzen heraus
wie `logoDataUrl`; ohne ihn hätten die strengen Invoice-Validatoren jeden Push abgelehnt.
Keine Migration nötig.

Der **CompanyProfile-Cloud-Roundtrip ist produktiv realgetestet**: Ein serverseitig
gesetzter Testwert mit gültiger `primaryColor` und den verbotenen Feldern `storagePath`
und `signedUrl` kam nach dem produktiven Write nur noch mit der Farbe zurück — die
Metadaten waren entfernt. Der Testwert wurde danach vollständig bereinigt.

Der **Rechnungs-Regressionsschutz ist fokussiert automatisiert getestet**, nicht
produktiv realgetestet. Kein offener Produktfehler.

**Offene Lücken:** Kein produktiver Upload, also entsteht noch keine
`LogoAssetReference` — der Contract transportiert bislang etwas, das niemand erzeugt.
Keine Logo-Anzeige aus `branding`, keine Anzeigepriorität gegenüber `logoDataUrl`, kein
`BrandingSnapshot` in Rechnung und PDF. `logoDataUrl` bleibt der Legacy-Weg und verlässt
das Gerät nie. `primaryColor` hat keine Oberfläche. **Ein zentraler Einstellungsbereich
existiert nicht** (D-012); Einstellungen liegen verstreut.

**Blocker:** keine.
**Nächster Schritt:** `BRANDING-01E-2` — produktiver Logo-Upload: Datei validieren,
unveränderliches Asset hochladen, `LogoAssetReference` in `branding.logo` speichern,
synchronisieren. Dort gehört auch die Anzeigepriorität hin. Danach `01F`.
Beide sind **noch nicht begonnen**.

---

## 9. Vollständiger UI/UX-Neuaufbau
**Status:** offen · **Priorität:** P1

**Aktueller Stand:** Ein Token-System (`src/styles/tokens.css`, „Design System v1.0"),
wiederverwendbare Basiskomponenten unter `src/components/ui`, Sidebar für Desktop und
Bottom-Navigation für Mobil.

**Offene Lücken:** Umfangreiches gewachsenes Seiten-CSS neben dem Tokensystem; bei
59 Seiten ist Konsistenz so nicht durchsetzbar. Leer-, Lade- und Fehlerzustände sind
nicht als durchgängiges Muster nachweisbar. Das Zielbild aus D-011 ist nicht erreicht.

**Blocker:** Sollte erst nach dem Grundkern beginnen, sonst wird zweimal gestaltet.
**Nächster Schritt:** Informationshierarchie und Seitenanzahl festlegen, dann
Komponentenbibliothek, dann Migration der Seiten.

---

## 10. E-Mail / Domain / Kommunikation
**Status:** offen · **Priorität:** P1

**Aktueller Stand:** Entwurfserzeugung, Kommunikationsverlauf, Kommunikationsseite,
Mail-Import als Dokument, E-Mail-Felder an Kunde und Firma.

**Offene Lücken:** **Kein Versandweg.** Kein SMTP, kein Versanddienst, keine
Serverfunktion dafür, keine Domain, kein Zustellstatus, kein Posteingang. OfficePilot
kann heute keine E-Mail senden.

**Blocker:** Braucht serverseitige Infrastruktur. Seit `1a297c7` existiert mit der
Edge Function erstmals eine Grundlage, auf der das aufsetzen kann.
**Nächster Schritt:** Versanddienst wählen, Serverfunktion, Zustellstatus.

---

## 11. WhatsApp
**Status:** offen · **Priorität:** P2

**Aktueller Stand:** Keine Infrastruktur. Die Treffer auf „WhatsApp" sind
Kanalbezeichnungen in der Oberfläche und im Einrichtungsassistenten — reine Platzhalter.

**Offene Lücken:** alles.
**Blocker:** Meta-Verifizierung, Vorlagengenehmigung, Einwilligungsverwaltung, laufende
Kosten je Konversation.
**Nächster Schritt:** Nach dem ersten Kunden. Vor dem Release wäre es eine Ablenkung.

---

## 12. Mobile / Kamera / Offline / Resume
**Status:** teilweise · **Priorität:** P0

**Aktueller Stand:** Mobile-First-Layout mit Bottom-Navigation, Kamera- und Fotoupload
mit HEIC-Behandlung, Draft-Durability für Rechnungen, Upload-Entwürfe in IndexedDB,
lokale Wiederherstellungsseiten, Outbox-Sync mit Wiederholung, Bildkompression,
Netzwerkstatus-Hinweis.

**Offene Lücken:** Kein PWA-Manifest gefunden — Installierbarkeit **nicht sicher
nachweisbar**. Formulare außerhalb der Rechnungsmaske haben **keine** Durability-Session;
die Firmendatenseite hält ihren Entwurf nur im React-State und kann ihn beim
App-Wechsel verlieren.

**Blocker:** keine.
**Nächster Schritt:** Formular-Durability für Firmendaten und übrige Masken.

---

## 13. Gewerke-Logik / Testfirmen
**Status:** teilweise · **Priorität:** P1

**Aktueller Stand:** Die Fachlogik ist weitgehend gewerkeneutral — Positionen,
Einheiten, §13b, Abschläge, Aufmaß und Baustellen funktionieren gewerkeübergreifend.
Referenzfirma und eingefrorene Gold-Suite unter `test-world/`.

**Offene Lücken:** Testdaten und Wissensregistry sind bau- und dachlastig. Es fehlen
realistische Testfirmen für SHK (Wartungsverträge, Notdienst), Elektro (Prüfprotokolle,
E-Check) und Maler (Flächenaufmaß, Pauschalen).

**Blocker:** keine.
**Nächster Schritt:** Mindestens ein zweites Gewerk als vollständige Testfirma.

---

## 14. Cloud / Security / Datenschutz
**Status:** teilweise · **Priorität:** P0 / P1

**Aktueller Stand:** Authentifizierung mit Profilfreigabe, Workspace-Isolation, RLS auf
allen Workspace-Tabellen, Schreiben nur über Security-Definer-RPCs, Storage-Policies mit
pfadbasierter Workspace-Prüfung, unveränderliche Branding-Assets, Versionsvertrag mit
Konflikterkennung, Tombstones, lokaler Backup-Export mit Prüfung und Wiederherstellung.
Seit `1a297c7`: KI-Schlüssel serverseitig, KI-Endpunkt mit vollständigem Gate.

**Offene Lücken:** Kein Audit-Log. Kein Cloud-Backup und **kein Wiederherstellungstest**.
Kein Datenexport und keine Kontolöschung für Betroffenenrechte. Dokumentdateien liegen
nur lokal (siehe Bereich 3).

**Blocker:** keine.
**Nächster Schritt:** Wiederherstellungstest des Backups; danach Datenexport und
Kontolöschung.

---

## 15. Abo / Lizenz / Zahlung / Anti-Free-Use
**Status:** teilweise · **Priorität:** P1

**Aktueller Stand:** `profiles` mit `status`, `license_status` und
`license_expires_at`, Admin-RPCs zur Lizenzverwaltung, Administrationsseite,
Sperrseiten im Frontend. Das ist eine **manuelle Lizenzverwaltung** — für den
Pilotbetrieb tragfähig.

Seit `1a297c7`: Der **KI-Endpunkt** prüft Kontostatus, Lizenz, Ablaufdatum und
Mitgliedschaft serverseitig und begrenzt die Nutzungshäufigkeit.

**Offene Lücken — hier ist die Trennung wichtig:**

| Bereich | Serverseitiges Lizenz-Gate |
|---|---|
| KI-Endpunkt | **vorhanden** |
| Cloud-Sync-RPCs | **fehlt** — prüfen Zugehörigkeit, nicht `license_status` |
| Storage (Branding) | **fehlt** — prüft Mitgliedschaft und Schreibrecht, nicht die Lizenz |
| Übrige RPCs | **fehlt** |
| Frontend-Routing | vorhanden, aber nur visuell — kein Schutz gegen direkte Serveraufrufe |

Der geschützte KI-Endpunkt bedeutet **nicht**, dass die App insgesamt gegen kostenlose
Nutzung geschützt ist. Ein gesperrter oder lizenzloser Nutzer behält mit gültigem Token
vollen Lese- und Schreibzugriff auf seine Cloud-Daten.

Weiter fehlen vollständig: Bezahlung, Abo, Trial, Selbstbedienung, Kündigung,
Rechnungsstellung für OfficePilot selbst.

**Blocker:** keine.
**Nächster Schritt:** **`LICENSE-SERVER-GATE-01`** — serverseitige Lizenzprüfung für
Sync-RPCs und Storage-Policies, als eigener Block. Bezahlung danach.

---

## 16. Go-Live / Monitoring / Recht
**Status:** teilweise · **Priorität:** P1

**Aktueller Stand:** Deployment- und Admin-Dokumentation, ausgearbeitete
Pilotunterlagen, Rechtsseiten mit Versionsverwaltung, Vercel-Konfiguration.

**Offene Lücken:** Kein Fehler-Monitoring, kein Logging-Konzept, **kein CI-Workflow**
(die vorhandenen Tests laufen nur lokal), kein automatisierter Releaseprozess, keine
Staging-Umgebung als Konzept, kein Wiederherstellungstest, keine Rate Limits außerhalb
des KI-Endpunkts, kein Supportweg, keine Kontolöschung, kein Datenexport.

**Blocker:** keine.
**Nächster Schritt:** Fehler-Monitoring und CI. Vollständige Liste in
[OFFICEPILOT_GO_LIVE.md](OFFICEPILOT_GO_LIVE.md).

---

## Übersicht

| # | Bereich | Status | Priorität |
|---|---|---|---|
| 1 | Kunden / Vorgänge / Baustellen | teilweise | P0 |
| 2 | Rechnungen / Abschläge / Zahlungen | teilweise | P0 |
| 3 | Dokumenterkennung | teilweise | P0 |
| 4 | Eingehende Briefe / Dokument-Q&A | teilweise | P1 |
| 5 | Intelligentes Archiv | teilweise | P1 |
| 6 | Steuerberater / Belege / Ausgaben | teilweise | P1 |
| 7 | Einkauf / Material / Weiterberechnung | offen | P1 / P2 |
| 8 | Firmenprofil / Branding / Einstellungen | teilweise | P0 / P1 |
| 9 | UI/UX-Neuaufbau | offen | P1 |
| 10 | E-Mail / Domain / Kommunikation | offen | P1 |
| 11 | WhatsApp | offen | P2 |
| 12 | Mobile / Kamera / Offline / Resume | teilweise | P0 |
| 13 | Gewerke-Logik / Testfirmen | teilweise | P1 |
| 14 | Cloud / Security / Datenschutz | teilweise | P0 / P1 |
| 15 | Abo / Lizenz / Zahlung | teilweise | P1 |
| 16 | Go-Live / Monitoring / Recht | teilweise | P1 |

**Kein Bereich steht auf `fertig`.** Das ist beabsichtigt: In jedem Bereich sind
relevante Kernlücken offen.
