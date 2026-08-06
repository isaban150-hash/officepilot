import type {
  WorkflowAnalysis,
  WorkflowRecommendation,
  WorkflowRisk,
  WorkflowStep,
  WorkflowStepId,
  WorkflowStepStatus,
} from '../../types/workflowIntelligence';
import type { CompanySessionContext } from '../../types/companySession';
import type { InboxItem, Vorgang, WorkflowResult } from '../../types/models';
import { analyzeContractIntelligenceFromInbox } from '../contractIntelligenceService';
import { filterActiveItems, getInboxItemById, getInboxItems } from '../inboxService';
import {
  getOpenQuantity,
  getPositionBillingStatus,
  hasAbschlagsrechnung,
  hasFinalSchlussrechnung,
  hasSchlussrechnung,
} from '../orderBillingRules';
import { buildVorgangDraftFromInbox, findSimilarVorgaenge } from '../vorgangMatchingService';
import { getAllVorgaenge, getVorgangById } from '../vorgangService';

const WORKFLOW_ORDER: WorkflowStepId[] = [
  'werkvertrag',
  'auftrag',
  'leistungsverzeichnis',
  'material',
  'lieferschein',
  'aufmasz',
  'abschlagsrechnung',
  'schlussrechnung',
  'abnahme',
  'gewaehrleistung',
];

const STEP_LABEL_KEYS: Record<WorkflowStepId, string> = {
  werkvertrag: 'workflowIntelligence.step.werkvertrag',
  auftrag: 'workflowIntelligence.step.auftrag',
  leistungsverzeichnis: 'workflowIntelligence.step.leistungsverzeichnis',
  material: 'workflowIntelligence.step.material',
  lieferschein: 'workflowIntelligence.step.lieferschein',
  aufmasz: 'workflowIntelligence.step.aufmasz',
  abschlagsrechnung: 'workflowIntelligence.step.abschlagsrechnung',
  schlussrechnung: 'workflowIntelligence.step.schlussrechnung',
  abnahme: 'workflowIntelligence.step.abnahme',
  gewaehrleistung: 'workflowIntelligence.step.gewaehrleistung',
};

const PRIORITY_BLOCKS = 10;
const PRIORITY_RISK = 20;
const PRIORITY_MISSING = 30;
const PRIORITY_NEXT = 40;
const PRIORITY_OPTIONAL = 50;
const MAX_WORKFLOW_HINTS = 5;

