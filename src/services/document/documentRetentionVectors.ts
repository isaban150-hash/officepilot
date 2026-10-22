/**
 * DOKUMENTE-01 / D-017 — gemeinsame Testvektoren der Aufbewahrungsregel.
 *
 * Dieselben Fälle prüfen `resolveDocumentRetention` (Client) und
 * `workspace_retention_rule` (Server, `supabase/tests/dokumente01_aufbewahrung.sql`).
 * `documentRetention.test.ts` stellt sicher, dass der Block im SQL-Test genau
 * aus diesen Vektoren besteht. Ein neuer Fall gehört deshalb immer hierher.
 */
import { retentionToday, type DocumentRetention, type DocumentRetentionFacts } from './documentRetention';

export interface DocumentRetentionVector {
  name: string;
  /** Zeitpunkt der Prüfung (ISO, UTC). */
  heute: string;
  facts: DocumentRetentionFacts;
  erwartet: DocumentRetention;
}

const HEUTE = '2026-10-20T10:00:00Z';

function laeuft(
  klasse: 'buchungsbeleg' | 'geschaeftsbrief',
  grund: DocumentRetention['grund'],
  bezugsjahr: number,
): DocumentRetention {
  const jahre = klasse === 'buchungsbeleg' ? 8 : 6;
  return { klasse, grund, jahre, bezugsjahr, fristEnde: `${bezugsjahr + jahre}-12-31`, status: 'laeuft' };
}

function abgelaufen(
  klasse: 'buchungsbeleg' | 'geschaeftsbrief',
  grund: DocumentRetention['grund'],
  bezugsjahr: number,
): DocumentRetention {
  return { ...laeuft(klasse, grund, bezugsjahr), status: 'abgelaufen' };
}

function pruefen(grund: DocumentRetention['grund']): DocumentRetention {
  return { klasse: 'pruefen', grund, jahre: null, bezugsjahr: null, fristEnde: null, status: 'pruefen' };
}

