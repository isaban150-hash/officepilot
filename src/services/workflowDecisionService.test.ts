import { describe, expect, it, beforeEach } from 'vitest';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { hydrateVorgangStore } from './vorgangService';
import { resetDocumentWorkResultStoreForTests } from './documentWorkResultStoreService';
import { processUploadedDocument } from './intakeWorkflowService';
import { buildWorkflowDecisionForInboxItem } from './workflowDecisionService';
import { getDocumentCase } from '../test/document-cases/_lib/loadCases';
import { runStablePipeline, testProfile } from '../test/document-cases/_lib/runStablePipeline';
import { hydrateInboxStore } from './inboxService';
import type { InboxItem } from '../types/models';

function seedHotelInbox() {
  const docCase = getDocumentCase('HOTEL-01');
  const observation = runStablePipeline(docCase);
  hydrateInboxStore([observation.item]);
  const workflow = processUploadedDocument(observation.item.id) ?? observation.workflow;
  return { workflow, item: observation.item };
}

describe('workflowDecisionService', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateCompanyProfileStore(testProfile);
    hydrateVorgangStore([]);
    resetDocumentWorkResultStoreForTests();
  });

  it('erstellt eine WorkflowDecision aus WorkflowResult und InboxItem', () => {
    const { workflow, item } = seedHotelInbox();
    const decision = buildWorkflowDecisionForInboxItem(item, workflow);

    expect(decision.inboxItemId).toBe(item.id);
    expect(decision.source).toBe('live');
    expect(decision.eventType).toBe(workflow.businessInterpretation?.meaning.eventType);
    expect(decision.primaryDecision).toBe(workflow.businessInterpretation?.operational.primaryCase);
    expect(decision.nextActions).toEqual(workflow.nextActions);
    expect(decision.taskProposals).toEqual(workflow.suggestedTasks);
    expect(decision.officeActionContext.availableDocumentActions.length).toBeGreaterThanOrEqual(0);
  });
});