function step(id: WorkflowStepId, status: WorkflowStepStatus, evidence?: string): WorkflowStep {
  return { id, status, labelKey: STEP_LABEL_KEYS[id], evidence };
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isMaterialInbox(item: InboxItem): boolean {
  return (
    item.classifiedKind === 'eingangsrechnung' ||
    item.documentType === 'eingangsrechnung' ||
    /material/i.test(item.title)
  );
}

function isAufmassSignal(item: InboxItem): boolean {
  return (
    item.classifiedKind === 'messprotokoll' ||
    item.classifiedKind === 'pruefprotokoll' ||
    /aufmaß|aufmass|mengenermittlung/i.test(item.title)
  );
}

function isLieferschein(item: InboxItem): boolean {
  return item.classifiedKind === 'lieferschein' || /lieferschein/i.test(item.title);
}

function isWerkvertragDoc(item: InboxItem): boolean {
  return (
    item.classifiedKind === 'werkvertrag' ||
    item.classifiedKind === 'leistungsverzeichnis' ||
    /werkvertrag/i.test(item.title)
  );
}

function isAlternativeOrderBasis(item: InboxItem): boolean {
  return (
    item.classifiedKind === 'angebot' ||
    item.classifiedKind === 'auftrag' ||
    item.classifiedKind === 'auftragsbestaetigung' ||
    item.documentType === 'kundenauftrag'
  );
}

function isAbnahme(item: InboxItem): boolean {
  return item.classifiedKind === 'abnahmeprotokoll' || /abnahme|übergabe/i.test(item.title);
}

function getLinkedInbox(vorgangId: string): InboxItem[] {
  return filterActiveItems(getInboxItems()).filter((item) => item.vorgangId === vorgangId);
}

function hasAnyInvoice(vorgang: Vorgang): boolean {
  return vorgang.invoices.some(
    (inv) => inv.status === 'vorbereitet' || inv.status === 'versendet',
  );
}

function allPositionsFullyBilled(vorgang: Vorgang): boolean {
  if (vorgang.orderPositions.length === 0) return false;
  return vorgang.orderPositions.every((position) => {
    const status = getPositionBillingStatus(vorgang, position.id);
    return status?.isFullyBilled;
  });
}

function hasOpenPositions(vorgang: Vorgang): boolean {
  return vorgang.orderPositions.some((position) => getOpenQuantity(vorgang, position.id) > 0);
}

function isUnknownCustomer(customer: string): boolean {
  const norm = customer.trim().toLowerCase();
  return !norm || norm === 'unbekannt' || norm === 'unbekannter kunde';
}

function hasBelastbareAuftragsgrundlage(vorgang: Vorgang, inbox: InboxItem[]): boolean {
  if (vorgang.orderPositions.length > 0) return true;
  if (inbox.some((item) => isWerkvertragDoc(item) || isAlternativeOrderBasis(item))) return true;
  if (vorgang.title?.trim() && !isUnknownCustomer(vorgang.customer)) return true;
  return false;
}

function contractAllowsAbschlag(inbox: InboxItem[]): boolean {
  const contractItem = inbox.find(isWerkvertragDoc);
  if (!contractItem) return false;
  return Boolean(analyzeContractIntelligenceFromInbox(contractItem)?.progressBillingAllowed);
}

function isAufmassRequired(vorgang: Vorgang, inbox: InboxItem[]): boolean {
  if (contractAllowsAbschlag(inbox)) return true;
  const measurableUnits = vorgang.orderPositions.some(
    (position) => position.unit === 'm²' || position.unit === 'Meter' || position.unit === 'Stunden',
  );
  if (!measurableUnits) return false;
  return hasAnyInvoice(vorgang) || allPositionsFullyBilled(vorgang);
}

function expectsLieferschein(vorgang: Vorgang, materialItems: InboxItem[]): boolean {
  if (materialItems.length === 0) return false;
  const hasMaterialPositions = vorgang.orderPositions.some((position) => position.category === 'material');
  return hasMaterialPositions || materialItems.length >= 2;
}

function parseMaterialAmount(item: InboxItem): string {
  return normalize(
    item.recognizedData.Betrag ??
      item.recognizedData.Brutto ??
      item.recognizedData.brutto ??
      item.recognizedData.Netto ??
      '',
  );
}

function parseMaterialSupplier(item: InboxItem): string {
  return normalize(item.recognizedData.Lieferant ?? item.sender ?? '');
}

function parseMaterialNumber(item: InboxItem): string {
  return normalize(item.recognizedData.Rechnungsnummer ?? item.recognizedData.rechnungsnummer ?? '');
}

function parseMaterialDate(item: InboxItem): string {
  return (item.recognizedData.Rechnungsdatum ?? item.receivedAt ?? '').trim();
}

function datesWithinWindow(a: string, b: string, days = 14): boolean {
  if (!a || !b) return false;
  const dateA = new Date(a);
  const dateB = new Date(b);
  if (Number.isNaN(dateA.getTime()) || Number.isNaN(dateB.getTime())) {
    return normalize(a) === normalize(b);
  }
  const diff = Math.abs(dateA.getTime() - dateB.getTime());
  return diff <= days * 24 * 60 * 60 * 1000;
}

function areMaterialDuplicates(a: InboxItem, b: InboxItem): boolean {
  const numberA = parseMaterialNumber(a);
  const numberB = parseMaterialNumber(b);
  if (!numberA || numberA !== numberB) return false;

  const supplierA = parseMaterialSupplier(a);
  const supplierB = parseMaterialSupplier(b);
  if (!supplierA || !supplierB || supplierA !== supplierB) return false;

  const amountA = parseMaterialAmount(a);
  const amountB = parseMaterialAmount(b);
  if (!amountA || !amountB || amountA !== amountB) return false;

  const dateA = parseMaterialDate(a);
  const dateB = parseMaterialDate(b);
  if (!dateA || !dateB) return false;
  return datesWithinWindow(dateA, dateB);
}

function findDuplicateMaterialInvoices(items: InboxItem[]): InboxItem[][] {
  const material = items.filter(isMaterialInbox);
  const groups: InboxItem[][] = [];
  const used = new Set<string>();

  for (let i = 0; i < material.length; i += 1) {
    if (used.has(material[i].id)) continue;
    const group = [material[i]];
    for (let j = i + 1; j < material.length; j += 1) {
      if (areMaterialDuplicates(material[i], material[j])) {
        group.push(material[j]);
        used.add(material[j].id);
      }
    }
    if (group.length > 1) {
      group.forEach((item) => used.add(item.id));
      groups.push(group);
    }
  }
  return groups;
}

function sortRecommendations(recs: WorkflowRecommendation[]): WorkflowRecommendation[] {
  return [...recs].sort((a, b) => a.priority - b.priority);
}

function sortRisks(risks: WorkflowRisk[]): WorkflowRisk[] {
  const order = { high: 0, medium: 1, low: 2 };
  return [...risks].sort((a, b) => order[a.severity] - order[b.severity]);
}

function capWorkflowOutput(analysis: WorkflowAnalysis): WorkflowAnalysis {
  return {
    ...analysis,
    risks: sortRisks(analysis.risks).slice(0, MAX_WORKFLOW_HINTS),
    recommendations: sortRecommendations(analysis.recommendations).slice(0, MAX_WORKFLOW_HINTS),
  };
}

function buildStepsForVorgang(vorgang: Vorgang, inbox: InboxItem[]): WorkflowStep[] {
  const werkvertragItems = inbox.filter(isWerkvertragDoc);
  const alternativeBasis = inbox.filter(isAlternativeOrderBasis);
  const materialItems = inbox.filter(isMaterialInbox);
  const lieferscheinItems = inbox.filter(isLieferschein);
  const aufmassItems = inbox.filter(isAufmassSignal);
  const abnahmeItems = inbox.filter(isAbnahme);
  const hasBasis = hasBelastbareAuftragsgrundlage(vorgang, inbox);

  let werkvertragStatus: WorkflowStepStatus = 'unknown';
  if (werkvertragItems.length > 0) werkvertragStatus = 'completed';
  else if (alternativeBasis.length > 0 || vorgang.orderPositions.length > 0) {
    werkvertragStatus = 'not_applicable';
  } else if (hasBasis) werkvertragStatus = 'not_applicable';

  const lvStatus: WorkflowStepStatus =
    vorgang.orderPositions.length > 0
      ? 'completed'
      : werkvertragItems.length > 0
        ? 'at_risk'
        : hasBasis
          ? 'unknown'
          : 'missing';

  let materialStatus: WorkflowStepStatus = 'not_applicable';
  if (materialItems.length > 0) materialStatus = 'completed';
  else if (vorgang.orderPositions.some((position) => position.category === 'material')) {
    materialStatus = 'partial';
  }

  let lieferscheinStatus: WorkflowStepStatus = 'not_applicable';
  if (lieferscheinItems.length > 0) lieferscheinStatus = 'completed';
  else if (expectsLieferschein(vorgang, materialItems)) lieferscheinStatus = 'at_risk';

  let aufmassStatus: WorkflowStepStatus = 'not_applicable';
  if (!isAufmassRequired(vorgang, inbox)) {
    aufmassStatus = 'not_applicable';
  } else if (aufmassItems.length > 0) {
    aufmassStatus = 'completed';
  } else if (allPositionsFullyBilled(vorgang) || hasSchlussrechnung(vorgang)) {
    aufmassStatus = 'at_risk';
  } else {
    aufmassStatus = 'not_due';
  }

  let abschlagStatus: WorkflowStepStatus = 'not_due';
  if (hasAbschlagsrechnung(vorgang)) abschlagStatus = 'completed';
  else if (contractAllowsAbschlag(inbox) && hasOpenPositions(vorgang)) abschlagStatus = 'partial';

  let schlussStatus: WorkflowStepStatus = 'not_due';
  if (hasSchlussrechnung(vorgang)) schlussStatus = 'completed';
  else if (allPositionsFullyBilled(vorgang)) schlussStatus = 'at_risk';

  const abnahmeStatus: WorkflowStepStatus =
    abnahmeItems.length > 0 ? 'completed' : hasSchlussrechnung(vorgang) ? 'missing' : 'not_due';

  let gewaehrleistungStatus: WorkflowStepStatus = 'not_due';
  if (abnahmeItems.length > 0 || hasSchlussrechnung(vorgang)) {
    gewaehrleistungStatus = 'missing';
  }

  return [
    step('werkvertrag', werkvertragStatus, werkvertragItems[0]?.title),
    step('auftrag', 'completed', vorgang.title),
    step('leistungsverzeichnis', lvStatus, `${vorgang.orderPositions.length} Positionen`),
    step('material', materialStatus, materialItems[0]?.title),
    step('lieferschein', lieferscheinStatus, lieferscheinItems[0]?.title),
    step('aufmasz', aufmassStatus, aufmassItems[0]?.title),
    step('abschlagsrechnung', abschlagStatus),
    step('schlussrechnung', schlussStatus),
    step('abnahme', abnahmeStatus, abnahmeItems[0]?.title),
    step('gewaehrleistung', gewaehrleistungStatus),
  ];
}

function buildRisksForVorgang(vorgang: Vorgang, inbox: InboxItem[]): WorkflowRisk[] {
  const risks: WorkflowRisk[] = [];
  const materialItems = inbox.filter(isMaterialInbox);
  const lieferscheinItems = inbox.filter(isLieferschein);

  if (isUnknownCustomer(vorgang.customer)) {
    risks.push({
      id: 'vorgang_without_customer',
      severity: 'high',
      messageKey: 'workflowIntelligence.risk.vorgangWithoutCustomer',
    });
  }

  if (hasAnyInvoice(vorgang) && !hasBelastbareAuftragsgrundlage(vorgang, inbox)) {
    risks.push({
      id: 'invoice_without_contract',
      severity: 'medium',
      messageKey: 'workflowIntelligence.risk.invoiceWithoutContract',
      params: { vorgang: vorgang.title },
    });
  }

  if (expectsLieferschein(vorgang, materialItems) && lieferscheinItems.length === 0) {
    risks.push({
      id: 'material_without_lieferschein',
      severity: 'medium',
      messageKey: 'workflowIntelligence.risk.materialWithoutLieferschein',
      params: { count: materialItems.length },
    });
  }

  const duplicates = findDuplicateMaterialInvoices(inbox);
  if (duplicates.length > 0) {
    risks.push({
      id: 'duplicate_material',
      severity: 'medium',
      messageKey: 'workflowIntelligence.risk.duplicateMaterial',
      params: { count: duplicates[0].length },
    });
  }

  if (
    isAufmassRequired(vorgang, inbox) &&
    (allPositionsFullyBilled(vorgang) || hasSchlussrechnung(vorgang)) &&
    !inbox.some(isAufmassSignal)
  ) {
    risks.push({
      id: 'schluss_without_aufmasz',
      severity: 'high',
      messageKey: 'workflowIntelligence.risk.schlussWithoutAufmasz',
    });
  }

  if (hasSchlussrechnung(vorgang) && !inbox.some(isAbnahme)) {
    risks.push({
      id: 'missing_abnahme',
      severity: 'medium',
      messageKey: 'workflowIntelligence.risk.missingAbnahme',
    });
  }

  if (hasOpenPositions(vorgang) && !hasFinalSchlussrechnung(vorgang)) {
    risks.push({
      id: 'open_positions',
      severity: 'low',
      messageKey: 'workflowIntelligence.risk.openPositions',
      params: {
        count: vorgang.orderPositions.filter((position) => getOpenQuantity(vorgang, position.id) > 0)
          .length,
      },
    });
  }

  return risks;
}

function buildRecommendationsForVorgang(vorgang: Vorgang, inbox: InboxItem[]): WorkflowRecommendation[] {
  const recs: WorkflowRecommendation[] = [];
  const materialItems = inbox.filter(isMaterialInbox);
  const lieferscheinItems = inbox.filter(isLieferschein);
  const aufmassItems = inbox.filter(isAufmassSignal);

  if (vorgang.orderPositions.length === 0 && inbox.some(isWerkvertragDoc)) {
    recs.push({
      id: 'import_positions',
      priority: PRIORITY_MISSING,
      messageKey: 'workflowIntelligence.recommend.importPositions',
      route: `/vorgaenge/${vorgang.id}`,
      labelKey: 'workflowIntelligence.nextStep.openVorgang',
    });
  }

  if (expectsLieferschein(vorgang, materialItems) && lieferscheinItems.length === 0) {
    recs.push({
      id: 'collect_lieferschein',
      priority: PRIORITY_OPTIONAL,
      messageKey: 'workflowIntelligence.recommend.collectLieferschein',
    });
  }

  if (
    isAufmassRequired(vorgang, inbox) &&
    !aufmassItems.length &&
    (allPositionsFullyBilled(vorgang) || hasOpenPositions(vorgang))
  ) {
    recs.push({
      id: 'check_aufmasz',
      priority: PRIORITY_RISK,
      messageKey: 'workflowIntelligence.recommend.checkAufmasz',
    });
  }

  if (hasOpenPositions(vorgang) && !hasFinalSchlussrechnung(vorgang)) {
    const allowsAbschlag = contractAllowsAbschlag(inbox);
    if (allowsAbschlag) {
      recs.push({
        id: 'create_abschlag',
        priority: PRIORITY_NEXT,
        messageKey: 'workflowIntelligence.recommend.createAbschlag',
        params: { vorgang: vorgang.title },
        route: `/vorgaenge/${vorgang.id}/rechnung`,
        labelKey: 'workflowIntelligence.nextStep.createInvoice',
        reasonKey: 'workflowIntelligence.nextStep.invoiceReason',
      });
    } else {
      recs.push({
        id: 'create_invoice',
        priority: PRIORITY_NEXT,
        messageKey: 'workflowIntelligence.recommend.createInvoice',
        params: { vorgang: vorgang.title },
        route: `/vorgaenge/${vorgang.id}/rechnung`,
        labelKey: 'workflowIntelligence.nextStep.createInvoice',
        reasonKey: 'workflowIntelligence.nextStep.invoiceReason',
      });
    }
  }

  if (allPositionsFullyBilled(vorgang) && !hasSchlussrechnung(vorgang)) {
    recs.push({
      id: 'create_schluss',
      priority: PRIORITY_NEXT,
      messageKey: 'workflowIntelligence.recommend.createSchluss',
      params: { vorgang: vorgang.title },
      route: `/vorgaenge/${vorgang.id}/rechnung`,
      labelKey: 'workflowIntelligence.nextStep.createSchluss',
      reasonKey: 'workflowIntelligence.nextStep.invoiceReason',
    });
  }

  if (hasSchlussrechnung(vorgang) && !inbox.some(isAbnahme)) {
    recs.push({
      id: 'prepare_abnahme',
      priority: PRIORITY_OPTIONAL,
      messageKey: 'workflowIntelligence.recommend.prepareAbnahme',
    });
  }

  return sortRecommendations(recs);
}

export function analyzeVorgangWorkflow(vorgangId: string): WorkflowAnalysis | null {
  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) return null;

  const inbox = getLinkedInbox(vorgangId);
  const relatedDocumentIds = [
    ...inbox.map((item) => item.id),
    ...vorgang.documents.map((doc) => doc.id),
  ];

  return capWorkflowOutput({
    scope: 'vorgang',
    scopeId: vorgang.id,
    scopeTitle: vorgang.title,
    steps: buildStepsForVorgang(vorgang, inbox),
    risks: buildRisksForVorgang(vorgang, inbox),
    recommendations: buildRecommendationsForVorgang(vorgang, inbox),
    relatedDocumentIds,
  });
}

