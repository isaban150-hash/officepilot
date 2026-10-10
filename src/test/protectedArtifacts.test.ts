/**
 * TEST-INFRA-GOLD-SCHUTZ-01 — Regressionsschutz der Testinfrastruktur.
 *
 * Schreibt ausschließlich in eigene Verzeichnisse unter `os.tmpdir()`; die echten geschützten
 * Artefakte werden nur gelesen. Geprüft:
 *  C. die sichere Konfiguration sammelt keinen ungeschützten Schreibtest ein, und jeder Test mit
 *     Schreibmuster ist einer der bekannten Listen zugeordnet (neue Schreibtests fallen auf),
 *  D. der Schutz-Setup erkennt jede Veränderung geschützter Artefakte und hängt in allen
 *     Konfigurationen; fehlende Artefakte brechen den Lauf schon vor Testbeginn ab, und die
 *     Schreibfreigabe gilt so, wie sie zu Laufbeginn feststand (Nacharbeit 1: B1, B2),
 *  E. die fachliche Gold-Prüfung im Gold-Test ist unverändert vorhanden.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import safeConfig from '../../vitest.safe.config';
import defaultConfig from '../../vitest.config';
import coreConfig from '../../vitest.core.config';
import {
  GATED_WRITING_TEST_FILES,
  GOLD_REPORT_ARTIFACTS,
  PROTECTED_ARTIFACTS,
  TEMP_ONLY_WRITING_TEST_FILES,
  UNGATED_WRITING_TEST_FILES,
  changedProtectedArtifacts,
  hashArtifacts,
  missingProtectedArtifacts,
} from './protectedArtifacts';
import { createProtectedArtifactsGuard } from './protectedArtifactsGlobalSetup';
import { UNIT_TEST_FILES } from './vitestUnitTestFiles';

const REPO_ROOT = process.cwd();
const SNAPSHOT = 'src/components/invoice/__snapshots__/InvoiceDocumentView.test.tsx.snap';
const GUARD = './src/test/protectedArtifactsGlobalSetup.ts';
const OHNE_FREIGABE = {};
const MIT_FREIGABE = { GOLD_WRITE_REPORT: '1' };

/** Schreib-Seiteneffekte in Testdateien: Dateisystem, Snapshots, Gold-Bericht. */
const WRITE_PATTERN =
  /\b(writeFileSync|appendFileSync|createWriteStream|rmSync|unlinkSync|renameSync|copyFileSync)\s*\(|\bwriteFile\s*\(|\btoMatch(File|Inline)?Snapshot\s*\(|\btoThrowErrorMatching(Inline)?Snapshot\s*\(|\bwriteSuiteReport\s*\(/;

type ProjectTest = {
  name?: string;
  include?: string[];
  exclude?: string[];
  env?: Record<string, string>;
  globalSetup?: string | string[];
};

function projectTests(config: unknown): ProjectTest[] {
  const projects = (config as { test?: { projects?: Array<{ test?: ProjectTest }> } }).test?.projects ?? [];
  return projects.map((p) => p.test ?? {});
}

function listTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listTestFiles(rel));
    else if (/\.test\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

function tempRootWithArtifacts(): string {
  const root = mkdtempSync(join(tmpdir(), 'gold-schutz-guard-'));
  for (const path of PROTECTED_ARTIFACTS) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `stand ${path}\n`);
  }
  return root;
}

describe('TEST-INFRA-GOLD-SCHUTZ-01 — sichere Konfiguration (C)', () => {
  it('C1: beide Projekte schließen die ungeschützten Schreibtests aus', () => {
    const tests = projectTests(safeConfig);
    expect(tests.map((t) => t.name)).toEqual(['unit', 'default']);
    for (const t of tests) {
      for (const file of UNGATED_WRITING_TEST_FILES) {
        expect(t.exclude, `${t.name} ${file}`).toContain(file);
      }
    }
  });

  it('C2: die sichere Konfiguration sammelt dieselben Projekte wie die Standardkonfiguration', () => {
    const safe = projectTests(safeConfig);
    const standard = projectTests(defaultConfig);
    expect(safe.map((t) => t.include)).toEqual(standard.map((t) => t.include));
    expect(safe[0].include).toEqual([...UNIT_TEST_FILES]);
    for (const file of UNIT_TEST_FILES) expect(safe[1].exclude).toContain(file);
  });

  it('C3: die Schreibfreigabe ist in jedem Projekt hart aus', () => {
    for (const t of projectTests(safeConfig)) {
      expect(t.env, t.name).toEqual({ GOLD_WRITE_REPORT: '' });
    }
  });

  it('C3b: das Laden der sicheren Konfiguration entfernt eine von außen gesetzte Freigabe', async () => {
    const vorher = process.env.GOLD_WRITE_REPORT;
    try {
      process.env.GOLD_WRITE_REPORT = '1';
      vi.resetModules();
      await import('../../vitest.safe.config');
      expect(process.env.GOLD_WRITE_REPORT).toBeUndefined();
    } finally {
      if (vorher === undefined) delete process.env.GOLD_WRITE_REPORT;
      else process.env.GOLD_WRITE_REPORT = vorher;
    }
  });

  it('C4: der gesperrte Gold-Test bleibt eingesammelt — sein fachliches Ergebnis bleibt sichtbar', () => {
    const [, def] = projectTests(safeConfig);
    for (const file of GATED_WRITING_TEST_FILES) {
      expect(def.exclude).not.toContain(file);
      expect(def.include).toEqual(['src/**/*.test.{ts,tsx}']);
    }
  });

  it('C5: jede Testdatei mit Schreibmuster ist einer bekannten Liste zugeordnet', () => {
    const known = new Set<string>([
      ...UNGATED_WRITING_TEST_FILES,
      ...GATED_WRITING_TEST_FILES,
      ...TEMP_ONLY_WRITING_TEST_FILES,
    ]);
    const writing = listTestFiles('src').filter((file) => WRITE_PATTERN.test(readFileSync(join(REPO_ROOT, file), 'utf8')));
    expect(writing.filter((file) => !known.has(file))).toEqual([]);
    // Die Listen zeigen auf vorhandene Dateien, die das Muster tatsächlich enthalten.
    expect([...known].filter((file) => !writing.includes(file))).toEqual([]);
  });

  it('C6: außerhalb der Testdateien schreibt unter src nur der gesperrte Gold-Bericht', () => {
    const writers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
          if (/\b(writeFileSync|appendFileSync|createWriteStream|rmSync|unlinkSync|renameSync|copyFileSync)\s*\(|\bwriteFile\s*\(/.test(text)) {
            writers.push(rel);
          }
        }
      }
    };
    walk('src');
    expect(writers).toEqual(['src/testWorld/goldPipelineRunner.ts']);
    const runner = readFileSync(join(REPO_ROOT, 'src/testWorld/goldPipelineRunner.ts'), 'utf8');
    expect(runner).toMatch(/if \(!isGoldReportWriteEnabled\(env\)\) return null;/);
  });
});

describe('TEST-INFRA-GOLD-SCHUTZ-01 — Schutz-Setup (D)', () => {
  it('D1: der Schutz-Setup hängt in der sicheren, der Standard- und der Kernkonfiguration', () => {
    for (const [label, config] of [
      ['safe', safeConfig],
      ['default', defaultConfig],
      ['core', coreConfig],
    ] as const) {
      const tests = projectTests(config);
      expect(tests.length, label).toBe(2);
      for (const t of tests) expect(t.globalSetup, `${label}/${t.name}`).toEqual([GUARD]);
    }
  });

  it('D2: ohne Veränderung bleibt der Lauf grün', () => {
    const root = tempRootWithArtifacts();
    const check = createProtectedArtifactsGuard(root, OHNE_FREIGABE);
    expect(() => check()).not.toThrow();
  });

  it('D3: ein veränderter Gold-Bericht ohne Freigabe lässt den Lauf scheitern', () => {
    for (const path of GOLD_REPORT_ARTIFACTS) {
      const root = tempRootWithArtifacts();
      const check = createProtectedArtifactsGuard(root, OHNE_FREIGABE);
      writeFileSync(join(root, path), 'überschrieben\n');
      expect(() => check()).toThrow(`verändert: ${path}`);
    }
  });

  it('D4: mit Freigabe dürfen nur die Gold-Berichte entstehen — der Snapshot bleibt geschützt', () => {
    const root = tempRootWithArtifacts();
    const check = createProtectedArtifactsGuard(root, MIT_FREIGABE);
    for (const path of GOLD_REPORT_ARTIFACTS) writeFileSync(join(root, path), 'neu erzeugt\n');
    expect(() => check()).not.toThrow();

    const root2 = tempRootWithArtifacts();
    const check2 = createProtectedArtifactsGuard(root2, MIT_FREIGABE);
    writeFileSync(join(root2, SNAPSHOT), 'überschrieben\n');
    expect(() => check2()).toThrow(`verändert: ${SNAPSHOT}`);
  });

  it('D7 (B1): eine schon vor Testbeginn fehlende Datei bricht sofort ab — auch mit Freigabe, nichts wird erzeugt', () => {
    for (const path of PROTECTED_ARTIFACTS) {
      for (const env of [OHNE_FREIGABE, MIT_FREIGABE]) {
        const root = tempRootWithArtifacts();
        rmSync(join(root, path));
        expect(() => createProtectedArtifactsGuard(root, env)).toThrow(
          `Geschützte Artefakte fehlen vor Testbeginn: ${path}.`,
        );
        expect(existsSync(join(root, path)), path).toBe(false);
      }
    }
    const leer = mkdtempSync(join(tmpdir(), 'gold-schutz-leer-'));
    expect(() => createProtectedArtifactsGuard(leer, OHNE_FREIGABE)).toThrow(PROTECTED_ARTIFACTS.join(', '));
    expect(readdirSync(leer)).toEqual([]);
  });

  it('D8 (B2): eine erst nach Laufbeginn gesetzte Freigabe erlaubt kein Überschreiben', () => {
    const env: Record<string, string | undefined> = {};
    const root = tempRootWithArtifacts();
    const check = createProtectedArtifactsGuard(root, env);
    env.GOLD_WRITE_REPORT = '1';
    writeFileSync(join(root, GOLD_REPORT_ARTIFACTS[0]), 'überschrieben\n');
    expect(() => check()).toThrow(`verändert: ${GOLD_REPORT_ARTIFACTS[0]}`);
  });

  it('D9 (B2): eine zu Laufbeginn erteilte Freigabe bleibt bestehen, auch wenn die Variable später fehlt', () => {
    const env: Record<string, string | undefined> = { GOLD_WRITE_REPORT: '1' };
    const root = tempRootWithArtifacts();
    const check = createProtectedArtifactsGuard(root, env);
    delete env.GOLD_WRITE_REPORT;
    for (const path of GOLD_REPORT_ARTIFACTS) writeFileSync(join(root, path), 'neu erzeugt\n');
    expect(() => check()).not.toThrow();
  });

  it('D10: eine während des Laufs gelöschte Datei lässt den Lauf scheitern — auch mit Freigabe', () => {
    for (const path of PROTECTED_ARTIFACTS) {
      for (const env of [OHNE_FREIGABE, MIT_FREIGABE]) {
        const root = tempRootWithArtifacts();
        const check = createProtectedArtifactsGuard(root, env);
        rmSync(join(root, path));
        expect(() => check()).toThrow(`fehlen nach dem Lauf: ${path}`);
        expect(existsSync(join(root, path)), path).toBe(false);
      }
    }
  });

  it('D11: fehlende Artefakte einer Messung werden vollständig benannt', () => {
    expect(missingProtectedArtifacts({ a: 'x', b: null, c: null })).toEqual(['b', 'c']);
    expect(missingProtectedArtifacts({ a: 'x' })).toEqual([]);
  });

  it('D5: Anlegen und Löschen zählen als Veränderung', () => {
    expect(changedProtectedArtifacts({ a: null }, { a: 'x' }, { goldWriteEnabled: false })).toEqual(['a']);
    expect(changedProtectedArtifacts({ a: 'x' }, { a: null }, { goldWriteEnabled: false })).toEqual(['a']);
    expect(changedProtectedArtifacts({ a: 'x' }, { a: 'x' }, { goldWriteEnabled: false })).toEqual([]);
  });

  it('D6: die echten geschützten Artefakte sind vorhanden und lesbar (nur Lesezugriff)', () => {
    const hashes = hashArtifacts(REPO_ROOT);
    expect(Object.keys(hashes)).toEqual([...PROTECTED_ARTIFACTS]);
    for (const [path, hash] of Object.entries(hashes)) expect(hash, path).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('TEST-INFRA-GOLD-SCHUTZ-01 — fachliche Gold-Prüfung (E)', () => {
  it('E1: der Gold-Test prüft weiterhin 36 Dokumente, kein ERROR und kein FAIL', () => {
    const text = readFileSync(join(REPO_ROOT, 'src/testWorld/gold-pdf-pipeline.test.ts'), 'utf8');
    expect(text).toContain('expect(report.checked).toBe(36);');
    expect(text).toContain('expect(report.error).toBe(0);');
    expect(text).toContain("expect(report.fail, report.deviations.join('\\n')).toBe(0);");
    // Der Bericht wird geschrieben, ohne dass eine Umgebungsvariable im Test gesetzt wird.
    expect(text).toContain('writeSuiteReport(report, testWorldRoot);');
    expect(text).not.toMatch(/process\.env\.GOLD_WRITE_REPORT\s*=/);
  });
});
