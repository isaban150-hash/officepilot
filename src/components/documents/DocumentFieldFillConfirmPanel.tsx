import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Card, CardTitle } from '../ui/Card';
import {
  buildDocumentFieldFillConfirmViewModel,
  formatConfirmedFillConfirmClipboardText,
} from '../../services/documentFieldFillConfirmService';
import { persistFillConfirmRowsToDocumentWorkOverlay } from '../../services/documentFieldFillConfirmPersistService';
import { applyStoredOverlayToFillConfirmRows } from '../../services/documentFieldFillConfirmTruthBridge';
import { applyFreeTextBridgeProposalToRows } from '../../services/documentFieldFillFreeTextBridgeService';
import { getDocumentWorkResultForItem } from '../../services/documentWorkResultService';
import type { DocumentFieldFillConfirmRow } from '../../types/documentFieldFillConfirm';
import type { DocumentFieldFillFreeTextBridgeProposal } from '../../types/documentFieldFillFreeTextBridge';
import type { InboxItem } from '../../types/models';

/** Local-only persist failure copy (no cloud/sync wording). */
const FILL_CONFIRM_PERSIST_FAILED_MESSAGE =
  'Speichern fehlgeschlagen. Die Bestätigung wurde nicht dauerhaft übernommen.';

function initialRowsForItem(item: InboxItem): DocumentFieldFillConfirmRow[] {
  const base = [...buildDocumentFieldFillConfirmViewModel(item).rows];
  const dwr = getDocumentWorkResultForItem(item.id);
  return applyStoredOverlayToFillConfirmRows(base, dwr?.overlay ?? null);
}

export interface DocumentFieldFillConfirmPanelProps {
  item: InboxItem;
  testIdPrefix?: string;
  /** Session-only free-text proposal; applied as local `proposed` when id changes. */
  freeTextBridgeProposal?: DocumentFieldFillFreeTextBridgeProposal | null;
  /**
   * Optional controlled rows (page-owned single source of truth).
   * When both `rows` and `onRowsChange` are set, internal row state is unused.
   */
  rows?: DocumentFieldFillConfirmRow[];
  onRowsChange?: (rows: DocumentFieldFillConfirmRow[]) => void;
  /** Optional host feedback (e.g. toast) when local persist fails. */
  onPersistFailed?: (message: string) => void;
}

function confidenceLabel(confidence: DocumentFieldFillConfirmRow['confidence']): string | null {
  if (confidence === 'low') return 'Unsicher';
  if (confidence === 'medium') return 'Mittel sicher';
  return null;
}

/**
 * Fill confirmation for inbox detail.
 * Confirmed/corrected/discarded slotted fields are written to the existing DWR overlay
 * and flushed locally via `persistAll` (same device). Does not archive, link, send, or sync.
 */
export function DocumentFieldFillConfirmPanel({
  item,
  testIdPrefix = 'document-field-fill-confirm',
  freeTextBridgeProposal = null,
  rows: controlledRows,
  onRowsChange,
  onPersistFailed,
}: DocumentFieldFillConfirmPanelProps) {
  const isControlled = controlledRows !== undefined && onRowsChange !== undefined;
  const [internalRows, setInternalRows] = useState<DocumentFieldFillConfirmRow[]>(() =>
    initialRowsForItem(item),
  );
  const rows = isControlled ? controlledRows : internalRows;
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editSeed, setEditSeed] = useState('');
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [persistError, setPersistError] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const lastBridgeIdRef = useRef<number | null>(null);

  const replaceRows = (
    updater: (current: DocumentFieldFillConfirmRow[]) => DocumentFieldFillConfirmRow[],
  ): void => {
    if (isControlled) {
      onRowsChange(updater(controlledRows));
      return;
    }
    setInternalRows((current) => updater(current));
  };

  const commitDurableRows = (
    updater: (current: DocumentFieldFillConfirmRow[]) => DocumentFieldFillConfirmRow[],
  ): boolean => {
    const previous = rows.map((row) => row);
    const next = updater(previous);
    replaceRows(() => next);
    const result = persistFillConfirmRowsToDocumentWorkOverlay({
      inboxItemId: item.id,
      rows: next,
    });
    if (result.success) {
      setPersistError(null);
      return true;
    }
    replaceRows(() => previous);
    setPersistError(FILL_CONFIRM_PERSIST_FAILED_MESSAGE);
    onPersistFailed?.(FILL_CONFIRM_PERSIST_FAILED_MESSAGE);
    return false;
  };

  useEffect(() => {
    if (!freeTextBridgeProposal) return;
    if (lastBridgeIdRef.current === freeTextBridgeProposal.id) return;
    lastBridgeIdRef.current = freeTextBridgeProposal.id;
    const proposal = freeTextBridgeProposal;
    if (isControlled) {
      onRowsChange(applyFreeTextBridgeProposalToRows(controlledRows, proposal));
    } else {
      setInternalRows((current) => applyFreeTextBridgeProposalToRows(current, proposal));
    }
    setEditingKey(null);
  }, [freeTextBridgeProposal, isControlled, onRowsChange, controlledRows]);

  const handleConfirm = (row: DocumentFieldFillConfirmRow): void => {
    const value = row.proposedValue.trim();
    if (!value) return;
    commitDurableRows((current) =>
      current.map((entry) =>
        entry.fieldKey === row.fieldKey
          ? Object.freeze({
              ...entry,
              status: 'confirmed' as const,
              confirmedValue: value,
              bridgedFromFreeText: undefined,
            })
          : entry,
      ),
    );
    setEditingKey(null);
  };

  const handleReject = (row: DocumentFieldFillConfirmRow): void => {
    commitDurableRows((current) =>
      current.map((entry) =>
        entry.fieldKey === row.fieldKey
          ? Object.freeze({
              ...entry,
              status: 'rejected' as const,
              confirmedValue: undefined,
              bridgedFromFreeText: undefined,
            })
          : entry,
      ),
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
    const saved = commitDurableRows((current) =>
      current.map((entry) =>
        entry.fieldKey === row.fieldKey
          ? Object.freeze({
              ...entry,
              status: 'confirmed' as const,
              confirmedValue: value,
              bridgedFromFreeText: undefined,
            })
          : entry,
      ),
    );
    if (!saved) return;
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
          Bestätigte Angaben werden lokal auf diesem Gerät gespeichert. Nichts wird
          archiviert oder versendet.
        </p>
        {persistError ? (
          <p
            className="document-field-fill-confirm__persist-error"
            data-testid={`${testIdPrefix}-persist-error`}
            role="alert"
          >
            {persistError}
          </p>
        ) : null}

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
                  <>
                    <p
                      className="document-field-fill-confirm__value"
                      data-testid={`${testIdPrefix}-value-${row.fieldKey}`}
                    >
                      {displayValue || '—'}
                    </p>
                    {row.bridgedFromFreeText && row.status === 'proposed' ? (
                      <p
                        className="document-field-fill-confirm__bridge-hint"
                        data-testid={`${testIdPrefix}-bridge-hint-${row.fieldKey}`}
                      >
                        Aus deiner Eingabe vorgeschlagen – noch nicht bestätigt.
                      </p>
                    ) : null}
                  </>
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
