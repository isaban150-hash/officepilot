import { countLabel } from '../../utils/germanCount';
import type {
  FinanceAnalysis,
  FinanceAnalysisSummary,
  FinanceKnowledgeResolution,
  FinanceStepStatus,
} from '../../types/financeIntelligence';
import type { CompanySessionContext } from '../../types/companySession';
import type { BrainSuggestedStep } from '../../types/brainOrchestration';
import type { FinanceStepId } from '../../types/financeIntelligence';
import type { VorgangInvoice } from '../../types/models';
import {
  analyzeSessionFinance,
  countDatevRelevantInboxItems,
  getFinanceStepLabelDe,
  getMissingTaxNoticesForInvoice,
  getDocumentedDunningLevel,
} from './financeIntelligenceService';
import { getCompanySession, hasActiveCompanyContext } from './companySessionService';
import { getVorgangInvoice } from '../vorgangService';
import { buildLegalNotices } from '../invoiceTaxService';
import { translateWorkflowMessage } from './workflowKnowledgeResolver';

function summarizeAnalysis(analysis: FinanceAnalysis): FinanceAnalysisSummary {
  const completedSteps = analysis.steps
    .filter((s) => s.status === 'completed')
    .map((s) => s.id);
  const openSteps = analysis.steps
    .filter((s) => s.status === 'open' || s.status === 'at_risk')
    .map((s) => s.id);
  const riskSteps = analysis.steps.filter((s) => s.status === 'at_risk').map((s) => s.id);
  const top = analysis.recommendations[0];

  return {
    scopeTitle: analysis.scopeTitle,
    completedSteps,
    openSteps,
    riskSteps,
    primaryRecommendationKey: top?.messageKey,
    primaryRecommendationParams: top?.params,
  };
}

function formatStepLine(stepId: FinanceStepId, status: FinanceStepStatus): string | null {
  if (status === 'not_applicable' || status === 'not_due') return null;
  const prefix =
    status === 'completed' ? '✓' : status === 'at_risk' ? '⚠' : status === 'unknown' ? '?' : '○';
  return `${prefix} ${getFinanceStepLabelDe(stepId)}`;
}

/**
 * P0/P1-INTEGRITAET 01B / P4 — ein Finanz-Schlüssel wird übersetzt; fertiger
 * Text bleibt, wie er ist. Die Antwortkarte übersetzt selbst nur `brain.*`.
 */
function financeNoteText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith('financeIntelligence.') ? translateWorkflowMessage(value) : value;
}

function buildFinanceBullets(analysis: FinanceAnalysis): string[] {
  const bullets: string[] = [];

  for (const financeStep of analysis.steps) {
    const line = formatStepLine(financeStep.id, financeStep.status);
    if (line) bullets.push(line);
  }

  /*
   * P0/P1-INTEGRITAET 01B / P4 — Hinweise und Empfehlungen tragen
   * Übersetzungsschlüssel mit Parametern; in die sichtbare Antwort gehört der
   * übersetzte Text (wie bei `workflowKnowledgeResolver`), nie der Schlüssel.
   */
  for (const risk of analysis.risks.slice(0, 3)) {
    bullets.push(`⚠ ${translateWorkflowMessage(risk.messageKey, risk.params)}`);
  }

  const top = analysis.recommendations[0];
  if (top) {
    bullets.push(`→ ${translateWorkflowMessage(top.messageKey, top.params)}`);
  }

  if (analysis.datevRelevantCount && analysis.datevRelevantCount > 0) {
    bullets.push(
      translateWorkflowMessage('financeIntelligence.datev.markForAccounting', {
        count: analysis.datevRelevantCount,
      }),
    );
  }

  return bullets.slice(0, 12);
}

function recommendationsToSteps(analysis: FinanceAnalysis): BrainSuggestedStep[] {
  return analysis.recommendations.slice(0, 3).map((rec) => ({
    id: rec.id,
    labelKey: rec.labelKey ?? 'financeIntelligence.nextStep.default',
    route: rec.route,
    reasonKey: rec.reasonKey,
  }));
}

