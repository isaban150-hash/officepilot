# Schriften für die Rechnungs-PDF

## Warum eingebettet

`pdf-lib` bringt vierzehn Standardschriften mit, die alle **WinAnsi** kodieren — also
grob Latin-1. Ein Firmenname wie `Çırmak` ist damit nicht darstellbar: `ı` (U+0131)
liegt ausserhalb, und `drawText` würde entweder werfen oder — wie bis
PDF-TEXT-RENDERING-01B — ein `?` erzeugen.

Auf einem Rechnungsdokument ist der Aussteller eine Rechtsangabe. Ein still verfälschter
Name ist kein Schönheitsfehler, und eine Transliteration (`ı → i`) wäre eine Fälschung.
Deshalb wird eine echte Unicode-Schrift eingebettet.

## Verwendete Schrift

**Liberation Sans**, Schnitte Regular und Bold.

- Herkunft: `node_modules/pdfjs-dist/standard_fonts/` — sie liegt dem bereits
  eingesetzten `pdfjs-dist` bei und wurde von dort unverändert übernommen. Es wurde
  nichts heruntergeladen und nichts verändert.
- Abdeckung: Latin-1 und Latin Extended-A (damit `ı İ ş Ş ğ Ğ ç Ç`), deutsche Umlaute
  und `ß`, typografische Striche `– —`, Anführungszeichen `„ “ ”`, `€` und `§`.
- **Metrisch kompatibel zu Helvetica/Arial.** Das ist der Grund für genau diese Wahl:
  Der Wechsel von `StandardFonts.Helvetica` verschiebt Zeilenumbrüche und Tabellen
  praktisch nicht.
- Grösse: je Schnitt rund 137 KB. In das erzeugte PDF wandert dank Subsetting nur der
  tatsächlich benutzte Glyphenausschnitt.

## Lizenz

**SIL Open Font License 1.1** — vollständiger Text in `LICENSE_LIBERATION.txt`.

Die OFL erlaubt Einbetten, Bündeln und Weitergabe mit Software ausdrücklich; die einzige
Einschränkung ist der Verkauf der Schrift für sich allein. Für Dokumente, die mit der
Schrift erzeugt werden, gilt die Lizenz nicht. Der reservierte Name „Liberation" bleibt
unangetastet, weil die Dateien unverändert übernommen wurden.
