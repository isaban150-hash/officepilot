import { Card, DataRow } from '../ui/Card';
import type { TranslationKey } from '../../i18n';
import { sortConfirmedOrderAmendments } from '../../services/orderPlanCompositionService';
import type { Vorgang } from '../../types/models';
import { formatAmendmentMoney } from './orderAmendmentUiHelpers';

interface OrderSummaryPanelProps {
  vorgang: Vorgang;
  translate: (key: TranslationKey) => string;
}

function confirmedOrderValue(vorgang: Vorgang): number | null {
  const positions = vorgang.contractConfirmation?.positions;
  if (!positions || positions.length === 0) return null;
  const total = positions.reduce(
    (sum, position) => sum + position.plannedQuantity * position.unitPrice,
    0,
  );
  return Math.round(total * 100) / 100;
}

export function OrderSummaryPanel({ vorgang, translate }: OrderSummaryPanelProps) {
  const confirmation = vorgang.contractConfirmation;
  const confirmedAmendments = sortConfirmedOrderAmendments(vorgang.confirmedOrderAmendments);
  const hasDraft = (vorgang.orderAmendments?.length ?? 0) > 0;
  const orderValue = confirmedOrderValue(vorgang);
  const mainPositionCount = confirmation?.positions.length ?? 0;

  return (
    <Card className="order-summary-panel" data-testid="order-summary-panel">
      <h2 className="section__title">{translate('vorgang.orderSummary.title')}</h2>
      {!confirmation ? (
        <p className="order-summary-panel__hint" data-testid="order-summary-unconfirmed">
          {translate('vorgang.orderSummary.notConfirmed')}
        </p>
      ) : (
        <div className="order-summary-panel__metrics" data-testid="order-summary-metrics">
          {orderValue !== null ? (
            <DataRow
              label={translate('vorgang.orderSummary.orderValue')}
              value={formatAmendmentMoney(orderValue)}
            />
          ) : null}
          <DataRow
            label={translate('vorgang.orderSummary.mainPositions')}
            value={String(mainPositionCount)}
          />
          <DataRow
            label={translate('vorgang.orderSummary.confirmedAmendments')}
            value={String(confirmedAmendments.length)}
          />
          <DataRow
            label={translate('vorgang.orderSummary.openDraft')}
            value={
              hasDraft
                ? translate('vorgang.orderSummary.openDraftYes')
                : translate('vorgang.orderSummary.openDraftNo')
            }
          />
        </div>
      )}
    </Card>
  );
}
