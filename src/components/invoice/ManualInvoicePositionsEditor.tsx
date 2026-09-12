import { useState } from 'react';
import { Button } from '../ui/Button';
import { NumericInput } from '../ui/NumericInput';
import { ORDER_UNITS } from '../../services/orderUnits';
import { buildManualInvoicePosition } from '../../services/invoiceService';
import {
  isValidManualUnit,
  validateManualPosition,
  type ManualPositionIssue,
} from '../../services/invoice/manualInvoiceFlow';
import { formatInvoiceCurrency } from '../../services/invoicePrintModel';
import type { InvoiceDraftPosition, OrderUnit } from '../../types/models';
import type { TranslationKey } from '../../i18n';

interface Props {
  positions: InvoiceDraftPosition[];
  onChange: (positions: InvoiceDraftPosition[]) => void;
  disabled?: boolean;
  translate: (key: TranslationKey) => string;
}

interface EditorState {
  id: string | null;
  description: string;
  quantity: number;
  unit: OrderUnit;
  unitPrice: number;
  /** Ein unvollständiger Zwischenstand im strengen Zahlenfeld sperrt Übernehmen. */
  quantityIncomplete: boolean;
  priceIncomplete: boolean;
  touched: boolean;
}

function emptyEditor(): EditorState {
  return {
    id: null,
    description: '',
    quantity: 1,
    unit: 'Stück',
    unitPrice: 0,
    quantityIncomplete: false,
    priceIncomplete: false,
    touched: false,
  };
}

function issueKey(issue: ManualPositionIssue): TranslationKey {
  return `manualInvoice.position.issue.${issue}` as TranslationKey;
}

/**
 * MANUAL-INVOICE-UI-01B1B — der Editor für **freie** Rechnungspositionen.
 *
 * Genau vier Felder: Beschreibung, Menge, Einheit, Einzelpreis. Keine Plan-,
 * Ausführungs- oder Abrechnungsmengen, keine Auftragsreferenz — die Zeile
 * entsteht über `buildManualInvoicePosition` und trägt diese Felder gar nicht.
 *
 * Zeilen statt Kartenwand; eine Zeile wird im selben Formular bearbeitet, in
 * dem sie angelegt wurde. Zahlen laufen durch `NumericInput` im strengen Modus:
 * ungültige Eingaben werden abgewiesen, nie umgedeutet.
 */
