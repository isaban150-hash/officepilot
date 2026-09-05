import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
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

/**
 * DOCUMENT-EXPERIENCE-SIMPLIFICATION-01B — die Originaldatei liegt jetzt unter
 * „Weitere Optionen → Originaldokument".
 *
 * Ein statischer Render zeigt eingeklappte Inhalte nicht. Damit die Zusicherung
 * „das Original bleibt erreichbar und funktionsfähig" nicht verloren geht, wird
 * hier zusätzlich echt gemountet und aufgeklappt.
 */
async function renderAblageDetailExpanded(itemId: string): Promise<HTMLElement> {
  const host = document.createElement('div');
  host.className = 'app-shell__main';
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/ablage/${itemId}`]}>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <Routes>
            <Route path="/ablage/:id" element={<EingangDetailPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
  });
  const settle = async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 0));
      });
    }
  };
  await settle();
  const clickById = async (testId: string) => {
    const el = host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (!el) return;
    await act(async () => {
      el.click();
    });
    await settle();
  };
  await clickById('document-review-more-toggle');
  await clickById('review-section-toggle-original-document');
  return host;
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
    ...overrides };
}

useDocumentBlobDatabaseReset();

describe('DOCUMENT-DETAIL-PRESENTATION-FIX-01', () => {
  afterEach(async () => {
    setImageOcrExtractorForTests(null);
    resetDocumentFileStoreForTests();
  });

  it('EingangDetailPage mit fileRefId zeigt Originalpanel ohne Weitere Optionen', async () => {
    setImageOcrExtractorForTests(async () => ({
      text: 'Eingangsrechnung RE-100 Lieferant Bau AG 120,00 EUR',
      confidence: 85 }));
    const bytes = new TextEncoder().encode('ORIGINAL-VISIBLE');
    const preview = await processDocumentFileForPreview(
      new File([bytes], 'eingang.jpg', { type: 'image/jpeg' }),
    );
    expect(preview.success).toBe(true);
    if (!preview.success) throw new Error('preview failed');

    const intake = await confirmPendingDocumentIntake(preview.pending, {
      userDecision: 'save_permanently',
      importSource: 'upload' });
    expect(intake.success).toBe(true);
    if (!intake.success || intake.duplicate) throw new Error('intake failed');

    /*
     * DOCUMENT-EXPERIENCE-SIMPLIFICATION-01B — vorher wurde hier zugesichert,
     * dass das Originalpanel **ohne** „Weitere Optionen" dauerhaft im
     * Hauptfluss steht. Die Originaldatei ist jetzt bewusst keine Dauerfläche
     * mehr; sie liegt unter „Weitere Optionen → Originaldokument".
     *
     * Die eigentliche Zusicherung bleibt vollständig erhalten: Download und
     * Dateiname werden weiterhin geprüft — nur nach dem Aufklappen.
     */
    const html = renderAblageDetail(intake.inboxItem.id);
    expect(html).not.toContain('data-testid="ablage-original-file"');
    expect(html).toContain('data-testid="document-review-more-toggle"');

    const expanded = await renderAblageDetailExpanded(intake.inboxItem.id);
    expect(expanded.querySelector('[data-testid="ablage-original-file"]')).not.toBeNull();
    expect(
      expanded.querySelector('[data-testid="document-original-file-panel-download"]'),
    ).not.toBeNull();
    expect(expanded.textContent).toContain('eingang.jpg');
  });

  it('fehlender Blob zeigt weiterhin Fehlermeldung im Originalpanel', async () => {
    const item = createMockInboxItemFromUpload({
      sourceFileName: 'missing.pdf',
      recognizedText: 'Eingangsrechnung',
      kind: 'materialrechnung' });
    const withMissingRef: InboxItem = { ...item, fileRefId: 'missing-file-ref' };
    hydrateInboxStore([withMissingRef]);

    /*
     * DOCUMENT-EXPERIENCE-SIMPLIFICATION-01B — dieselbe Verlagerung. Die
     * Fehlermeldung bei fehlendem Blob bleibt zugesichert, nur eben im
     * aufgeklappten Bereich.
     */
    const html = renderAblageDetail(withMissingRef.id);
    expect(html).not.toContain('data-testid="ablage-original-file"');

    const expanded = await renderAblageDetailExpanded(withMissingRef.id);
    expect(expanded.querySelector('[data-testid="ablage-original-file"]')).not.toBeNull();
    expect(expanded.textContent).toContain(t('document.original.unavailable', 'de'));
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
      kind: 'materialrechnung' });
    hydrateInboxStore([item]);
    const workflow = processUploadedDocument(item.id)!;
    expect(workflow.classifiedKind).toBe('eingangsrechnung');
    const recommendations = buildDocumentReviewRecommendations(item, workflow);
    expect(recommendations.map((entry) => entry.id)).not.toContain('write_invoice');
    expect(recommendations.some((entry) => entry.labelKey === 'reviewWorkflow.recommend.writeInvoice')).toBe(false);
  });

  it('DocumentAssistantPanel zeigt automatische Erklärung ohne Frage-Chips und ohne Freitextfragen', () => {
    const item = createMockInboxItemFromUpload({
      sourceFileName: 'frage.pdf',
      recognizedText: 'BG BAU Beitragsbescheid',
      kind: 'bg_bau' });
    const html = renderToStaticMarkup(
      <DocumentAssistantPanel
        item={item}
        workflow={null}
        translate={(key) => t(key, 'de')}
        language="de"
      />,
    );
    expect(html).toContain('data-testid="document-assistant-panel"');
    expect(html).not.toContain('data-testid="doc-assistant-question-input"');
    expect(html).not.toContain('document-assistant-panel__chips');
    expect(html).not.toContain('document-assistant-panel__chip');
  });

  it('digitalFolder und paperFiling bleiben am gespeicherten Item erhalten', async () => {
    setImageOcrExtractorForTests(async () => ({
      text: 'Eingangsrechnung RE-55 Lieferant Bau AG 88,00 EUR',
      confidence: 90 }));
    const preview = await processDocumentFileForPreview(
      new File([new TextEncoder().encode('KEEP-FOLDERS')], 'ablage.jpg', { type: 'image/jpeg' }),
    );
    expect(preview.success).toBe(true);
    if (!preview.success) throw new Error('preview failed');

    const intake = await confirmPendingDocumentIntake(preview.pending, {
      userDecision: 'save_permanently',
      importSource: 'upload' });
    expect(intake.success).toBe(true);
    if (!intake.success || intake.duplicate) throw new Error('intake failed');

    const stored = getInboxItemById(intake.inboxItem.id);
    expect(stored?.digitalFolder).toBeTruthy();
    expect(stored?.paperFiling).toBeTruthy();
  });
});
