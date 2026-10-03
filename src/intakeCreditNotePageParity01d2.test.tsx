/**
 * EINGANG-01D-2 Paritätsfix 1 — Aufnahme und Archiv verwenden dieselbe
 * Seitenwahrheit einer Gutschrift.
 *
 * Echter Aufnahmeweg wie in der Produktion: Vorschau-Klassifikation OHNE
 * Seitentexte (`pendingDocumentIntakeService`), Speichern über
 * `intakeCachedDocumentFile` mit `pageTexts`. Geprüft werden die strukturierte
 * Wahrheit (Frist, Fristart, Aufgabenvorlage, Aufgabenvorschläge), die
 * Bedeutung im Eingang (KI-Kontext und sichtbares Bedeutungsfeld) und die
 * Parität zur Archivprojektion desselben Belegs.
 */
import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';
import { importInboxDocumentForTests } from './test/confirmFilingDecisionForTests';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import { EingangDetailPage } from './pages/EingangDetailPage';
import type { CachedDocumentFilePayload } from './services/cachedDocumentFileService';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { classifyDocument } from './services/documentClassificationService';
import { intakeCachedDocumentFile } from './services/documentIntakeService';
import {
  buildDocumentAiContextFromDocument,
  buildDocumentAiContextFromInbox,
} from './services/document/documentAiContextService';
import { buildDocumentAiPrompt } from './services/document/documentAiPromptBuilder';
import { hydrateDocumentFileStore } from './services/documentFileStoreService';
import { hydrateDocumentStore } from './services/documentService';
import { resetDocumentWorkResultStoreForTests } from './services/documentWorkResultService';
import { hydrateExpenseStore } from './services/expenseStore';
import { getInboxItemById, hydrateInboxStore, markInboxImportedToArchive } from './services/inboxService';
import { analyzeUploadedDocument, processUploadedDocument } from './services/intakeWorkflowService';
import { setActiveStorageScope } from './services/storage/storageScopeService';
import { hydrateVorgangStore } from './services/vorgangService';
import { getTaskProposals } from './services/workflowDecisionUtils';
import { resetTestStores } from './test/resetStores';
import type { DocumentAiContext } from './types/areaAi';
import type { CompanyDocument, InboxItem } from './types/models';

const OWN = 'Mustermann Sanitär GmbH';
const TO_US = `An: ${OWN}\nHandwerkerweg 7\n10115 Berlin`;
const CREDIT = `Baustoff Meyer GmbH\nGutschrift\n${TO_US}\nGutschriftsnummer: GS-2026-17\nDatum: 01.10.2026\nRücknahme Material\nGutschrift brutto 119,00 EUR`;
const OWN_REPLY = `${CREDIT}\nBitte bestätigen Sie den Erhalt dieser Gutschrift bis zum 20.10.2026.`;
const TWO_DUTIES = `${OWN_REPLY}\nBitte senden Sie das Leergut bis zum 31.10.2026 zurück.`;
const COPY = (tail: string) =>
  `Baustoff Meyer GmbH\nRechnung\n${TO_US}\nRechnungsnummer: RE-2026-1\nMaterial 100,00 EUR\nGesamtbetrag 119,00 EUR\n${tail}`;

useDocumentBlobDatabaseReset();

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let seq = 0;

beforeEach(() => {
  setActiveStorageScope({ type: 'guest' });
  localStorage.clear();
  resetDocumentWorkResultStoreForTests();
  hydrateInboxStore([]);
  hydrateVorgangStore([]);
  hydrateDocumentStore([]);
  hydrateDocumentFileStore([], {});
  hydrateExpenseStore([]);
  hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: OWN, street: 'Handwerkerweg 7', zip: '10115', city: 'Berlin' });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  resetDocumentWorkResultStoreForTests();
  resetTestStores();
  localStorage.clear();
});

