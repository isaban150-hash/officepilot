/**
 * GOLD-PDF-PARTY-DIRECTION-02 — echte Produktionslaeufe fuer DOC-00002 und DOC-00004.
 *
 * Die PDFs laufen unveraendert durch die produktive Intake-Pipeline. WorkflowResult,
 * recognizedData und Summary werden nach ihrer Erzeugung nicht angefasst.
 * link_vorgang ist hier ausschliesslich eine bestaetigungspflichtige Aktion — es wird
 * waehrend Analyse und Vorschau keine Verknuepfung gespeichert.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useDocumentBlobDatabaseReset } from '../test/documentBlobTestReset';
import { resetTestStores } from '../test/resetStores';
import { resetDocumentFileStoreForTests } from '../services/documentFileStoreService';
import { hydrateVorgangStore, isInboxLinkedToVorgang } from '../services/vorgangService';
import { buildDocumentCaseMatch } from '../services/documentCaseMatchService';
import {
  goldProjectsToVorgaenge,
  loadGoldMasterData,
  resolveTestWorldRoot,
} from './goldLoader';
import { runGoldPdfThroughPipeline } from './goldPipelineRunner';
import { installGoldPdfJsVitestBridge } from './goldPdfJsVitestBridge';

useDocumentBlobDatabaseReset();

describe('GOLD-PARTY-DIRECTION-02', () => {
  const testWorldRoot = resolveTestWorldRoot();
  const masters = loadGoldMasterData(testWorldRoot);
  let uninstallPdfBridge: (() => void) | undefined;

  beforeAll(async () => {
    uninstallPdfBridge = await installGoldPdfJsVitestBridge();
  });

  afterAll(() => {
    uninstallPdfBridge?.();
  });

  beforeEach(() => {
    resetTestStores();
    resetDocumentFileStoreForTests();
    hydrateVorgangStore(goldProjectsToVorgaenge(masters));
  });

  it('DOC-00002 (Angebot): Empfaenger statt eigener Firma, Confirm-first', async () => {
    const { item, summary } = await runGoldPdfThroughPipeline('DOC-00002', testWorldRoot);

    const customer = summary.facts.find((fact) => fact.id === 'customer')?.value;
    const subject = summary.facts.find((fact) => fact.id === 'subject')?.value;
    expect(customer).toBe('WEG Mehrfamilienhaus Bielefeld-Mitte');
    expect(subject).toContain('WEG Mehrfamilienhaus Bielefeld-Mitte');
    expect(customer).not.toBe(item.sender);

    const match = buildDocumentCaseMatch(item);
    expect(match.matchStatus).toBe('exact');
    expect(match.reasons).toEqual(expect.arrayContaining(['same_project', 'same_customer']));
    expect(match.matchedCaseId).toBe('PRJ-005');
    expect(match.candidates.map((candidate) => candidate.caseId)).toEqual(['PRJ-005']);

    expect(summary.primaryAction.id).toBe('link_vorgang');
    expect(summary.primaryAction.id).not.toBe('open_vorgang');
    expect(summary.primaryAction.id).not.toBe('select_vorgang');

    // Confirm-first: Analyse und Vorschau speichern keine Verknuepfung.
    expect(isInboxLinkedToVorgang(item)).toBe(false);
    expect(item.vorgangId).toBeUndefined();
    expect(item.vorgangLinkStatus).toBeUndefined();
  }, 120_000);

  it('DOC-00004 (Ausgangsrechnung): Empfaenger statt eigener Firma, Confirm-first', async () => {
    const { item, summary } = await runGoldPdfThroughPipeline('DOC-00004', testWorldRoot);

    const customer = summary.facts.find((fact) => fact.id === 'customer')?.value;
    expect(customer).toBe('Sägewerk Ernst Flisch GmbH');
    expect(customer).not.toBe(item.sender);

    const match = buildDocumentCaseMatch(item);
    expect(match.matchStatus).toBe('exact');
    expect(match.reasons).toEqual(
      expect.arrayContaining(['same_project', 'same_site', 'same_customer']),
    );
    expect(match.matchedCaseId).toBe('PRJ-001');

    expect(summary.primaryAction.id).toBe('link_vorgang');

    expect(isInboxLinkedToVorgang(item)).toBe(false);
    expect(item.vorgangId).toBeUndefined();
    expect(item.vorgangLinkStatus).toBeUndefined();
  }, 120_000);
});
