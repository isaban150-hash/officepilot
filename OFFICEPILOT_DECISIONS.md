# OfficePilot – Entscheidungen

Verbindliche Produkt-, Technik- und Arbeitsentscheidungen. Nummeriert und **additiv**:
Ein Eintrag wird nie umgeschrieben. Gilt eine Entscheidung nicht mehr, wird ihr Status
auf `abgelöst durch D-0xx` gesetzt und ein neuer Eintrag angelegt — so bleibt
nachvollziehbar, warum eine Regel einmal anders lautete.

**Typen:** Produktentscheidung · Technische Entscheidung · Arbeitsweise
**Nachweis:** Datei/Test im Repository — oder ausdrücklich „nicht im Code verankert".

---

## D-001 – Confirm-first

**Typ:** Produktentscheidung · **Status:** gültig

**Entscheidung:** OfficePilot übernimmt fachlich relevante Werte oder Aktionen nicht
still; wo eine Bestätigung erforderlich ist, entscheidet der Nutzer.

**Begründung:** Falsche Kundenzuordnungen, Beträge oder Ablagen sind im Nachhinein
teuer zu korrigieren. Ein Vorschlag, den der Nutzer ablehnen kann, ist immer besser als
eine stille Übernahme.

**Nachweis:** `customerOwnCompanyGuard.ts`, `assignCustomerToVorgang`,
`updateVorgangCustomerFromMaster` (schreibt erst nach Nutzerklick),
`invoiceFinalizationPreflightService`.

---

## D-002 – Keine automatischen Positionsimporte

**Typ:** Produktentscheidung · **Status:** gültig

**Entscheidung:** Positionen aus einem Vertrag oder Leistungsverzeichnis werden nie
ohne Nutzerentscheidung in einen Vorgang oder eine Rechnung übernommen.

**Begründung:** Positionen bestimmen den Rechnungsbetrag. Eine Fehlerkennung würde
direkt zu einer falschen Rechnung führen.

**Nachweis:** `contractPositionImportService`, `ContractOrderProposalPanel`
(Auswahl durch den Nutzer), `confirmImportContractPositions`.

---

## D-003 – `needs_review` respektieren

**Typ:** Produktentscheidung · **Status:** gültig

**Entscheidung:** Ein Review-Status verschwindet nicht durch einen automatischen
Vorgang. Er wird nur durch eine Nutzerentscheidung aufgelöst.

**Begründung:** Der Status ist das Signal „hier ist etwas unsicher". Wird er
automatisch entfernt, geht genau die Information verloren, für die er da ist.

**Nachweis:** Confidence- und Review-Kennzeichnung in der Dokumentpipeline.

---

## D-004 – `deselected` respektieren

**Typ:** Produktentscheidung · **Status:** gültig

**Entscheidung:** Vom Nutzer abgewählte Inhalte werden nicht still wieder aktiviert.

**Begründung:** Eine Abwahl ist eine bewusste Entscheidung. Sie später zu übergehen,
wäre aus Nutzersicht ein Fehler des Programms.

**Nachweis:** Auswahlzustände in den Import- und Vorschlagspfaden.

---

## D-005 – Ablage von Tankbelegen

**Typ:** Produktentscheidung · **Status:** gültig

**Entscheidung:** Tankbelege werden standardmäßig unter `/Tankbelege/<Jahr>/<Monat>/`
abgelegt.

Tankbelege werden **nicht** standardmäßig unter einem Fahrzeugordner abgelegt — weder
als `/Tankbelege/<Fahrzeug>/<Jahr>/<Monat>/` noch unter `/Fahrzeuge/…`.

**Begründung:** Tankbelege sind ein eigener, häufiger Belegtyp mit eigener
Auswertungslogik. Sie unter Fahrzeuge einzusortieren vermischt Beleg und Anlage. Die
Gliederung nach Jahr und Monat entspricht der Art, wie Belege im Betrieb tatsächlich
gesucht und an den Steuerberater übergeben werden.

**Nachweis:** **Nicht im Code verankert.** Der Dokumentkatalog kennt die Art
`tankbeleg`, ordnet sie aber heute der Fahrzeug-Kategorie zu. Umsetzung offen — siehe
[OFFICEPILOT_ROADMAP.md](OFFICEPILOT_ROADMAP.md), Bereich 6.

