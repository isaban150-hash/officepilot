import {
  buildSyntheticWerkvertragPages,
  buildSyntheticWerkvertragText,
} from '../../werkvertragMultiSectionFixtures';
import type {
  DocumentCaseExpected,
  DocumentCaseScenario,
  LoadedDocumentCase,
} from './types';

/**
 * Vite/Vitest-kompatible Case-Erkennung ohne Node-fs.
 * Pfade relativ zu dieser Datei (_lib/).
 */
const scenarioModules = import.meta.glob('../**/scenario.json', {
  eager: true,
  import: 'default',
}) as Record<string, DocumentCaseScenario>;

const expectedModules = import.meta.glob('../**/expected.json', {
  eager: true,
  import: 'default',
}) as Record<string, DocumentCaseExpected>;

const ocrModules = import.meta.glob('../**/ocr.txt', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const pagesModules = import.meta.glob('../**/pages.json', {
  eager: true,
  import: 'default',
}) as Record<string, Array<{ pageNumber: number; text: string }>>;

const notesModules = import.meta.glob('../**/notes.md', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

/** Virtueller Case-Root-Schlüssel, z. B. `../contracts/WV-LV-01`. */
export type DocumentCaseDirKey = string;

function caseDirFromScenarioPath(scenarioPath: string): DocumentCaseDirKey {
  return scenarioPath.replace(/\/scenario\.json$/, '');
}

function resolveOcrText(
  dir: DocumentCaseDirKey,
  scenario: DocumentCaseScenario,
): {
  ocrText: string;
  pages?: Array<{ pageNumber: number; text: string }>;
} {
  if (scenario.textFixture === 'werkvertragMultiSection') {
    return {
      ocrText: buildSyntheticWerkvertragText(),
      pages: buildSyntheticWerkvertragPages(),
    };
  }

  const pages = pagesModules[`${dir}/pages.json`];
  if (pages) {
    return {
      ocrText: pages.map((page) => page.text).join('\n\n'),
      pages,
    };
  }

  const ocrRaw = ocrModules[`${dir}/ocr.txt`];
  if (ocrRaw == null) {
    throw new Error(`Case ${scenario.caseId}: weder ocr.txt noch pages.json noch textFixture`);
  }
  return { ocrText: String(ocrRaw).trim() };
}

export function loadDocumentCase(dir: DocumentCaseDirKey): LoadedDocumentCase {
  const scenario = scenarioModules[`${dir}/scenario.json`];
  const expected = expectedModules[`${dir}/expected.json`];
  if (!scenario || !expected) {
    throw new Error(`Unvollständiger Case in ${dir}`);
  }
  const { ocrText, pages } = resolveOcrText(dir, scenario);
  const notes = notesModules[`${dir}/notes.md`];
  return {
    caseId: scenario.caseId,
    dir,
    scenario,
    expected,
    ocrText,
    pages,
    notes: notes != null ? String(notes) : undefined,
  };
}

/** Zentrale Registrierung über import.meta.glob (alle scenario.json). */
export function listDocumentCases(): LoadedDocumentCase[] {
  const cases: LoadedDocumentCase[] = [];
  for (const scenarioPath of Object.keys(scenarioModules)) {
    const dir = caseDirFromScenarioPath(scenarioPath);
    cases.push(loadDocumentCase(dir));
  }
  return cases.sort((a, b) => a.caseId.localeCompare(b.caseId));
}

export function getDocumentCase(caseId: string): LoadedDocumentCase {
  const found = listDocumentCases().find((entry) => entry.caseId === caseId);
  if (!found) throw new Error(`Unbekannter Document-Case: ${caseId}`);
  return found;
}
