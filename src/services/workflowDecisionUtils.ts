import type { WorkflowResult } from '../types/models';
import type { TaskProposal } from '../types/models';

export function getTaskProposals(workflow?: WorkflowResult | null): TaskProposal[] {
  if (!workflow) return [];
  try {
    const decision = (workflow as any).workflowDecision;
    if (decision && Array.isArray(decision.taskProposals)) return decision.taskProposals as TaskProposal[];
  } catch {
    // defensive: fall through to suggestedTasks
  }
  return workflow.suggestedTasks ?? [];
}
