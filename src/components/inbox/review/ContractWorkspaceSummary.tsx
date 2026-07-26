import { DataRow } from '../../ui/Card';
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
}

function renderRows(
  rows: ReturnType<typeof buildContractWorkspaceSummaryView>['rows'],
  translate: (key: TranslationKey) => string,
  testIdPrefix = 'contract-workspace-summary',
) {
  return rows.map((row) => (
    <div key={row.id} data-testid={`${testIdPrefix}-${row.id}`}>
      <DataRow
        label={translate(row.labelKey)}
        value={
          row.needsReview
            ? `${row.value} (${translate('documentIntelligence.workspace.needsReview')})`
            : row.value
        }
      />
    </div>
  ));
}

export function ContractWorkspaceSummary({
  proposal,
  translate,
  item,
  vorgang,
}: ContractWorkspaceSummaryProps) {
  const view = buildContractWorkspaceSummaryView(proposal, { item, vorgang });
  const showParties = view.partyRows.length > 0;
  const showGeneral = view.generalRows.length > 0;
  const showTypeSpecific = view.typeSpecificRows.length > 0;
  const showPositionsSection = view.positionInsightRows.length > 0;
  const showStatusSection = view.statusRows.length > 0;
  const kindValue = view.contractKindNeedsReview
    ? `${translate(view.contractKindLabelKey)} (${translate('documentIntelligence.workspace.needsReview')})`
    : translate(view.contractKindLabelKey);

  return (
    <section
      className="contract-workspace-summary"
      data-testid="contract-workspace-summary"
      aria-label={translate(view.titleKey)}
    >
      <h4 data-testid="contract-workspace-summary-title">{translate(view.titleKey)}</h4>
      <p className="contract-workspace-summary__disclaimer" data-testid="contract-workspace-summary-disclaimer">
        {translate(view.disclaimerKey)}
      </p>

      <div
        className="contract-workspace-summary__section"
        data-testid="contract-workspace-summary-section-overview"
      >
        <h5 className="contract-workspace-summary__section-title">
          {translate('documentIntelligence.workspace.section.overview')}
        </h5>
        <DataRow
          label={translate('documentIntelligence.field.contractKind')}
          value={kindValue}
        />
        {view.overviewRows.length > 0 ? (
          <div data-testid="contract-workspace-summary-overview-rows">
            {renderRows(view.overviewRows, translate)}
          </div>
        ) : null}
      </div>

      {showParties ? (
        <div
          className="contract-workspace-summary__section"
          data-testid="contract-workspace-summary-section-parties"
        >
          <h5 className="contract-workspace-summary__section-title">
            {translate('documentIntelligence.workspace.section.parties')}
          </h5>
          <div data-testid="contract-workspace-summary-parties">
            {view.partyRows.map((party) => (
              <div key={party.id} data-testid={`contract-workspace-summary-party-${party.id}`}>
                <DataRow label={translate(party.roleLabelKey)} value={party.name} />
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {showGeneral ? (
        <div
          className="contract-workspace-summary__section"
          data-testid="contract-workspace-summary-section-general"
        >
          <h5 className="contract-workspace-summary__section-title">
            {translate('documentIntelligence.workspace.section.general')}
          </h5>
          <div data-testid="contract-workspace-summary-general-rows">
            {renderRows(view.generalRows, translate)}
          </div>
        </div>
      ) : null}

      {showTypeSpecific ? (
        <div
          className="contract-workspace-summary__section"
          data-testid="contract-workspace-summary-section-type-specific"
        >
          <h5 className="contract-workspace-summary__section-title">
            {translate('documentIntelligence.workspace.section.typeSpecific')}
          </h5>
          <div data-testid="contract-workspace-summary-type-specific-rows">
            {renderRows(view.typeSpecificRows, translate)}
          </div>
        </div>
      ) : null}

      {showPositionsSection ? (
        <div
          className="contract-workspace-summary__section"
          data-testid="contract-workspace-summary-section-positions"
        >
          <h5 className="contract-workspace-summary__section-title">
            {translate('documentIntelligence.workspace.section.positions')}
          </h5>
          <div data-testid="contract-workspace-summary-positions">
            <DataRow
              label={translate('documentIntelligence.field.positions')}
              value={String(proposal.positions.length)}
            />
            <div data-testid="contract-workspace-summary-position-insights">
              {view.positionInsightRows.map((row) => (
                <div key={row.id} data-testid={`contract-workspace-summary-${row.id}`}>
                  <DataRow
                    label={translate(row.labelKey)}
                    value={interpolateParams(translate(row.valueKey), row.valueParams)}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {showStatusSection ? (
        <div
          className="contract-workspace-summary__section"
          data-testid="contract-workspace-summary-section-status"
        >
          <h5 className="contract-workspace-summary__section-title">
            {translate('documentIntelligence.workspace.section.status')}
          </h5>
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
    </section>
  );
}
