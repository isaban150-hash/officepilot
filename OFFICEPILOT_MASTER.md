# OfficePilot – Master

Dauerhafte Beschreibung dessen, was OfficePilot ist und wie es aufgebaut ist.
Kein Tagesprotokoll, keine Sprintliste — der aktuelle Stand steht in
[OFFICEPILOT_HANDOFF.md](OFFICEPILOT_HANDOFF.md), die Bereichsübersicht in
[OFFICEPILOT_ROADMAP.md](OFFICEPILOT_ROADMAP.md).

**Lesehinweis zur Wahrheit:** Dieses Dokument trennt bewusst zwischen
*technischem Ist-Stand* (aus dem Repository belegbar), *Produktentscheidung*,
*Zielbild* und *offener Lücke*. Wo eine Angabe nicht aus dem Code stammt, ist sie als
solche gekennzeichnet.

---

## 1. Produkt

OfficePilot ist ein digitaler Büromitarbeiter für kleine Handwerksbetriebe. Er soll die
Büroarbeit vereinfachen: Dokumente verstehen, Vorgänge organisieren, Rechnungen
erstellen, Belege erfassen und den Nutzer durch Büroabläufe führen, die er sonst allein
bewältigen müsste.

**Zielgruppe für V1** *(Produktentscheidung)* — klassische Handwerksbetriebe:
Dachdecker · SHK/Sanitär/Heizung/Klima · Elektro · Fliesenleger · Maler · Trockenbau ·
Garten- und Landschaftsbau.

Geschäftsmodelle mit Kasse, TSE und Laufkundschaft — etwa Friseursalons — gehören
**nicht zwingend** zum V1-Kern. Das ist eine Produktentscheidung (siehe D-016), keine
technische Einschränkung: Die Fachlogik ist weitgehend gewerkeneutral.

**Was OfficePilot nicht ist:** keine Buchhaltungssoftware, kein Warenwirtschaftssystem,
kein Kassensystem und keine Rechts- oder Steuerberatung.

---

## 2. Produktprinzipien

Kurzfassung; die verbindlichen Formulierungen stehen in
[OFFICEPILOT_DECISIONS.md](OFFICEPILOT_DECISIONS.md).

- **Confirm-first** — fachlich relevante Werte werden nicht still übernommen (D-001).
- **Keine stillen Übernahmen** — Positionen, Zuordnungen und Beträge brauchen eine
  Nutzerentscheidung (D-002, D-019).
- **Der Nutzer entscheidet**, wo es unsicher oder geschäftlich relevant wird.
- **Einfache Kernabläufe** — wenige Schritte, wenig gleichzeitig sichtbar.
- **Selten Benötigtes ist sekundär** und liegt in Unterbereichen (D-012).
- **KI unterstützt, entscheidet nicht** — Vorschläge, keine Tatsachen (D-018).
- **Antworten sind dokumentgebunden**, Unsicherheit wird sichtbar gemacht (D-018).

---

## 3. Kernabläufe

**Dokument** — hochladen → erkennen → Inhalt verstehen → Fakten, Fristen und Aufgaben
ableiten → vom Nutzer bestätigen lassen → ablegen und weiterverarbeiten.

**Vorgang** — Kunde, Baustelle und Auftrag erfassen → Abschläge und Schlussrechnung →
Versand und Zahlung → Abschluss und Archivierung.

**Beleg** — erkennen → als Ausgabe erfassen → gegebenenfalls einem Vorgang zuordnen →
steuerlich und betrieblich weiterverarbeiten.

**Eingehender Brief** — Absender und Behörde erkennen → Anliegen erklären → Fristen und
Handlungsbedarf ableiten → Rückfragen zum echten Dokument beantworten → Antwortentwurf
anbieten. Es wird nichts ohne Bestätigung gesendet.

---

## 4. Architekturüberblick *(technischer Ist-Stand)*

