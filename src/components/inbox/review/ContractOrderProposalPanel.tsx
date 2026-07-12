import { Button } from '../../ui/Button';
import { Card, CardMeta, CardTitle, DataRow } from '../../ui/Card';
import type { ContractOrderProposal } from '../../../types/documentIntelligence';
import type { TranslationKey } from '../../../i18n';

interface ContractOrderProposalPanelProps {
  proposal: ContractOrderProposal;
  translate: (key: TranslationKey) => string;
  onCreateOrder: () => void;
  isCreating?: boolean;
}

export function ContractOrderProposalPanel({
  proposal,
  translate,
  onCreateOrder,
  isCreating = false,
}: ContractOrderProposalPanelProps) {
  const labelKey = proposal.intelligence.documentLabelKey as TranslationKey;

  return (
    <Card className="contract-order-proposal" data-testid="contract-order-proposal">
      <CardTitle>{translate(labelKey)}</CardTitle>
      <CardMeta data-testid="contract-order-proposal-meta">
        {translate('documentIntelligence.section.contractCore')}:{' '}
        {proposal.intelligence.segmentation.contractCorePages.join(', ') || '–'}
        {' · '}
        {translate('documentIntelligence.section.billOfQuantities')}:{' '}
        {proposal.intelligence.segmentation.billOfQuantitiesPages.join(', ') || '–'}
        {' · '}
        {translate('documentIntelligence.section.technicalAttachments')}:{' '}
        {proposal.intelligence.technicalAttachmentCount}
      </CardMeta>

      <div className="contract-order-proposal__summary">
        <DataRow label={translate('documentIntelligence.field.customer')} value={proposal.customer} />
        <DataRow label={translate('documentIntelligence.field.contractor')} value={proposal.contractor} />
        <DataRow label={translate('documentIntelligence.field.constructionSite')} value={proposal.constructionSite} />
        <DataRow label={translate('documentIntelligence.field.contractDate')} value={proposal.contractDate} />
        <DataRow
          label={translate('documentIntelligence.field.positions')}
          value={String(proposal.positionCount)}
        />
        <DataRow
          label={translate('documentIntelligence.field.contractTotal')}
          value={proposal.contractTotalNet}
        />
        <DataRow
          label={translate('documentIntelligence.field.paymentTerms')}
          value={proposal.paymentTermsSummary}
        />
      </div>

      {proposal.progressBillingHint && (
        <p className="contract-order-proposal__hint" data-testid="contract-progress-billing-hint">
          {translate(proposal.progressBillingHint as TranslationKey)}
        </p>
      )}

      {proposal.technicalAttachmentsLabel && (
        <p className="contract-order-proposal__hint" data-testid="contract-technical-attachments-hint">
          {translate(proposal.technicalAttachmentsLabel as TranslationKey)}
        </p>
      )}

      {proposal.reviewHints.length > 0 && (
        <ul className="contract-order-proposal__reviews" data-testid="contract-review-hints">
          {proposal.reviewHints.map((hint) => (
            <li key={hint}>{translate(hint as TranslationKey)}</li>
          ))}
        </ul>
      )}

      <div className="contract-order-proposal__positions" data-testid="contract-order-positions">
        <h4>{translate('documentIntelligence.positionsTitle')}</h4>
        <table className="contract-order-proposal__table">
          <thead>
            <tr>
              <th>{translate('documentIntelligence.table.pos')}</th>
              <th>{translate('documentIntelligence.table.quantity')}</th>
              <th>{translate('documentIntelligence.table.unit')}</th>
              <th>{translate('documentIntelligence.table.description')}</th>
              <th>{translate('documentIntelligence.table.unitPrice')}</th>
              <th>{translate('documentIntelligence.table.total')}</th>
            </tr>
          </thead>
          <tbody>
            {proposal.positions.map((position) => (
              <tr key={`${position.positionNumber}-${position.description}`}>
                <td>{position.positionNumber}</td>
                <td>{position.quantity.toLocaleString('de-DE')}</td>
                <td>{position.unit}</td>
                <td>{position.description}</td>
                <td>{position.unitPrice.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €</td>
                <td>{position.lineTotal.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Button
        fullWidth
        loading={isCreating}
        onClick={onCreateOrder}
        data-testid="contract-create-order-button"
      >
        {translate('documentIntelligence.action.createOrderWithPositions').replace(
          '{count}',
          String(proposal.positionCount),
        )}
      </Button>
    </Card>
  );
}