---

## D-006 – Analyse vor Implementierung

**Typ:** Arbeitsweise · **Status:** gültig

**Entscheidung:** Vor jedem Implementierungsblock gilt die Reihenfolge:
(1) eigene fachliche Analyse, (2) getrennter Analyse-only-Auftrag an den Coding-Agenten,
(3) Vergleich beider Bewertungen, (4) Implementierung erst nach ausdrücklicher Zustimmung.

**Begründung:** Zwei unabhängige Analysen decken unterschiedliche Lücken auf. Mehrere
Blöcke dieses Projekts wurden dadurch vor der Umsetzung neu geschnitten.

**Nachweis:** nicht im Code verankert (Arbeitsweise).

---

## D-007 – Kostenbewusstes Testen

**Typ:** Arbeitsweise · **Status:** gültig

**Entscheidung:** Es laufen nur die Tests, die zum aktuellen Block gehören. Keine Full
Suite nach jedem Fix, keine Wiederholung unveränderter Bereiche. Zusätzliche Tests nur
mit fachlicher Begründung. Bei Codeänderungen `npx tsc --noEmit` und `git diff --check`
als günstige Grundprüfung. Realgerätetests nur bei relevantem Risiko.

**Begründung:** Das Repository enthält knapp 500 Testdateien. Sie vollständig nach jeder
Korrektur zu starten kostet Zeit und Geld, ohne zusätzliche Sicherheit für den geänderten
Bereich zu liefern.

**Nachweis:** `npm test` läuft gegen `vitest.core.config.ts` (Kernauswahl);
`npm run test:full` bleibt die vollständige Regression.

---

## D-008 – Git-Writes nur durch den Nutzer

**Typ:** Arbeitsweise · **Status:** gültig

**Entscheidung:** Der Coding-Agent führt kein `git add`, `commit`, `push`, `restore`,
`reset` oder `checkout` aus. Git-Schreibvorgänge erfolgen kontrolliert durch den Nutzer.

**Begründung:** Der Nutzer behält die Kontrolle darüber, was in die Historie gelangt,
und kann jeden Block vorher prüfen.

**Nachweis:** nicht im Code verankert (Arbeitsweise).

---

## D-009 – Ein Terminalschritt nach dem anderen

**Typ:** Arbeitsweise · **Status:** gültig

**Entscheidung:** Befehle werden einzeln und zuverlässig kopierbar ausgegeben. Es wird
das ASCII-Minus verwendet, kein typografischer Gedankenstrich.

**Begründung:** Zusammengesetzte Befehlsketten sind schwer zu prüfen, und ein
typografischer Strich bricht den Befehl beim Einfügen.

**Nachweis:** nicht im Code verankert (Arbeitsweise).

---

## D-010 – Keine destruktiven Änderungen an Testdaten

**Typ:** Arbeitsweise · **Status:** gültig

**Entscheidung:** Produktive, entfernte oder lokale Testdaten, `localStorage`,
IndexedDB und Kontozustände werden nicht destruktiv verändert, solange das nicht
ausdrücklich freigegeben wurde.

**Begründung:** Reale Testdaten sind Grundlage laufender Realtests. Ein stiller Reset
zerstört den Vergleichsmaßstab.

**Nachweis:** nicht im Code verankert (Arbeitsweise).

---

## D-011 – UI/UX wird grundlegend neu aufgebaut

**Typ:** Produktentscheidung · **Status:** gültig

**Entscheidung:** Die Oberfläche wird nicht kosmetisch überarbeitet, sondern
grundlegend neu aufgebaut — Informationshierarchie, Navigation, Formulare, Typografie,
Abstände, mobile Darstellung.

**Begründung:** Die heutige Oberfläche ist gewachsen und zeigt zu viel gleichzeitig.
Ein Facelift würde die Struktur nicht verbessern.

**Nachweis:** Zielbild, kein Ist-Stand. Vorhanden sind ein Token-System
(`src/styles/tokens.css`) und eine Komponentenbasis (`src/components/ui`); daneben steht
umfangreiches, gewachsenes Seiten-CSS.

