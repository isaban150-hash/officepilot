import type { TranslationKey } from '../i18n';
import { buildProactiveHints } from './brain/companyProactiveHintsService';
import { getCompanySession } from './brain/companySessionService';
import {
  buildHomeHintId,
  isHomeHintVisible,
} from './homeHintDismissalService';
import { getAllInvoiceOverview } from './invoiceOverviewService';
import { getSteuerberaterMonthOverview } from './steuerberaterOverviewService';
import { getTodayIso } from './taskNormalize';

export type HomeHintSeverity = 'critical' | 'warning' | 'info';

export interface HomeHint {
  id: string;
  severity: HomeHintSeverity;
  messageKey: TranslationKey;
  params?: Record<string, string | number>;
  route?: string;
}

function severityForMessageKey(messageKey: string): HomeHintSeverity {
  if (
    messageKey.includes('risk') ||
    messageKey.includes('overdue') ||
    messageKey.includes('payment') ||
    messageKey.includes('mahnung')
  ) {
    return 'critical';
  }
  if (
    messageKey.includes('recommend') ||
    messageKey.includes('steuerberater') ||
    messageKey.includes('material') ||
    messageKey.includes('assign')
  ) {
    return 'warning';
  }
  return 'info';
}

function addHint(
  hints: HomeHint[],
  seen: Set<string>,
  messageKey: TranslationKey,
  params?: Record<string, string | number>,
  route?: string,
  severity?: HomeHintSeverity,
): void {
  const id = buildHomeHintId(messageKey, params);
  if (seen.has(id) || !isHomeHintVisible(id)) return;
  seen.add(id);
  hints.push({
    id,
    severity: severity ?? severityForMessageKey(messageKey),
    messageKey,
    params,
    route,
  });
}

export function buildHomeHints(now: Date | string = new Date()): HomeHint[] {
  const hints: HomeHint[] = [];
  const seen = new Set<string>();
  const todayIso = getTodayIso(now);
  const tomorrow = new Date(`${todayIso.slice(0, 10)}T12:00:00`);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowIso = tomorrow.toISOString().slice(0, 10);

  for (const proactive of buildProactiveHints(getCompanySession())) {
    addHint(
      hints,
      seen,
      proactive.messageKey as TranslationKey,
      proactive.params,
    );
  }

  for (const item of getAllInvoiceOverview(todayIso)) {
    if (item.paymentSummary.status !== 'offen' && item.paymentSummary.status !== 'teilbezahlt') {
      continue;
    }
    const due = item.invoice.paymentDueDate?.slice(0, 10);
    if (due === tomorrowIso) {
      addHint(
        hints,
        seen,
        'hints.invoiceDueTomorrow',
        { customer: item.customer, number: item.invoice.number },
        '/rechnungen/offen',
        'critical',
      );
    }
  }

  const steuerMonth = getSteuerberaterMonthOverview(now);
  if (steuerMonth.isComplete) {
    addHint(
      hints,
      seen,
      'hints.steuerberaterReady',
      { month: steuerMonth.monthLabel },
      '/steuerberater',
      'warning',
    );
  } else if (steuerMonth.completenessPercent >= 80 && steuerMonth.documentCount > 0) {
    addHint(
      hints,
      seen,
      'hints.steuerberaterAlmost',
      { month: steuerMonth.monthLabel },
      '/steuerberater',
      'warning',
    );
  } else if (steuerMonth.missingCount > 0) {
    addHint(
      hints,
      seen,
      'hints.steuerberaterMissing',
      { count: steuerMonth.missingCount, month: steuerMonth.monthLabel },
      '/steuerberater',
      'warning',
    );
  }

  return hints.slice(0, 3);
}
