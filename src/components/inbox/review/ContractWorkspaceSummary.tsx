import { useState } from 'react';
import { Badge, DataRow } from '../../ui/Card';
import { Button } from '../../ui/Button';
import type { ContractOrderProposal } from '../../../types/documentIntelligence';
import type { InboxItem, Vorgang } from '../../../types/models';
import type { TranslationKey } from '../../../i18n';
import { interpolateParams } from '../../../i18n';
import { buildContractWorkspaceSummaryView } from '../../../services/contractWorkspaceSummaryView';

interface ContractWorkspaceSummaryProps {
  proposal: ContractOrderProposal;
  translate: (key: TranslationKey) => string;
  item?: InboxItem;
  vorgang?: Vorgang | null;
  /** Primary action rendered inside the chef summary (no duplicate outside). */
  primaryAction?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    loading?: boolean;
    testId: string;
  };
}

function renderFactValue(value: string, needsReview: boolean, translate: (key: TranslationKey) => string) {
  return needsReview
    ? `${value} (${translate('documentIntelligence.workspace.needsReview')})`
    : value;
}

export function ContractWorkspaceSummary({
  proposal,
  translate,
  item,
  vorgang,
  primaryAction,
}: ContractWorkspaceSummaryProps) {
  const view = buildContractWorkspaceSummaryView(proposal, { item, vorgang });
  const showFacts = view.factRows.length > 0;
  const showStatusSection = view.statusRows.length > 0;
  const badgeTone = view.contractKindNeedsReview ? 'warning' : 'success';
  const [statusOpen, setStatusOpen] = useState(false);

  return (
    <section
      className="contract-workspace-summary"
      data-testid="contract-workspace-summary"
      aria-label={translate(view.titleKey)}
    >
      <header className="contract-workspace-summary__header" data-testid="contract-workspace-summary-header">
        <div className="contract-workspace-summary__header-top">
          <h3
            className="contract-workspace-summary__kind"
            data-testid="contract-workspace-summary-kind"
          >
            {translate(view.contractKindLabelKey)}
          </h3>
          <Badge tone={badgeTone}>
            <span data-testid="contract-workspace-summary-status-badge">
              {translate(view.statusBadgeKey)}
            </span>
          </Badge>
        </div>
        {view.subject ? (
          <p className="contract-workspace-summary__subject" data-testid="contract-workspace-summary-subject">
            {view.subject}
          </p>
        ) : null}
        <p className="contract-workspace-summary__disclaimer" data-testid="contract-workspace-summary-disclaimer">
          {translate(view.disclaimerKey)}
        </p>
      </header>

      <div
        className="contract-workspace-summary__chef"
        data-testid="contract-workspace-summary-chef"
      >
        {view.partyRows.length > 0 ? (
          <div
            className="contract-workspace-summary__parties"
            data-testid="contract-workspace-summary-section-parties"
          >
            <div className="contract-workspace-summary__parties-grid">
              {view.primaryPartyRows.map((party) => (
                <article
                  key={party.id}
                  className="contract-workspace-summary__party"
                  data-testid={`contract-workspace-summary-party-${party.id}`}
                >
                  <p className="contract-workspace-summary__party-role">
                    {translate(party.roleLabelKey)}
                  </p>
                  <p className="contract-workspace-summary__party-name">{party.name}</p>
                  {party.isOwnCompany ? (
                    <p className="contract-workspace-summary__party-meta">Ihr Betrieb</p>
                  ) : null}
                  {party.address ? (
                    <p className="contract-workspace-summary__party-meta">{party.address}</p>
                  ) : null}
                  {party.contact ? (
                    <p className="contract-workspace-summary__party-meta">
                      {translate('documentIntelligence.field.contact')}: {party.contact}
                    </p>
                  ) : null}
                </article>
              ))}
            </div>
            {view.extraPartyRows.length > 0 ? (
              <div
                className="contract-workspace-summary__parties-extra"
                data-testid="contract-workspace-summary-parties-extra"
              >
                {view.extraPartyRows.map((party) => (
                  <DataRow
                    key={party.id}
                    label={translate(party.roleLabelKey)}
                    value={party.name}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {view.moneyMetric ? (
          <div
            className="contract-workspace-summary__metric"
            data-testid="contract-workspace-summary-metric"
          >
            <span className="contract-workspace-summary__metric-label">
              {translate(view.moneyMetric.labelKey)}
            </span>
            <strong
              className="contract-workspace-summary__metric-value"
              data-testid="contract-workspace-summary-metric-value"
            >
              {renderFactValue(
                view.moneyMetric.value,
                view.moneyMetric.needsReview,
                translate,
              )}
            </strong>
          </div>
        ) : null}

        {view.lvOverview ? (
          <div
            className="contract-workspace-summary__lv"
            data-testid="contract-workspace-summary-lv"
          >
            <span className="contract-workspace-summary__metric-label">
              {translate('documentIntelligence.workspace.section.lvOverview')}
            </span>
            <strong className="contract-workspace-summary__metric-value">
              {view.lvOverview.positionCount}{' '}
              {translate('documentIntelligence.field.positions')}
            </strong>
            {view.lvOverview.importableCount > 0 ? (
              <p className="contract-workspace-summary__party-meta">
                {view.lvOverview.importableCount}{' '}
                {translate('documentIntelligence.workspace.positions.importable')}
              </p>
            ) : null}
            {view.lvOverview.totalLabel ? (
              <p className="contract-workspace-summary__party-meta">
                {view.lvOverview.totalLabel}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="contract-workspace-summary__chef-facts">
          {view.objectFact ? (
            <div data-testid={`contract-workspace-summary-${view.objectFact.id}`}>
              <DataRow
                label={translate(view.objectFact.labelKey)}
                value={renderFactValue(
                  view.objectFact.value,
                  view.objectFact.needsReview,
                  translate,
                )}
              />
            </div>
          ) : null}
          {view.deadlineFact ? (
            <div data-testid={`contract-workspace-summary-${view.deadlineFact.id}`}>
              <DataRow
                label={translate(view.deadlineFact.labelKey)}
                value={renderFactValue(
                  view.deadlineFact.value,
                  view.deadlineFact.needsReview,
                  translate,
                )}
              />
            </div>
          ) : null}
        </div>

        {primaryAction ? (
          <div
            className="contract-workspace-summary__primary"
            data-testid="contract-workspace-summary-primary"
          >
            <Button
              fullWidth
              onClick={primaryAction.onClick}
              disabled={primaryAction.disabled}
              loading={primaryAction.loading}
              data-testid={primaryAction.testId}
            >
              {primaryAction.label}
            </Button>
          </div>
        ) : null}
      </div>

      {showFacts ? (
        <div
          className="contract-workspace-summary__facts"
          data-testid="contract-workspace-summary-section-facts"
        >
          <h4 className="contract-workspace-summary__section-title">
            {translate('documentIntelligence.workspace.section.facts')}
          </h4>
          <ul
            className="contract-workspace-summary__facts-list"
            data-testid="contract-workspace-summary-facts-rows"
          >
            {view.factRows.map((row) => (
              <li
                key={row.id}
                className="contract-workspace-summary__fact"
                data-testid={`contract-workspace-summary-${row.id}`}
              >
                <span className="contract-workspace-summary__fact-label">
                  {translate(row.labelKey)}
                </span>
                <span className="contract-workspace-summary__fact-value">
                  {renderFactValue(row.value, row.needsReview, translate)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {view.reviewHintKeys.length > 0 ? (
        <ul
          className="contract-workspace-summary__hints"
          data-testid="contract-workspace-summary-review-hints"
        >
          {view.reviewHintKeys.map((hint) => (
            <li key={hint}>{translate(hint as TranslationKey)}</li>
          ))}
        </ul>
      ) : null}

      {showStatusSection ? (
        <details
          className="contract-workspace-summary__status-details"
          data-testid="contract-workspace-summary-section-status"
          onToggle={(event) =>
            setStatusOpen((event.currentTarget as HTMLDetailsElement).open)
          }
        >
          <summary aria-expanded={statusOpen}>
            {translate('documentIntelligence.workspace.section.status')}
          </summary>
          <div data-testid="contract-workspace-summary-status">
            {view.statusRows.map((row) => (
              <div key={row.id} data-testid={`contract-workspace-summary-status-${row.id}`}>
                <DataRow
                  label={translate(row.labelKey)}
                  value={interpolateParams(translate(row.valueKey), row.valueParams)}
                />
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}