export function analyzeInboxWorkflow(inboxId: string, workflow?: WorkflowResult | null): WorkflowAnalysis | null {
  const item = getInboxItemById(inboxId);
  if (!item) return null;

  if (item.vorgangId) {
    return analyzeVorgangWorkflow(item.vorgangId);
  }

  const steps: WorkflowStep[] = [];
  const risks: WorkflowRisk[] = [];
  const recommendations: WorkflowRecommendation[] = [];

  if (isWerkvertragDoc(item)) {
    steps.push(step('werkvertrag', 'completed', item.title));
    steps.push(step('auftrag', 'missing'));
    steps.push(step('leistungsverzeichnis', 'missing'));
    recommendations.push({
      id: 'create_vorgang',
      priority: PRIORITY_NEXT,
      messageKey: 'workflowIntelligence.recommend.createVorgangFromContract',
      route: `/ablage/${item.id}`,
      labelKey: 'workflowIntelligence.nextStep.reviewContract',
      reasonKey: 'workflowIntelligence.nextStep.createVorgangReason',
    });
  }

  if (isMaterialInbox(item)) {
    steps.push(step('material', 'completed', item.title));
    const matches =
      workflow?.similarVorgaenge ?? findSimilarVorgaenge(buildVorgangDraftFromInbox(item), getAllVorgaenge());
    if (matches.length === 1) {
      recommendations.push({
        id: 'link_material',
        priority: PRIORITY_BLOCKS,
        messageKey: 'workflowIntelligence.recommend.linkMaterialToVorgang',
        params: { vorgang: matches[0].title },
        route: `/ablage/${item.id}`,
        labelKey: 'workflowIntelligence.nextStep.linkMaterial',
      });
    } else if (matches.length > 1) {
      risks.push({
        id: 'material_ambiguous_vorgang',
        severity: 'medium',
        messageKey: 'workflowIntelligence.risk.materialAmbiguousVorgang',
      });
    } else {
      risks.push({
        id: 'material_without_vorgang',
        severity: 'high',
        messageKey: 'workflowIntelligence.risk.materialWithoutVorgang',
      });
      recommendations.push({
        id: 'assign_material',
        priority: PRIORITY_BLOCKS,
        messageKey: 'workflowIntelligence.recommend.assignMaterial',
        route: `/ablage/${item.id}`,
        labelKey: 'workflowIntelligence.nextStep.linkMaterial',
      });
    }
  }

  const filledSteps = WORKFLOW_ORDER.map((id) => {
    const existing = steps.find((entry) => entry.id === id);
    if (existing) return existing;
    if (id === 'auftrag' || id === 'werkvertrag') return step(id, 'missing');
    return step(id, 'not_applicable');
  });

  return capWorkflowOutput({
    scope: 'inbox',
    scopeId: item.id,
    scopeTitle: item.title,
    steps: filledSteps,
    risks,
    recommendations,
    relatedDocumentIds: [item.id],
  });
}

