/**
 * LV-EXTRACTION-BOUNDED-TOKEN-01B — entarteter OCR-Text darf die Extraktion
 * nicht lahmlegen.
 *
 * Gemessener Anlass: `LV_FLAT_SEQUENCE_ROW` ist das einzige nicht
 * zeilenverankerte Muster. Seine erste Gruppe — die Beschreibung — war
 * unbegrenzt lazy. Auf einer Zeile ohne jedes Leerzeichen begann die Suche
 * deshalb an jeder Position neu und dehnte die Gruppe jedes Mal bis zum
 * Zeilenende: 50.000 Zeichen kosteten ~8,5 Sekunden, 75.000 ~19 Sekunden, bei
 * sauber quadratischem Wachstum. Ein realer Vertrag derselben Länge kostet
 * einstellige bis niedrig zweistellige Millisekunden.
 *
 * Bewusst **keine** Millisekunden-Zusicherung: Die Laufzeit streut über
 * Maschinen, und eine Zeitgrenze wäre genau die Art von wackeligem Test, die
 * wir andernorts beseitigt haben. Das normale Vitest-Budget ist der grobe
 * Deckel; geprüft wird das Verhalten.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { describe, expect, it } from 'vitest';
import { extractBillOfQuantitiesPositions } from './billOfQuantitiesExtractionService';

/** Eine einzige Zeile aus 50.000 Zeichen ohne jeden Trenner. */
const DEGENERATE_LINE = 'x'.repeat(50_000);

