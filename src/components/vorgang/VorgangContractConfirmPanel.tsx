import { Button } from '../ui/Button';
import { Card, CardMeta, CardTitle, DataRow } from '../ui/Card';
import type { TranslationKey } from '../../i18n';
import { confirmContractOrder } from '../../services/contractConfirmationService';
import type { Vorgang } from '../../types/models';

interface VorgangContractConfirmPanelProps {
  vorgang: Vorgang;
  translate: (key: TranslationKey) => string;
  onUpdated: () => void;
  onToast: (message: string) => void;
}

function formatConfirmedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('de-DE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function VorgangContractConfirmPanel({
  vorgang,
  translate,
  onUpdated,
  onToast,
}: VorgangContractConfirmPanelProps) {
  const snapshot = vorgang.contractConfirmation;
  const canConfirm = vorgang.status === 'in_verhandlung' && !snapshot;

  if (!canConfirm && !snapshot) {
    return null;
  }

  const handleConfirm = () => {
    const result = confirmContractOrder(vorgang.id);
    if (!result.success) {
      onToast(translate(`confirmation.error.${result.errorKey}` as TranslationKey));
      return;
    }
    onUpdated();
    onToast(translate('confirmation.success'));
  };

  return (
    <section className="section" data-testid="vorgang-contract-confirm-panel">
      <h2 className="section__title">{translate('confirmation.title')}</h2>

      {canConfirm ? (
        <Card>
          <p className="empty-state">{translate('confirmation.intro')}</p>
          <Button fullWidth onClick={handleConfirm} data-testid="confirmation-accept-order">
            {translate('confirmation.acceptOrder')}
          </Button>
          <Button
            variant="outline"
            fullWidth
            onClick={handleConfirm}
            data-testid="confirmation-confirm-contract"
          >
            {translate('confirmation.confirmContract')}
          </Button>
        </Card>
      ) : null}

      {snapshot ? (
        <Card data-testid="confirmation-snapshot-card">
          <CardTitle>{translate('confirmation.confirmed')}</CardTitle>
          <DataRow
            label={translate('confirmation.confirmedAt')}
            value={formatConfirmedAt(snapshot.confirmedAt)}
          />
          <DataRow label={translate('confirmation.customer')} value={snapshot.customer} />
          <DataRow label={translate('confirmation.auftraggeber')} value={snapshot.auftraggeber} />
          <DataRow label={translate('confirmation.baustelle')} value={snapshot.baustelle} />
          <CardMeta>
            {translate('confirmation.positionsCount').replace(
              '{count}',
              String(snapshot.positions.length),
            )}
          </CardMeta>
          <p className="invoice-hint" data-testid="confirmation-immutable-hint">
            {translate('confirmation.immutableHint')}
          </p>
        </Card>
      ) : null}
    </section>
  );
}