function buildFinanceAnswer(
  analysis: FinanceAnalysis,
  title: string,
  intro: string,
  uncertaintyNote?: string,
): FinanceKnowledgeResolution {
  return {
    source: 'rules',
    financeUsed: ['finance_intelligence', analysis.scope],
    financeSummary: summarizeAnalysis(analysis),
    assistantAnswer: {
      title,
      summary: intro,
      bullets: buildFinanceBullets(analysis),
      actions: [],
      linkedRoute:
        analysis.scope === 'vorgang'
          ? `/vorgaenge/${analysis.scopeId}`
          : analysis.scope === 'invoice'
            ? undefined
            : analysis.scope === 'inbox'
              ? `/ablage/${analysis.scopeId}`
              : '/offene-rechnungen',
    },
    suggestedNextSteps: recommendationsToSteps(analysis),
    uncertaintyNote: financeNoteText(
      uncertaintyNote ??
        analysis.uncertaintyNote ??
        (analysis.risks.length > 0 ? 'financeIntelligence.uncertainty.reviewRecommended' : undefined),
    ),
  };
}

function getSessionInvoice(session: CompanySessionContext): VorgangInvoice | null {
  if (!session.lastInvoiceId || !session.lastInvoiceVorgangId) return null;
  return getVorgangInvoice(session.lastInvoiceVorgangId, session.lastInvoiceId) ?? null;
}

function buildTaxAnswer(
  titleKey: string,
  bullets: string[],
  summary: string,
): FinanceKnowledgeResolution {
  return {
    source: 'rules',
    financeUsed: ['finance_intelligence', 'tax_guidance'],
    assistantAnswer: {
      title: titleKey,
      summary,
      // P0/P1-INTEGRITAET 01B / P4 — übersetzt, nicht als Schlüssel.
      bullets: bullets.map((key) => translateWorkflowMessage(key)),
      actions: [],
    },
    uncertaintyNote: financeNoteText('financeIntelligence.tax.noAdvice'),
  };
}

function resolveReverseChargeQuestion(session: CompanySessionContext): FinanceKnowledgeResolution {
  const invoice = getSessionInvoice(session);
  const bullets = ['financeIntelligence.tax.reverseChargeExplain'];
  if (invoice?.taxStatus === 'reverse_charge_13b') {
    bullets.push('financeIntelligence.tax.reverseChargeWhen');
    const missing = getMissingTaxNoticesForInvoice(invoice);
    if (missing.length > 0) {
      bullets.push('financeIntelligence.tax.missingInvoiceNotices');
    }
  } else {
    bullets.push('financeIntelligence.tax.reverseChargeWhen');
  }
  return buildTaxAnswer(
    'Reverse Charge / §13b',
    bullets,
    'Reverse Charge verschiebt die Umsatzsteuerschuld auf den Leistungsempfänger. OfficeTakt ersetzt keine Steuerberatung.',
  );
}

function resolveKleinunternehmerQuestion(session: CompanySessionContext): FinanceKnowledgeResolution {
  const invoice = getSessionInvoice(session);
  const bullets = ['financeIntelligence.tax.kleinunternehmerExplain'];
  if (invoice?.taxStatus === 'kleinunternehmer_19') {
    const missing = getMissingTaxNoticesForInvoice(invoice);
    if (missing.length > 0) bullets.push('financeIntelligence.tax.missingInvoiceNotices');
    else bullets.push(...buildLegalNotices('kleinunternehmer_19').map(() => 'financeIntelligence.tax.kleinunternehmerExplain'));
  }
  return buildTaxAnswer(
    'Kleinunternehmerregelung',
    bullets,
    'Die Kleinunternehmerregelung betrifft die Umsatzsteuerpflicht. Bitte mit Steuerberater oder Buchhaltung prüfen.',
  );
}

export function isFinanceQuestion(question: string): boolean {
  const q = question.trim();
  if (!q) return false;

  if (/^was ist (vob|voob)/i.test(q)) return false;

  return (
    /zahlung|rechnung.*(offen|bezahlt|überfällig|ueberfaellig|fällig|faellig)|offene rechnung|überfällig|ueberfaellig/i.test(
      q,
    ) ||
    /skonto|mahnung|zahlungserinnerung|teilzahl|überzahl|ueberzahl|forderung/i.test(q) ||
    /zahlungseingang|noch kein.*zahlung|zahlung.*offen|bezahlt.*rechnung/i.test(q) ||
    /datev|buchungsbeleg|buchhaltung.*beleg/i.test(q) ||
    /doppelte rechnung|doppelte zahlung|dublette/i.test(q) ||
    /finanz.*(stand|übersicht|uebersicht)|kaufmännisch|zahlungsrisiko/i.test(q) ||
    /gutschrift|stornorechnung|reverse.?charge|§\s*13b|kleinunternehmer|umsatzsteuer/i.test(q)
  );
}

