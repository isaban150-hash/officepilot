/**
 * TEST-INFRA-GOLD-SCHUTZ-01 — geschützte Artefakte und Tests mit Schreib-Seiteneffekt.
 *
 * Die drei Dateien unten sind lokale, geschützte Artefakte (OFFICEPILOT_PROJECT_STATE.md,
 * Abschnitt 8): kein Testlauf darf sie verändern. Der globale Schutz-Setup
 * (`protectedArtifactsGlobalSetup.ts`) hält ihre Prüfsummen vor und nach jedem Lauf fest und
 * lässt den Lauf scheitern, wenn eine fehlt oder sich geändert hat.
 *
 * Ausnahme: Mit der ausdrücklichen Freigabe `GOLD_WRITE_REPORT=1` darf der Gold-Test die beiden
 * Berichte schreiben (`writeSuiteReport`). Der Snapshot bleibt in jedem Fall geschützt.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const GOLD_REPORT_ARTIFACTS = [
  'test-world/reports/gold-pipeline-04b.json',
  'test-world/reports/gold-pipeline-04b.md',
] as const;

export const PROTECTED_ARTIFACTS = [
  ...GOLD_REPORT_ARTIFACTS,
  'src/components/invoice/__snapshots__/InvoiceDocumentView.test.tsx.snap',
] as const;

/**
 * Tests, deren Schreib-Seiteneffekt NICHT abgeschaltet ist. `vitest.safe.config.ts` sammelt sie
 * in keinem Projekt ein:
 *  - der Snapshot-Test schreibt außerhalb von CI fehlende Snapshots in die geschützte Datei,
 *  - der Feldspur-Test schreibt `tmp-wv-lv-01-field-trace.json` ins Repository-Wurzelverzeichnis.
 */
export const UNGATED_WRITING_TEST_FILES = [
  'src/components/invoice/InvoiceDocumentView.test.tsx',
  'src/test/pipelineFieldTrace.wvLv01.test.ts',
] as const;

/** Schreibt nur mit `GOLD_WRITE_REPORT=1`; im sicheren Lauf ist die Freigabe zusätzlich hart aus. */
export const GATED_WRITING_TEST_FILES = ['src/testWorld/gold-pdf-pipeline.test.ts'] as const;

/** Schreibt ausschließlich in ein eigenes Verzeichnis unter `os.tmpdir()`. */
export const TEMP_ONLY_WRITING_TEST_FILES = [
  'src/test/goldReportWriteGate.test.ts',
  'src/test/protectedArtifacts.test.ts',
] as const;

export type ArtifactHashes = Record<string, string | null>;

/** SHA-256 je Artefakt, `null` für eine fehlende Datei. */
export function hashArtifacts(root: string, paths: readonly string[] = PROTECTED_ARTIFACTS): ArtifactHashes {
  const result: ArtifactHashes = {};
  for (const relative of paths) {
    const absolute = join(root, relative);
    result[relative] = existsSync(absolute) ? createHash('sha256').update(readFileSync(absolute)).digest('hex') : null;
  }
  return result;
}

/** Fehlende Artefakte einer Messung — ein Fehler vor und nach dem Lauf, auch mit Freigabe. */
export function missingProtectedArtifacts(hashes: ArtifactHashes): string[] {
  return Object.keys(hashes).filter((path) => hashes[path] === null);
}

/**
 * Welche Artefakte sich zwischen zwei Messungen verändert haben. Die Gold-Berichte zählen nicht,
 * wenn das Schreiben ausdrücklich freigegeben war; der Snapshot zählt immer.
 */
export function changedProtectedArtifacts(
  before: ArtifactHashes,
  after: ArtifactHashes,
  options: { goldWriteEnabled: boolean },
): string[] {
  const gold = new Set<string>(GOLD_REPORT_ARTIFACTS);
  return Object.keys({ ...before, ...after }).filter(
    (path) => before[path] !== after[path] && !(options.goldWriteEnabled && gold.has(path)),
  );
}
