/**
 * FINANZ-CORE-01A (Feiertage, § 193 BGB) — gesetzliche Feiertage in Deutschland je Bundesland.
 *
 * § 193 BGB verschiebt das Ende einer Leistungsfrist, das auf einen Samstag, Sonntag oder einen „am
 * Erklärungs- oder Leistungsorte staatlich anerkannten allgemeinen Feiertag“ fällt, auf den nächsten
 * Werktag. Welche Feiertage gelten, regeln die Feiertagsgesetze der Länder; bundesweit ist nur der
 * 3. Oktober durch Bundesrecht bestimmt, die übrigen bundesweiten Tage stehen in allen Landesgesetzen.
 *
 * Gemeindefeiertage sind kein Landesfeiertag und werden hier nie geraten:
 *  - Fronleichnam in Sachsen (bestimmte Gemeinden im Landkreis Bautzen) und Thüringen (Gemeinden mit
 *    überwiegend katholischer Bevölkerung),
 *  - Mariä Himmelfahrt in Bayern (Gemeinden mit überwiegend katholischer Bevölkerung),
 *  - Augsburger Friedensfest (nur Stadt Augsburg).
 * Für sie liefert `feiertagImLand` die Art `gemeinde`; ob der Tag am Sitz des Kunden gilt, entscheidet
 * eine ausdrückliche Angabe (Kunde) oder er bleibt ungeklärt (`fristende.ts`).
 *
 * Ostersonntag und Pfingstsonntag (Brandenburg) sind Sonntage und verschieben ohnehin; sie fehlen hier.
 *
 * Der Server rechnet dieselben Regeln (Migration 20261118120000, `workspace_feiertag_im_land`); die
 * gemeinsamen Testvektoren stehen in `fristenFeiertageFc01a.test.ts` und `supabase/tests/fc01a_feiertage.sql`.
 */

export type Bundesland =
  | 'BW' | 'BY' | 'BE' | 'BB' | 'HB' | 'HH' | 'HE' | 'MV'
  | 'NI' | 'NW' | 'RP' | 'SL' | 'SN' | 'ST' | 'SH' | 'TH';

export const BUNDESLAENDER: readonly Bundesland[] = [
  'BW', 'BY', 'BE', 'BB', 'HB', 'HH', 'HE', 'MV', 'NI', 'NW', 'RP', 'SL', 'SN', 'ST', 'SH', 'TH',
];

export const BUNDESLAND_NAMEN: Readonly<Record<Bundesland, string>> = {
  BW: 'Baden-Württemberg', BY: 'Bayern', BE: 'Berlin', BB: 'Brandenburg', HB: 'Bremen', HH: 'Hamburg',
  HE: 'Hessen', MV: 'Mecklenburg-Vorpommern', NI: 'Niedersachsen', NW: 'Nordrhein-Westfalen',
  RP: 'Rheinland-Pfalz', SL: 'Saarland', SN: 'Sachsen', ST: 'Sachsen-Anhalt', SH: 'Schleswig-Holstein',
  TH: 'Thüringen',
};

export function isBundesland(value: unknown): value is Bundesland {
  return typeof value === 'string' && (BUNDESLAENDER as readonly string[]).includes(value);
}

/** Feiertage, die nur in einzelnen Gemeinden eines Landes gelten. */
export type GemeindeFeiertag = 'fronleichnam' | 'mariaeHimmelfahrt' | 'augsburgerFriedensfest';

export type FeiertagImLand =
  | { art: 'kein' }
  | { art: 'feiertag'; name: string }
  | { art: 'gemeinde'; gemeinde: GemeindeFeiertag; name: string };

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function utc(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  const match = ISO.exec(day.slice(0, 10));
  if (!match) return day;
  const date = utc(Number(match[1]), Number(match[2]), Number(match[3]));
  date.setUTCDate(date.getUTCDate() + days);
  return iso(date);
}

/** 0 = Sonntag … 6 = Samstag (UTC, ohne Uhrzeit). */
export function weekday(day: string): number {
  const match = ISO.exec(day.slice(0, 10));
  if (!match) return -1;
  return utc(Number(match[1]), Number(match[2]), Number(match[3])).getUTCDay();
}

export function isWeekend(day: string): boolean {
  const w = weekday(day);
  return w === 0 || w === 6;
}

/** Ostersonntag (gregorianisch, Algorithmus nach Meeus/Jones/Butcher). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(utc(year, month, day));
}

/** Buß- und Bettag: der Mittwoch vor dem 23. November. */
function bussUndBettag(year: number): string {
  const nov22 = utc(year, 11, 22);
  const back = (nov22.getUTCDay() - 3 + 7) % 7;
  nov22.setUTCDate(nov22.getUTCDate() - back);
  return iso(nov22);
}

