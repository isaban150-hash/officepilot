import { describe, expect, it } from 'vitest';
import type { WorkflowResult } from '../types/models';
import { mergeReviewWorkflowWithRestoredDocumentWorkResult } from './EingangDetailPage';

describe('mergeReviewWorkflowWithRestoredDocumentWorkResult', () => {
  it('prefers live rich review data while preserving restored BI and workflow decision as fallback', () => {
    const restored = {
      inboxItemId: 'inbox-1',
      companyRelevant: true,
      companyRelevance: { isRelevant: true, reasons: [], matchedHints: [] },
      classifiedKind: 'rechnung',
      classificationConfidence: 'medium',
      classification: null,
      documentExplanation: null,
      documentUnderstanding: null,
      documentAiActions: [],
      contractAnalysis: null,
      contractIntelligence: null,
      contractOrderProposal: null,
      suggestedVorgang: null,
      similarVorgaenge: [],
      suggestedOrderPositions: [],
      suggestedTasks: [],
      suggestedArchiveFolder: { id: 'folder-1', name: 'Folder' },
      requiredDocuments: [],
      pendingSummary: null,
      warnings: [{ id: 'restored', message: 'restored' }],
      nextActions: [],
      businessInterpretation: { operational: { primaryCase: 'restored-case' } },
      workflowDecision: { decision: 'review' },
    } as unknown as WorkflowResult;

    const live = {
      inboxItemId: 'inbox-1',
      companyRelevant: true,
      companyRelevance: { isRelevant: true, reasons: [], matchedHints: [] },
      classifiedKind: 'rechnung',
      classificationConfidence: 'high',
      classification: null,
      documentExplanation: null,
      documentUnderstanding: null,
      documentAiActions: [],
      contractAnalysis: null,
      contractIntelligence: null,
      contractOrderProposal: { positions: [] },
      suggestedVorgang: null,
      similarVorgaenge: [],
      suggestedOrderPositions: [],
      suggestedTasks: [],
      suggestedArchiveFolder: { id: 'folder-1', name: 'Folder' },
      requiredDocuments: [],
      pendingSummary: null,
      warnings: [{ id: 'live', message: 'live' }],
      nextActions: [],
      businessInterpretation: null,
      workflowDecision: null,
    } as unknown as WorkflowResult;

    const merged = mergeReviewWorkflowWithRestoredDocumentWorkResult(restored, live);

    expect(merged?.contractOrderProposal).toEqual(live.contractOrderProposal);
    expect(merged?.businessInterpretation).toEqual(restored.businessInterpretation);
    expect(merged?.workflowDecision).toEqual(restored.workflowDecision);
  });
});