---

## D-012 – Zentraler Einstellungsbereich

**Typ:** Produktentscheidung · **Status:** gültig

**Entscheidung:** Es gibt künftig einen zentralen Einstellungsbereich mit mindestens:
Firmenprofil, Logo, Stammdaten, Rechnungs- und Dokumentvorlagen, Standardwerte,
Zahlungsbedingungen, Skonto, E-Mail/Kommunikation. Er überlädt die Hauptnavigation nicht.

**Begründung:** Einstellungen liegen heute verstreut über mehrere Seiten. Selten
benötigte Optionen gehören gebündelt und aus dem Hauptweg heraus.

**Nachweis:** **Nicht vorhanden.** Einstellungen verteilen sich derzeit auf
`FirmendatenPage`, `MehrPage`, `SyncPage`, `AdminUsersPage`, `SetupPage`.

---

## D-013 – Zentrales Branding

**Typ:** Produktentscheidung · **Status:** gültig

**Entscheidung:** Logo und Markenfarbe werden zentral verwaltet und von allen
Dokumentvorlagen gemeinsam genutzt.

**Begründung:** Sonst löst jede spätere Vorlage Absender und Erscheinungsbild selbst
auf — mit unterschiedlichen Ergebnissen.

**Nachweis:** `src/types/branding.ts`, `brandingSnapshotService.ts`,
`brandingAssetCloudService.ts` (Modell und Speicher vorhanden, **noch ohne produktiven
Aufrufer**); Legacy-Weg bleibt `CompanyProfile.logoDataUrl`.

---

## D-014 – Kein Gemini-Aufruf aus dem Browser

**Typ:** Technische Entscheidung · **Status:** gültig

**Entscheidung:** Produktive Gemini-Aufrufe direkt aus dem Browser mit
`VITE_GEMINI_API_KEY` sind verboten. Der Schlüssel ist ein Server-Secret.

**Begründung:** Alles mit `VITE_`-Präfix wird in das ausgelieferte Bundle kompiliert und
ist damit für jeden Nutzer lesbar. Der frühere Aufruf übertrug den Schlüssel zusätzlich
als Adressparameter.

**Nachweis:** `src/services/ai/aiProxyClient.ts`, `supabase/functions/ai/index.ts`;
maschinell durchgesetzt durch `src/services/ai/aiKeyRemoval01.test.ts`.

---

## D-015 – Bezahlte Funktionen serverseitig schützen

**Typ:** Technische Entscheidung · **Status:** gültig

**Entscheidung:** Funktionen, die Kosten verursachen oder Teil eines künftigen
Bezahlmodells sind, werden serverseitig geschützt. Eine Prüfung nur im Frontend genügt
nicht.

**Begründung:** Das Frontend ist beim Nutzer und damit veränderbar. Wer die
Routenführung umgeht, erreicht die Serverfunktionen unverändert.

**Nachweis:** Für den KI-Endpunkt umgesetzt (`supabase/functions/ai/index.ts`).
Für Sync, Storage und übrige RPCs **noch offen** — siehe ROADMAP, Bereich 15.

---

## D-016 – Gewerkeauswahl für V1

**Typ:** Produktentscheidung · **Status:** gültig

**Entscheidung:** V1 richtet sich an klassische Handwerksbetriebe. Geschäftsmodelle mit
Kasse, TSE und Laufkundschaft — etwa Friseursalons — gehören nicht zwingend zum V1-Kern.

**Begründung:** Sie bräuchten Kassensystem, Terminbuchung und andere gesetzliche
Anforderungen; das ist ein eigenes Produkt, kein Zusatz.

**Nachweis:** Produktentscheidung. Die Fachlogik selbst ist weitgehend gewerkeneutral.

---

## D-017 – Aufbewahrung und Löschen

**Typ:** Produktentscheidung · **Status:** gültig

**Entscheidung:** OfficePilot bezeichnet Geschäftsunterlagen nicht leichtfertig als
löschbar. Aufbewahrungsanforderungen werden berücksichtigt, bevor eine Entsorgung
vorgeschlagen wird. Es wird keine Rechtsberatung erteilt.

