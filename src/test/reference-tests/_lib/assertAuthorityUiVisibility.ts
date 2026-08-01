import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DocumentIntakeUnderstandingPanel } from '../../../components/inbox/DocumentIntakeUnderstandingPanel';
import { OperationalOverview } from '../../../components/inbox/review/OperationalOverview';
import { t, type TranslationKey } from '../../../i18n';
import { buildOperationalOverviewView } from '../../../services/operationalOverviewView';
import type { AuthorityJourneyObservation } from './runAuthorityJourney';

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
 * UI: Operational Overview + Intake Understanding — Behörde, Frist, Pflicht, Status.
 */
export function assertAuthorityUiVisibility(obs: AuthorityJourneyObservation): void {
  const { reference, pipeline, inbox, archiveDocumentId } = obs;
  const exp = reference.authorityUiVisibility;
  const journey = reference.authorityJourney;
  const caseId = reference.caseId;

  const overview = buildOperationalOverviewView(pipeline.workflow, { inboxItem: inbox });
  if (!overview.present) {
    fail(caseId, 'Hinweis in der UI nicht sichtbar', 'OperationalOverview nicht present');
  }

  const overviewHtml = renderToStaticMarkup(
    createElement(OperationalOverview, {
      view: overview,
      translate,
      primaryAction: null,
    }),
  );

  if (exp.overviewVisible && !overviewHtml.includes('data-testid="operational-overview"')) {
    fail(caseId, 'Hinweis in der UI nicht sichtbar', 'operational-overview fehlt');
  }

  if (exp.documentKindVisible && !overviewHtml.includes('data-testid="operational-overview-document-kind"')) {
    fail(caseId, 'falsche Dokumentenklasse', 'document-kind fehlt in UI');
  }

  if (exp.authorityVisible) {
    const authorityInUi =
      overviewHtml.toLowerCase().includes(journey.authorityContains.toLowerCase()) ||
      overviewHtml.includes('data-testid="operational-overview-sender"');
    if (!authorityInUi) {
      fail(caseId, 'falsche Organisation', 'Organisation/Absender nicht in Overview-UI');
    }
    if (!overviewHtml.toLowerCase().includes(journey.authorityContains.toLowerCase())) {
      fail(caseId, 'falsche Organisation', `Text "${journey.authorityContains}" fehlt in Overview`);
    }
  }

  if (exp.deadlineVisible && journey.deadlineContains) {
    if (!overviewHtml.includes('data-testid="operational-overview-deadline"')) {
      fail(caseId, 'Hinweis in der UI nicht sichtbar', 'deadline-row fehlt');
    }
    if (!dateVisibleInHtml(overviewHtml, journey.deadlineContains)) {
      fail(
        caseId,
        'Hinweis in der UI nicht sichtbar',
        `Datum "${journey.deadlineContains}" fehlt (view.deadlineDate=${overview.deadlineDate ?? '—'})`,
      );
    }
  }

  if (exp.obligationVisible) {
    if (!overviewHtml.includes('data-testid="operational-overview-meanings"')) {
      fail(caseId, 'Nachweispflicht übersehen', 'meanings fehlen in UI');
    }
    if (!overviewHtml.includes('data-testid="operational-overview-primary-case"')) {
      fail(caseId, 'Nachweispflicht übersehen', 'primary-case fehlt in UI');
    }
  }

  if (exp.nextStepVisible) {
    if (!overviewHtml.includes('data-testid="operational-overview-next-step"')) {
      fail(caseId, 'Nachweispflicht übersehen', 'next-step fehlt in UI');
    }
  }

  const understanding = pipeline.workflow.documentUnderstanding;
  if (exp.understandingPanelVisible) {
    if (!understanding) {
      fail(caseId, 'Hinweis in der UI nicht sichtbar', 'documentUnderstanding fehlt');
    }
    const understandingHtml = renderToStaticMarkup(
      createElement(DocumentIntakeUnderstandingPanel, {
        summary: understanding,
        translate,
      }),
    );
    if (!understandingHtml.includes('data-testid="document-intake-understanding"')) {
      fail(caseId, 'Hinweis in der UI nicht sichtbar', 'Understanding-Panel fehlt');
    }
    // Archiv-/Dokumentstatus: Inbox mit Archiv-ID + Overview Document Kind.
    if (!inbox.archiveDocumentId || inbox.archiveDocumentId !== archiveDocumentId) {
      fail(caseId, 'falsche Ablage', 'Archivstatus an Inbox nicht gesetzt');
    }
  }
}
