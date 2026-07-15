import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DocumentAssistantPanel } from './components/documents/DocumentAssistantPanel';
import { DEFAULT_SETUP } from './data/mockData';
import { t } from './i18n';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { buildDocumentAiActions } from './services/documentIntakeUnderstandingService';
import { buildDocumentReviewRecommendations } from './services/documentReviewViewService';
import { confirmPendingDocumentIntake, processDocumentFileForPreview } from './services/pendingDocumentIntakeService';
import { getInboxItemById, hydrateInboxStore } from './services/inboxService';
import { createMockInboxItemFromUpload } from './services/inboxUploadFactory';
import { processUploadedDocument } from './services/intakeWorkflowService';
import { setImageOcrExtractorForTests } from './services/ocrDocumentService';
import { resetDocumentFileStoreForTests } from './services/documentFileStoreService';
import { resetDocumentBlobDatabaseForTests } from './services/storage/documentBlobIndexedDbService';
import { resetTestStores } from './test/resetStores';
import type { ClassifiedDocumentKind, DocumentUnderstandingSummary, InboxItem } from './types/models';

function renderAblageDetail(itemId: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/ablage/${itemId}`]}>
      <AppProvider initialSetup={DEFAULT_SETUP}>
        <Routes>
          <Route path="/ablage/:id" element={<EingangDetailPage />} />
        </Routes>
      </AppProvider>
    </MemoryRouter>,
  );
}

function emptySummary(overrides: Partial<DocumentUnderstandingSummary> = {}): DocumentUnderstandingSummary {
  return {
    documentType: 'sonstiges',
    sender: undefined,
    recipient: undefined,
    date: undefined,
    referenceNumber: undefined,
    constructionSite: undefined,
    customer: undefined,
    vorgang: undefined,
    invoiceNumber: undefined,
    amount: undefined,
    deadline: undefined,
    nextStep: 'Dokument prüfen',
    partialRecognition: false,
    ...overrides,
  };
}

describe('DOCUMENT-DETAIL-PRESENTATION-FIX-01', () => {
  afterEach(async () => {
    setImageOcrExtractorForTests(null);
    resetTestStores();
    resetDocumentFileStoreForTests();
    await resetDocumentBlobDatabaseForTests();
  });

  it('EingangDetailPage mit fileRefId zeigt Originalpanel ohne Weitere Optionen', async () => {
    setImageOcrExtractorForTests(async () => ({
      text: 'Eingangsrechnung RE-100 Lieferant Bau AG 120,00 EUR',
      confidence: 85,
    }));
    const bytes = new TextEncoder().encode('ORIGINAL-VISIBLE');
    const preview = await processDocumentFileForPreview(
      new File([bytes], 'eingang.jpg', { type: 'image/jpeg' }),
    );
    expect(preview.success).toBe(true);
    if (!preview.success) throw new Error('preview failed');

    const intake = await confirmPendingDocumentIntake(preview.pending, {
      userDecision: 'save_permanently',
      importSource: 'upload',
    });
    expect(intake.success).toBe(true);
    if (!intake.success || intake.duplicate) throw new Error('intake failed');

    const html = renderAblageDetail(intake.inboxItem.id);
    expect(html).toContain('data-testid="ablage-original-file"');
    expect(html).toContain('data-testid="document-original-file-panel-download"');
    expect(html).not.toContain('data-testid="document-review-more-content"');
    expect(html).not.toContain('data-testid="document-review-original-section"');
    expect(html).toContain('eingang.jpg');
  });

  it('fehlender Blob zeigt weiterhin Fehlermeldung im Originalpanel', () => {
    const item = createMockInboxItemFromUpload({
      sourceFileName: 'missing.pdf',
      recognizedText: 'Eingangsrechnung',
      kind: 'materialrechnung',
    });
    const withMissingRef: InboxItem = { ...item, fileRefId: 'missing-file-ref' };
    hydrateInboxStore([withMissingRef]);

    const html = renderAblageDetail(withMissingRef.id);
    expect(html).toContain('data-testid="ablage-original-file"');
    expect(html).toContain(t('document.original.unavailable', 'de'));
    expect(html).not.toContain('data-testid="document-review-more-content"');
  });

  it('Eingangsrechnung enthält keine Aktion write_invoice', () => {
    const actions = buildDocumentAiActions('eingangsrechnung', emptySummary({ documentType: 'eingangsrechnung' }));
    expect(actions.map((action) => action.id)).not.toContain('write_invoice');
    expect(actions.map((action) => action.id)).toContain('archive_document');
    expect(actions.map((action) => action.id)).toContain('paper_folder');
  });

  it('rechnung und Belegarten erhalten kein write_invoice', () => {
    const kinds: ClassifiedDocumentKind[] = [
      'rechnung',
      'kassenbeleg',
      'quittung',
      'mahnung',
      'gutschrift',
    ];
    for (const kind of kinds) {
      const actions = buildDocumentAiActions(kind, emptySummary({ documentType: kind }));
      expect(actions.map((action) => action.id), kind).not.toContain('write_invoice');
    }
  });

  it('Ausgangsrechnung darf write_invoice weiterhin erhalten', () => {
    const actions = buildDocumentAiActions('ausgangsrechnung', emptySummary({ documentType: 'ausgangsrechnung' }));
    expect(actions.map((action) => action.id)).toContain('write_invoice');
    expect(actions.find((action) => action.id === 'write_invoice')?.recommended).toBe(true);
  });

  it('Review-Empfehlungen für Eingangsrechnung ohne Rechnung schreiben', () => {
    const item = createMockInboxItemFromUpload({
      sourceFileName: 'lieferantenrechnung.pdf',
      recognizedText: 'Eingangsrechnung Nr. RE-2026-1 Betrag 500,00 EUR Lieferant: Holz AG',
      kind: 'materialrechnung',
    });
    hydrateInboxStore([item]);
    const workflow = processUploadedDocument(item.id)!;
    expect(workflow.classifiedKind).toBe('eingangsrechnung');
    const recommendations = buildDocumentReviewRecommendations(item, workflow);
    expect(recommendations.map((entry) => entry.id)).not.toContain('write_invoice');
    expect(recommendations.some((entry) => entry.labelKey === 'reviewWorkflow.recommend.writeInvoice')).toBe(false);
  });

  it('DocumentAssistantPanel zeigt keine Frage-Chips, Freitext bleibt', () => {
    const item = createMockInboxItemFromUpload({
      sourceFileName: 'frage.pdf',
      recognizedText: 'BG BAU Beitragsbescheid',
      kind: 'bg_bau',
    });
    const html = renderToStaticMarkup(
      <DocumentAssistantPanel
        item={item}
        workflow={null}
        translate={(key) => t(key, 'de')}
        language="de"
      />,
    );
    expect(html).toContain('data-testid="doc-assistant-question-input"');
    expect(html).toContain('data-testid="doc-assistant-question-submit"');
    expect(html).not.toContain('document-assistant-panel__chips');
    expect(html).not.toContain('document-assistant-panel__chip');
  });

  it('digitalFolder und paperFiling bleiben am gespeicherten Item erhalten', async () => {
    setImageOcrExtractorForTests(async () => ({
      text: 'Eingangsrechnung RE-55 Lieferant Bau AG 88,00 EUR',
      confidence: 90,
    }));
    const preview = await processDocumentFileForPreview(
      new File([new TextEncoder().encode('KEEP-FOLDERS')], 'ablage.jpg', { type: 'image/jpeg' }),
    );
    expect(preview.success).toBe(true);
    if (!preview.success) throw new Error('preview failed');

    const intake = await confirmPendingDocumentIntake(preview.pending, {
      userDecision: 'save_permanently',
      importSource: 'upload',
    });
    expect(intake.success).toBe(true);
    if (!intake.success || intake.duplicate) throw new Error('intake failed');

    const stored = getInboxItemById(intake.inboxItem.id);
    expect(stored?.digitalFolder).toBeTruthy();
    expect(stored?.paperFiling).toBeTruthy();
  });
});
