import type {
  FinanceAnalysis,
  FinanceRecommendation,
  FinanceRisk,
  FinanceStep,
  FinanceStepId,
  FinanceStepStatus,
} from '../../types/financeIntelligence';
import type { CompanySessionContext } from '../../types/companySession';
import type { InboxItem, InvoicePayment, Vorgang, VorgangInvoice } from '../../types/models';
import { getContractSkontoOfferForVorgang } from '../contractIntelligenceService';
import { getCommunicationHistoryStoreEvents } from '../communicationHistoryStore';
import { filterActiveItems, getInboxItemById, getInboxItems } from '../inboxService';
import { isFinalizedInvoice } from '../invoiceArchiveService';
import {
  getAllInvoiceOverview,
  getOverdueInvoices,
  summarizeInvoiceOverview,
  type InvoiceOverviewItem,
} from '../invoiceOverviewService';
import {
  calculatePaymentSummary,
  formatPaymentCurrency,
  getInvoicePayments,
  getOverdueDays,
  isInvoiceCancelled,
  isInvoiceOverdue,
} from '../invoicePaymentService';
import { buildLegalNotices } from '../invoiceTaxService';
import { getNotesForVorgang } from '../vorgangNoteService';
import { getAllVorgaenge, getVorgangById, getVorgangInvoice } from '../vorgangService';

const FINANCE_ORDER: FinanceStepId[] = ['auftrag', 'rechnung', 'zahlung', 'faelligkeit', 'mahnung'];

const STEP_LABEL_KEYS: Record<FinanceStepId, string> = {
  auftrag: 'financeIntelligence.step.auftrag',
  rechnung: 'financeIntelligence.step.rechnung',
  zahlung: 'financeIntelligence.step.zahlung',
  faelligkeit: 'financeIntelligence.step.faelligkeit',
  mahnung: 'financeIntelligence.step.mahnung',
};

const PRIORITY_PAYMENT_RISK = 10;
const PRIORITY_DEADLINE = 20;
const PRIORITY_MISSING_DOC = 30;
const PRIORITY_NEXT = 40;
const PRIORITY_OPTIONAL = 50;
const MAX_FINANCE_HINTS = 5;

const DATEV_RELEVANT_KINDS = new Set([
  'eingangsrechnung',
  'rechnung',
  'ausgangsrechnung',
  'gutschrift',
  'tankbeleg',
  'kassenbeleg',
  'quittung',
  'ec_beleg',
  'kreditkartenbeleg',
  'reparaturrechnung',
]);

type DueRelation = 'before' | 'on' | 'after' | 'none';
type DunningLevel = 0 | 1 | 2;
type DunningAction = 'none' | 'payment_reminder' | 'mahnung';

interface SkontoWindow {
  percent: number;
  days: number;
  deadline: string;
}

function step(id: FinanceStepId, status: FinanceStepStatus, evidence?: string): FinanceStep {
  return { id, status, labelKey: STEP_LABEL_KEYS[id], evidence };
}

