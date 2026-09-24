# ZUGFeRD 2.5.2 / Factur-X 1.09.2 — Profil EN16931

Die Testdatei nebenan prüft **Strukturen und Invarianten**. Ob das Ergebnis
profilkonform ist, entscheiden die offiziellen Artefakte. Hier steht, welche das
sind, woher sie kommen und wie der Lauf wiederholt wird.

## Woher die normativen Artefakte stammen

Das Infopaket von **FeRD** (`ferd-net.de`) und **FNFE-MPE** (`fnfe-mpe.org`)
steht nur hinter einem Anmeldeformular mit Namens- und E-Mail-Pflicht bereit.
Ein solches Formular wurde **nicht** ausgefüllt.

Die darin enthaltenen normativen Dateien liefert die Referenzimplementierung des
ZUGFeRD-Projekts unverändert mit und veröffentlicht sie offen:

| Artefakt | Pfad in `github.com/ZUGFeRD/mustangproject`, Stand `core-2.26.0` |
| --- | --- |
| XSD EN16931 | `validator/src/main/resources/schema/ZF_250/EN16931/FACTUR-X_EN16931.xsd` (+ 3 Typschemata) |
| Schematron EN16931 | `validator/src/main/resources/zugferd2p0_en16931.sch` |
| kompiliertes XSLT | `validator/src/main/resources/xslt/zugferd2p0_en16931.xslt` |
| Profil-Kennungen | `library/…/ZUGFeRD/Profiles.java` |
| Anhang, Dateiname, Medientyp, AFRelationship | `library/…/ZUGFeRD/ZUGFeRDExporterFromA3.java` |
| Factur-X-XMP | `library/…/ZUGFeRD/XMPSchemaZugferd.java` |
| PDF/A-Erweiterungsschema | `library/…/ZUGFeRD/XMPSchemaPDFAExtensions.java` |

Dass diese Fassung **2.5.2** trägt, ist belegt: Release `core-2.25.0` vom
2026-08-05 nennt „Support for ZUGFeRD 2.5.2 (=Factur-X 1.09.2, #1216)"
ausdrücklich in den Veröffentlichungshinweisen; `core-2.26.0` vom 2026-08-25
baut darauf auf. Ein grünes Ergebnis einer älteren Fassung wäre kein Nachweis
gewesen.

Alle daraus abgelesenen Werte stehen in `zugferdProfile.ts`, jeder mit Quelle.

## Verwendete Prüfer

- **ZUGFeRD-Referenzvalidator** (Mustang CLI 2.26.0) — führt die oben genannten
  XSD- und Schematron-Artefakte aus. SHA-256 des Jars:
  `42d7868cb68264874a7b8cab4c3587b03b23ccc7cd72373da917f66758bb9736`
- **veraPDF 1.30.2** (greenfield), Profil PDF/A-3U — dieselbe Fassung wie in
  04E1.

Der KoSIT-XRechnung-Validator wurde für dieses Profil **nicht** verwendet. Er
prüft die XRechnung-CIUS und hätte über EN16931 nichts Belastbares gesagt.

Beide Werkzeuge liegen **nicht im Repository**. Sie sind Prüfwerkzeuge, kein
Bestandteil des Produkts.

```sh
curl -sSLo Mustang-CLI-2.26.0.jar \
  https://github.com/ZUGFeRD/mustangproject/releases/download/core-2.26.0/Mustang-CLI-2.26.0.jar
java -jar Mustang-CLI-2.26.0.jar --action validate --source <datei>
```

## Zwei getrennte Beweise

Ein hybrides Dokument muss zwei Prüfungen bestehen, und sie prüfen
Verschiedenes: der eine den Rechnungsdatensatz, der andere die Hülle. Nur
zusammen sagen sie etwas aus.

### 1 — XML gegen ZUGFeRD 2.5.2 EN16931

Alle Belege: Profil erkannt als `urn:cen.eu:en16931:2017`, **0 fehlgeschlagene
Regeln, keine Warnungen**, Status `valid`.

Geprüft: Standard 19 %, Standard 7 %, Reverse Charge §13b, Kleinunternehmer,
manuelle Rechnung, Teilrechnung, Abschlag mengenbasiert, Abschlag pauschal,
Schlussrechnung ohne Abzüge, Korrekturrechnung, Sonderzeichen, 60 Positionen.

Der erste Lauf meldete `PEPPOL-EN16931-R008` („Document MUST not contain empty
elements") auf `ApplicableHeaderTradeDelivery`. Die Regel ist im Profil auf
Warnung herabgestuft — sie wurde trotzdem behoben und nicht weggesehen: Das
Element trägt jetzt das Liefer-/Leistungsdatum BT-72 aus dem Leistungsende.

### 2 — Hybrid-PDF gegen PDF/A-3U

Alle Belege: **148 bestandene, 0 fehlgeschlagene Regeln**.

### Gegenproben

Ein Prüfer, der auch Fehlerhaftes durchwinkt, hat nichts bewiesen.

| Variante | Erwartung |
| --- | --- |
| N1 — falscher Profil-Identifier | Prüfer wählt das Profil nicht mehr / lehnt ab |
| N2 — Pflichtfeld Verkäufername entfernt | abgelehnt |
| N3 — leeres `ApplicableHeaderTradeDelivery` | Regel `PEPPOL-EN16931-R008` schlägt an |
| N4 — Anhang heisst anders als das XMP behauptet | Abweichung nachweisbar |
| N5 — PDF/A-Metadaten entfernt | veraPDF lehnt ab (`6.6.2.1-1`) |

## Was hier bewusst noch fehlt

Keine Oberfläche, kein Knopf, keine Auswahl zwischen XRechnung und ZUGFeRD,
keine Cloud-Ablage und kein Versand. 04E2 beweist den Artefaktkern; die
sichtbare Integration ist 04E3.
