/**
 * DOKUMENTE-01 / D-017 — die Aufbewahrungsregel.
 *
 * Die Vektoren sind dieselben wie im SQL-Test (`supabase/tests/dokumente01_aufbewahrung.sql`);
 * der letzte Block hier stellt sicher, dass beide wirklich dieselben sind.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isRetentionDowngrade,
  resolveDocumentRetention,
  resolveOriginalRetentionAdvice,
  retentionBlocksDelete,
  retentionToday,
  retentionYearOf,
} from './documentRetention';
import { DOCUMENT_RETENTION_VECTORS, renderRetentionVectorsSql } from './documentRetentionVectors';

describe('DOKUMENTE-01 — Aufbewahrungsregel', () => {
  it.each(DOCUMENT_RETENTION_VECTORS.map((vector) => [vector.name, vector] as const))('Vektor %s', (_name, vector) => {
    expect(resolveDocumentRetention(vector.facts, new Date(vector.heute))).toEqual(vector.erwartet);
  });

  it('jede Klasse, jeder Grund und jeder Status kommt in den Vektoren vor', () => {
    const erwartet = DOCUMENT_RETENTION_VECTORS.map((vector) => vector.erwartet);
    expect(new Set(erwartet.map((r) => r.klasse))).toEqual(new Set(['buchungsbeleg', 'geschaeftsbrief', 'pruefen']));
    expect(new Set(erwartet.map((r) => r.status))).toEqual(new Set(['laeuft', 'abgelaufen', 'pruefen']));
    expect(new Set(erwartet.map((r) => r.grund))).toEqual(
      new Set([
        'zahlungsnachweis',
        'ausgabenbeleg',
        'rechnungsbeleg',
        'rechnung_nicht_festgeschrieben',
        'belegart',
        'geschaeftsbrief',
        'keine_feste_regel',
      ]),
    );
  });

  it('die Frist sperrt das Löschen nur, solange sie läuft', () => {
    expect(retentionBlocksDelete({ status: 'laeuft' })).toBe(true);
    expect(retentionBlocksDelete({ status: 'abgelaufen' })).toBe(false);
    expect(retentionBlocksDelete({ status: 'pruefen' })).toBe(false);
  });

  it('Jahr und Tag gelten in Berliner Zeit', () => {
    expect(retentionYearOf('2026-12-31T23:30:00.000Z')).toBe(2027);
    expect(retentionYearOf('2026-12-31T22:59:59Z')).toBe(2026);
    expect(retentionYearOf('2026-06-30')).toBe(2026);
    expect(retentionYearOf('2026-02-30')).toBeNull();
    expect(retentionYearOf('31.12.2026')).toBeNull();
    expect(retentionYearOf('')).toBeNull();
    expect(retentionYearOf(undefined)).toBeNull();
    expect(retentionToday(new Date('2026-12-31T23:00:00Z'))).toBe('2027-01-01');
  });

  it('keine Abschwächung während der Frist, Aufwertung und abgelaufene Fristen bleiben frei', () => {
    expect(isRetentionDowngrade({ klasse: 'buchungsbeleg', status: 'laeuft' }, { klasse: 'pruefen' })).toBe(true);
    expect(isRetentionDowngrade({ klasse: 'buchungsbeleg', status: 'laeuft' }, { klasse: 'geschaeftsbrief' })).toBe(true);
    expect(isRetentionDowngrade({ klasse: 'geschaeftsbrief', status: 'laeuft' }, { klasse: 'buchungsbeleg' })).toBe(false);
    expect(isRetentionDowngrade({ klasse: 'buchungsbeleg', status: 'laeuft' }, { klasse: 'buchungsbeleg' })).toBe(false);
    expect(isRetentionDowngrade({ klasse: 'buchungsbeleg', status: 'abgelaufen' }, { klasse: 'pruefen' })).toBe(false);
  });

  it('Papieroriginal: entsorgen nur bei Werbung, nie weil das Dokument abgelegt ist', () => {
    expect(resolveOriginalRetentionAdvice({ isAdvertisement: true, classifiedKind: 'sonstiges' })).toBe('dispose_after_digital');
    expect(resolveOriginalRetentionAdvice({ classifiedKind: 'eingangsrechnung' })).toBe('keep_until_tax');
    expect(resolveOriginalRetentionAdvice({ classifiedKind: 'kontoauszug' })).toBe('keep_until_tax');
    expect(resolveOriginalRetentionAdvice({ classifiedKind: 'mahnung' })).toBe('keep');
    expect(resolveOriginalRetentionAdvice({ classifiedKind: 'lohnabrechnung' })).toBe('keep_until_tax');
    expect(resolveOriginalRetentionAdvice({ classifiedKind: 'brief', hasDeadline: true })).toBe('keep');
    expect(resolveOriginalRetentionAdvice({ classifiedKind: 'aok', taxRelevant: true })).toBe('keep_until_tax');
    expect(resolveOriginalRetentionAdvice({ classifiedKind: 'sonstiges' })).toBe('uncertain');
  });

  it('der SQL-Test prüft genau diese Vektoren', () => {
    const sql = readFileSync(resolve(process.cwd(), 'supabase/tests/dokumente01_aufbewahrung.sql'), 'utf8').replace(
      /\r\n/g,
      '\n',
    );
    const block = /-- VEKTOREN-ANFANG\n([\s\S]*?)\n-- VEKTOREN-ENDE/.exec(sql)?.[1];
    expect(block).toBe(renderRetentionVectorsSql());
  });
});
