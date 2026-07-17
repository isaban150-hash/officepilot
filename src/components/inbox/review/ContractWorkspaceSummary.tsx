import { DataRow } from '../../ui/Card';
import type { ContractOrderProposal } from '../../../types/documentIntelligence';
import type { TranslationKey } from '../../../i18n';
import { buildContractWorkspaceSummaryView } from '../../../services/contractWorkspaceSummaryView';

interface ContractWorkspaceSummaryProps {
  proposal: ContractOrderProposal;
  translate: (key: TranslationKey) => string;
}

export function ContractWorkspaceSummary({ proposal, translate }: ContractWorkspaceSummaryProps) {
  const view = buildContractWorkspaceSummaryView(proposal);

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

      <DataRow
        label={translate('documentIntelligence.field.contractKind')}
        value={translate(view.contractKindLabelKey)}
      />

      <div data-testid="contract-workspace-summary-rows">
        {view.rows.map((row) => (
          <div key={row.id} data-testid={`contract-workspace-summary-${row.id}`}>
            <DataRow
              label={translate(row.labelKey)}
              value={
                row.needsReview
                  ? `${row.value} (${translate('documentIntelligence.workspace.needsReview')})`
                  : row.value
              }
            />
          </div>
        ))}
      </div>

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