export function tryResolveFinanceQuestion(
  question: string,
  session: CompanySessionContext = getCompanySession(),
): FinanceKnowledgeResolution | null {
  const q = question.trim();
  if (!q || !isFinanceQuestion(q)) return null;

  if (/reverse.?charge|§\s*13b/i.test(q)) {
    return resolveReverseChargeQuestion(session);
  }

  if (/kleinunternehmer/i.test(q)) {
    return resolveKleinunternehmerQuestion(session);
  }

  const analysis = analyzeSessionFinance(session);
  if (!analysis && !hasActiveCompanyContext(session)) {
    return {
      source: 'clarification',
      financeUsed: [],
      assistantAnswer: {
        title: 'Finanzen',
        summary:
          'Für eine Finanz-Einschätzung brauche ich Bezug zu einem Auftrag, einer Rechnung oder einem Dokument.',
        bullets: [],
        actions: [],
      },
      clarificationQuestion: 'brain.clarification.specifyDocumentOrVorgang',
    };
  }

  if (!analysis) return null;

  if (/datev|buchungsbeleg|buchhaltung/i.test(q)) {
    const count = countDatevRelevantInboxItems();
    return buildFinanceAnswer(
      analysis,
      'Buchhaltungsbelege',
      count > 0
        ? `${count} Belege sind buchungsrelevant und sollten für die Buchhaltung vorgemerkt werden. Export oder Buchung erfolgt nicht automatisch.`
        : 'Auf Basis vorhandener Daten sind keine buchungsrelevanten Belege im Eingang erkannt.',
      'financeIntelligence.datev.noExport',
    );
  }

  if (/überfällig|ueberfaellig|mahnung|zahlungserinnerung/i.test(q)) {
    const overdueRisks = analysis.risks.filter(
      (risk) => risk.id === 'invoice_overdue' || risk.id.startsWith('overdue_'),
    );
    return buildFinanceAnswer(
      analysis,
      'Zahlungsfristen',
      overdueRisks.length > 0
        ? `Ich habe ${countLabel(overdueRisks.length, 'überfällige Rechnung', 'überfällige Rechnungen')} auf Basis Ihrer Daten erkannt.`
        : 'Auf Basis vorhandener Daten sind keine überfälligen Rechnungen erkannt.',
    );
  }

  if (/skonto/i.test(q)) {
    const skontoRec = analysis.recommendations.find((rec) =>
      ['incoming_skonto_usable', 'outgoing_skonto_customer', 'skonto_review_required'].includes(rec.id),
    );
    return buildFinanceAnswer(
      analysis,
      'Skonto',
      skontoRec
        ? 'Skonto-Hinweis auf Basis des erkannten Rechnungstyps und vorhandener Daten.'
        : 'Auf Basis vorhandener Daten ist aktuell kein Skonto erkennbar oder die Frist ist abgelaufen.',
      skontoRec?.id === 'skonto_review_required'
        ? 'financeIntelligence.skonto.reviewRequired'
        : 'financeIntelligence.uncertainty.reviewRecommended',
    );
  }

  if (/bezahlt|zahlungseingang|teilzahl|offen/i.test(q)) {
    const openSteps = analysis.steps.filter((s) => s.status === 'open' || s.status === 'at_risk');
    return buildFinanceAnswer(
      analysis,
      'Zahlungsstand',
      openSteps.length > 0
        ? `Zu „${analysis.scopeTitle}“ sind noch offene Zahlungsschritte erkannt.`
        : `Zu „${analysis.scopeTitle}“ sind auf Basis vorhandener Daten keine offenen Zahlungen erkannt.`,
    );
  }

  if (/doppelte|dublette/i.test(q)) {
    const dupRisks = analysis.risks.filter((risk) => risk.id.includes('duplicate'));
    return buildFinanceAnswer(
      analysis,
      'Dublettenprüfung',
      dupRisks.length > 0
        ? `Ich habe ${countLabel(dupRisks.length, 'mögliche Dublette', 'mögliche Dubletten')} erkannt – bitte manuell prüfen.`
        : 'Auf Basis vorhandener Daten sind keine Dubletten erkannt.',
    );
  }

  const top = analysis.recommendations[0];
  return buildFinanceAnswer(
    analysis,
    'Finanzstand',
    top
      ? `Empfehlung für „${analysis.scopeTitle}“ auf Basis Ihrer Daten.`
      : `Für „${analysis.scopeTitle}“ sind auf Basis vorhandener Daten keine dringenden Finanz-Schritte erkannt.`,
  );
}

export { summarizeAnalysis, getDocumentedDunningLevel };
