import type { WorkflowAnalysis, WorkflowAnalysisSummary, WorkflowKnowledgeResolution } from '../../types/workflowIntelligence';
import type { CompanySessionContext } from '../../types/companySession';
import type { BrainSuggestedStep } from '../../types/brainOrchestration';
import type { WorkflowStepId, WorkflowStepStatus } from '../../types/workflowIntelligence';
import {
  analyzeSessionWorkflow,
  getWorkflowStepLabelDe,
} from './workflowIntelligenceService';
import { getCompanySession, hasActiveCompanyContext } from './companySessionService';

function summarizeAnalysis(analysis: WorkflowAnalysis): WorkflowAnalysisSummary {
  const completedSteps = analysis.steps
    .filter((s) => s.status === 'completed')
    .map((s) => s.id);
  const missingSteps = analysis.steps
    .filter((s) => s.status === 'missing')
    .map((s) => s.id);
  const riskSteps = analysis.steps
    .filter((s) => s.status === 'at_risk' || s.status === 'partial')
    .map((s) => s.id);
  const notDueSteps = analysis.steps
    .filter((s) => s.status === 'not_due' || s.status === 'not_applicable')
    .map((s) => s.id);
  const unknownSteps = analysis.steps.filter((s) => s.status === 'unknown').map((s) => s.id);
  const top = analysis.recommendations[0];

  return {
    scopeTitle: analysis.scopeTitle,
    completedSteps,
    missingSteps,
    riskSteps,
    notDueSteps,
    unknownSteps,
    primaryRecommendationKey: top?.messageKey,
    primaryRecommendationParams: top?.params,
  };
}

function formatStepLine(stepId: WorkflowStepId, status: WorkflowStepStatus): string | null {
  if (status === 'not_applicable' || status === 'not_due') return null;
  const prefix =
    status === 'completed'
      ? '✓'
      : status === 'at_risk' || status === 'partial'
        ? '⚠'
        : status === 'unknown'
          ? '?'
          : '○';
  return `${prefix} ${getWorkflowStepLabelDe(stepId)}`;
}

function buildWorkflowBullets(analysis: WorkflowAnalysis): string[] {
  const bullets: string[] = [];

  for (const workflowStep of analysis.steps) {
    const line = formatStepLine(workflowStep.id, workflowStep.status);
    if (line) bullets.push(line);
  }

  for (const risk of analysis.risks.slice(0, 3)) {
    bullets.push(`⚠ ${risk.messageKey}`);
  }

  const top = analysis.recommendations[0];
  if (top) {
    bullets.push(`→ ${top.messageKey}`);
  }

  if (analysis.relatedDocumentIds.length > 1) {
    bullets.push(`Zusammengehörige Dokumente: ${analysis.relatedDocumentIds.length}`);
  }

  return bullets.slice(0, 12);
}

function recommendationsToSteps(analysis: WorkflowAnalysis): BrainSuggestedStep[] {
  return analysis.recommendations.slice(0, 3).map((rec) => ({
    id: rec.id,
    labelKey: rec.labelKey ?? 'workflowIntelligence.nextStep.default',
    route: rec.route,
    reasonKey: rec.reasonKey,
  }));
}

function buildWorkflowAnswer(
  analysis: WorkflowAnalysis,
  title: string,
  intro: string,
): WorkflowKnowledgeResolution {
  return {
    source: 'rules',
    workflowUsed: ['workflow_intelligence', analysis.scope],
    workflowSummary: summarizeAnalysis(analysis),
    assistantAnswer: {
      title,
      summary: intro,
      bullets: buildWorkflowBullets(analysis),
      actions: [],
      linkedRoute:
        analysis.scope === 'vorgang'
          ? `/vorgaenge/${analysis.scopeId}`
          : `/ablage/${analysis.scopeId}`,
    },
    suggestedNextSteps: recommendationsToSteps(analysis),
    uncertaintyNote:
      analysis.risks.length > 0 ? 'brain.uncertainty.reviewRecommended' : undefined,
  };
}

export function isWorkflowQuestion(question: string): boolean {
  const q = question.trim();
  if (!q) return false;
  return (
    /was fehlt|welche schritte fehlen|workflow|arbeitsablauf|was wurde erledigt|was ist erledigt/i.test(q) ||
    /was ist offen.*(auftrag|schritt|workflow|dokument)|was ist noch offen/i.test(q) ||
    /was soll|nächste[s]? schritt|als nächstes|wie weiter|empfehlung/i.test(q) ||
    /stand.*auftrag|status.*auftrag|wie steht der auftrag|überblick.*auftrag/i.test(q) ||
    /gehören zusammen|zusammengehör|welche dokumente/i.test(q) ||
    /risiko|was ist das problem|was blockiert/i.test(q)
  );
}

export function tryResolveWorkflowQuestion(
  question: string,
  session: CompanySessionContext = getCompanySession(),
): WorkflowKnowledgeResolution | null {
  const q = question.trim();
  if (!q || !isWorkflowQuestion(q)) return null;

  const analysis = analyzeSessionWorkflow(session);
  if (!analysis && !hasActiveCompanyContext(session)) {
    return {
      source: 'clarification',
      workflowUsed: [],
      assistantAnswer: {
        title: 'Arbeitsablauf',
        summary: 'Für eine Workflow-Einschätzung brauche ich Bezug zu einem Auftrag oder Dokument im Eingang.',
        bullets: [],
        actions: [],
      },
      clarificationQuestion: 'brain.clarification.specifyDocumentOrVorgang',
    };
  }

  if (!analysis) {
    return null;
  }

  if (/gehören zusammen|zusammengehör|welche dokumente/i.test(q)) {
    return buildWorkflowAnswer(
      analysis,
      'Zusammengehörige Dokumente',
      `Zu „${analysis.scopeTitle}“ gehören ${analysis.relatedDocumentIds.length} erfasste Dokument(e) in Ihren Daten.`,
    );
  }

  if (/risiko|problem|blockiert/i.test(q)) {
    const riskCount = analysis.risks.length;
    return buildWorkflowAnswer(
      analysis,
      'Risiken im Ablauf',
      riskCount > 0
        ? `Ich habe ${riskCount} Risiko-Hinweis(e) auf Basis vorhandener Daten erkannt.`
        : 'Auf Basis vorhandener Daten sind keine kritischen Risiken erkannt.',
    );
  }

  if (/was fehlt|offen|erledigt/i.test(q)) {
    const missing = analysis.steps.filter((s) => s.status === 'missing').length;
    const done = analysis.steps.filter((s) => s.status === 'completed').length;
    return buildWorkflowAnswer(
      analysis,
      'Workflow-Stand',
      `Ich habe erkannt: ${done} Schritt(e) erledigt, ${missing} fehlen noch (basierend auf vorhandenen Daten).`,
    );
  }

  const top = analysis.recommendations[0];
  return buildWorkflowAnswer(
    analysis,
    'Nächster Schritt',
    top
      ? `Empfehlung für „${analysis.scopeTitle}“.`
      : `Für „${analysis.scopeTitle}“ sind auf Basis vorhandener Daten keine dringenden Schritte erkannt.`,
  );
}

export { summarizeAnalysis };