function toDateOnly(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
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

function isIncomingInvoiceItem(item: InboxItem): boolean {
  return (
    item.classifiedKind === 'eingangsrechnung' ||
    item.documentType === 'eingangsrechnung' ||
    item.classifiedKind === 'gutschrift'
  );
}

export function isSentInvoice(invoice: VorgangInvoice): boolean {
  return invoice.status === 'versendet';
}

export function isExpectingPayment(invoice: VorgangInvoice): boolean {
  return isSentInvoice(invoice) && !isInvoiceCancelled(invoice);
}

function getDueRelation(invoice: VorgangInvoice, today: Date | string): DueRelation {
  if (!invoice.paymentDueDate) return 'none';
  const todayStr = toDateOnly(today);
  const due = toDateOnly(invoice.paymentDueDate);
  if (todayStr < due) return 'before';
  if (todayStr === due) return 'on';
  return 'after';
}

export function isDatevRelevantKind(kind?: string): boolean {
  if (!kind) return false;
  return DATEV_RELEVANT_KINDS.has(kind);
}

export function countDatevRelevantInboxItems(): number {
  return filterActiveItems(getInboxItems()).filter((item) =>
    isDatevRelevantKind(item.classifiedKind),
  ).length;
}

export function countUnassignedDatevRelevantInbox(): number {
  return filterActiveItems(getInboxItems()).filter(
    (item) => isDatevRelevantKind(item.classifiedKind) && !item.vorgangId,
  ).length;
}

function parseSkontoFromText(text: string): { percent: number; days: number } | null {
  const percentFirst = text.match(/(\d+(?:[.,]\d+)?)\s*%.*?(\d+)\s*tage/i);
  if (percentFirst) {
    const percent = Number(percentFirst[1].replace(',', '.'));
    const days = Number(percentFirst[2]);
    if (Number.isFinite(percent) && Number.isFinite(days) && percent > 0 && days > 0) {
      return { percent, days };
    }
  }

  const daysFirst = text.match(/(\d+)\s*tage.*?(\d+(?:[.,]\d+)?)\s*%/i);
  if (daysFirst) {
    const days = Number(daysFirst[1]);
    const percent = Number(daysFirst[2].replace(',', '.'));
    if (Number.isFinite(percent) && Number.isFinite(days) && percent > 0 && days > 0) {
      return { percent, days };
    }
  }

  return null;
}

function buildSkontoDeadline(baseDate: string, days: number): string {
  const deadlineDate = new Date(baseDate);
  deadlineDate.setDate(deadlineDate.getDate() + days);
  return toDateOnly(deadlineDate);
}

function getOutgoingSkontoWindow(
  invoice: VorgangInvoice,
  vorgang: Vorgang,
  today: Date | string,
): SkontoWindow | null {
  let percent = 0;
  let days = 0;

  if (invoice.skontoText?.trim()) {
    const parsed = parseSkontoFromText(invoice.skontoText);
    if (parsed) {
      percent = parsed.percent;
      days = parsed.days;
    }
  }

  if (percent <= 0 || days <= 0) {
    const contractOffer = getContractSkontoOfferForVorgang(vorgang);
    if (contractOffer) {
      percent = contractOffer.percent;
      days = contractOffer.days;
    }
  }

  if (percent <= 0 || days <= 0) return null;

  const baseDate = invoice.issueDate ?? invoice.date;
  if (!baseDate) return null;

  const deadline = buildSkontoDeadline(baseDate, days);
  if (toDateOnly(today) > deadline) return null;

  return { percent, days, deadline };
}

function getIncomingSkontoWindow(item: InboxItem, today: Date | string): SkontoWindow | null {
  const textSources = [
    item.recognizedData.Skonto,
    item.recognizedData.skonto,
    item.recognizedData.Zahlungsbedingungen,
    item.recognizedData.zahlungsbedingungen,
  ].filter(Boolean) as string[];

  let percent = 0;
  let days = 0;
  for (const source of textSources) {
    const parsed = parseSkontoFromText(source);
    if (parsed) {
      percent = parsed.percent;
      days = parsed.days;
      break;
    }
  }

  if (percent <= 0 || days <= 0) return null;

  const baseDate = item.recognizedData.Rechnungsdatum ?? item.receivedAt;
  if (!baseDate) return null;

  const deadline = buildSkontoDeadline(baseDate, days);
  if (toDateOnly(today) > deadline) return null;

  return { percent, days, deadline };
}

function parseIncomingAmount(item: InboxItem): number | null {
  const raw = item.recognizedData.Betrag ?? item.recognizedData.Brutto ?? item.recognizedData.Netto ?? '';
  const cleaned = raw.replace(/[^\d,.-]/g, '').trim();
  if (!cleaned) return null;

  const german = cleaned.match(/^(\d{1,3}(?:\.\d{3})*),(\d{2})$/);
  if (german) {
    const value = Number(`${german[1].replace(/\./g, '')}.${german[2]}`);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  const value = Number(cleaned.replace(',', '.'));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function calculateSkontoPayableAmount(amount: number, percent: number): number {
  return Math.round(amount * (1 - percent / 100) * 100) / 100;
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

function areOutgoingInvoicesDuplicate(a: VorgangInvoice, b: VorgangInvoice): boolean {
  if (a.id === b.id) return false;
  const numberA = normalize(a.number);
  const numberB = normalize(b.number);
  if (!numberA || numberA !== numberB) return false;

  const customerA = normalize(a.customerSnapshot?.name ?? '');
  const customerB = normalize(b.customerSnapshot?.name ?? '');
  if (!customerA || customerA !== customerB) return false;

  if (a.amount !== b.amount) return false;
  return datesWithinWindow(a.issueDate ?? a.date, b.issueDate ?? b.date);
}

function findDuplicateOutgoingInvoices(items: InvoiceOverviewItem[]): InvoiceOverviewItem[][] {
  const groups: InvoiceOverviewItem[][] = [];
  const used = new Set<string>();

  for (let i = 0; i < items.length; i += 1) {
    if (used.has(items[i].invoice.id)) continue;
    const group = [items[i]];
    for (let j = i + 1; j < items.length; j += 1) {
      if (areOutgoingInvoicesDuplicate(items[i].invoice, items[j].invoice)) {
        group.push(items[j]);
        used.add(items[j].invoice.id);
      }
    }
    if (group.length > 1) {
      group.forEach((item) => used.add(item.invoice.id));
      groups.push(group);
    }
  }
  return groups;
}

function arePaymentsDuplicate(a: InvoicePayment, b: InvoicePayment): boolean {
  if (a.id === b.id) return false;
  if (a.amount !== b.amount) return false;
  if (toDateOnly(a.date) !== toDateOnly(b.date)) return false;
  return normalize(a.reference ?? '') === normalize(b.reference ?? '');
}

function findDuplicatePayments(invoice: VorgangInvoice): InvoicePayment[][] {
  const payments = getInvoicePayments(invoice);
  const groups: InvoicePayment[][] = [];
  const used = new Set<string>();

  for (let i = 0; i < payments.length; i += 1) {
    if (used.has(payments[i].id)) continue;
    const group = [payments[i]];
    for (let j = i + 1; j < payments.length; j += 1) {
      if (arePaymentsDuplicate(payments[i], payments[j])) {
        group.push(payments[j]);
        used.add(payments[j].id);
      }
    }
    if (group.length > 1) {
      group.forEach((payment) => used.add(payment.id));
      groups.push(group);
    }
  }
  return groups;
}

function hasPaymentDisputeOrDeferral(vorgang: Vorgang, invoice: VorgangInvoice): boolean {
  const pattern = /streit|aufschub|reklamation|beanstandung|zahlung.*vertag|widerspruch/i;
  for (const note of getNotesForVorgang(vorgang.id)) {
    if (pattern.test(note.body)) return true;
  }
  if (invoice.cancelReason?.trim()) return true;
  return false;
}

export function getDocumentedDunningLevel(vorgangId: string, invoiceNumber: string): DunningLevel {
  let level: DunningLevel = 0;
  const normNumber = normalize(invoiceNumber);

  for (const event of getCommunicationHistoryStoreEvents()) {
    const excerpt = `${event.userInputExcerpt ?? ''} ${event.resultExcerpt ?? ''}`;
    const matchesInvoice =
      (event.contextRef.type === 'invoice' &&
        event.contextRef.vorgangId === vorgangId &&
        event.contextRef.id) ||
      normalize(excerpt).includes(normNumber);

    if (!matchesInvoice) continue;

    if (event.intent === 'payment_reminder') level = Math.max(level, 1) as DunningLevel;
    if (/mahnung/i.test(excerpt)) level = 2;
    else if (/zahlungserinnerung/i.test(excerpt)) level = Math.max(level, 1) as DunningLevel;
  }

  for (const note of getNotesForVorgang(vorgangId)) {
    if (!normalize(note.body).includes(normNumber)) continue;
    if (/mahnung/i.test(note.body)) level = 2;
    else if (/zahlungserinnerung/i.test(note.body)) level = Math.max(level, 1) as DunningLevel;
  }

  for (const item of filterActiveItems(getInboxItems()).filter((entry) => entry.vorgangId === vorgangId)) {
    const ref = normalize(item.recognizedData.Rechnungsnummer ?? item.title);
    if (normNumber && ref && !ref.includes(normNumber)) continue;
    if (item.classifiedKind === 'mahnung') level = 2;
    if (item.classifiedKind === 'zahlungserinnerung') level = Math.max(level, 1) as DunningLevel;
  }

  return level;
}

function resolveDunningAction(
  invoice: VorgangInvoice,
  vorgang: Vorgang,
  today: Date | string,
): DunningAction {
  if (!isExpectingPayment(invoice)) return 'none';
  const summary = calculatePaymentSummary(invoice, today);
  if (summary.openAmount <= 0 || summary.status === 'bezahlt') return 'none';
  if (getDueRelation(invoice, today) !== 'after') return 'none';
  if (hasPaymentDisputeOrDeferral(vorgang, invoice)) return 'none';

  const overdueDays = getOverdueDays(invoice, today);
  if (overdueDays <= 0) return 'none';

  const level = getDocumentedDunningLevel(vorgang.id, invoice.number);
  if (level >= 2) return 'none';

  if (level === 1 && overdueDays >= 7) return 'mahnung';
  if (level === 0 && overdueDays >= 3) return 'payment_reminder';

  return 'none';
}

function sortByPriority<T extends { priority: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.priority - b.priority);
}

function sortRisks(risks: FinanceRisk[]): FinanceRisk[] {
  const order = { high: 0, medium: 1, low: 2 };
  return [...risks].sort((a, b) => {
    const priorityDiff = a.priority - b.priority;
    if (priorityDiff !== 0) return priorityDiff;
    return order[a.severity] - order[b.severity];
  });
}

function capFinanceOutput(analysis: FinanceAnalysis): FinanceAnalysis {
  const risks = sortRisks(analysis.risks);
  const recommendations = sortByPriority(analysis.recommendations);
  const merged = [
    ...risks.map((risk) => ({ priority: risk.priority, risk, recommendation: undefined as FinanceRecommendation | undefined })),
    ...recommendations.map((recommendation) => ({
      priority: recommendation.priority,
      risk: undefined as FinanceRisk | undefined,
      recommendation,
    })),
  ].sort((a, b) => a.priority - b.priority);

  const capped = merged.slice(0, MAX_FINANCE_HINTS);
  return {
    ...analysis,
    risks: capped.map((entry) => entry.risk).filter((risk): risk is FinanceRisk => Boolean(risk)),
    recommendations: capped
      .map((entry) => entry.recommendation)
      .filter((recommendation): recommendation is FinanceRecommendation => Boolean(recommendation)),
  };
}

function buildStepsForInvoice(
  vorgang: Vorgang,
  invoice: VorgangInvoice,
  today: Date | string,
): FinanceStep[] {
  if (invoice.status === 'entwurf') {
    return [
      step('auftrag', 'completed', vorgang.title),
      step('rechnung', 'open', 'Entwurf'),
      step('zahlung', 'not_applicable'),
      step('faelligkeit', 'not_applicable'),
      step('mahnung', 'not_applicable'),
    ];
  }

  if (!isSentInvoice(invoice)) {
    return [
      step('auftrag', 'completed', vorgang.title),
      step('rechnung', 'completed', invoice.number),
      step('zahlung', 'not_due', 'Noch nicht versendet'),
      step('faelligkeit', 'not_due'),
      step('mahnung', 'not_applicable'),
    ];
  }

  const summary = calculatePaymentSummary(invoice, today);
  const overdueDays = getOverdueDays(invoice, today);
  const dueRelation = getDueRelation(invoice, today);
  const hasPayments = getInvoicePayments(invoice).length > 0;
  const dunningAction = resolveDunningAction(invoice, vorgang, today);

  let zahlungStatus: FinanceStepStatus = 'not_due';
  if (summary.status === 'bezahlt' || summary.overpaidAmount > 0) zahlungStatus = 'completed';
  else if (summary.status === 'teilbezahlt') zahlungStatus = 'at_risk';
  else if (dueRelation === 'after') zahlungStatus = 'at_risk';
  else if (dueRelation === 'on') zahlungStatus = 'open';
  else if (dueRelation === 'before') zahlungStatus = 'not_due';

  let faelligkeitStatus: FinanceStepStatus = 'not_applicable';
  if (summary.openAmount > 0) {
    if (dueRelation === 'after') faelligkeitStatus = 'at_risk';
    else if (dueRelation === 'on') faelligkeitStatus = 'open';
    else if (dueRelation === 'before') faelligkeitStatus = 'not_due';
  }

  let mahnungStatus: FinanceStepStatus = 'not_due';
  if (dunningAction === 'mahnung') mahnungStatus = 'at_risk';
  else if (dunningAction === 'payment_reminder') mahnungStatus = 'open';

  return [
    step('auftrag', 'completed', vorgang.title),
    step('rechnung', 'completed', invoice.number),
    step(
      'zahlung',
      zahlungStatus,
      hasPayments ? formatPaymentCurrency(summary.paidAmount) : summary.openAmount > 0 ? formatPaymentCurrency(summary.openAmount) : undefined,
    ),
    step('faelligkeit', faelligkeitStatus, invoice.paymentDueDate),
    step('mahnung', mahnungStatus, overdueDays > 0 ? `${overdueDays} Tage` : undefined),
  ];
}

function buildRisksForInvoice(
  _vorgang: Vorgang,
  invoice: VorgangInvoice,
  today: Date | string,
): FinanceRisk[] {
  const risks: FinanceRisk[] = [];
  if (!isExpectingPayment(invoice)) return risks;

  const summary = calculatePaymentSummary(invoice, today);
  const overdueDays = getOverdueDays(invoice, today);
  const dueRelation = getDueRelation(invoice, today);
  const hasPayments = getInvoicePayments(invoice).length > 0;

  if (dueRelation === 'after' && summary.openAmount > 0) {
    risks.push({
      id: 'invoice_overdue',
      severity: overdueDays >= 21 ? 'high' : 'medium',
      messageKey: 'financeIntelligence.risk.invoiceOverdue',
      params: { days: overdueDays, number: invoice.number },
      priority: PRIORITY_PAYMENT_RISK,
    });
  }

  if (dueRelation === 'after' && summary.openAmount > 0 && !hasPayments) {
    risks.push({
      id: 'payment_open',
      severity: 'medium',
      messageKey: 'financeIntelligence.risk.paymentOpen',
      params: { number: invoice.number },
      priority: PRIORITY_PAYMENT_RISK,
    });
  }

  if (summary.status === 'teilbezahlt' && summary.openAmount > 0) {
    risks.push({
      id: 'partial_payment',
      severity: dueRelation === 'after' ? 'medium' : 'low',
      messageKey: 'financeIntelligence.risk.partialPayment',
      params: { amount: formatPaymentCurrency(summary.openAmount), number: invoice.number },
      priority: PRIORITY_PAYMENT_RISK,
    });
  }

  const duplicatePayments = findDuplicatePayments(invoice);
  if (duplicatePayments.length > 0) {
    risks.push({
      id: 'duplicate_payment',
      severity: 'medium',
      messageKey: 'financeIntelligence.risk.duplicatePayment',
      params: { number: invoice.number, count: duplicatePayments[0].length },
      priority: PRIORITY_PAYMENT_RISK,
    });
  }

  return risks;
}

function buildRecommendationsForInvoice(
  vorgang: Vorgang,
  invoice: VorgangInvoice,
  today: Date | string,
): FinanceRecommendation[] {
  const recs: FinanceRecommendation[] = [];
  if (!isExpectingPayment(invoice)) return recs;

  const summary = calculatePaymentSummary(invoice, today);
  const dueRelation = getDueRelation(invoice, today);
  const hasPayments = getInvoicePayments(invoice).length > 0;
  const dunningAction = resolveDunningAction(invoice, vorgang, today);
  const skonto = getOutgoingSkontoWindow(invoice, vorgang, today);

  if (dueRelation === 'on' && summary.openAmount > 0) {
    recs.push({
      id: 'due_today',
      priority: PRIORITY_OPTIONAL,
      messageKey: 'financeIntelligence.info.dueToday',
      params: { number: invoice.number },
    });
  }

  if (dunningAction === 'mahnung') {
    recs.push({
      id: 'mahnung',
      priority: PRIORITY_PAYMENT_RISK,
      messageKey: 'financeIntelligence.recommend.mahnung',
      params: { number: invoice.number, days: getOverdueDays(invoice, today) },
      route: `/vorgaenge/${vorgang.id}/rechnung/${invoice.id}`,
      labelKey: 'financeIntelligence.nextStep.paymentReminder',
      reasonKey: 'financeIntelligence.uncertainty.reviewRecommended',
    });
  } else if (dunningAction === 'payment_reminder') {
    recs.push({
      id: 'payment_reminder',
      priority: PRIORITY_DEADLINE,
      messageKey: 'financeIntelligence.recommend.paymentReminder',
      params: { number: invoice.number, days: getOverdueDays(invoice, today) },
      route: `/vorgaenge/${vorgang.id}/rechnung/${invoice.id}`,
      labelKey: 'financeIntelligence.nextStep.paymentReminder',
    });
  }

  if (summary.openAmount > 0 && dueRelation === 'after' && !hasPayments) {
    recs.push({
      id: 'record_payment',
      priority: PRIORITY_NEXT,
      messageKey: 'financeIntelligence.recommend.recordPayment',
      params: { number: invoice.number },
      route: `/vorgaenge/${vorgang.id}/rechnung/${invoice.id}`,
      labelKey: 'financeIntelligence.nextStep.recordPayment',
    });
  }

  if (skonto && summary.openAmount > 0) {
    recs.push({
      id: 'outgoing_skonto_customer',
      priority: PRIORITY_DEADLINE,
      messageKey: 'financeIntelligence.skonto.outgoingCustomer',
      params: {
        number: invoice.number,
        percent: skonto.percent,
        deadline: skonto.deadline,
      },
      route: `/vorgaenge/${vorgang.id}/rechnung/${invoice.id}`,
      labelKey: 'financeIntelligence.nextStep.openInvoice',
    });
  }

  if (summary.overpaidAmount > 0) {
    recs.push({
      id: 'review_overpaid',
      priority: PRIORITY_OPTIONAL,
      messageKey: 'financeIntelligence.recommend.reviewOverpaid',
      params: { number: invoice.number, amount: formatPaymentCurrency(summary.overpaidAmount) },
      route: `/vorgaenge/${vorgang.id}/rechnung/${invoice.id}`,
      labelKey: 'financeIntelligence.nextStep.openInvoice',
    });
  }

  return sortByPriority(recs);
}

function buildDraftInvoiceAnalysis(vorgang: Vorgang, invoice: VorgangInvoice): FinanceAnalysis {
  return capFinanceOutput({
    scope: 'invoice',
    scopeId: invoice.id,
    scopeTitle: `${invoice.number} – ${vorgang.title}`,
    steps: buildStepsForInvoice(vorgang, invoice, new Date()),
    risks: [],
    recommendations: [],
  });
}

export function analyzeInvoiceFinance(
  vorgangId: string,
  invoiceId: string,
  today: Date | string = new Date(),
): FinanceAnalysis | null {
  const vorgang = getVorgangById(vorgangId);
  const invoice = getVorgangInvoice(vorgangId, invoiceId);
  if (!vorgang || !invoice) return null;

  if (invoice.status === 'entwurf') {
    return buildDraftInvoiceAnalysis(vorgang, invoice);
  }

  if (!isFinalizedInvoice(invoice)) return null;

  const summary = calculatePaymentSummary(invoice, today);
  const needsReview =
    isExpectingPayment(invoice) &&
    summary.openAmount > 0 &&
    (getDueRelation(invoice, today) === 'after' || getInvoicePayments(invoice).length === 0);

  return capFinanceOutput({
    scope: 'invoice',
    scopeId: invoice.id,
    scopeTitle: `${invoice.number} – ${vorgang.title}`,
    steps: buildStepsForInvoice(vorgang, invoice, today),
    risks: buildRisksForInvoice(vorgang, invoice, today),
    recommendations: buildRecommendationsForInvoice(vorgang, invoice, today),
    uncertaintyNote: needsReview ? 'financeIntelligence.uncertainty.reviewRecommended' : undefined,
  });
}

function buildStepsForVorgang(vorgang: Vorgang, today: Date | string): FinanceStep[] {
  const sentInvoices = (vorgang.invoices ?? []).filter(isSentInvoice);
  const finalized = (vorgang.invoices ?? []).filter(isFinalizedInvoice);
  const hasInvoice = finalized.length > 0;
  const openInvoices = sentInvoices.filter((inv) => calculatePaymentSummary(inv, today).openAmount > 0);
  const overdueInvoices = sentInvoices.filter((inv) => isInvoiceOverdue(inv, today));
  const allPaid = sentInvoices.length > 0 && openInvoices.length === 0;

  let rechnungStatus: FinanceStepStatus = hasInvoice ? 'completed' : 'open';
  if (!hasInvoice && vorgang.orderPositions.length > 0) rechnungStatus = 'at_risk';

  let zahlungStatus: FinanceStepStatus = 'not_applicable';
  if (sentInvoices.length > 0) {
    if (allPaid) zahlungStatus = 'completed';
    else if (openInvoices.some((inv) => getInvoicePayments(inv).length > 0)) zahlungStatus = 'at_risk';
    else zahlungStatus = openInvoices.length > 0 ? 'open' : 'not_due';
  }

  let faelligkeitStatus: FinanceStepStatus = 'not_applicable';
  if (openInvoices.length > 0) {
    faelligkeitStatus = overdueInvoices.length > 0 ? 'at_risk' : 'open';
  }

  let mahnungStatus: FinanceStepStatus = 'not_due';
  if (sentInvoices.some((inv) => resolveDunningAction(inv, vorgang, today) === 'mahnung')) {
    mahnungStatus = 'at_risk';
  } else if (sentInvoices.some((inv) => resolveDunningAction(inv, vorgang, today) === 'payment_reminder')) {
    mahnungStatus = 'open';
  }

  return [
    step('auftrag', 'completed', vorgang.title),
    step('rechnung', rechnungStatus, hasInvoice ? `${finalized.length} Rechnung(en)` : undefined),
    step('zahlung', zahlungStatus),
    step('faelligkeit', faelligkeitStatus),
    step('mahnung', mahnungStatus),
  ];
}

function buildRisksForVorgang(vorgang: Vorgang, today: Date | string): FinanceRisk[] {
  const risks: FinanceRisk[] = [];
  const finalized = (vorgang.invoices ?? []).filter(isFinalizedInvoice);
  const overviewItems = finalized.map((invoice) => ({
    vorgangId: vorgang.id,
    vorgangTitle: vorgang.title,
    customer: vorgang.customer,
    baustelle: vorgang.baustelle,
    invoice,
    paymentSummary: calculatePaymentSummary(invoice, today),
  }));

  if (finalized.length === 0 && vorgang.orderPositions.length > 0) {
    risks.push({
      id: 'no_invoice_on_vorgang',
      severity: 'medium',
      messageKey: 'financeIntelligence.risk.noInvoiceOnVorgang',
      params: { vorgang: vorgang.title },
      priority: PRIORITY_MISSING_DOC,
    });
  }

  for (const item of overviewItems) {
    risks.push(...buildRisksForInvoice(vorgang, item.invoice, today));
  }

  const duplicates = findDuplicateOutgoingInvoices(overviewItems);
  if (duplicates.length > 0) {
    risks.push({
      id: 'duplicate_invoice',
      severity: 'medium',
      messageKey: 'financeIntelligence.risk.duplicateInvoice',
      params: { number: duplicates[0][0].invoice.number, count: duplicates[0].length },
      priority: PRIORITY_PAYMENT_RISK,
    });
  }

  return risks;
}

function buildRecommendationsForVorgang(vorgang: Vorgang, today: Date | string): FinanceRecommendation[] {
  const recs: FinanceRecommendation[] = [];
  const finalized = (vorgang.invoices ?? []).filter(isFinalizedInvoice);

  if (finalized.length === 0 && vorgang.orderPositions.length > 0) {
    recs.push({
      id: 'create_invoice',
      priority: PRIORITY_NEXT,
      messageKey: 'financeIntelligence.recommend.createInvoice',
      params: { vorgang: vorgang.title },
      route: `/vorgaenge/${vorgang.id}/rechnung`,
      labelKey: 'financeIntelligence.nextStep.openInvoice',
    });
  }

  const sentInvoices = finalized.filter(isSentInvoice);
  const topOverdue = sentInvoices
    .filter((inv) => resolveDunningAction(inv, vorgang, today) !== 'none')
    .sort((a, b) => getOverdueDays(b, today) - getOverdueDays(a, today))[0];

  if (topOverdue) {
    const action = resolveDunningAction(topOverdue, vorgang, today);
    recs.push({
      id: action,
      priority: action === 'mahnung' ? PRIORITY_PAYMENT_RISK : PRIORITY_DEADLINE,
      messageKey:
        action === 'mahnung'
          ? 'financeIntelligence.recommend.mahnung'
          : 'financeIntelligence.recommend.paymentReminder',
      params: { number: topOverdue.number, days: getOverdueDays(topOverdue, today) },
      route: `/vorgaenge/${vorgang.id}/rechnung/${topOverdue.id}`,
      labelKey: 'financeIntelligence.nextStep.paymentReminder',
    });
  }

  return sortByPriority(recs);
}

export function analyzeVorgangFinance(
  vorgangId: string,
  today: Date | string = new Date(),
): FinanceAnalysis | null {
  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) return null;

  return capFinanceOutput({
    scope: 'vorgang',
    scopeId: vorgang.id,
    scopeTitle: vorgang.title,
    steps: buildStepsForVorgang(vorgang, today),
    risks: buildRisksForVorgang(vorgang, today),
    recommendations: buildRecommendationsForVorgang(vorgang, today),
  });
}

export function analyzeGlobalFinance(today: Date | string = new Date()): FinanceAnalysis {
  const overview = getAllInvoiceOverview(today);
  const totals = summarizeInvoiceOverview(overview);
  const overdue = getOverdueInvoices(today);
  const risks: FinanceRisk[] = [];
  const recommendations: FinanceRecommendation[] = [];

  if (totals.openInvoiceCount > 0) {
    risks.push({
      id: 'open_receivables',
      severity: totals.overdueInvoiceCount > 0 ? 'high' : 'medium',
      messageKey: 'financeIntelligence.risk.openReceivables',
      params: {
        count: totals.openInvoiceCount,
        amount: formatPaymentCurrency(totals.openReceivables),
      },
      priority: PRIORITY_PAYMENT_RISK,
    });
  }

  for (const item of overdue.slice(0, 2)) {
    const vorgang = getVorgangById(item.vorgangId);
    if (!vorgang || !isSentInvoice(item.invoice)) continue;
    const days = getOverdueDays(item.invoice, today);
    risks.push({
      id: `overdue_${item.invoice.id}`,
      severity: days >= 21 ? 'high' : 'medium',
      messageKey: 'financeIntelligence.risk.invoiceOverdue',
      params: { days, number: item.invoice.number },
      priority: PRIORITY_PAYMENT_RISK,
    });
  }

  const duplicates = findDuplicateOutgoingInvoices(overview);
  if (duplicates.length > 0) {
    risks.push({
      id: 'duplicate_invoice_global',
      severity: 'medium',
      messageKey: 'financeIntelligence.risk.duplicateInvoice',
      params: { number: duplicates[0][0].invoice.number, count: duplicates[0].length },
      priority: PRIORITY_PAYMENT_RISK,
    });
  }

  const unassignedDatev = countUnassignedDatevRelevantInbox();
  if (unassignedDatev > 0) {
    recommendations.push({
      id: 'collect_datev_docs',
      priority: PRIORITY_MISSING_DOC,
      messageKey: 'financeIntelligence.datev.markForAccounting',
      params: { count: unassignedDatev },
      route: '/eingang',
      labelKey: 'financeIntelligence.nextStep.assignMaterial',
    });
  }

  const topOverdue = overdue.find((item) => {
    const vorgang = getVorgangById(item.vorgangId);
    return vorgang && resolveDunningAction(item.invoice, vorgang, today) !== 'none';
  });

  if (topOverdue) {
    const vorgang = getVorgangById(topOverdue.vorgangId);
    if (vorgang) {
      const action = resolveDunningAction(topOverdue.invoice, vorgang, today);
      recommendations.push({
        id: action,
        priority: action === 'mahnung' ? PRIORITY_PAYMENT_RISK : PRIORITY_DEADLINE,
        messageKey:
          action === 'mahnung'
            ? 'financeIntelligence.recommend.mahnung'
            : 'financeIntelligence.recommend.paymentReminder',
        params: { number: topOverdue.invoice.number, days: getOverdueDays(topOverdue.invoice, today) },
        route: `/vorgaenge/${topOverdue.vorgangId}/rechnung/${topOverdue.invoice.id}`,
        labelKey: 'financeIntelligence.nextStep.paymentReminder',
      });
    }
  }

  const datevCount = countDatevRelevantInboxItems();

  return capFinanceOutput({
    scope: 'global',
    scopeId: 'global',
    scopeTitle: 'Finanzübersicht',
    steps: [
      step('auftrag', 'completed', `${getAllVorgaenge().length} Auftrag/Aufträge`),
      step('rechnung', totals.totalInvoiceCount > 0 ? 'completed' : 'open', `${totals.totalInvoiceCount}`),
      step(
        'zahlung',
        totals.openReceivables <= 0 && totals.totalInvoiceCount > 0 ? 'completed' : 'open',
        formatPaymentCurrency(totals.openReceivables),
      ),
      step(
        'faelligkeit',
        totals.overdueInvoiceCount > 0 ? 'at_risk' : totals.openInvoiceCount > 0 ? 'open' : 'not_applicable',
        `${totals.overdueInvoiceCount} überfällig`,
      ),
      step('mahnung', topOverdue ? 'open' : 'not_due'),
    ],
    risks,
    recommendations,
    datevRelevantCount: datevCount,
    uncertaintyNote:
      totals.openInvoiceCount > 0 ? 'financeIntelligence.uncertainty.reviewRecommended' : undefined,
  });
}

function buildIncomingSkontoRecommendations(
  item: InboxItem,
  today: Date | string,
): FinanceRecommendation[] {
  const skonto = getIncomingSkontoWindow(item, today);
  if (!skonto) {
    const hasSkontoHint = /skonto/i.test(
      `${item.recognizedData.Skonto ?? ''} ${item.recognizedData.Zahlungsbedingungen ?? ''}`,
    );
    if (hasSkontoHint) {
      return [
        {
          id: 'skonto_review_required',
          priority: PRIORITY_OPTIONAL,
          messageKey: 'financeIntelligence.skonto.reviewRequired',
        },
      ];
    }
    return [];
  }

  const amount = parseIncomingAmount(item);
  const params: Record<string, string | number> = {
    percent: skonto.percent,
    deadline: skonto.deadline,
  };
  if (amount !== null) {
    params.amount = formatPaymentCurrency(calculateSkontoPayableAmount(amount, skonto.percent));
  } else {
    params.amount = '–';
  }

  return [
    {
      id: 'incoming_skonto_usable',
      priority: PRIORITY_DEADLINE,
      messageKey: 'financeIntelligence.skonto.incomingUsable',
      params,
      route: `/ablage/${item.id}`,
      labelKey: 'financeIntelligence.nextStep.openInvoice',
    },
  ];
}

export function analyzeInboxFinance(
  inboxId: string,
  today: Date | string = new Date(),
): FinanceAnalysis | null {
  const item = getInboxItemById(inboxId);
  if (!item) return null;

  if (item.vorgangId) {
    return analyzeVorgangFinance(item.vorgangId, today);
  }

  const risks: FinanceRisk[] = [];
  const recommendations: FinanceRecommendation[] = [];
  const steps: FinanceStep[] = [];

  if (isMaterialInbox(item) || isIncomingInvoiceItem(item)) {
    steps.push(step('rechnung', 'completed', item.title));
    if (!item.vorgangId) {
      risks.push({
        id: 'material_without_vorgang',
        severity: 'high',
        messageKey: 'financeIntelligence.risk.materialWithoutVorgang',
        priority: PRIORITY_MISSING_DOC,
      });
      recommendations.push({
        id: 'assign_material',
        priority: PRIORITY_NEXT,
        messageKey: 'financeIntelligence.recommend.assignMaterial',
        route: `/ablage/${item.id}`,
        labelKey: 'financeIntelligence.nextStep.assignMaterial',
      });
    }
  }

  if (isIncomingInvoiceItem(item)) {
    recommendations.push(...buildIncomingSkontoRecommendations(item, today));
  } else if (/skonto/i.test(item.title)) {
    recommendations.push({
      id: 'skonto_review_required',
      priority: PRIORITY_OPTIONAL,
      messageKey: 'financeIntelligence.skonto.reviewRequired',
    });
  }

  const filledSteps = FINANCE_ORDER.map((id) => {
    const existing = steps.find((entry) => entry.id === id);
    if (existing) return existing;
    if (id === 'auftrag') return step(id, 'open');
    return step(id, 'not_applicable');
  });

  return capFinanceOutput({
    scope: 'inbox',
    scopeId: item.id,
    scopeTitle: item.title,
    steps: filledSteps,
    risks,
    recommendations,
    datevRelevantCount: isDatevRelevantKind(item.classifiedKind) ? 1 : 0,
    uncertaintyNote: 'financeIntelligence.uncertainty.reviewRecommended',
  });
}

export function analyzeSessionFinance(
  session: CompanySessionContext,
  today: Date | string = new Date(),
): FinanceAnalysis | null {
  if (session.lastInvoiceId && session.lastInvoiceVorgangId) {
    return (
      analyzeInvoiceFinance(session.lastInvoiceVorgangId, session.lastInvoiceId, today) ??
      analyzeVorgangFinance(session.lastInvoiceVorgangId, today)
    );
  }
  if (session.currentVorgangId) {
    return analyzeVorgangFinance(session.currentVorgangId, today);
  }
  const inboxId = session.currentInboxId ?? session.lastUploadInboxId;
  if (inboxId) {
    return analyzeInboxFinance(inboxId, today);
  }
  return analyzeGlobalFinance(today);
}

export function getMissingTaxNoticesForInvoice(invoice: VorgangInvoice): string[] {
  const expected = buildLegalNotices(invoice.taxStatus);
  const existing = (invoice.legalNotices ?? []).map((entry) => normalize(entry));
  return expected.filter((notice) => !existing.some((entry) => entry.includes(normalize(notice))));
}

const FINANCE_STEP_LABELS_DE: Record<FinanceStepId, string> = {
  auftrag: 'Auftrag',
  rechnung: 'Rechnung',
  zahlung: 'Zahlung',
  faelligkeit: 'Fälligkeit',
  mahnung: 'Mahnung',
};

export function getFinanceStepLabelDe(stepId: FinanceStepId): string {
  return FINANCE_STEP_LABELS_DE[stepId];
}

export function buildFinanceProactiveHints(
  session: CompanySessionContext,
  today: Date | string = new Date(),
): import('../../types/companySession').ProactiveHint[] {
  const hints: import('../../types/companySession').ProactiveHint[] = [];
  const analysis = analyzeSessionFinance(session, today);
  if (!analysis) return hints;

  const pool = [
    ...analysis.risks.map((risk) => ({ priority: risk.priority, messageKey: risk.messageKey, params: risk.params })),
    ...analysis.recommendations.map((rec) => ({
      priority: rec.priority,
      messageKey: rec.messageKey,
      params: rec.params,
    })),
  ]
    .sort((a, b) => a.priority - b.priority)
    .slice(0, MAX_FINANCE_HINTS);

  for (const entry of pool) {
    hints.push({ messageKey: entry.messageKey, params: entry.params });
  }

  return hints;
}