describe('LV-EXTRACTION-BOUNDED-TOKEN-01B — entarteter Input', () => {
  it('D1: eine 50.000-Zeichen-Zeile ohne Trenner kehrt zurück und erfindet nichts', () => {
    /*
     * Die strukturelle Begründung, warum hier gar kein Treffer möglich ist:
     * Der Flat-Fallback verlangt zwischen Beschreibung und Menge zwingend
     * horizontalen Whitespace. Eine Zeile ohne Leerzeichen kann das Muster
     * also niemals erfüllen — sie darf die Suche aber auch nicht aufhalten.
     */
    expect(DEGENERATE_LINE).not.toMatch(/\s/);
    expect(DEGENERATE_LINE).toHaveLength(50_000);

    expect(() => extractBillOfQuantitiesPositions(DEGENERATE_LINE)).not.toThrow();
    expect(extractBillOfQuantitiesPositions(DEGENERATE_LINE)).toEqual([]);
  });

  it('D2: auch andere trennerlose Zeichenklassen erzeugen keine Positionen', () => {
    const cases: Array<[string, string]> = [
      ['lange Buchstabenfolge', 'abcdefghij'.repeat(5_000)],
      ['base64-artig', 'QWxhZGRpbjpvcGVuIHNlc2FtZQ'.repeat(2_000)],
      ['OCR-artig gemischt', 'llllIIII1111oooo0000'.repeat(2_500)],
    ];

    for (const [label, text] of cases) {
      expect(text.length, label).toBeGreaterThanOrEqual(45_000);
      expect(extractBillOfQuantitiesPositions(text), label).toEqual([]);
    }
  });

  it('D3: eine gültige Position bleibt erhalten, auch neben einer entarteten Zeile', () => {
    const text = [
      DEGENERATE_LINE,
      'Dachabdichtung 950,00 m² 3,80 3.610,00',
      DEGENERATE_LINE,
    ].join('\n');

    const positions = extractBillOfQuantitiesPositions(text);

    expect(positions).toHaveLength(1);
    expect(positions[0]!.description).toBe('Dachabdichtung');
    expect(positions[0]!.quantity).toBe(950);
    expect(positions[0]!.unitPrice).toBe(3.8);
    expect(positions[0]!.lineTotal).toBe(3610);
  });

  /*
   * Die Reserve der Grenze. Der Flat-Fallback liest als Beschreibung genau
   * **einen** Token — seine Zeichenklasse enthält kein Leerzeichen. Der
   * längste über diesen Weg je erfasste Token im Testbestand ist 12 Zeichen
   * lang, der längste Token in den realen Vertragsfixtures 31. Ein
   * zusammengesetztes Fachwort von 80 Zeichen ist damit weit jenseits des
   * Realistischen und muss trotzdem sicher durchgehen.
   */
  it('D4: ein ungewöhnlich langer, aber echter Beschreibungstoken wird erkannt', () => {
    const longToken =
      'Dachflaechenabdichtungsbahn-Randanschluss/Attika-Sonderprofil.Ausfuehrung';
    expect(longToken.length).toBeGreaterThan(31);
    expect(longToken.length).toBeLessThan(120);
    expect(longToken).not.toMatch(/\s/);

    const positions = extractBillOfQuantitiesPositions(`${longToken} 12,00 m 45,00 540,00`);

    expect(positions).toHaveLength(1);
    expect(positions[0]!.description).toBe(longToken);
    expect(positions[0]!.quantity).toBe(12);
    expect(positions[0]!.unitPrice).toBe(45);
    expect(positions[0]!.lineTotal).toBe(540);
  });

  /*
   * LV-EXTRACTION-BOUNDED-TOKEN-01C — der Grenzfall, und warum „gekürzt" hier
   * nicht als richtig gilt.
   *
   * Mit der blossen Obergrenze aus 01B lieferte ein Token über 120 Zeichen
   * weiterhin einen Treffer — das unverankerte Muster setzte weiter rechts an
   * und nahm dessen **letzte** 120 Zeichen als Beschreibung. Menge und Preise
   * waren dabei korrekt, die Beschreibung aber stillschweigend beschnitten.
   *
   * Das ist die gefährlichere Variante: Eine halbe Beschreibung landet
   * unbemerkt im Auftrag und sieht dort vertrauenswürdig aus. Der Lookbehind
   * erzwingt deshalb den Start an einer echten Tokengrenze — bis 120 Zeichen
   * vollständig, darüber gar kein Flat-Treffer. Die vier zeilenverankerten
   * Muster sind davon nicht betroffen.
   */
  it('D5: Grenzfall — bis 120 Zeichen vollständig, darüber kein still gekürzter Treffer', () => {
    for (const within of [119, 120]) {
      const token = 'a'.repeat(within);
      const result = extractBillOfQuantitiesPositions(`${token} 12,00 m 45,00 540,00`);

      expect(result, `Token ${within}: Position fehlt`).toHaveLength(1);
      // Vollständig, nicht beschnitten.
      expect(result[0]!.description, `Token ${within}: Beschreibung`).toBe(token);
      expect(result[0]!.quantity, `Token ${within}: Menge`).toBe(12);
      expect(result[0]!.unitPrice, `Token ${within}: Einzelpreis`).toBe(45);
      expect(result[0]!.lineTotal, `Token ${within}: Gesamtpreis`).toBe(540);
    }

    for (const over of [121, 200, 500]) {
      const token = 'a'.repeat(over);
      const result = extractBillOfQuantitiesPositions(`${token} 12,00 m 45,00 540,00`);

      expect(result, `Token ${over}: still gekürzter Treffer entstanden`).toEqual([]);
    }
  });

  /*
   * Die Gegenprobe zum Lookbehind: Ein Token beginnt nicht nur nach einem
   * Leerzeichen, sondern auch nach Zeichen, die gar nicht Teil einer
   * Beschreibung sein können. Die Grenze darf solche Startstellen nicht
   * verschlucken.
   */
  it('D6: ein Tokenanfang nach Satzzeichen bleibt ein gültiger Startpunkt', () => {
    const positions = extractBillOfQuantitiesPositions(
      'Vorbemerkung: Flatleistung 6,00 m² 5,00 30,00',
    );

    expect(positions).toHaveLength(1);
    expect(positions[0]!.description).toBe('Flatleistung');
    expect(positions[0]!.quantity).toBe(6);
    expect(positions[0]!.lineTotal).toBe(30);
  });
});
