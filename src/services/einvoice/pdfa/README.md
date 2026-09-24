# PDF/A-3 — externe Konformitätsprüfung

Die Testdatei neben dieser Beschreibung prüft **Strukturen**. Ob daraus ein
gültiges PDF/A-3 wird, entscheidet nicht dieses Repository, sondern ein
unabhängiger Prüfer. Hier steht, wie dieser Lauf wiederholt wird.

## Verwendeter Prüfer

**veraPDF 1.30.2** (greenfield), <https://verapdf.org> — der von der PDF
Association und der Open Preservation Foundation getragene Referenzvalidator.
Benötigt Java 8/11/17/21.

Der Validator liegt **absichtlich nicht im Repository**. Er ist ein
Prüfwerkzeug, kein Bestandteil des Produkts, rund 33 MB gross und steht unter
GPLv3/MPLv2 — er gehört in die Werkstatt, nicht in die Lieferung.

```sh
curl -sSLo verapdf-installer.zip https://software.verapdf.org/releases/verapdf-installer.zip
unzip -q verapdf-installer.zip
# Kopflose Installation über eine auto-install.xml, siehe https://docs.verapdf.org/install/
java -jar verapdf-greenfield-1.30.2/verapdf-izpack-installer-1.30.2.jar auto-install.xml
```

## Prüfbelege erzeugen

Die geprüften Dateien entstehen aus denselben Rechnungsdaten wie die Tests —
über `generateArchivalInvoicePdfA3`. Es wird **keine** neue Rechnungsnummer
vergeben; die Daten sind Fixtures.

## Befund vom Stand dieses Blocks

Aufruf je Datei: `verapdf -f 3u --format xml <datei>`

| Beleg | Ergebnis | Regeln |
| --- | --- | --- |
| Standard 19 % | konform | 148 bestanden, 0 fehlgeschlagen |
| mehrseitig (60 Positionen) | konform | 148 / 0 |
| Logo mit Alphakanal | konform | 148 / 0 |
| §13b Reverse Charge | konform | 148 / 0 |
| Kleinunternehmer | konform | 148 / 0 |
| manuelle Rechnung ohne Auftrag | konform | 148 / 0 |
| Sonderzeichen und Unicode | konform | 148 / 0 |
| mit eingebettetem XML-Anhang | konform | 148 / 0 |
| **absichtlich beschädigt** (XMP entfernt) | **nicht konform** | 147 / 1 — Regel `6.6.2.1-1` |

Die letzte Zeile ist die wichtigste: Ein Prüfer, der auch die beschädigte Datei
durchwinkt, sagt über die anderen acht nichts aus.

## Ausgangslage vor diesem Block

Dasselbe Werkzeug gegen das **unveränderte** Rechnungs-PDF: 145 bestanden, 3
fehlgeschlagen.

- `6.1.3-1` — im Trailer fehlt `/ID`
- `6.6.2.1-1` — im Katalog fehlt `/Metadata`
- `6.2.4.3-2` — `DeviceRGB` ohne RGB-OutputIntent (70 Fundstellen)

Schrifteinbettung, Unicode-Zuordnung und die verbotenen PDF-Merkmale waren
bereits in Ordnung. Das ist der Grund, warum die Konformitätsstufe **U** und
nicht **B** gewählt wurde — sie kostete nichts. Die ausführliche Begründung
steht in `pdfaProfile.ts`.