/** Produktionsnah: Vorschau ohne Seitentexte, Speichern mit Seitentexten. */
async function realIntake(pages: string[], options: { withPageTexts?: boolean } = {}): Promise<InboxItem> {
  const name = `beleg-${++seq}.pdf`;
  const recognizedText = pages.join('\n');
  const pageTexts = pages.map((text, index) => ({ pageNumber: index + 1, text }));
  const previewClassification = classifyDocument({ sourceFileName: name, recognizedText });
  const bytes = new TextEncoder().encode(`${name}:${recognizedText}`);
  const payload: CachedDocumentFilePayload = { bytes, fileName: name, mimeType: 'application/pdf', fileSize: bytes.byteLength };
  const result = await intakeCachedDocumentFile(payload, {
    sourceFileName: name,
    recognizedText,
    ...(options.withPageTexts === false ? {} : { pageTexts }),
    previewClassification,
    userDecision: 'save_permanently',
  });
  if (!result.success || result.duplicate) throw new Error('Aufnahme fehlgeschlagen');
  const item = getInboxItemById(result.inboxItem.id)!;
  // Wie bei der Prüfung im Eingang: als Betriebsbeleg markiert, damit die Analyse Aufgaben vorschlägt.
  hydrateInboxStore([{ ...item, markedAsCompanyDocument: true }]);
  processUploadedDocument(item.id);
  return getInboxItemById(item.id)!;
}

function inboxContext(item: InboxItem): DocumentAiContext {
  return buildDocumentAiContextFromInbox(item, { liveWorkflow: analyzeUploadedDocument(item.id) });
}

function archiveContext(item: InboxItem, mode: 'source' | 'missing'): DocumentAiContext {
  const imported = importInboxDocumentForTests(getInboxItemById(item.id)!, OWN);
  if (!imported.success) throw new Error('Ablage fehlgeschlagen');
  markInboxImportedToArchive(item.id, imported.document.id);
  const source = getInboxItemById(item.id)!;
  hydrateInboxStore(mode === 'source' ? [source] : []);
  const context = buildDocumentAiContextFromDocument(imported.document as CompanyDocument);
  hydrateInboxStore([source]);
  return context;
}

/** Strukturierte Hauptdokument-Wahrheit einer Projektion. */
function mainTruth(context: DocumentAiContext) {
  return {
    frist: (context.documentWorkTruthFactLines ?? []).filter((line) => line.startsWith('Frist:')),
    eigenePflichten: (context.semantic?.obligations ?? [])
      .filter((pflicht) => pflicht.who === 'own_company' && pflicht.byWhen)
      .map((pflicht) => pflicht.byWhen)
      .sort(),
    termineMitHandlung: (context.semantic?.deadlines ?? [])
      .filter((frist) => frist.actionRequired)
      .map((frist) => `${frist.type}:${frist.date}`)
      .sort(),
  };
}

function taskDueDates(item: InboxItem): string[] {
  return getTaskProposals(analyzeUploadedDocument(item.id))
    .map((task) => task.dueDate?.slice(0, 10))
    .filter((date): date is string => Boolean(date));
}

const outsideSourceText = (context: DocumentAiContext) =>
  buildDocumentAiPrompt('Was muss ich tun?', context, 'de').replace(/<<<OCR_DATEN>>>[\s\S]*?<<<ENDE_OCR_DATEN>>>/g, '');

