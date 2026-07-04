import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContractAnalysisPanel } from './ContractAnalysisPanel';
import { analyzeContractFromInbox, SAMPLE_WERKVERTRAG_TEXT } from '../../services/contractAnalysisService';
import { createMockInboxItemFromUpload } from '../../services/inboxUploadFactory';
import { createAuftragInboxItem } from '../../test/fixtures';
import type { TranslationKey } from '../../i18n';

function translate(key: TranslationKey): string {
  return key;
}

describe('ContractAnalysisPanel', () => {
  it('rendert Vertragsanalyse-Karte nach Upload', () => {
    const item = createMockInboxItemFromUpload({
      kind: 'auftrag',
      recognizedText: `Werkvertrag\n${SAMPLE_WERKVERTRAG_TEXT}`,
    });
    const analysis = analyzeContractFromInbox(item);

    const html = renderToStaticMarkup(
      <ContractAnalysisPanel analysis={analysis} item={item} translate={translate} onAction={() => {}} />,
    );

    expect(html).toContain('contract.analysisTitle');
    expect(html).toContain('contract.field.bauvorhaben');
    expect(html).toContain('contract.paymentTermsTitle');
    expect(html).toContain('contract.requiredDocsTitle');
    expect(html).toContain('contract.positionsTitle');
    expect(html).toContain('contract.action.createVorgang');
  });

  it('rendert nichts wenn kein Vertrag erkannt', () => {
    const item = createAuftragInboxItem({ id: 'contract-panel-empty' });
    const html = renderToStaticMarkup(
      <ContractAnalysisPanel
        item={item}
        analysis={{
          isContract: false,
          contractType: null,
          confidence: 'low',
          reason: 'Kein Vertrag',
          fields: {},
          positions: [],
          paymentTerms: [],
          requiredDocuments: [],
          signaturePages: [],
          suggestedActions: [],
        }}
        translate={translate}
        onAction={() => {}}
      />,
    );

    expect(html).toBe('');
  });
});