**Begründung:** Ein falscher Löschhinweis kann einen Betrieb in echte Schwierigkeiten
bringen. Zurückhaltung ist hier der einzig vertretbare Standard.

**Nachweis:** **Nicht im Code verankert.** Es gibt heute weder Aufbewahrungsfristen noch
Löschschutz. Siehe ROADMAP, Bereich 5.

---

## D-018 – Dokumentgebundene KI-Antworten

**Typ:** Produktentscheidung · **Status:** gültig

**Entscheidung:** Antworten zu einem Dokument stützen sich auf dessen tatsächlichen
Inhalt. Unsicherheit wird kenntlich gemacht. Es werden keine Dokumentfakten erfunden.

**Begründung:** Eine plausible, aber erfundene Aussage über einen Behördenbrief ist
schädlicher als keine Antwort.

**Nachweis:** `aiGuardrails.ts`, `aiOutputGuardService.ts`,
`documentAiAnswerPostCheck.ts`, `validateFactAssignments` (prüft jede Zuordnung gegen die
tatsächlich erkannten Fakten).

---

## D-019 – Keine geschäftlich relevante Aktion ohne Bestätigung

**Typ:** Produktentscheidung · **Status:** gültig

**Entscheidung:** Nachrichten, Rechnungen, Zuordnungen und vergleichbare geschäftliche
Aktionen werden nicht ohne die erforderliche Nutzerbestätigung gespeichert, gesendet
oder ausgeführt.

**Begründung:** Ergänzt D-001 um den Ausgangsweg: Was den Betrieb verlässt, muss der
Betrieb gewollt haben.

**Nachweis:** Freigabepflicht bei Rechnungen und Nachträgen; Entwürfe werden erzeugt,
aber nicht versendet (ein Versandweg existiert derzeit ohnehin nicht).

---

## D-020 – Speichereffiziente Verarbeitung von Fotos

**Typ:** Produktentscheidung · **Status:** gültig

**Entscheidung:** Große Smartphone-Fotos werden vor der dauerhaften Ablage verkleinert
oder komprimiert, soweit Lesbarkeit und OCR-Qualität erhalten bleiben.

**Begründung:** Unverarbeitete Fotos sprengen lokale Speichergrenzen und verteuern
später jede Cloud-Ablage.

**Nachweis:** Teilweise vorhanden für Dokument-Uploads
(`documentFileRasterEncodeService`, Thumbnail- und Vorschau-Erzeugung). Für Logos
ausdrücklich **nicht** umgesetzt — dort würde JPEG-Neukodierung die Transparenz
zerstören (siehe `brandingLogoValidation.ts`).

---

## D-021 – Pflege dieser Master-Dokumentation

**Typ:** Arbeitsweise · **Status:** gültig

**Entscheidung:** Die fünf Master-Dateien werden nach festen Auslösern aktualisiert:

| Auslöser | Zu aktualisieren |
|---|---|
| Größerer Block abgeschlossen | `HANDOFF` und betroffener `ROADMAP`-Bereich |
| Architekturentscheidung getroffen | `DECISIONS`; `MASTER` nur, wenn die Architekturgrundlage betroffen ist |
| Migration remote angewendet | `HANDOFF`; `GO_LIVE` nur bei Release- oder Sicherheitsbezug |
| Neuer externer Dienst | `MASTER` und `GO_LIVE` |
| Produktentscheidung geändert | Alten `DECISIONS`-Eintrag als abgelöst markieren, neuen anlegen |
| Vor einer Übergabe | `HANDOFF` gegen den echten Git-Stand prüfen (`git log -1`, `git status -sb`) |
| Vor Go-Live | alle fünf Dateien prüfen |

**Begründung:** Eine veraltete Dokumentation ist schlechter als keine. Die Auslöser
sorgen dafür, dass meist nur ein bis zwei Dateien betroffen sind — sonst wird die Pflege
unrealistisch und unterbleibt.

**Nachweis:** nicht im Code verankert (Arbeitsweise).

---

## D-022 – Branding-Löschsemantik

**Typ:** Technische Entscheidung · **Status:** gültig

**Entscheidung:** Ein gespeicherter `CompanyProfile`-Brandingblock wird ausdrücklich nur
durch `branding: {}` geleert.