- **Frontend:** React 19 mit TypeScript, Vite als Build, React Router.
  Einseitige Anwendung, mobil zuerst gedacht.
- **Lokale Persistenz:** In-Memory-Stores → `persistenceService` → `localStorage`.
  Dazu drei getrennte IndexedDB-Datenbanken, jede auf Version 1:
  `officepilot-document-blobs`, `officepilot-upload-drafts`,
  `officepilot-branding-assets`.
- **Cloud:** Supabase — Authentifizierung, PostgreSQL mit Row Level Security,
  Storage (privater Bucket `branding-assets`), eine Edge Function (`ai`).
- **Schreibzugriffe auf Fachdaten** laufen ausschließlich über zwei Security-Definer-RPCs:
  `upsert_workspace_sync_entity` und `pull_workspace_sync_state`.
- **Dateiverarbeitung** geschieht im Browser: `pdfjs-dist`, `pdf-lib`, `tesseract.js`,
  `heic-to`, `jszip`.
- **Kein allgemeiner eigener Backend-Server.** Die einzige Serverkomponente ist die
  Edge Function `ai`; das Hosting (Vercel) liefert ausschließlich statische Dateien aus.

---

## 5. Zentrale Datenobjekte *(technischer Ist-Stand)*

| Objekt | Rolle |
|---|---|
| `Customer` | Kundenstamm mit stabiler Kennung; erweitert `CustomerBilling` |
| `Vorgang` | Auftrag/Baustelle; `customerId` ist die Identitätsbeziehung zum Kunden |
| `VorgangInvoice` | finalisierte Rechnung mit eingefrorenem `customerSnapshot` und `companySnapshot` |
| `InvoiceDraft` | Rechnungsentwurf, ebenfalls mit eingefrorenem Firmenstand |
| `CompanyDocument` | abgelegtes Dokument mit Kategorie, digitaler und Papier-Ablage |
| `Expense` | Ausgabe/Beleg mit Zeilen, Zahlungen und Steuerangaben |
| `CompanyProfile` | eigene Firmendaten (Anschrift, Kontakt, Steuer, Bank, Zahlungsvorgaben) |
| `BrandingProfile` / `BrandingSnapshot` | aktuelles bzw. eingefrorenes Erscheinungsbild |
| `LogoAssetReference` | unveränderliche Referenz auf ein Logo-Asset |
| `SharedPresentationContext` | gemeinsame Absender-/Empfängerdaten für spätere Vorlagen |
| `SyncMeta` / `SyncOutboxEntry` | Synchronisationszustand je Objekt und Warteschlange |

---

## 6. Dokumentenpipeline *(technischer Ist-Stand)*

Upload (PDF oder Foto) → HEIC-Normalisierung → Textgewinnung über `pdfjs` beziehungsweise
OCR mit `tesseract.js` → **regelbasierte Klassifikation** → Faktenextraktion →
Confidence- und Review-Kennzeichnung → Bestätigung durch den Nutzer → Ablage und
Folgeaktion.

Der Klassifikationskatalog (`documentClassificationCatalog.ts`) führt **über 80
Dokumentarten** — von `finanzamt`, `bg_bau` und `soka_bau` über Verträge, Protokolle,
Personal- und Versicherungsunterlagen bis `tankbeleg` und `entsorgungsnachweis`.

**Wichtig:** Die Grundklassifikation und die OCR sind **nicht** von Gemini abhängig. Sie
laufen regelbasiert und lokal. KI ergänzt einzelne Aufgaben — Faktenzuordnung,
Rückfragen zu einem Dokument, Entwurfsverbesserung —, sie ist nicht die
Dokumenterkennung selbst.

---

## 7. Rechnungs- und Vorgangskette *(technischer Ist-Stand)*

Rechnungsarten: `rechnung`, `abschlag`, `teilrechnung`, `schluss`, `gutschrift`,
`storno`. Abrechnung mengenbasiert oder als Festbetrag. Abschlagsabzüge werden aus den
vorangegangenen Abschlägen des Vorgangs abgeleitet.