const ALLE = BUNDESLAENDER;

/**
 * Der Feiertag an `day` im Land `land`, oder `kein`.
 *
 * Stichtage der Landesgesetze: Reformationstag in HB, HH, NI, SH seit 2018 (2017 einmalig bundesweit);
 * Internationaler Frauentag in Berlin seit 2019, in Mecklenburg-Vorpommern seit 2023; Weltkindertag in
 * Thüringen seit 2019; Tag der Befreiung in Berlin einmalig am 08.05.2020 und 08.05.2025.
 */
export function feiertagImLand(day: string, land: Bundesland): FeiertagImLand {
  const match = ISO.exec(day.slice(0, 10));
  if (!match) return { art: 'kein' };
  const year = Number(match[1]);
  const md = `${match[2]}-${match[3]}`;
  const ostern = easterSunday(year);
  const d = `${match[1]}-${md}`;
  const ja = (name: string, laender: readonly Bundesland[]): FeiertagImLand | null =>
    laender.includes(land) ? { art: 'feiertag', name } : null;

  const treffer: Array<FeiertagImLand | null> = [];
  if (md === '01-01') treffer.push(ja('Neujahr', ALLE));
  if (md === '01-06') treffer.push(ja('Heilige Drei Könige', ['BW', 'BY', 'ST']));
  if (md === '03-08') {
    const laender: Bundesland[] = [];
    if (year >= 2019) laender.push('BE');
    if (year >= 2023) laender.push('MV');
    treffer.push(ja('Internationaler Frauentag', laender));
  }
  if (d === addDays(ostern, -2)) treffer.push(ja('Karfreitag', ALLE));
  if (d === addDays(ostern, 1)) treffer.push(ja('Ostermontag', ALLE));
  if (md === '05-01') treffer.push(ja('Tag der Arbeit', ALLE));
  if (md === '05-08' && (year === 2020 || year === 2025)) treffer.push(ja('Tag der Befreiung', ['BE']));
  if (d === addDays(ostern, 39)) treffer.push(ja('Christi Himmelfahrt', ALLE));
  if (d === addDays(ostern, 50)) treffer.push(ja('Pfingstmontag', ALLE));
  if (d === addDays(ostern, 60)) {
    treffer.push(ja('Fronleichnam', ['BW', 'BY', 'HE', 'NW', 'RP', 'SL']));
    if (land === 'SN' || land === 'TH') treffer.push({ art: 'gemeinde', gemeinde: 'fronleichnam', name: 'Fronleichnam' });
  }
  if (md === '08-08' && land === 'BY') {
    treffer.push({ art: 'gemeinde', gemeinde: 'augsburgerFriedensfest', name: 'Augsburger Friedensfest' });
  }
  if (md === '08-15') {
    treffer.push(ja('Mariä Himmelfahrt', ['SL']));
    if (land === 'BY') treffer.push({ art: 'gemeinde', gemeinde: 'mariaeHimmelfahrt', name: 'Mariä Himmelfahrt' });
  }
  if (md === '09-20' && year >= 2019) treffer.push(ja('Weltkindertag', ['TH']));
  if (md === '10-03' && year >= 1990) treffer.push(ja('Tag der Deutschen Einheit', ALLE));
  if (md === '10-31') {
    if (year === 2017) treffer.push(ja('Reformationstag', ALLE));
    else {
      const laender: Bundesland[] = ['BB', 'MV', 'SN', 'ST', 'TH'];
      if (year >= 2018) laender.push('HB', 'HH', 'NI', 'SH');
      treffer.push(ja('Reformationstag', laender));
    }
  }
  if (md === '11-01') treffer.push(ja('Allerheiligen', ['BW', 'BY', 'NW', 'RP', 'SL']));
  if (d === bussUndBettag(year)) treffer.push(ja('Buß- und Bettag', ['SN']));
  if (md === '12-25') treffer.push(ja('1. Weihnachtstag', ALLE));
  if (md === '12-26') treffer.push(ja('2. Weihnachtstag', ALLE));

  // Ein Landesfeiertag geht einem Gemeindefeiertag vor (zusammen fallen sie heute nicht).
  const landesweit = treffer.find((t) => t?.art === 'feiertag');
  if (landesweit) return landesweit;
  return treffer.find((t) => t?.art === 'gemeinde') ?? { art: 'kein' };
}