export function analyzeSessionWorkflow(session: CompanySessionContext): WorkflowAnalysis | null {
  if (session.currentVorgangId) {
    return analyzeVorgangWorkflow(session.currentVorgangId);
  }
  const inboxId = session.currentInboxId ?? session.lastUploadInboxId;
  if (inboxId) {
    return analyzeInboxWorkflow(inboxId);
  }
  return null;
}

const WORKFLOW_STEP_LABELS_DE: Record<WorkflowStepId, string> = {
  werkvertrag: 'Werkvertrag',
  auftrag: 'Auftrag',
  leistungsverzeichnis: 'Leistungsverzeichnis',
  material: 'Materialrechnung',
  lieferschein: 'Lieferschein',
  aufmasz: 'Aufmaß',
  abschlagsrechnung: 'Abschlagsrechnung',
  schlussrechnung: 'Schlussrechnung',
  abnahme: 'Abnahme',
  gewaehrleistung: 'Gewährleistung',
};

export function getWorkflowStepLabelDe(stepId: WorkflowStepId): string {
  return WORKFLOW_STEP_LABELS_DE[stepId];
}

export function buildWorkflowProactiveHints(
  session: CompanySessionContext,
): import('../../types/companySession').ProactiveHint[] {
  const analysis = analyzeSessionWorkflow(session);
  if (!analysis) return [];

  const hints: import('../../types/companySession').ProactiveHint[] = [];
  for (const rec of analysis.recommendations.slice(0, 3)) {
    hints.push({ messageKey: rec.messageKey, params: rec.params });
  }
  for (const risk of analysis.risks.slice(0, 2)) {
    hints.push({ messageKey: risk.messageKey, params: risk.params });
  }
  return hints.slice(0, MAX_WORKFLOW_HINTS);
}