Zahlungen kennen Teilzahlung und Überzahlung. Die Finalisierung läuft über einen
Preflight und ist serverseitig gegen doppelte Schlussrechnungen abgesichert.
Beim Finalisieren werden Firmen- und Kundenstand **eingefroren**; ein späterer
Stammdatenwechsel verändert eine bestehende Rechnung nicht. Der
`immutableInvoiceFingerprint` schützt den finalisierten Stand vor stillen Änderungen.

PDF-Erzeugung über `pdf-lib` mit Standardschriften. **Offen:** Das erzeugte PDF enthält
derzeit kein Logo; ein Logo erscheint nur in der Bildschirm- und Druckansicht.

---

## 8. Cloud- und Sync-Grundlagen *(technischer Ist-Stand)*

- **Outbox** — lokale Änderungen werden eingereiht und beim nächsten Lauf gesendet.
- **Versionsvertrag** — `sync.version` ist ausschließlich die zuletzt vom Server
  bestätigte `row_version`. Lokale Fachänderungen erhöhen sie nicht.
- **Strict-Zero** — `p_row_version = 0` bedeutet serverseitig „diese Zeile darf noch
  nicht existieren" (für `vorgang` und `customer`).
- **Lost-Ack-Adoption** — ging die Bestätigung eines Creates verloren, wird die
  Serverbasis übernommen, sobald die Remote-Zeile nachweislich unberührt ist.
- **Tombstones** — Löschungen reisen als Grabstein; die bekannte Serverversion bleibt
  dabei unverändert.
- **Konflikte statt Last-Write-Wins** — abweichende Versionen führen zu einem sichtbaren
  Konflikt, nicht zum stillen Überschreiben.

Synchronisiert werden derzeit: `workspace`, `workspace_member`, `workspace_settings`,
`company_setup`, `company_profile`, `vorgang`, `customer`. Rechnungen, Zahlungen,
erzeugte Rechnungsdokumente und Nachträge haben eigene Cloud-Wege.

---

## 9. KI-Architektur *(technischer Ist-Stand, Commit `1a297c7`)*

```
Browser → aiProxyClient → Supabase Edge Function /functions/v1/ai
        → Sitzung · Kontostatus · Lizenz · Workspace · Rate Limit
        → Gemini → Antwort
```

Fünf Operationen, mehr erlaubt der Server nicht:
`document_question` · `document_facts` · `communication_draft` · `assistant` ·
`vorgang_question`.

- Das **Modell wird serverseitig bestimmt**; der Browser kann es nicht wählen.
- Der **Gemini-Schlüssel wird im Produktivcode nicht mehr aus dem Browser gelesen**;
  er ist ein Server-Secret und reist im Header, nicht in der Adresse.
- **Prompts werden in diesem Stand weiterhin clientseitig gebaut** und an den Endpunkt
  übergeben. Die Guards und Parser liegen ebenfalls oberhalb des Transports.
- Der Proxy schützt den Schlüssel und schafft eine zentrale Kontrollstelle.

**Was der Proxy nicht leistet:** Die fachlichen Daten — Dokumenttexte, Kundenangaben,
Vorgangskontext — verlassen OfficePilot weiterhin und werden an den externen
KI-Anbieter übertragen. Der Datenschutz ist damit **nicht** automatisch gelöst; verbessert
hat sich der Schutz des Schlüssels und die Möglichkeit, künftig zentral zu begrenzen,
was hinausgeht.

---

## 10. Sicherheitsgrundlagen

**Vorhanden** *(technischer Ist-Stand)*
- Supabase-Authentifizierung mit Profilfreigabe (`pending` / `approved` / `blocked`).
- Workspace-Isolation über `is_active_workspace_member` und `can_write_workspace`;
  beide sind Security-Definer-Funktionen und für Clients nicht ausführbar.
