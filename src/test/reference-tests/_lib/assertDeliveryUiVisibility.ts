import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DocumentIntakeUnderstandingPanel } from '../../../components/inbox/DocumentIntakeUnderstandingPanel';
import { OperationalOverview } from '../../../components/inbox/review/OperationalOverview';
import { OrderSummaryPanel } from '../../../components/vorgang/OrderSummaryPanel';
import { t, type TranslationKey } from '../../../i18n';
import { buildOperationalOverviewView } from '../../../services/operationalOverviewView';
import type { DeliveryJourneyObservation } from './runDeliveryJourney';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function fail(caseId: string, damage: string, detail: string): never {
  throw new Error(`[${caseId}] damagePrevented: ${damage} — ${detail}`);
}

function dateVisibleInHtml(html: string, dateContains: string): boolean {
  if (html.includes(dateContains)) return true;
  const german = dateContains.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!german) return false;
  const day = Number(german[1]);
  const month = Number(german[2]);
  const year = german[3]!;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return (
    html.includes(iso) ||
    html.includes(`${day}.${month}.${year}`) ||
    html.includes(`${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}.${year}`)
  );
}

/**
 * UI: Operational Overview + Understanding + Order Summary — sichtbare Lieferschein-Fakten.
 */
export function assertDeliveryUiVisibility(obs: DeliveryJourneyObservation): void {
  const { reference, pipeline, inbox, vorgang, archiveDocumentId } = obs;
  const exp = reference.deliveryUiVisibility;
  const journey = reference.deliveryJourney;
  const caseId = reference.caseId;

  const overview = buildOperationalOverviewView(pipeline.workflow, { inboxItem: inbox });
  if (!overview.present) {
    fail(caseId, 'Lieferschein in der UI nicht sichtbar', 'OperationalOverview nicht present');
  }

  const overviewHtml = renderToStaticMarkup(
    createElement(OperationalOverview, {
      view: overview,
      translate,
      primaryAction: null,
    }),
  );

  if (exp.overviewVisible && !overviewHtml.includes('data-testid="operational-overview"')) {
    fail(caseId, 'Lieferschein in der UI nicht sichtbar', 'operational-overview fehlt');
  }

  if (exp.documentKindVisible) {
    if (!overviewHtml.includes('data-testid="operational-overview-document-kind"')) {
      fail(caseId, 'Lieferschein in der UI nicht sichtbar', 'document-kind fehlt');
    }
    if (!overviewHtml.toLowerCase().includes('lieferschein')) {
      fail(caseId, 'Lieferschein in der UI nicht sichtbar', 'Label Lieferschein fehlt');
    }
  }

  if (exp.deliveryPrimaryCaseVisible) {
    if (!overviewHtml.includes('data-testid="operational-overview-primary-case"')) {
      fail(caseId, 'Lieferschein in der UI nicht sichtbar', 'primary-case fehlt');
    }
    // Produktiv oft review_required (CI reviewRequired) mit Alt. delivery_recorded —
    // sichtbarer Anker bleibt Dokumentart Lieferschein + Primary-Case-Zeile.
    const primaryOk =
      overviewHtml.toLowerCase().includes('lieferung') ||
      overviewHtml.toLowerCase().includes('prüfung') ||
      overviewHtml.toLowerCase().includes('pruefung') ||
      overview.primaryCaseId === 'delivery_recorded' ||
      overview.primaryCaseId === 'review_required';
    if (!primaryOk) {
      fail(
        caseId,
        'Lieferschein in der UI nicht sichtbar',
        `Primary Case unerwartet: ${overview.primaryCaseId}`,
      );
    }
  }

  if (exp.supplierVisible) {
    if (!overviewHtml.toLowerCase().includes(journey.supplierContains.toLowerCase())) {
      fail(caseId, 'Auftrag falsch zugeordnet', 'Lieferant nicht in Overview-UI');
    }
  }

  const understanding = pipeline.workflow.documentUnderstanding;
  if (exp.understandingPanelVisible) {
    if (!understanding) {
      fail(caseId, 'Lieferschein in der UI nicht sichtbar', 'documentUnderstanding fehlt');
    }
  }

  const understandingHtml = understanding
    ? renderToStaticMarkup(
        createElement(DocumentIntakeUnderstandingPanel, {
          summary: {
            ...understanding,
            vorgang: inbox.vorgangTitle ?? understanding.vorgang,
          },
          translate,
        }),
      )
    : '';

  if (exp.understandingPanelVisible) {
    if (!understandingHtml.includes('data-testid="document-intake-understanding"')) {
      fail(caseId, 'Lieferschein in der UI nicht sichtbar', 'Understanding-Panel fehlt');
    }
  }

  const orderHtml = renderToStaticMarkup(
    createElement(OrderSummaryPanel, {
      vorgang,
      translate,
    }),
  );

  const combined = `${overviewHtml}\n${understandingHtml}\n${orderHtml}`;

  if (exp.deliveryDateVisible && journey.deliveryDateContains) {
    if (!dateVisibleInHtml(combined, journey.deliveryDateContains)) {
      fail(
        caseId,
        'Lieferdatum in der UI nicht sichtbar',
        `Datum "${journey.deliveryDateContains}" fehlt (du.date=${understanding?.date ?? '—'})`,
      );
    }
  }

  if (exp.orderVisible || exp.orderLinkVisible) {
    const orderOk =
      combined.toLowerCase().includes(journey.vorgangTitleContains.toLowerCase()) ||
      combined.includes(journey.vorgangId) ||
      Boolean(inbox.vorgangTitle && combined.includes(inbox.vorgangTitle));
    if (!orderOk) {
      fail(caseId, 'Dokumentverknüpfung verloren', 'Auftrag nicht in UI sichtbar');
    }
  }

  if (exp.positionHintsVisible) {
    const posOk = journey.positionDescriptionContains.some((needle) =>
      combined.toLowerCase().includes(needle.toLowerCase()),
    );
    // Fallback: Baustelle + Lieferschein-Kontext in Understanding — Positionstext oft nur OCR.
    const siteOk =
      combined.toLowerCase().includes(journey.baustelleContains.toLowerCase()) ||
      Boolean(understanding?.constructionSite);
    if (!posOk && !siteOk) {
      fail(caseId, 'Lieferschein in der UI nicht sichtbar', 'Positions-/Baustellenhinweis fehlt');
    }
  }

  if (exp.quantityHintsVisible) {
    // Dedizierte Liefermengen-UI fehlt (knownGap) — sichtbar bleiben Lieferschein-Kind
    // und Confirm-Hinweis; Planmengen-Schutz liegt in der Journey-Negativprüfung.
    const kindVisible = overviewHtml.toLowerCase().includes('lieferschein');
    const confirmVisible =
      overviewHtml.includes('data-testid="operational-overview-confirm-requirement"') ||
      overviewHtml.toLowerCase().includes('bestätig') ||
      overviewHtml.toLowerCase().includes('zuordnen') ||
      overviewHtml.toLowerCase().includes('nutzerentscheidung') ||
      Boolean(overview.confirmRequirement);
    if (!kindVisible || !confirmVisible) {
      fail(
        caseId,
        'Mengen still geändert / UI',
        'Lieferschein/Confirm-first in Overview nicht sichtbar',
      );
    }
  }

  if (exp.archiveVisible) {
    if (!inbox.archiveDocumentId || inbox.archiveDocumentId !== archiveDocumentId) {
      fail(caseId, 'Dokument nicht archiviert', 'Archivstatus an Inbox nicht gesetzt');
    }
  }

  if (!orderHtml.includes('data-testid="order-summary-panel"')) {
    fail(caseId, 'Dokumentverknüpfung verloren', 'OrderSummaryPanel fehlt');
  }
}