Ein fehlender Schlüssel und `branding: undefined` bedeuten clientseitig **keinen**
Löschvorgang und führen beim Cloud-Write zum Preserve-Verhalten aus BRANDING-01E-0.
`branding: null` ist ebenfalls kein gültiges Löschsignal.

**Begründung:** BRANDING-01E-0 unterscheidet serverseitig bewusst zwischen einem
fehlenden Feld und einem leeren Objekt, um Altclients vor stillem Datenverlust zu
schützen. Ein Client, der `branding` nicht kennt, sendet den Schlüssel nicht mit — würde
das als „löschen" gelten, verschwände das Branding unbemerkt und ohne Konflikt.

Die Fußangel liegt bei `undefined`: Es sieht im Code wie ein Löschbefehl aus,
verschwindet aber in der JSON-Serialisierung und wirkt damit wie „nicht gesendet".

Diese Regel gilt **ausschließlich für `branding`**. Alle übrigen `CompanyProfile`-Felder
behalten ihre vollständige Replace-Semantik; es gibt keine allgemeine Regel, unbekannte
oder fehlende Felder zu bewahren.

**Nachweis:** `supabase/migrations/20250902120000_company_profile_branding_preserve.sql`
(Serverseite, remote angewendet und per Runtime-Test bestätigt);
`src/services/branding/brandingCompanyProfilePreserve01.test.ts` (Struktur der RPC);
`src/services/branding/brandingCompanyProfileCloudContract01.test.ts` (Client-Vertrag,
insbesondere `{}` gegenüber „fehlt" und `undefined`).

---

## D-023 – Übergang vom Legacy-Logo zum Branding-Asset

**Typ:** Technische Entscheidung · **Status:** gültig

**Entscheidung:** Für die Übergangszeit, in der `CompanyProfile.logoDataUrl` und
`CompanyProfile.branding.logo` nebeneinander existieren, gilt:

1. **Anzeigepriorität in den Firmendaten:** `branding.logo` vor `logoDataUrl`.
2. **Bei Resolver-Fehler** darf die Firmendatenseite auf `logoDataUrl` zurückfallen und
   **informiert den Nutzer** darüber.
3. Diese Fallbackregel gilt **nicht** für historische Rechnungen und PDFs. Dort bleibt es
   dabei: Fehlt das damalige Logo, wird keines gezeigt.
4. Nach einem erfolgreichen neuen Branding-Upload bleibt ein vorhandenes `logoDataUrl`
   **lokal erhalten**.
5. Es gibt **keine automatische Legacy-Migration**.
6. „Logo entfernen" entfernt **beides**: `branding.logo` und das lokale `logoDataUrl`.
7. `primaryColor` bleibt dabei erhalten.
8. Ist `branding` danach leer, wird `branding: {}` gesetzt — gemäß D-022, nicht der
   Schlüssel weggelassen.
9. Das unveränderliche Asset selbst wird **nicht** gelöscht; entfernt wird die Referenz.

**Begründung:** Punkt 3 ist der Kern. In den Firmendaten konkurrieren zwei Darstellungen
desselben heutigen Logos — die ältere zu zeigen ist besser als eine leere Fläche. In einem
historischen Dokument wäre genau dasselbe eine stille Fälschung.

Punkt 6 folgt der Nutzersicht: Bliebe das Legacy-Logo stehen, erschiene nach dem Entfernen
überraschend das alte wieder, und niemand könnte erklären, warum. Punkt 4 und 5 verhindern
zugleich, dass daraus ein automatischer, unumkehrbarer Datenverlust wird — entfernt wird
nur auf ausdrückliche Nutzeraktion.

Punkt 9 folgt aus der Storage-Foundation: Es gibt bewusst keine DELETE-Policy, damit ein
ersetztes Logo für historische Dokumente erhalten bleibt.

Diese Regeln gelten **nur für das Firmenlogo**. Sie sind keine allgemeine Datei- oder
Storage-Regel.

**Nachweis:** `src/hooks/useCompanyLogoObjectUrl.ts`, `src/pages/FirmendatenPage.tsx`,
`src/brandingLogoAssetUpload01.test.tsx`.
