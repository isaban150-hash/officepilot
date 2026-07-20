import { useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Card, CardTitle } from '../ui/Card';
import {
  buildDocumentFieldFillConfirmViewModel,
  formatConfirmedFillConfirmClipboardText,
} from '../../services/documentFieldFillConfirmService';
import type { DocumentFieldFillConfirmRow } from '../../types/documentFieldFillConfirm';
import type { InboxItem } from '../../types/models';

export interface DocumentFieldFillConfirmPanelProps {
  item: InboxItem;
  testIdPrefix?: string;
}

function confidenceLabel(confidence: DocumentFieldFillConfirmRow['confidence']): string | null {
  if (confidence === 'low') return 'Unsicher';
  if (confidence === 'medium') return 'Mittel sicher';
  return null;
}

/**
 * Local session-only fill confirmation for inbox detail.
 * Never persists, archives, links, or sends.
 */
export function DocumentFieldFillConfirmPanel({
  item,
  testIdPrefix = 'document-field-fill-confirm',
}: DocumentFieldFillConfirmPanelProps) {
  const [rows, setRows] = useState<DocumentFieldFillConfirmRow[]>(() => [
    ...buildDocumentFieldFillConfirmViewModel(item).rows,
  ]);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editSeed, setEditSeed] = useState('');
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);

  const updateRow = (
    fieldKey: string,
    updater: (row: DocumentFieldFillConfirmRow) => DocumentFieldFillConfirmRow,
  ): void => {
    setRows((current) =>
      current.map((row) => (row.fieldKey === fieldKey ? updater(row) : row)),
    );
  };

  const handleConfirm = (row: DocumentFieldFillConfirmRow): void => {
    const value = row.proposedValue.trim();
    if (!value) return;
    updateRow(row.fieldKey, (current) =>
      Object.freeze({
        ...current,
        status: 'confirmed',
        confirmedValue: value,
      }),
    );
    setEditingKey(null);
  };

  const handleReject = (row: DocumentFieldFillConfirmRow): void => {
    updateRow(row.fieldKey, (current) =>
      Object.freeze({
        ...current,
        status: 'rejected',
        confirmedValue: undefined,
      }),
    );
    setEditingKey(null);
  };

  const startCorrect = (row: DocumentFieldFillConfirmRow): void => {
    setEditingKey(row.fieldKey);
    setEditSeed(
      row.status === 'confirmed' && row.confirmedValue
        ? row.confirmedValue
        : row.proposedValue,
    );
  };

  const applyCorrect = (row: DocumentFieldFillConfirmRow): void => {
    const value = (editInputRef.current?.value ?? '').trim();
    if (!value) return;
    updateRow(row.fieldKey, (current) =>
      Object.freeze({
        ...current,
        status: 'confirmed',
        confirmedValue: value,
      }),
    );
    setEditingKey(null);
    setEditSeed('');
  };

  const handleCopyConfirmed = async (): Promise<void> => {
    const text = formatConfirmedFillConfirmClipboardText(rows);
    if (!text) {
      setCopyFeedback('Noch keine bestätigten Angaben.');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedback('Bestätigte Angaben kopiert.');
    } catch {
      setCopyFeedback('Kopieren nicht möglich.');
    }
  };

  const confirmedCount = rows.filter((row) => row.status === 'confirmed').length;

  return (
    <section
      className="document-field-fill-confirm"
      data-testid={`${testIdPrefix}-panel`}
    >
      <Card className="document-field-fill-confirm__card">
        <CardTitle>Angaben prüfen</CardTitle>
        <p
          className="document-field-fill-confirm__hint"
          data-testid={`${testIdPrefix}-unsaved-hint`}
        >
          Vorschläge sind noch nicht gespeichert. Nur lokal bestätigt — nichts wird
          übernommen, archiviert oder versendet.
        </p>

        <ul className="document-field-fill-confirm__list">
          {rows.map((row) => {
            const isEditing = editingKey === row.fieldKey;
            const displayValue =
              row.status === 'confirmed' && row.confirmedValue
                ? row.confirmedValue
                : row.proposedValue;
            const uncertain = row.confidence === 'low' && row.status === 'proposed';

            return (
              <li
                key={row.fieldKey}
                className="document-field-fill-confirm__row"
                data-testid={`${testIdPrefix}-row-${row.fieldKey}`}
                data-status={row.status}
                data-confidence={row.confidence ?? ''}
              >
                <div className="document-field-fill-confirm__row-head">
                  <span className="document-field-fill-confirm__label">{row.label}</span>
                  {uncertain ? (
                    <span
                      className="badge badge--warning"
                      data-testid={`${testIdPrefix}-uncertainty-${row.fieldKey}`}
                    >
                      {confidenceLabel(row.confidence)}
                    </span>
                  ) : null}
                  {row.status === 'confirmed' ? (
                    <span
                      className="badge badge--success"
                      data-testid={`${testIdPrefix}-confirmed-badge-${row.fieldKey}`}
                    >
                      Bestätigt
                    </span>
                  ) : null}
                  {row.status === 'rejected' ? (
                    <span
                      className="badge"
                      data-testid={`${testIdPrefix}-rejected-badge-${row.fieldKey}`}
                    >
                      Verworfen
                    </span>
                  ) : null}
                  {row.status === 'missing' ? (
                    <span
                      className="badge"
                      data-testid={`${testIdPrefix}-missing-badge-${row.fieldKey}`}
                    >
                      Fehlt
                    </span>
                  ) : null}
                  {row.status === 'proposed' ? (
                    <span
                      className="badge badge--info"
                      data-testid={`${testIdPrefix}-proposed-badge-${row.fieldKey}`}
                    >
                      Vorschlag
                    </span>
                  ) : null}
                </div>

                {!isEditing ? (
                  <p
                    className="document-field-fill-confirm__value"
                    data-testid={`${testIdPrefix}-value-${row.fieldKey}`}
                  >
                    {displayValue || '—'}
                  </p>
                ) : (
                  <div className="document-field-fill-confirm__edit">
                    <input
                      ref={editInputRef}
                      type="text"
                      className="input"
                      defaultValue={editSeed}
                      key={`${row.fieldKey}-${editSeed}-edit`}
                      data-testid={`${testIdPrefix}-edit-input-${row.fieldKey}`}
                      aria-label={`${row.label} korrigieren`}
                    />
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => applyCorrect(row)}
                      data-testid={`${testIdPrefix}-edit-apply-${row.fieldKey}`}
                    >
                      Übernehmen
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditingKey(null);
                        setEditSeed('');
                      }}
                    >
                      Abbrechen
                    </Button>
                  </div>
                )}

                {!isEditing ? (
                  <div className="document-field-fill-confirm__actions">
                    {row.status === 'proposed' ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => handleConfirm(row)}
                        data-testid={`${testIdPrefix}-confirm-${row.fieldKey}`}
                      >
                        Bestätigen
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => startCorrect(row)}
                      data-testid={`${testIdPrefix}-correct-${row.fieldKey}`}
                    >
                      {row.status === 'missing' ? 'Ergänzen' : 'Korrigieren'}
                    </Button>
                    {row.status === 'proposed' || row.status === 'confirmed' ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => handleReject(row)}
                        data-testid={`${testIdPrefix}-reject-${row.fieldKey}`}
                      >
                        Verwerfen
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>

        <div className="document-field-fill-confirm__footer">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void handleCopyConfirmed()}
            disabled={confirmedCount === 0}
            data-testid={`${testIdPrefix}-copy`}
          >
            Bestätigte Angaben kopieren
          </Button>
          {copyFeedback ? (
            <p
              className="document-field-fill-confirm__copy-feedback"
              data-testid={`${testIdPrefix}-copy-feedback`}
            >
              {copyFeedback}
            </p>
          ) : null}
        </div>
      </Card>
    </section>
  );
}