export const DOCUMENT_RETENTION_VECTORS: readonly DocumentRetentionVector[] = [
  {
    name: 'eingangsrechnung-2026',
    heute: HEUTE,
    facts: { classifiedKind: 'eingangsrechnung', documentDate: '2026-03-15', createdAt: '2026-03-16T08:00:00.000Z' },
    erwartet: laeuft('buchungsbeleg', 'belegart', 2026),
  },
  {
    name: 'quittung-2016-abgelaufen',
    heute: HEUTE,
    facts: { classifiedKind: 'quittung', documentDate: '2016-05-01', createdAt: '2016-05-02T09:00:00.000Z' },
    erwartet: abgelaufen('buchungsbeleg', 'belegart', 2016),
  },
  {
    name: 'grenze-letzter-tag-berlin',
    heute: '2026-12-31T22:59:59Z',
    facts: { classifiedKind: 'tankbeleg', issueDate: '2018-07-01', createdAt: '2018-07-02T10:00:00.000Z' },
    erwartet: laeuft('buchungsbeleg', 'belegart', 2018),
  },
  {
    name: 'grenze-erster-tag-danach-berlin',
    heute: '2026-12-31T23:00:00Z',
    facts: { classifiedKind: 'tankbeleg', issueDate: '2018-07-01', createdAt: '2018-07-02T10:00:00.000Z' },
    erwartet: abgelaufen('buchungsbeleg', 'belegart', 2018),
  },
  {
    name: 'spaetere-erfassung-gewinnt',
    heute: HEUTE,
    facts: { classifiedKind: 'rechnung', documentDate: '2025-12-30', uploadedAt: '2026-01-05T08:00:00.000Z' },
    erwartet: laeuft('buchungsbeleg', 'belegart', 2026),
  },
  {
    name: 'silvesterabend-zaehlt-berliner-jahr',
    heute: HEUTE,
    facts: { classifiedKind: 'kassenbeleg', issueDate: '2026-12-31', createdAt: '2026-12-31T23:30:00.000Z' },
    erwartet: laeuft('buchungsbeleg', 'belegart', 2027),
  },
  {
    name: 'zeitstempel-ohne-zone-gilt-als-utc',
    heute: HEUTE,
    facts: { classifiedKind: 'kontoauszug', createdAt: '2026-12-31T23:30:00' },
    erwartet: laeuft('buchungsbeleg', 'belegart', 2027),
  },
  {
    name: 'zeitstempel-mit-versatz',
    heute: HEUTE,
    facts: { classifiedKind: 'kontoauszug', createdAt: '2026-12-31T23:30:00-01:00' },
    erwartet: laeuft('buchungsbeleg', 'belegart', 2027),
  },
  {
    name: 'ungueltiges-datum-zaehlt-nicht',
    heute: HEUTE,
    facts: { classifiedKind: 'ec_beleg', issueDate: '2026-02-30', createdAt: '2020-01-10T09:00:00.000Z' },
    erwartet: laeuft('buchungsbeleg', 'belegart', 2020),
  },
  {
    name: 'schalttag-gilt',
    heute: HEUTE,
    facts: { classifiedKind: 'quittung', documentDate: '2024-02-29', createdAt: '2019-03-01T09:00:00.000Z' },
    erwartet: laeuft('buchungsbeleg', 'belegart', 2024),
  },
  {
    name: 'unplausibles-jahr-zaehlt-nicht',
    heute: HEUTE,
    facts: { classifiedKind: 'kreditkartenbeleg', documentDate: '3026-01-01', createdAt: '2024-04-04T09:00:00.000Z' },
    erwartet: laeuft('buchungsbeleg', 'belegart', 2024),
  },
  {
    name: 'deutsches-datumsformat-zaehlt-nicht',
    heute: HEUTE,
    facts: { classifiedKind: 'reparaturrechnung', issueDate: '15.03.2019', createdAt: '2021-03-16T09:00:00.000Z' },
    erwartet: laeuft('buchungsbeleg', 'belegart', 2021),
  },
  {
    name: 'ohne-lesbares-datum-ab-heute',
    heute: HEUTE,
    facts: { classifiedKind: 'gutschrift' },
    erwartet: laeuft('buchungsbeleg', 'belegart', 2026),
  },
  {
    name: 'kategorie-ausgangsrechnung-ohne-art',
    heute: HEUTE,
    facts: { category: 'ausgangsrechnung', createdAt: '2025-02-01T09:00:00.000Z' },
    erwartet: laeuft('buchungsbeleg', 'belegart', 2025),
  },
  {
    name: 'art-gross-geschrieben-und-mit-leerzeichen',
    heute: HEUTE,
    facts: { classifiedKind: ' Rechnung ', createdAt: '2025-02-01T09:00:00.000Z' },
    erwartet: laeuft('buchungsbeleg', 'belegart', 2025),
  },
  {
    name: 'erzeugte-rechnung-festgeschrieben',
    heute: HEUTE,
    facts: {
      rechnungsbeleg: 'festgeschrieben',
      classifiedKind: 'ausgangsrechnung',
      category: 'ausgangsrechnung',
      issueDate: '2026-08-24',
      createdAt: '2026-08-24T10:00:00.000Z',
    },
    erwartet: laeuft('buchungsbeleg', 'rechnungsbeleg', 2026),
  },
  {
    name: 'erzeugte-rechnung-entwurf',
    heute: HEUTE,
    facts: {
      rechnungsbeleg: 'offen',
      classifiedKind: 'ausgangsrechnung',
      category: 'ausgangsrechnung',
      issueDate: '2026-08-24',
      createdAt: '2026-08-24T10:00:00.000Z',
    },
    erwartet: pruefen('rechnung_nicht_festgeschrieben'),
  },
  {
    name: 'korrekturbeleg',
    heute: HEUTE,
    facts: { rechnungsbeleg: 'korrektur', classifiedKind: 'rechnungskorrektur', createdAt: '2026-09-01T10:00:00.000Z' },
    erwartet: laeuft('buchungsbeleg', 'rechnungsbeleg', 2026),
  },
  {
    name: 'zahlungsnachweis-als-foto',
    heute: HEUTE,
    facts: { zahlungsnachweis: true, classifiedKind: 'foto', createdAt: '2026-05-05T10:00:00.000Z' },
    erwartet: laeuft('buchungsbeleg', 'zahlungsnachweis', 2026),
  },
  {
    name: 'ausgabenbeleg-ohne-art',
    heute: HEUTE,
    facts: { ausgabenbeleg: true, classifiedKind: 'sonstiges', createdAt: '2026-05-05T10:00:00.000Z' },
    erwartet: laeuft('buchungsbeleg', 'ausgabenbeleg', 2026),
  },
  {
    name: 'ausgabenbeleg-schlaegt-geschaeftsbrief',
    heute: HEUTE,
    facts: { ausgabenbeleg: true, classifiedKind: 'auftrag', createdAt: '2026-05-05T10:00:00.000Z' },
    erwartet: laeuft('buchungsbeleg', 'ausgabenbeleg', 2026),
  },
  {
    name: 'auftragsbestaetigung-2021',
    heute: HEUTE,
    facts: { classifiedKind: 'auftragsbestaetigung', documentDate: '2021-04-01', createdAt: '2021-04-02T10:00:00.000Z' },
    erwartet: laeuft('geschaeftsbrief', 'geschaeftsbrief', 2021),
  },
  {
    name: 'mahnung-2019-abgelaufen',
    heute: HEUTE,
    facts: { classifiedKind: 'mahnung', documentDate: '2019-11-11', createdAt: '2019-11-12T10:00:00.000Z' },
    erwartet: abgelaufen('geschaeftsbrief', 'geschaeftsbrief', 2019),
  },
  {
    name: 'werkvertrag-2026',
    heute: HEUTE,
    facts: { classifiedKind: 'werkvertrag', createdAt: '2026-02-02T10:00:00.000Z' },
    erwartet: laeuft('geschaeftsbrief', 'geschaeftsbrief', 2026),
  },
  {
    name: 'angebot-pruefen',
    heute: HEUTE,
    facts: { classifiedKind: 'angebot', createdAt: '2026-02-02T10:00:00.000Z' },
    erwartet: pruefen('keine_feste_regel'),
  },
  {
    name: 'lieferschein-pruefen',
    heute: HEUTE,
    facts: { classifiedKind: 'lieferschein', createdAt: '2026-02-02T10:00:00.000Z' },
    erwartet: pruefen('keine_feste_regel'),
  },
  {
    name: 'lohnabrechnung-pruefen',
    heute: HEUTE,
    facts: { classifiedKind: 'lohnabrechnung', createdAt: '2026-02-02T10:00:00.000Z' },
    erwartet: pruefen('keine_feste_regel'),
  },
  {
    name: 'arbeitsvertrag-pruefen',
    heute: HEUTE,
    facts: { classifiedKind: 'arbeitsvertrag', category: 'personal', createdAt: '2026-02-02T10:00:00.000Z' },
    erwartet: pruefen('keine_feste_regel'),
  },
  {
    name: 'steuerbescheid-pruefen',
    heute: HEUTE,
    facts: { classifiedKind: 'steuerbescheid', category: 'steuer', createdAt: '2026-02-02T10:00:00.000Z' },
    erwartet: pruefen('keine_feste_regel'),
  },
  {
    name: 'kategorie-vertrag-ohne-art-pruefen',
    heute: HEUTE,
    facts: { category: 'vertrag', createdAt: '2026-02-02T10:00:00.000Z' },
    erwartet: pruefen('keine_feste_regel'),
  },
  {
    name: 'kategorie-steuer-sonstiges-pruefen',
    heute: HEUTE,
    facts: { classifiedKind: 'sonstiges', category: 'steuer', createdAt: '2026-02-02T10:00:00.000Z' },
    erwartet: pruefen('keine_feste_regel'),
  },
  {
    name: 'ohne-angaben-pruefen',
    heute: HEUTE,
    facts: {},
    erwartet: pruefen('keine_feste_regel'),
  },
];

