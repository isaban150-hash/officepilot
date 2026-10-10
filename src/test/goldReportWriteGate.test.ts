/**
 * TEST-INFRA-GOLD-SCHUTZ-01 — die ausdrückliche Schreibfreigabe der Gold-Berichte.
 *
 * Schreibt ausschließlich in ein eigenes Verzeichnis unter `os.tmpdir()`, nie nach
 * `test-world/reports/`. Geprüft:
 *  A. ohne Freigabe (Standard) schreibt `writeSuiteReport` nichts und gibt `null` zurück,
 *  B. nur genau `GOLD_WRITE_REPORT=1` schreibt beide Berichte — unverändert im Inhalt,
 *  F. ein fachliches FAIL bleibt im Bericht ein FAIL; die Sperre maskiert nichts.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GOLD_WRITE_REPORT_ENV,
  formatSuiteReport,
  isGoldReportWriteEnabled,
  writeSuiteReport,
  type GoldPipelineSuiteReport,
} from '../testWorld/goldPipelineRunner';

function bericht(o: Partial<GoldPipelineSuiteReport> = {}): GoldPipelineSuiteReport {
  return {
    generatedAt: '2026-10-11T08:00:00.000Z',
    checked: 36,
    pass: 30,
    fail: 6,
    error: 0,
    successRate: '83.3%',
    documents: [],
    deviations: ['DOC-00001: caseMatch — status likely ≠ exact'],
    ...o,
  };
}

function leeresTestweltVerzeichnis(): string {
  return mkdtempSync(join(tmpdir(), 'gold-schutz-'));
}

describe('TEST-INFRA-GOLD-SCHUTZ-01 — Schreibfreigabe der Gold-Berichte', () => {
  it('A1: ohne Freigabe schreibt writeSuiteReport nichts und gibt null zurück', () => {
    const root = leeresTestweltVerzeichnis();
    expect(writeSuiteReport(bericht(), root, {})).toBeNull();
    expect(existsSync(join(root, 'reports'))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it('A2: nur genau "1" gibt frei — keine Schreibweise, kein Wahrheitswert, keine Leerzeichen', () => {
    expect(GOLD_WRITE_REPORT_ENV).toBe('GOLD_WRITE_REPORT');
    for (const wert of [undefined, '', '0', 'true', 'TRUE', 'yes', ' 1', '1 ', '01', 'on']) {
      expect(isGoldReportWriteEnabled({ [GOLD_WRITE_REPORT_ENV]: wert }), String(wert)).toBe(false);
      const root = leeresTestweltVerzeichnis();
      expect(writeSuiteReport(bericht(), root, { [GOLD_WRITE_REPORT_ENV]: wert })).toBeNull();
      expect(readdirSync(root)).toEqual([]);
    }
    expect(isGoldReportWriteEnabled({ [GOLD_WRITE_REPORT_ENV]: '1' })).toBe(true);
  });

  it('A3: kein npm-Skript und keine Vitest-Konfiguration erteilt die Freigabe von selbst', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const [name, command] of Object.entries(pkg.scripts)) {
      expect(command, name).not.toContain(GOLD_WRITE_REPORT_ENV);
    }
    for (const config of ['vitest.config.ts', 'vitest.core.config.ts', 'vitest.safe.config.ts']) {
      const text = readFileSync(join(process.cwd(), config), 'utf8');
      expect(text, config).not.toMatch(/GOLD_WRITE_REPORT[^\n]*['"]1['"]/);
    }
  });

  it('B1: mit GOLD_WRITE_REPORT=1 entstehen beide Berichte mit unverändertem Inhalt', () => {
    const root = leeresTestweltVerzeichnis();
    const daten = bericht();
    const pfad = writeSuiteReport(daten, root, { [GOLD_WRITE_REPORT_ENV]: '1' });
    expect(pfad).toBe(join(root, 'reports', 'gold-pipeline-04b.md'));
    expect(readFileSync(join(root, 'reports', 'gold-pipeline-04b.md'), 'utf8')).toBe(formatSuiteReport(daten));
    expect(JSON.parse(readFileSync(join(root, 'reports', 'gold-pipeline-04b.json'), 'utf8'))).toEqual(daten);
  });

  it('F1: ein fachliches FAIL bleibt im geschriebenen Bericht ein FAIL', () => {
    const root = leeresTestweltVerzeichnis();
    writeSuiteReport(bericht(), root, { [GOLD_WRITE_REPORT_ENV]: '1' });
    const md = readFileSync(join(root, 'reports', 'gold-pipeline-04b.md'), 'utf8');
    expect(md).toContain('FAIL: 6');
    expect(md).toContain('Erfolgsquote: 83.3%');
    expect(md).toContain('DOC-00001: caseMatch — status likely ≠ exact');
  });
});
