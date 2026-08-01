import type { ReactNode } from 'react';
import { Button } from '../../ui/Button';
import { Card, DataRow } from '../../ui/Card';
import type { TranslationKey } from '../../../i18n';
import type {
  DocumentSummary,
  DocumentSummaryActionId,
} from '../../../types/documentSummary';
import {
  DOCUMENT_SUMMARY_MAX_ALERTS,
  DOCUMENT_SUMMARY_MAX_FACTS,
  DOCUMENT_SUMMARY_MAX_SECONDARY,
} from '../../../types/documentSummary';
import {
  resolveDocumentSummaryAlertLabel,
  resolveDocumentSummaryFactLabel,
} from '../../../services/documentSummary';
import { resolveDocumentCaseMatchReasonLabel } from '../../../services/documentCaseMatchPresentation';

export const DOCUMENT_EXPERIENCE_MAX_FACTS = DOCUMENT_SUMMARY_MAX_FACTS;
export const DOCUMENT_EXPERIENCE_MAX_ALERTS = DOCUMENT_SUMMARY_MAX_ALERTS;
export const DOCUMENT_EXPERIENCE_MAX_SECONDARY = DOCUMENT_SUMMARY_MAX_SECONDARY;

export type DocumentExperienceActionUi = {
  disabled?: boolean;
  loading?: boolean;
  testId?: string;
  variant?: 'primary' | 'outline' | 'ghost';
  /** Hide this secondary action (e.g. inquiry not wired). */
  hidden?: boolean;
};

export type DocumentExperienceCardProps = {
  /** First-screen SSOT — no Proposal/Understanding/Letter props. */
  summary: DocumentSummary;
  translate: (key: TranslationKey) => string;
  onAction: (actionId: DocumentSummaryActionId) => void;
  actionUi?: Partial<Record<DocumentSummaryActionId, DocumentExperienceActionUi>>;
  /** Zone E — collapsed by default (Guidance / Letter / contract extras). */
  details?: ReactNode;
  detailsLabel?: string;
  className?: string;
  cardTestId?: string;
  /**
   * default: type eyebrow + headline.
   * headline-only: inbox list — document type is the sole title (no duplicate eyebrow).
   */
  headerMode?: 'default' | 'headline-only';
};

/**
 * DOCUMENT-SUMMARY — shared first-screen shell (A–E) rendered only from DocumentSummary.
 * Zone F (Weitere Optionen) stays in DocumentReviewExperience.
 */
