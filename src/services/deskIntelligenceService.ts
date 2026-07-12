import type { TranslationKey } from '../i18n';
import { analyzeSessionFinance } from './brain/financeIntelligenceService';
import { getCompanySession } from './brain/companySessionService';
import { analyzeSessionWorkflow } from './brain/workflowIntelligenceService';
import { filterActiveItems, getInboxItems } from './inboxService';
import { buildHomeHints, type HomeHint, type HomeHintSeverity } from './homeHintService';
import {
  buildHomeHintId,
  isHomeHintVisible,
} from './homeHintDismissalService';
import { scanPendingItems } from './pendingEngineService';
import { getSteuerberaterMonthOverview } from './steuerberaterOverviewService';
import { getAllTasksFromStore } from './taskStore';
import { getTodayIso, isTaskDone } from './taskNormalize';
import { getAllVorgaenge } from './vorgangService';
import type { PendingHighlight, PendingItemKind } from '../types/models';

export type DayPhase = 'morning' | 'midday' | 'evening';

export type DeskGreetingKey =
  | 'desk.greeting.morning'
  | 'desk.greeting.midday'
  | 'desk.greeting.evening';

export interface DeskGreeting {
  messageKey: DeskGreetingKey;
  firstName?: string;
}

export interface DeskSuccess {
  id: string;
  messageKey: TranslationKey;
  count: number;
}

export interface DeskRecommendation {
  messageKey: TranslationKey;
  params?: Record<string, string | number>;
  route?: string;
}

const MAX_PRIORITIES = 3;
const MAX_SUCCESSES = 4;

const PENDING_DESK_KEYS: Record<string, TranslationKey> = {
  'pending.highlight.newInbox': 'desk.priority.newDocuments',
  'pending.highlight.deferredInbox': 'desk.priority.deferredDocuments',
  'pending.highlight.overdueInvoiceOne': 'desk.priority.overdueInvoiceOne',
  'pending.highlight.overdueInvoicesMany': 'desk.priority.overdueInvoicesMany',
  'pending.highlight.dueTodayInvoiceOne': 'desk.priority.dueTodayInvoiceOne',
  'pending.highlight.dueTodayInvoicesMany': 'desk.priority.dueTodayInvoicesMany',
};

function isSameDay(iso: string | undefined, todayIso: string): boolean {
  if (!iso) return false;
  return iso.slice(0, 10) === todayIso;
}

export function getDayPhase(now: Date | string = new Date()): DayPhase {
  const date = typeof now === 'string' ? new Date(`${now.slice(0, 10)}T12:00:00`) : now;
  const hour = date.getHours();
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 17) return 'midday';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'midday';
}

export function buildDeskGreeting(
  firstName: string | undefined,
  now: Date | string = new Date(),
): DeskGreeting {
  const phase = getDayPhase(now);
  const messageKey: DeskGreetingKey =
    phase === 'morning'
      ? 'desk.greeting.morning'
      : phase === 'evening'
        ? 'desk.greeting.evening'
        : 'desk.greeting.midday';
  const trimmed = firstName?.trim();
  return {
    messageKey,
    firstName: trimmed ? trimmed.split(/\s+/)[0] : undefined,
  };
}

function highlightSeverity(kind: PendingHighlight['kind']): HomeHintSeverity {
  switch (kind) {
    case 'invoice_overdue':
    case 'document_expired':
    case 'invoice_due_today':
      return 'critical';
    case 'inbox_new':
    case 'inbox_unlinked':
    case 'contract_missing_proof':
      return 'warning';
    default:
      return 'info';
  }
}

function pendingKindWeight(kind: PendingItemKind | 'open_tasks', phase: DayPhase): number {
  if (phase === 'morning') {
    if (kind === 'inbox_new') return -8;
    if (kind === 'open_tasks') return -6;
    if (kind === 'invoice_due_today') return -5;
    if (kind === 'inbox_deferred') return 4;
  }
  if (phase === 'midday') {
    if (kind === 'inbox_deferred') return -8;
    if (kind === 'inbox_unfiled') return -6;
    if (kind === 'inbox_unlinked') return -5;
    if (kind === 'inbox_new') return 3;
  }
  if (phase === 'evening') {
    if (kind === 'document_expiring') return -4;
    if (kind === 'inbox_new') return 5;
  }
  return 0;
}

function hintSortWeight(hint: HomeHint, phase: DayPhase, highlightKind?: PendingHighlight['kind']): number {
  const severityBase =
    hint.severity === 'critical' ? 0 : hint.severity === 'warning' ? 10 : 20;
  const key = hint.messageKey;
  let phaseAdjust = highlightKind ? pendingKindWeight(highlightKind, phase) : 0;

  if (phase === 'morning') {
    if (key.includes('newDocuments') || key.includes('material') || key.includes('invoiceDue')) {
      phaseAdjust -= 5;
    }
    if (key.includes('steuerberater')) phaseAdjust += 8;
  } else if (phase === 'midday') {
    if (key.includes('deferred') || key.includes('Missing') || key.includes('missing')) {
      phaseAdjust -= 5;
    }
    if (key.includes('material') || key.includes('Matches')) phaseAdjust -= 3;
  } else if (phase === 'evening') {
    if (key.includes('steuerberater') || key.includes('Almost') || key.includes('Ready')) {
      phaseAdjust -= 6;
    }
    if (key.includes('newDocuments')) phaseAdjust += 6;
  }

  return severityBase + phaseAdjust;
}