- Row Level Security auf allen Workspace-Tabellen; Schreiben nur über die RPCs.
- Storage: privater Bucket, Pfad `<workspaceId>/<assetId>`, keine UPDATE- und keine
  DELETE-Policy — Branding-Assets sind damit unveränderlich.
- KI-Endpunkt: serverseitiges Gate aus Sitzung, Kontostatus, Lizenz,
  Workspace-Mitgliedschaft und Rate Limit; fail closed bei technischen Fehlern.
- Lokaler Backup-Export mit Prüfung und Wiederherstellung.

**Noch nicht vorhanden** *(offene Lücken)*
- Ein allgemeiner serverseitiger Lizenzschutz für **alle** Cloud-Funktionen. Sync-RPCs
  und Storage prüfen Zugehörigkeit und Berechtigung, aber **nicht** `license_status`.
- Vollständiger Schutz künftig bezahlter Funktionen.
- Fehler-Monitoring, automatisierte Testläufe, Wiederherstellungstest des Backups,
  Datenexport und Kontolöschung.

Einzelheiten und Priorität: [OFFICEPILOT_ROADMAP.md](OFFICEPILOT_ROADMAP.md),
Bereiche 14 und 15.

---

## 11. UI/UX-Zielbild *(Zielbild, ausdrücklich kein Ist-Zustand)*

OfficePilot soll professionell, modern, hochwertig und ruhig wirken — wie ein
digitaler Büroassistent, dem man den Betrieb anvertraut.

Geplant ist ein **grundlegender Neuaufbau**, keine kosmetische Anpassung (D-011):
klare visuelle Hierarchie · deutlich weniger gleichzeitig sichtbare Elemente · einfache
Kernabläufe · bessere Navigation · saubere Typografie · konsistente Abstände ·
hochwertige Formulare · eindeutige Schaltflächen · vollwertige mobile Nutzung ·
durchgängige Gestaltung über alle Bereiche.

Der heutige Zustand entspricht dem nicht. Es gibt ein Token-System und eine
Komponentenbasis, daneben aber umfangreiches gewachsenes Seiten-CSS.

---

## 12. V1-Abgrenzung

**V1-Kern** — Kunden und Vorgänge · Dokumenterkennung und Ablage · eingehende Post
verstehen · Angebot bis Schlussrechnung mit Zahlungen · Rechnung als PDF mit eigenem
Branding **und Versand** · Belege und Ausgaben erfassen · zentrale Firmendaten und
Einstellungen · mobile Nutzung ohne Datenverlust · getrennte, gesicherte Betriebsdaten.

**Spätere Ausbaustufen** — Materialkatalog, Lieferantenstamm, Nachkalkulation ·
Abo-Selbstbedienung und Bezahlung · Benutzer und Rollen im Betrieb · weitere
Dokumenttypen und Vorlagen · weitere Gewerke.

**Nicht für den ersten Release** — WhatsApp-Kommunikation. Es existiert dafür **keine**
Infrastruktur; die Kanalbezeichnungen in der Oberfläche sind Platzhalter.

---

## 13. Verweise

- [OFFICEPILOT_ROADMAP.md](OFFICEPILOT_ROADMAP.md) — 16 Produktbereiche mit Status
- [OFFICEPILOT_HANDOFF.md](OFFICEPILOT_HANDOFF.md) — aktueller Übergabestand
- [OFFICEPILOT_DECISIONS.md](OFFICEPILOT_DECISIONS.md) — verbindliche Entscheidungen
- [OFFICEPILOT_GO_LIVE.md](OFFICEPILOT_GO_LIVE.md) — Release-Checkliste
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Deployment und Umgebungsvariablen
- [docs/FIRST_ADMIN.md](docs/FIRST_ADMIN.md) — Ersteinrichtung des Administrators
- [docs/pilot/](docs/pilot/) — Unterlagen für den begleiteten Pilotbetrieb
- [test-world/](test-world/) — Referenzfirma und eingefrorene Gold-Suite