export function DocumentExperienceCard({
  summary,
  translate,
  onAction,
  actionUi = {},
  details,
  detailsLabel,
  className,
  cardTestId = 'document-experience-card',
  headerMode = 'default',
}: DocumentExperienceCardProps) {
  const documentTypeLabel = translate(summary.documentTypeLabelKey);
  const facts = summary.facts
    .filter((f) => f.value.trim())
    .slice(0, DOCUMENT_SUMMARY_MAX_FACTS)
    .map((f) => ({
      id: f.id,
      label: resolveDocumentSummaryFactLabel(f, translate),
      value: f.value.trim(),
    }));
  const alerts = summary.alerts
    .map((a) => ({
      id: a.id,
      label: resolveDocumentSummaryAlertLabel(a, translate),
    }))
    .filter((a) => a.label.trim())
    .slice(0, DOCUMENT_SUMMARY_MAX_ALERTS);

  const primaryUi = actionUi[summary.primaryAction.id] ?? {};
  const secondary = summary.secondaryActions
    .filter((action) => !actionUi[action.id]?.hidden)
    .slice(0, DOCUMENT_SUMMARY_MAX_SECONDARY);

  const detailsTitle = detailsLabel ?? translate('documentExperience.details');

  const summaryDetails =
    !details && summary.details.length > 0 ? (
      <>
        {summary.details.map((section) => (
          <section key={section.id} data-testid={`document-summary-detail-${section.id}`}>
            <h3 className="document-experience-card__section-title">
              {translate(section.titleKey)}
            </h3>
            {section.proseText ? <p>{section.proseText}</p> : null}
            {section.rows?.map((row) => (
              <DataRow
                key={row.id}
                label={resolveDocumentSummaryFactLabel(row, translate)}
                value={row.value}
              />
            ))}
            {section.listItems ? (
              section.listItems.length > 0 ? (
                <ul>
                  {section.listItems.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ) : section.listEmptyKey ? (
                <p>{translate(section.listEmptyKey)}</p>
              ) : null
            ) : null}
          </section>
        ))}
      </>
    ) : null;

  const detailsBody = details ?? summaryDetails;

  return (
    <Card
      className={['document-experience-card', className].filter(Boolean).join(' ')}
      data-testid={cardTestId}
      highlight
    >
      <header className="document-experience-card__header" data-testid="document-experience-header">
        {headerMode === 'default' && summary.headline !== documentTypeLabel ? (
          <p className="document-experience-card__type" data-testid="document-experience-type">
            {documentTypeLabel}
          </p>
        ) : null}
        <h2 className="document-experience-card__headline" data-testid="document-experience-headline">
          {headerMode === 'headline-only' ? documentTypeLabel : summary.headline}
        </h2>
        {summary.subtitle?.trim() ? (
          <p className="document-experience-card__subtitle" data-testid="document-experience-subtitle">
            {summary.subtitle.trim()}
          </p>
        ) : null}
      </header>

      {facts.length > 0 ? (
        <div className="document-experience-card__facts" data-testid="document-experience-facts">
          {facts.map((fact) => (
            <DataRow key={fact.id} label={fact.label} value={fact.value} />
          ))}
        </div>
      ) : null}

      {alerts.length > 0 ? (
        <section
          className="document-experience-card__alerts"
          data-testid="document-experience-alerts"
        >
          <h3 className="document-experience-card__section-title document-experience-card__section-title--warn">
            {translate('documentExperience.alerts')}
          </h3>
          <ul>
            {alerts.map((alert) => (
              <li key={alert.id} data-testid={`document-experience-alert-${alert.id}`}>
                {alert.label}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {summary.caseMatch && summary.caseMatch.matchStatus !== 'none' ? (
        <section
          className="document-experience-card__case-match"
          data-testid="document-case-match"
          data-match-status={summary.caseMatch.matchStatus}
        >
          <h3 className="document-experience-card__section-title">
            {summary.caseMatch.matchStatus === 'multiple'
              ? translate('vorgangIntelligence.match.multipleTitle')
              : translate('vorgangIntelligence.match.title')}
          </h3>
          {summary.caseMatch.matchedCaseTitle ? (
            <p
              className="document-experience-card__case-match-title"
              data-testid="document-case-match-title"
            >
              {summary.caseMatch.matchedCaseTitle}
            </p>
          ) : null}
          {summary.caseMatch.matchStatus === 'multiple' && summary.caseMatch.candidates.length > 0 ? (
            <ul
              className="document-experience-card__case-match-candidates"
              data-testid="document-case-match-candidates"
            >
              {summary.caseMatch.candidates.map((candidate) => (
                <li key={candidate.caseId}>{candidate.caseTitle}</li>
              ))}
            </ul>
          ) : null}
          {summary.caseMatch.reasons.length > 0 ? (
            <div className="document-experience-card__case-match-reasons">
              <p className="document-experience-card__case-match-reason-label">
                {translate('vorgangIntelligence.match.reasonLabel')}
              </p>
              <ul data-testid="document-case-match-reasons">
                {summary.caseMatch.reasons.map((reason) => (
                  <li key={reason}>
                    {resolveDocumentCaseMatchReasonLabel(reason, translate)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="document-experience-card__actions" data-testid="document-experience-actions">
        <Button
          fullWidth
          disabled={primaryUi.disabled || !summary.primaryAction.enabled}
          loading={primaryUi.loading}
          onClick={() => onAction(summary.primaryAction.id)}
          data-testid={primaryUi.testId ?? 'document-experience-primary'}
        >
          {translate(summary.primaryAction.labelKey)}
        </Button>
        {secondary.length > 0 ? (
          <div
            className="document-experience-card__secondary"
            data-testid="document-experience-secondary"
          >
            {secondary.map((action) => {
              const ui = actionUi[action.id] ?? {};
              return (
                <Button
                  key={action.id}
                  variant={
                    ui.variant ??
                    (action.id === 'later' || action.id === 'reject_contract_proposal'
                      ? 'ghost'
                      : 'outline')
                  }
                  fullWidth
                  disabled={ui.disabled || !action.enabled}
                  loading={ui.loading}
                  onClick={() => onAction(action.id)}
                  data-testid={ui.testId ?? `document-experience-secondary-${action.id}`}
                >
                  {translate(action.labelKey)}
                </Button>
              );
            })}
          </div>
        ) : null}
      </div>

      {detailsBody ? (
        <details
          className="document-experience-card__details"
          data-testid="document-experience-details"
        >
          <summary data-testid="document-experience-details-toggle">{detailsTitle}</summary>
          <div
            className="document-experience-card__details-body"
            data-testid="document-experience-details-body"
          >
            {detailsBody}
          </div>
        </details>
      ) : null}
    </Card>
  );
}