function highlightToHint(highlight: PendingHighlight): HomeHint | null {
  if (highlight.count <= 0) return null;
  const params: Record<string, string | number> = { count: highlight.count, ...highlight.params };
  const deskKey = PENDING_DESK_KEYS[highlight.labelKey] ?? highlight.labelKey;
  const id = buildHomeHintId(deskKey, params);
  if (!isHomeHintVisible(id)) return null;
  return {
    id,
    severity: highlightSeverity(highlight.kind),
    messageKey: deskKey as TranslationKey,
    params,
    route: highlight.route,
  };
}

function mergePriorities(base: HomeHint[], extras: HomeHint[], phase: DayPhase): HomeHint[] {
  const seen = new Set(base.map((hint) => hint.id));
  const merged = [...base];
  for (const hint of extras) {
    if (seen.has(hint.id)) continue;
    seen.add(hint.id);
    merged.push(hint);
  }

  const highlightKinds = new Map<string, PendingHighlight['kind']>();
  for (const highlight of scanPendingItems().summary.highlights) {
    const deskKey = PENDING_DESK_KEYS[highlight.labelKey] ?? highlight.labelKey;
    highlightKinds.set(
      buildHomeHintId(deskKey, { count: highlight.count, ...highlight.params }),
      highlight.kind,
    );
  }

  return merged
    .sort(
      (a, b) =>
        hintSortWeight(a, phase, highlightKinds.get(a.id)) -
        hintSortWeight(b, phase, highlightKinds.get(b.id)),
    )
    .slice(0, MAX_PRIORITIES);
}

export function buildDeskPriorities(now: Date | string = new Date()): HomeHint[] {
  const phase = getDayPhase(now);
  const baseHints = buildHomeHints(now);
  const pendingHints = scanPendingItems(now)
    .summary.highlights.map(highlightToHint)
    .filter((hint): hint is HomeHint => hint !== null);

  return mergePriorities(baseHints, pendingHints, phase);
}

export function buildDeskSuccesses(now: Date | string = new Date()): DeskSuccess[] {
  const todayIso = getTodayIso(now);
  const successes: DeskSuccess[] = [];

  const documentsProcessed = filterActiveItems(getInboxItems()).filter((item) => {
    const stamp = item.modifiedAt ?? item.receivedAt;
    if (!isSameDay(stamp, todayIso)) return false;
    return item.status === 'abgelegt' || item.status === 'geprueft' || item.importedToArchive;
  }).length;

  if (documentsProcessed > 0) {
    successes.push({
      id: 'documents-processed',
      messageKey: 'desk.success.documents',
      count: documentsProcessed,
    });
  }

  const ordersUpdated = getAllVorgaenge().filter((vorgang) =>
    isSameDay(vorgang.sync?.updatedAt, todayIso),
  ).length;

  if (ordersUpdated > 0) {
    successes.push({
      id: 'orders-updated',
      messageKey: 'desk.success.orders',
      count: ordersUpdated,
    });
  }

  let invoicesPrepared = 0;
  for (const vorgang of getAllVorgaenge()) {
    for (const invoice of vorgang.invoices ?? []) {
      if (!isSameDay(invoice.createdAt, todayIso)) continue;
      if (invoice.status === 'vorbereitet' || invoice.status === 'versendet') {
        invoicesPrepared += 1;
      }
    }
  }

  if (invoicesPrepared > 0) {
    successes.push({
      id: 'invoices-prepared',
      messageKey: 'desk.success.invoices',
      count: invoicesPrepared,
    });
  }

  const documentsLinked = filterActiveItems(getInboxItems()).filter((item) => {
    if (!isSameDay(item.modifiedAt, todayIso)) return false;
    return item.vorgangLinkStatus === 'linked' || item.vorgangLinkStatus === 'created';
  }).length;

  if (documentsLinked > 0) {
    successes.push({
      id: 'documents-linked',
      messageKey: 'desk.success.linked',
      count: documentsLinked,
    });
  }

  const tasksCompleted = getAllTasksFromStore().filter(
    (task) => isTaskDone(task) && isSameDay(task.completedAt, todayIso),
  ).length;

  if (tasksCompleted > 0 && successes.length < MAX_SUCCESSES) {
    successes.push({
      id: 'tasks-completed',
      messageKey: 'desk.success.tasks',
      count: tasksCompleted,
    });
  }

  return successes.slice(0, MAX_SUCCESSES);
}

export function buildDeskRecommendation(now: Date | string = new Date()): DeskRecommendation | null {
  const session = getCompanySession();
  const phase = getDayPhase(now);

  const workflow = analyzeSessionWorkflow(session);
  if (workflow?.recommendations[0]) {
    const rec = workflow.recommendations[0];
    return {
      messageKey: rec.messageKey as TranslationKey,
      params: rec.params,
      route: rec.route,
    };
  }

  const finance = analyzeSessionFinance(session, now);
  const financeRec = finance?.recommendations.sort((a, b) => a.priority - b.priority)[0];
  if (financeRec) {
    return {
      messageKey: financeRec.messageKey as TranslationKey,
      params: financeRec.params,
      route: financeRec.route,
    };
  }

  const steuerMonth = getSteuerberaterMonthOverview(now);
  if (steuerMonth.documentCount > 0) {
    if (steuerMonth.isComplete) {
      return {
        messageKey: 'hints.steuerberaterReady',
        params: { month: steuerMonth.monthLabel },
        route: '/steuerberater',
      };
    }
    if (steuerMonth.completenessPercent >= 80) {
      return {
        messageKey: 'desk.recommendation.steuerberaterPrepare',
        params: { month: steuerMonth.monthLabel },
        route: '/steuerberater',
      };
    }
    if (phase === 'evening' && steuerMonth.missingCount > 0) {
      return {
        messageKey: 'hints.steuerberaterMissing',
        params: { count: steuerMonth.missingCount, month: steuerMonth.monthLabel },
        route: '/steuerberater',
      };
    }
  }

  return null;
}
