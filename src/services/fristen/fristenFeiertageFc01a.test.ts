/**
 * FINANZ-CORE-01A (Feiertage, § 193 BGB) — Kalender, PLZ-Tabelle und Fristfenster, Nacharbeit zu WEISS
 * FC01A-END16-R1 (Fristende Fr 01.05.2026, Zahlung Mo 04.05.2026 galt als verspätet).
 *
 *  G   gemeinsame Vektoren (`fristenVektoren.json`): Ostern, Feiertag je Land, PLZ, Fristfenster.
 *      Derselbe Text steht wortgleich in `supabase/tests/fc01a_feiertage.sql` (G0 prüft das), dort rechnet
 *      der Server dieselben Fälle.
 *  P   PLZ-Tabelle = Server-Tabelle (kanonische md5) und Sonderfälle Österreich.
 *  L   Lage einer Rechnung: Vereinbarung > Kunde > Land > PLZ > unbekannt (wie FT6 auf dem Server).
 *  Z   Zahlungstag gegen Fenster: fristgerecht / ungeklärt / verspätet.
 *  N   Angabe am Kunden in kanonischer Form.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { easterSunday, feiertagImLand, type Bundesland } from './feiertage';
import {
  berechneFristFenster,
  ermittleFristLage,
  laenderFuerPlz,
  normalizeHolidayLocation,
  pruefeZahlungstag,
  type FristLage,
} from './fristende';
import { PLZ_LEITBEREICHE, PLZ_LEITBEREICHE_MD5 } from './plzLeitbereiche';

const VEKTOREN_TEXT = readFileSync(resolve(process.cwd(), 'src/services/fristen/fristenVektoren.json'), 'utf8');
const VEKTOREN = JSON.parse(VEKTOREN_TEXT) as {
  ostern: Array<[number, string]>;
  feiertage: Array<[string, Bundesland, string]>;
  plz: Array<[string, { laender: string[]; augsburg: string } | null]>;
  fenster: Array<{ name: string; ende: string; lage: FristLage; fruehestens: string; spaetestens: string }>;
};

function alsText(day: string, land: Bundesland): string {
  const f = feiertagImLand(day, land);
  return f.art === 'gemeinde' ? `gemeinde:${f.gemeinde}` : f.art;
}

describe('G — gemeinsame Vektoren mit dem Server', () => {
  it('G0 der SQL-Test trägt die Vektoren wortgleich', () => {
    const sql = readFileSync(resolve(process.cwd(), 'supabase/tests/fc01a_feiertage.sql'), 'utf8');
    const match = /\$vektoren\$([\s\S]*?)\$vektoren\$/.exec(sql);
    expect(match, 'Vektorblock im SQL-Test fehlt').not.toBeNull();
    expect(match![1].replace(/\r\n/g, '\n')).toBe(VEKTOREN_TEXT.replace(/\r\n/g, '\n').trim());
  });

  it.each(VEKTOREN.ostern)('G1 Ostersonntag %i = %s', (jahr, erwartet) => {
    expect(easterSunday(jahr)).toBe(erwartet);
  });

  it.each(VEKTOREN.feiertage)('G2 %s in %s: %s', (tag, land, erwartet) => {
    expect(alsText(tag, land)).toBe(erwartet);
  });

  it.each(VEKTOREN.plz)('G3 PLZ "%s"', (zip, erwartet) => {
    const ergebnis = laenderFuerPlz(zip);
    if (erwartet === null) {
      expect(ergebnis).toBeNull();
      return;
    }
    expect([...(ergebnis?.laender ?? [])].sort()).toEqual([...erwartet.laender].sort());
    expect(ergebnis?.augsburg).toBe(erwartet.augsburg);
  });

  it.each(VEKTOREN.fenster.map((v) => [v.name, v] as const))('G4 %s', (_name, vektor) => {
    expect(berechneFristFenster(vektor.ende, vektor.lage)).toEqual({
      fruehestens: vektor.fruehestens,
      spaetestens: vektor.spaetestens,
    });
  });
});

describe('P — PLZ-Tabelle', () => {
  it('P1 kanonische md5 = Konstante = Server (FT4)', () => {
    const kanonisch = Object.keys(PLZ_LEITBEREICHE)
      .sort()
      .map((bereich) => `${bereich}:${PLZ_LEITBEREICHE[bereich]}`)
      .join('\n');
    const md5 = createHash('md5').update(kanonisch, 'utf8').digest('hex');
    expect(md5).toBe(PLZ_LEITBEREICHE_MD5);
    expect(md5).toBe('9225419144963c0adeff70fb690b2de8');
    expect(Object.keys(PLZ_LEITBEREICHE)).toHaveLength(676);
    expect(readFileSync(resolve(process.cwd(), 'supabase/tests/fc01a_feiertage.sql'), 'utf8')).toContain(md5);
  });

  it('P2 jede Zeile hat gültige Länder und eine Augsburg-Angabe', () => {
    for (const [bereich, eintrag] of Object.entries(PLZ_LEITBEREICHE)) {
      expect(bereich).toMatch(/^\d{3}$/);
      expect(eintrag).toMatch(/^(BW|BY|BE|BB|HB|HH|HE|MV|NI|NW|RP|SL|SN|ST|SH|TH)(\+(BW|BY|BE|BB|HB|HH|HE|MV|NI|NW|RP|SL|SN|ST|SH|TH))*:(ja|nein|teils)$/);
    }
  });
});

describe('L — Lage einer Rechnung (wie FT6)', () => {
  const kundeSN = { holidayLocation: { region: 'SN' as const, fronleichnam: true } };

  it('L1 Vereinbarung geht allem vor', () => {
    expect(ermittleFristLage({ deadlineShiftWaived: true, kunde: kundeSN })).toEqual({ art: 'abbedungen' });
  });

  it('L2 Angabe am Kunden geht der PLZ vor', () => {
    expect(ermittleFristLage({ kunde: kundeSN, customerSnapshot: { zip: '33602' } })).toEqual({
      art: 'inland', laender: ['SN'], gemeinde: { fronleichnam: true }, quelle: 'kunde',
    });
  });

  it('L3 ein gelöschter Kunde zählt nicht', () => {
    const lage = ermittleFristLage({ kunde: { ...kundeSN, sync: { deleted: true } }, customerSnapshot: { zip: '33602' } });
    expect(lage).toMatchObject({ art: 'inland', laender: ['NW'], quelle: 'plz' });
  });

  it('L4 Ausland: aus der Angabe am Kunden, aus dem Land, aus einer österreichischen PLZ', () => {
    expect(ermittleFristLage({ kunde: { holidayLocation: { region: 'AUSLAND' } } })).toEqual({
      art: 'ausland', ohneFeiertagBestaetigt: false, quelle: 'kunde',
    });
    expect(ermittleFristLage({ kunde: { holidayLocation: { region: 'AUSLAND', auslandOhneFeiertag: true } } })).toMatchObject({
      ohneFeiertagBestaetigt: true,
    });
    expect(ermittleFristLage({ customerSnapshot: { zip: '1010', countryCode: 'at' } })).toMatchObject({ art: 'ausland', quelle: 'land' });
    for (const zip of ['87491', '87567', '87568', '87569']) {
      expect(ermittleFristLage({ customerSnapshot: { zip } })).toMatchObject({ art: 'ausland', quelle: 'plz' });
    }
    expect(ermittleFristLage({ customerSnapshot: { zip: '78266', countryCode: 'DE' } })).toMatchObject({
      art: 'inland', laender: ['BW'],
    });
  });

  it('L5 Augsburg aus der PLZ; ohne PLZ alle Länder', () => {
    expect(ermittleFristLage({ customerSnapshot: { zip: '86150', countryCode: 'DE' } })).toEqual({
      art: 'inland', laender: ['BY'], gemeinde: { augsburgerFriedensfest: true }, quelle: 'plz',
    });
    const unbekannt = ermittleFristLage({});
    expect(unbekannt).toMatchObject({ art: 'inland', quelle: 'unbekannt', gemeinde: {} });
    expect(unbekannt.art === 'inland' ? unbekannt.laender : []).toHaveLength(16);
  });
});

describe('Z — Zahlungstag gegen das Fristfenster', () => {
  it('Z1 WEISS: Fristende Fr 01.05., Sitz Bielefeld — Montag fristgerecht, Dienstag verspätet', () => {
    const fenster = berechneFristFenster('2026-05-01', ermittleFristLage({ customerSnapshot: { zip: '33602' } }));
    expect(pruefeZahlungstag('2026-05-04', fenster)).toBe('fristgerecht');
    expect(pruefeZahlungstag('2026-05-05', fenster)).toBe('verspaetet');
  });

  it('Z2 Grenz-PLZ an Fronleichnam: Freitag ungeklärt, Donnerstag fristgerecht, Montag verspätet', () => {
    const fenster = berechneFristFenster('2026-06-04', ermittleFristLage({ customerSnapshot: { zip: '48431' } }));
    expect(pruefeZahlungstag('2026-06-04', fenster)).toBe('fristgerecht');
    expect(pruefeZahlungstag('2026-06-05', fenster)).toBe('ungeklaert');
    expect(pruefeZahlungstag('2026-06-08', fenster)).toBe('verspaetet');
  });
});

describe('N — Angabe am Kunden in kanonischer Form', () => {
  it('N1 nur die Schlüssel, die für das Land etwas bedeuten', () => {
    expect(normalizeHolidayLocation({ region: 'NW', fronleichnam: true, mariaeHimmelfahrt: false })).toEqual({ region: 'NW' });
    expect(normalizeHolidayLocation({ region: 'TH', fronleichnam: false, augsburgerFriedensfest: true })).toEqual({
      region: 'TH', fronleichnam: false,
    });
    expect(normalizeHolidayLocation({ region: 'BY', mariaeHimmelfahrt: true, augsburgerFriedensfest: 'ja' })).toEqual({
      region: 'BY', mariaeHimmelfahrt: true,
    });
    expect(normalizeHolidayLocation({ region: 'AUSLAND', auslandOhneFeiertag: true, fronleichnam: true })).toEqual({
      region: 'AUSLAND', auslandOhneFeiertag: true,
    });
    expect(normalizeHolidayLocation({ region: 'AUSLAND', auslandOhneFeiertag: false })).toEqual({ region: 'AUSLAND' });
  });

  it('N2 Unbrauchbares ergibt keine Angabe', () => {
    for (const wert of [undefined, null, 'NW', { region: 'XX' }, { region: 'nw' }, {}]) {
      expect(normalizeHolidayLocation(wert)).toBeUndefined();
    }
  });
});