export function ManualInvoicePositionsEditor({ positions, onChange, disabled, translate }: Props) {
  const [editor, setEditor] = useState<EditorState>(emptyEditor);

  const issues = validateManualPosition(editor);
  const canCommit =
    !disabled && issues.length === 0 && !editor.quantityIncomplete && !editor.priceIncomplete;

  const commit = () => {
    if (!canCommit) {
      setEditor((prev) => ({ ...prev, touched: true }));
      return;
    }
    const description = editor.description.trim();
    if (editor.id) {
      onChange(
        positions.map((position) =>
          position.id === editor.id
            ? { ...position, description, quantity: editor.quantity, unit: editor.unit, unitLabel: editor.unit, unitPrice: editor.unitPrice }
            : position,
        ),
      );
    } else {
      onChange([
        ...positions,
        buildManualInvoicePosition({
          description,
          quantity: editor.quantity,
          unit: editor.unit,
          unitLabel: editor.unit,
          unitPrice: editor.unitPrice,
        }),
      ]);
    }
    setEditor(emptyEditor());
  };

  const startEdit = (position: InvoiceDraftPosition) => {
    setEditor({
      id: position.id,
      description: position.description,
      quantity: position.quantity,
      unit: isValidManualUnit(position.unit) ? position.unit : 'Stück',
      unitPrice: position.unitPrice,
      quantityIncomplete: false,
      priceIncomplete: false,
      touched: false,
    });
  };

  const remove = (id: string) => {
    onChange(positions.filter((position) => position.id !== id));
    if (editor.id === id) setEditor(emptyEditor());
  };

  const visibleIssues = editor.touched ? issues : [];

  return (
    <div className="manual-positions" data-testid="manual-positions-editor">
      {positions.length === 0 ? (
        <p className="empty-state" data-testid="manual-positions-empty">
          {translate('manualInvoice.positions.empty')}
        </p>
      ) : (
        <ol className="manual-positions__list" data-testid="manual-positions-list">
          {positions.map((position, index) => (
            <li
              key={position.id}
              className={`manual-positions__row ${editor.id === position.id ? 'manual-positions__row--editing' : ''}`}
              data-testid={`manual-position-${index}`}
            >
              <div className="manual-positions__main">
                <span className="manual-positions__index">{index + 1}.</span>
                <span className="manual-positions__description">{position.description}</span>
              </div>
              <div className="manual-positions__meta">
                <span>
                  {position.quantity} {position.unitLabel ?? position.unit} ×{' '}
                  {formatInvoiceCurrency(position.unitPrice)}
                </span>
                <strong>{formatInvoiceCurrency(position.quantity * position.unitPrice)}</strong>
              </div>
              <div className="manual-positions__actions">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={() => startEdit(position)}
                  data-testid={`manual-position-edit-${index}`}
                >
                  {translate('position.edit')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={() => remove(position.id)}
                  data-testid={`manual-position-remove-${index}`}
                >
                  {translate('position.delete')}
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}

      <div className="manual-positions__form" data-testid="manual-position-form">
        <p className="manual-positions__form-title">
          {editor.id ? translate('manualInvoice.position.editTitle') : translate('manualInvoice.position.addTitle')}
        </p>
        <label className="invoice-edit__field">
          <span className="invoice-edit__label">{translate('manualInvoice.position.description')}</span>
          <textarea
            className="input manual-positions__textarea"
            rows={2}
            value={editor.description}
            disabled={disabled}
            onChange={(event) => setEditor((prev) => ({ ...prev, description: event.target.value }))}
            data-testid="manual-position-description"
          />
        </label>
        <div className="manual-positions__grid">
          <label className="invoice-edit__field">
            <span className="invoice-edit__label">{translate('manualInvoice.position.quantity')}</span>
            <NumericInput
              id="manual-position-quantity"
              mode="decimal"
              strict
              min={0}
              value={editor.quantity}
              disabled={disabled}
              onChange={(value) => setEditor((prev) => ({ ...prev, quantity: value }))}
              onEditingValidityChange={(valid) =>
                setEditor((prev) => ({ ...prev, quantityIncomplete: !valid }))
              }
              data-testid="manual-position-quantity"
            />
          </label>
          <label className="invoice-edit__field">
            <span className="invoice-edit__label">{translate('manualInvoice.position.unit')}</span>
            <select
              className="input"
              value={editor.unit}
              disabled={disabled}
              onChange={(event) => {
                const next = event.target.value;
                if (isValidManualUnit(next)) setEditor((prev) => ({ ...prev, unit: next }));
              }}
              data-testid="manual-position-unit"
            >
              {ORDER_UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </select>
          </label>
          <label className="invoice-edit__field">
            <span className="invoice-edit__label">{translate('manualInvoice.position.unitPrice')}</span>
            <NumericInput
              id="manual-position-unit-price"
              mode="decimal"
              strict
              min={0}
              value={editor.unitPrice}
              disabled={disabled}
              onChange={(value) => setEditor((prev) => ({ ...prev, unitPrice: value }))}
              onEditingValidityChange={(valid) =>
                setEditor((prev) => ({ ...prev, priceIncomplete: !valid }))
              }
              data-testid="manual-position-unit-price"
            />
          </label>
        </div>

        {visibleIssues.length > 0 && (
          <ul className="form-error manual-positions__issues" data-testid="manual-position-issues">
            {visibleIssues.map((issue) => (
              <li key={issue}>{translate(issueKey(issue))}</li>
            ))}
          </ul>
        )}

        <div className="manual-positions__form-actions">
          {editor.id && (
            <Button type="button" variant="outline" onClick={() => setEditor(emptyEditor())} data-testid="manual-position-cancel-edit">
              {translate('common.cancel')}
            </Button>
          )}
          <Button
            type="button"
            variant={editor.id ? 'primary' : 'outline'}
            onClick={commit}
            disabled={disabled}
            data-testid="manual-position-commit"
          >
            {editor.id ? translate('manualInvoice.position.apply') : translate('manualInvoice.position.add')}
          </Button>
        </div>
      </div>
    </div>
  );
}
