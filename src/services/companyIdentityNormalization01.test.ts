/**
 * OWN-COMPANY-NAME-NORMALIZATION-01 — dieselbe Firma, andere Schreibweise.
 *
 * Im Firmenprofil steht „Çırmak Haustechnik GmbH", im Vertrag „Cirmak
 * Haustechnik GmbH". Beide Namensvergleiche hielten das für zwei Firmen — und
 * der Identitäts-Normalisierer verstümmelte den Namen zusätzlich zu
 * „rmak haustechnik gmbh", weil `\w` ohne `u`-Flag nur ASCII kennt und `Ç`
 * sowie `ı` deshalb gelöscht wurden.
 *
 * Folge: Die eigene Firma war im Vertrag nicht identifizierbar, und das
 * Sicherheitstor aus `8ccfd8b` lieferte bei zwei Parteien folgerichtig keine
 * Gegenpartei — das Kundenformular blieb vollständig leer.
 *
 * **Deterministische kanonische Normalisierung, kein Ähnlichkeitsmaß.**
 * Verglichen wird weiterhin auf exakte Gleichheit; gefaltet werden nur sichere
 * Schreibvarianten desselben Zeichens. Transliterationen wie `ue → ü` bleiben
 * ausdrücklich draussen: `Müller` und `Mueller` sind verschieden.
 *
 * Neutrale Beispieldaten ausser dem realen Firmennamen des Betriebs.
 */
import { describe, expect, it } from 'vitest';
import { normalizeCompanyIdentityName } from './companyIdentityNormalization';
import { normalizeCompanyIdentityValue } from './companyRelevanceService';
import {
  isOwnCompanyName,
  normalizeCompanyNameForComparison,
} from './customerOwnCompanyGuard';

describe('OWN-COMPANY-NAME-NORMALIZATION-01 — zentrale Normalisierung', () => {
  it('1: Çırmak und Cirmak ergeben denselben Identitätswert', () => {
    expect(normalizeCompanyIdentityName('Çırmak Haustechnik GmbH')).toBe(
      normalizeCompanyIdentityName('Cirmak Haustechnik GmbH'),
    );
  });

  it('2-5: türkische und deutsche Diakritika werden gefaltet', () => {
    const pairs: Array<[string, string]> = [
      ['Şahin Bau GmbH', 'Sahin Bau GmbH'],
      ['İnşaat GmbH', 'Insaat GmbH'],
      ['Öztürk GmbH', 'Ozturk GmbH'],
      ['Müller GmbH', 'Muller GmbH'],
    ];
    for (const [a, b] of pairs) {
      expect(normalizeCompanyIdentityName(a), `${a} / ${b}`).toBe(
        normalizeCompanyIdentityName(b),
      );
    }
  });

  it('6: Müller und Mueller bleiben verschieden', () => {
    /*
     * `ue → ü` wäre Transliteration, keine Faltung. Eine solche Regel würde
     * „Neuer", „Steuer" oder „Feuerbach" mit verändern — deshalb bewusst nicht.
     */
    expect(normalizeCompanyIdentityName('Müller GmbH')).not.toBe(
      normalizeCompanyIdentityName('Mueller GmbH'),
    );
  });

  it('7: der Name wird nicht verstümmelt', () => {
    expect(normalizeCompanyIdentityName('Çırmak Haustechnik GmbH')).toBe(
      'cirmak haustechnik gmbh',
    );
    expect(normalizeCompanyIdentityValue('Çırmak Haustechnik GmbH')).not.toBe(
      'rmak haustechnik gmbh',
    );
    expect(normalizeCompanyIdentityValue('Çırmak Haustechnik GmbH')).toContain('cirmak');
  });

  it('8: Rand und Mehrfach-Leerzeichen werden vereinheitlicht', () => {
    expect(normalizeCompanyIdentityName('  Çırmak   Haustechnik  GmbH ')).toBe(
      'cirmak haustechnik gmbh',
    );
  });

  it('9: ß bleibt unverändert — keine zusätzliche Transliteration', () => {
    /*
     * `ß → ss` wäre eine weitere Transliteration ohne Bezug zu diesem Fall.
     * Der bisherige Vergleich hat ß ebenfalls erhalten; das bleibt so.
     */
    expect(normalizeCompanyIdentityName('Straßenbau GmbH')).toBe('straßenbau gmbh');
    expect(normalizeCompanyIdentityName('Straßenbau GmbH')).not.toBe(
      normalizeCompanyIdentityName('Strassenbau GmbH'),
    );
  });

  it('10: leere und fehlende Werte bleiben leer', () => {
    expect(normalizeCompanyIdentityName('')).toBe('');
    expect(normalizeCompanyIdentityName('   ')).toBe('');
  });
});

describe('OWN-COMPANY-NAME-NORMALIZATION-01 — Eigenfirmen-Guard', () => {
  it('11: die Schreibvariante gilt als eigene Firma', () => {
    expect(isOwnCompanyName('Cirmak Haustechnik GmbH', 'Çırmak Haustechnik GmbH')).toBe(true);
    expect(isOwnCompanyName('Çırmak Haustechnik GmbH', 'Cirmak Haustechnik GmbH')).toBe(true);
  });

  it('12: eine ähnlich geschriebene fremde Firma bleibt fremd', () => {
    /*
     * Der Schutz aus 8ccfd8b bleibt: Gefaltet wird das Zeichen, nicht der Name.
     * Verglichen wird weiterhin auf vollständige Gleichheit.
     */
    expect(isOwnCompanyName('Cirmak Bau GmbH', 'Çırmak Haustechnik GmbH')).toBe(false);
    expect(isOwnCompanyName('RheinWest Industriebau GmbH', 'Çırmak Haustechnik GmbH')).toBe(
      false,
    );
  });

  it('13: ein leerer eigener Firmenname blockiert weiterhin niemanden', () => {
    expect(isOwnCompanyName('Cirmak Haustechnik GmbH', '')).toBe(false);
  });

  it('14: der Guard-Normalisierer nutzt dieselbe Identitätsregel', () => {
    expect(normalizeCompanyNameForComparison('Çırmak Haustechnik GmbH')).toBe(
      normalizeCompanyNameForComparison('Cirmak Haustechnik GmbH'),
    );
  });
});
