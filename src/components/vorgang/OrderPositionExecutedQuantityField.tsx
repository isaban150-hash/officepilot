import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { DataRow } from '../ui/Card';
import type { TranslationKey } from '../../i18n';
import {
  canUpdateExecutedQuantity,
  updateOrderPositionExecutedQuantity,
} from '../../services/vorgangService';
import type { OrderPosition, Vorgang } from '../../types/models';
import {
  formatAmendmentDecimalInput,
  parseAmendmentDecimalInput,
} from './orderAmendmentUiHelpers';

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
  return `${formatAmendmentDecimalInput(value)} ${unitLabel}`;
}

export function OrderPositionExecutedQuantityField({
  vorgang,
  position,
  unitLabel,
  translate,
  onUpdated,
  onToast,
}: OrderPositionExecutedQuantityFieldProps) {
  const reactId = useId();
  const inputId = `execution-qty-${position.id}-${reactId}`;
  const errorId = `${inputId}-error`;
  const unitId = `${inputId}-unit`;

  const editable = canUpdateExecutedQuantity(vorgang);
  const [draft, setDraft] = useState(
    position.executedQuantity === undefined
      ? ''
      : formatAmendmentDecimalInput(position.executedQuantity),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  useEffect(() => {
    setDraft(
      position.executedQuantity === undefined
        ? ''
        : formatAmendmentDecimalInput(position.executedQuantity),
    );
    setError(null);
  }, [position.id, position.executedQuantity]);

  if (!editable) {
    return (
      <DataRow
        label={translate('execution.executedQuantity')}
        value={formatExecutedDisplay(position.executedQuantity, unitLabel)}
      />
    );
  }

  const handleSave = async () => {
    if (savingRef.current || saving) return;

    const trimmed = draft.trim();
    let next: number | undefined;
    if (trimmed === '') {
      next = undefined;
      setError(null);
    } else {
      const parsed = parseAmendmentDecimalInput(trimmed);
      if (parsed === null) {
        setError(translate('execution.qty.invalidFormat'));
        return;
      }
      if (parsed < 0) {
        setError(translate('execution.qty.negative'));
        return;
      }
      next = parsed;
      setError(null);
    }

    savingRef.current = true;
    setSaving(true);
    try {
      const result = await Promise.resolve(
        updateOrderPositionExecutedQuantity(vorgang.id, position.id, next),
      );
      if (!result.success) {
        setError(translate('execution.qty.saveFailed'));
        savingRef.current = false;
        setSaving(false);
        return;
      }
      onUpdated(result.vorgang);
      onToast(translate('execution.qty.saved'));
      savingRef.current = false;
      setSaving(false);
    } catch {
      setError(translate('execution.qty.saveFailed'));
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <div
      className="form-group execution-qty-field"
      data-testid={`execution-qty-field-${position.id}`}
    >
      <label className="execution-qty-field__label" htmlFor={inputId}>
        {translate('execution.executedQuantity')}
      </label>
      <div className="execution-qty-field__controls">
        <div className="execution-qty-field__input-row">
          <input
            id={inputId}
            className="input execution-qty-field__input"
            inputMode="decimal"
            value={draft}
            disabled={saving}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${errorId} ${unitId}` : unitId}
            data-testid={`execution-qty-input-${position.id}`}
            onChange={(event) => {
              setDraft(event.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              void handleSave();
            }}
          />
          <span id={unitId} className="execution-qty-field__unit">
            {unitLabel}
          </span>
        </div>
        <Button
          variant="outline"
          disabled={saving}
          loading={saving}
          onClick={() => void handleSave()}
          data-testid={`execution-qty-save-${position.id}`}
        >
          {translate('execution.qty.save')}
        </Button>
      </div>
      {error ? (
        <p
          id={errorId}
          className="field-error"
          role="alert"
          data-testid={`execution-qty-error-${position.id}`}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