async function meaningPanelText(item: InboxItem): Promise<string> {
  host = document.createElement('div');
  host.className = 'app-shell__main';
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/ablage/${item.id}`] },
        createElement(
          AppProvider,
          { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
          createElement(Routes, null, createElement(Route, { path: '/ablage/:id', element: createElement(EingangDetailPage) })),
        ),
      ),
    );
  });
  for (let i = 0; i < 30; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
  const panel = host.querySelector('[data-testid="document-meaning-panel"]');
  expect(panel, 'Bedeutungsfeld fehlt').not.toBeNull();
  return panel!.textContent ?? '';
}

describe('Paritätsfix 1 — echte Aufnahme: Seite 2 erzeugt keine Wahrheit der Gutschrift', () => {
  it('A: Seite 2 response_due 25.10. → keine Frist, keine Fristart, kein Task, keine eigene Pflicht, Bedeutungsfeld ohne 25.10.', async () => {
    const item = await realIntake([CREDIT, COPY('Zahlbar bis 15.09.2026\nBitte antworten Sie bis zum 25.10.2026.')]);
    expect(item.classifiedKind).toBe('gutschrift');
    expect(item.recognizedData._pageTexts).toBeTruthy();
    expect(item.deadline ?? null).toBeNull();
    expect(item.deadlineType).toBeUndefined();
    expect(item.taskTemplate?.dueDate).toBeUndefined();
    expect(taskDueDates(item)).not.toContain('2026-10-25');
    const truth = mainTruth(inboxContext(item));
    expect(truth.frist).toEqual([]);
    expect(truth.eigenePflichten).toEqual([]);
    expect(truth.termineMitHandlung).toEqual([]);
    expect(outsideSourceText(inboxContext(item))).not.toMatch(/25\.10\.2026/);
    expect(await meaningPanelText(item)).not.toMatch(/25\.10\.2026/);
  });

  it('B: Seite 2 payment_due 15.09. → keine Gutschrift-Frist, keine Zahlungspflicht, keine Forderung, kein Task', async () => {
    const item = await realIntake([CREDIT, COPY('Zahlbar bis 15.09.2026')]);
    expect(item.deadline ?? null).toBeNull();
    expect(taskDueDates(item)).not.toContain('2026-09-15');
    const context = inboxContext(item);
    expect(context.semantic?.deadlines.some((frist) => frist.type === 'payment_due')).toBe(false);
    expect(context.semantic?.amounts.some((betrag) => betrag.isClaimAgainstUs)).toBe(false);
    expect(mainTruth(context).eigenePflichten).toEqual([]);
  });

  it('C: Seite 2 document_submission_due 28.10. → keine eigene Frist, Pflicht oder Task', async () => {
    const item = await realIntake([CREDIT, COPY('Bitte reichen Sie die Lieferscheine bis zum 28.10.2026 ein.')]);
    expect(item.deadline ?? null).toBeNull();
    expect(item.deadlineType).toBeUndefined();
    expect(taskDueDates(item)).not.toContain('2026-10-28');
    const truth = mainTruth(inboxContext(item));
    expect(truth.eigenePflichten).toEqual([]);
    expect(truth.termineMitHandlung).toEqual([]);
  });

  it('D: Seite 1 response_due 20.10. + Seite 2 response_due 25.10. → 20.10. ja, 25.10. nein (Frist, Task, Bedeutung)', async () => {
    const item = await realIntake([OWN_REPLY, COPY('Bitte antworten Sie bis zum 25.10.2026.')]);
    expect(item.deadline).toBe('2026-10-20');
    expect(item.deadlineType).toBe('response_due');
    expect(item.taskTemplate?.dueDate).toBe('2026-10-20');
    expect(taskDueDates(item)).toContain('2026-10-20');
    expect(taskDueDates(item)).not.toContain('2026-10-25');
    const truth = mainTruth(inboxContext(item));
    expect(truth.eigenePflichten).toEqual(['2026-10-20']);
    expect(truth.termineMitHandlung).toEqual(['response_due:2026-10-20']);
    const panel = await meaningPanelText(item);
    expect(panel).toMatch(/20\.10\.2026/);
    expect(panel).not.toMatch(/25\.10\.2026/);
  });

  it('E: Seite 1 zwei eigene Pflichten + Seite 2 fremde Zahlungsfrist 25.10. → beide Pflichten, keine fremde, genau eine Hauptfrist', async () => {
    const item = await realIntake([TWO_DUTIES, COPY('Zahlbar bis 25.10.2026')]);
    expect(item.deadline).toBe('2026-10-20');
    const context = inboxContext(item);
    const truth = mainTruth(context);
    expect(truth.frist).toEqual(['Frist: 20.10.2026']);
    expect(truth.eigenePflichten).toEqual(['2026-10-20', '2026-10-31']);
    expect(truth.termineMitHandlung).toEqual(['response_due:2026-10-20', 'response_due:2026-10-31']);
    expect(outsideSourceText(context)).not.toMatch(/25\.10\.2026/);
    expect(taskDueDates(item)).not.toContain('2026-10-25');
    const panel = await meaningPanelText(item);
    expect(panel).toMatch(/20\.10\.2026/);
    expect(panel).toMatch(/31\.10\.2026/);
    expect(panel).not.toMatch(/25\.10\.2026/);
  });
});

describe('Paritätsfix 1 — Gegenkontrollen', () => {
  it('F: normale Rechnung mit Seite-2-Antwortfrist → Aufnahme exakt wie die bisherige (leichte) Klassifikation', async () => {
    const pages = [COPY('Zahlbar bis 15.09.2026'), 'Baustoff Meyer GmbH\nAnlage\nBitte antworten Sie bis zum 25.10.2026.'];
    const light = classifyDocument({ sourceFileName: 'x.pdf', recognizedText: pages.join('\n') });
    const item = await realIntake(pages);
    expect(item.classifiedKind).toBe('eingangsrechnung');
    expect(item.deadline).toBe(light.deadline);
    expect(item.deadlineType).toBe(light.deadlineType);
    expect(item.taskTemplate?.dueDate).toBe(light.taskTemplate?.dueDate);
    const context = inboxContext(item);
    expect(context.semantic?.deadlines.some((frist) => frist.type === 'payment_due' && frist.date === '2026-09-15')).toBe(true);
    expect(context.semantic?.deadlines.some((frist) => frist.type === 'response_due' && frist.date === '2026-10-25')).toBe(true);
  });

  it('G: Gutschrift ohne Seitentexte → bestehendes Verhalten (keine erfundene Seitengrenze)', async () => {
    const pages = [CREDIT, COPY('Bitte antworten Sie bis zum 25.10.2026.')];
    const light = classifyDocument({ sourceFileName: 'x.pdf', recognizedText: pages.join('\n') });
    const item = await realIntake(pages, { withPageTexts: false });
    expect(item.recognizedData._pageTexts).toBeUndefined();
    expect(item.deadline).toBe(light.deadline);
    expect(item.deadlineType).toBe(light.deadlineType);
  });
});

describe('Paritätsfix 1 — Aufnahme und Archiv: dieselbe Hauptdokument-Wahrheit', () => {
  const cases: Array<[string, string[]]> = [
    ['A Seite-2-Antwortfrist', [CREDIT, COPY('Bitte antworten Sie bis zum 25.10.2026.')]],
    ['D eigene 20.10. + fremde 25.10.', [OWN_REPLY, COPY('Bitte antworten Sie bis zum 25.10.2026.')]],
    ['E zwei eigene Pflichten + fremde Zahlungsfrist', [TWO_DUTIES, COPY('Zahlbar bis 25.10.2026')]],
  ];
  for (const [label, pages] of cases) {
    it(`H ${label}: Frist, eigene Pflichten und Termine mit Handlung gleich in Eingang, Archiv mit Quelle und ohne Quelle`, async () => {
      const item = await realIntake(pages);
      const inbox = mainTruth(inboxContext(item));
      const withSource = mainTruth(archiveContext(item, 'source'));
      const withoutSource = mainTruth(archiveContext(getInboxItemById(item.id)!, 'missing'));
      expect(withSource, `${label}: Archiv mit Quelle`).toEqual(inbox);
      expect(withoutSource, `${label}: Archiv ohne Quelle`).toEqual(inbox);
      expect(inbox.termineMitHandlung.some((termin) => termin.endsWith('2026-10-25'))).toBe(false);
    });
  }
});
