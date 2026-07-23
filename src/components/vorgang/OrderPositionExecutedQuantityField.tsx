import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { DataRow } from '../ui/Card';
import type { TranslationKey } from '../../i18n';
import {
  canUpdateExecutedQuantity,
  updateOrderPositionExecutedQuantity,
} from '../../services/vorgangService';
import type { OrderPosition, Vorgang } from '../../types/models';

interface OrderPositionExecutedQuantityFieldProps {
  vorgang: Vorgang;
  position: OrderPosition;
  unitLabel: string;
  translate: (key: TranslationKey) => string;
  onUpdated: (vorgang: Vorgang) => void;
  onToast: (message: string) => void;
}

function formatExecutedDisplay(value: number | undefined, unitLabel: string): string {
  if (value === undefined) return '—';
  return `${value} ${unitLabel}`;
}

export function OrderPositionExecutedQuantityField({
  vorgang,
  position,
  unitLabel,
  translate,
  onUpdated,
  onToast,
}: OrderPositionExecutedQuantityFieldProps) {
  const editable = canUpdateExecutedQuantity(vorgang);
  const [draft, setDraft] = useState(
    position.executedQuantity === undefined ? '' : String(position.executedQuantity),
  );

  useEffect(() => {
    setDraft(position.executedQuantity === undefined ? '' : String(position.executedQuantity));
  }, [position.id, position.executedQuantity]);

  if (!editable) {
    return (
      <DataRow
        label={translate('execution.executedQuantity')}
        value={formatExecutedDisplay(position.executedQuantity, unitLabel)}
      />
    );
  }

  const handleSave = () => {
    const trimmed = draft.trim();
    let next: number | undefined;
    if (trimmed === '') {
      next = undefined;
    } else {
      const parsed = Number(trimmed.replace(',', '.'));
      if (!Number.isFinite(parsed) || parsed < 0) {
        onToast(translate('execution.qty.invalid'));
        return;
      }
      next = parsed;
    }

    const result = updateOrderPositionExecutedQuantity(vorgang.id, position.id, next);
    if (!result.success) {
      onToast(translate(`execution.error.${result.errorKey}` as TranslationKey));
      return;
    }
    onUpdated(result.vorgang);
    onToast(translate('execution.qty.saved'));
  };

  return (
    <div className="form-group" data-testid={`execution-qty-field-${position.id}`}>
      <span>{translate('execution.executedQuantity')}</span>
      <div className="order-position-card__actions">
        <input
          className="input"
          inputMode="decimal"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label={translate('execution.executedQuantity')}
          data-testid={`execution-qty-input-${position.id}`}
        />
        <Button
          variant="outline"
          onClick={handleSave}
          data-testid={`execution-qty-save-${position.id}`}
        >
          {translate('execution.qty.save')}
        </Button>
      </div>
    </div>
  );
}