function sqlText(value: string | null | undefined): string {
  return value === null || value === undefined ? 'null' : `'${value.replace(/'/g, "''")}'`;
}

function sqlNumber(value: number | null): string {
  return value === null ? 'null' : String(value);
}

/**
 * Der Vektorblock des SQL-Tests, genau so, wie er dort zwischen
 * `-- VEKTOREN-ANFANG` und `-- VEKTOREN-ENDE` stehen muss.
 *
 * Der Server bekommt den Prüftag als Berliner Datum und als Ersatzjahr das
 * Jahr dieses Tages — wie der Client, wenn kein Datum lesbar ist.
 */
export function renderRetentionVectorsSql(vectors: readonly DocumentRetentionVector[] = DOCUMENT_RETENTION_VECTORS): string {
  const rows = vectors.map((vector) => {
    const today = retentionToday(new Date(vector.heute));
    const { facts, erwartet } = vector;
    const dates = [facts.documentDate, facts.issueDate, facts.uploadedAt, facts.createdAt].map(sqlText).join(', ');
    return `  (${[
      sqlText(vector.name),
      sqlText(facts.rechnungsbeleg),
      sqlText(facts.classifiedKind),
      sqlText(facts.category),
      facts.ausgabenbeleg ? 'true' : 'false',
      facts.zahlungsnachweis ? 'true' : 'false',
      `array[${dates}]::text[]`,
      today.slice(0, 4),
      `'${today}'`,
      sqlText(erwartet.klasse),
      sqlText(erwartet.grund),
      sqlNumber(erwartet.jahre),
      sqlNumber(erwartet.bezugsjahr),
      sqlText(erwartet.fristEnde),
      sqlText(erwartet.status),
    ].join(', ')})`;
  });
  return `insert into aufbewahrung_vektoren values\n${rows.join(',\n')};`;
}
