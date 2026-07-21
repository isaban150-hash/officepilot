import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import {
  documentDunningDelivery,
  DUNNING_DELIVERY_METHODS,
  DUNNING_DOCUMENTATION_KINDS,
  formatDunningDeliveryLabel,
  formatDunningKindLabel,
  getDunningDocumentationsForInvoice,
} from '../../services/dunningDocumentationService';
import { getLastPersistSuccess } from '../../services/persistenceService';
import type {
  DocumentDunningInput,
  DunningDeliveryMethod,
  DunningDocumentationKind,
  InvoiceDunningDocumentation,
} from '../../types/dunningDocumentation';
import type { CommunicationIntent } from '../../types/communication';
import type { TranslationKey } from '../../i18n';

interface Props {
  vorgangId: string;
  invoiceId: string;
  /** Prefill kind from the current draft intent when available. */
  draftIntent?: CommunicationIntent;
  translate: (key: TranslationKey) => string;
  onDocumented?: (doc: InvoiceDunningDocumentation) => void;
}

type FormMode = 'closed' | 'form' | 'confirm';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDisplayDate(value: string): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleDateString('de-DE');
  } catch {
    return value;
  }
}

function kindFromIntent(intent?: CommunicationIntent): DunningDocumentationKind {
  return intent === 'dunning_notice' ? 'dunning_notice' : 'payment_reminder';
}

export function DunningDocumentationPanel({
  vorgangId,
  invoiceId,
  draftIntent,
  translate,
  onDocumented,
}: Props) {
  const [mode, setMode] = useState<FormMode>('closed');
  const [kind, setKind] = useState<DunningDocumentationKind>(kindFromIntent(draftIntent));
  const [documentedAt, setDocumentedAt] = useState(todayIso());
  const [deliveryMethod, setDeliveryMethod] = useState<DunningDeliveryMethod>('email');
  const [note, setNote] = useState('');
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [records, setRecords] = useState(() =>
    getDunningDocumentationsForInvoice(vorgangId, invoiceId),
  );

  useEffect(() => {
    setRecords(getDunningDocumentationsForInvoice(vorgangId, invoiceId));
  }, [vorgangId, invoiceId]);

  useEffect(() => {
    if (mode !== 'form') return;
    setKind(kindFromIntent(draftIntent));
    setDocumentedAt(todayIso());
    setDeliveryMethod('email');
    setNote('');
    setErrorKey(null);
  }, [mode, draftIntent]);

  const closeAll = () => {
    setMode('closed');
    setErrorKey(null);
  };

  const buildInput = (): DocumentDunningInput => ({
    kind,
    documentedAt,
    deliveryMethod,
    note: note.trim() || undefined,
  });

  const handleConfirm = () => {
    const result = documentDunningDelivery(vorgangId, invoiceId, buildInput());
    if (!result.ok) {
      if (result.reason === 'invalid_date') {
        setErrorKey('dunning.doc.error.date');
      } else if (result.reason === 'invalid_delivery') {
        setErrorKey('dunning.doc.error.delivery');
      } else if (result.reason === 'invalid_kind') {
        setErrorKey('dunning.doc.error.kind');
      } else if (result.reason === 'not_open') {
        setErrorKey('dunning.doc.error.notOpen');
      } else if (result.reason === 'draft_or_prepared' || result.reason === 'not_sent') {
        setErrorKey('dunning.doc.error.notSent');
      } else {
        setErrorKey('dunning.doc.error.failed');
      }
      return;
    }

    setRecords(getDunningDocumentationsForInvoice(vorgangId, invoiceId));
    onDocumented?.(result.documentation);
    if (!getLastPersistSuccess()) {
      setErrorKey('persist.failed.userAction');
      setMode('closed');
      return;
    }
    closeAll();
  };

  return (
    <section className="dunning-doc-panel" data-testid="dunning-doc-panel">
      <p className="dunning-doc-panel__hint" data-testid="dunning-doc-hint">
        {translate('dunning.doc.hint')}
      </p>

      {records.length > 0 ? (
        <ul className="dunning-doc-panel__list" data-testid="dunning-doc-list">
          {records.map((doc) => (
            <li key={doc.id} data-testid="dunning-doc-item">
              <strong>{formatDunningKindLabel(doc.kind, translate)}</strong>
              {' · '}
              {formatDisplayDate(doc.documentedAt)}
              {' · '}
              {formatDunningDeliveryLabel(doc.deliveryMethod, translate)}
              {doc.note?.trim() ? ` · ${doc.note}` : ''}
            </li>
          ))}
        </ul>
      ) : (
        <p className="dunning-doc-panel__empty">{translate('dunning.doc.empty')}</p>
      )}

      {mode === 'closed' ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setMode('form')}
          data-testid="dunning-doc-open"
        >
          {translate('dunning.doc.mark')}
        </Button>
      ) : null}

      {mode === 'form' ? (
        <form
          className="dunning-doc-panel__form"
          data-testid="dunning-doc-form"
          onSubmit={(event) => {
            event.preventDefault();
            setMode('confirm');
          }}
        >
          <label className="dunning-doc-panel__label" htmlFor="dunning-doc-kind">
            {translate('dunning.doc.kind')}
          </label>
          <select
            id="dunning-doc-kind"
            className="input"
            value={kind}
            onChange={(event) => setKind(event.target.value as DunningDocumentationKind)}
            data-testid="dunning-doc-kind"
          >
            {DUNNING_DOCUMENTATION_KINDS.map((option) => (
              <option key={option} value={option}>
                {formatDunningKindLabel(option, translate)}
              </option>
            ))}
          </select>

          <label className="dunning-doc-panel__label" htmlFor="dunning-doc-date">
            {translate('dunning.doc.date')}
          </label>
          <input
            id="dunning-doc-date"
            type="date"
            className="input"
            value={documentedAt}
            onChange={(event) => setDocumentedAt(event.target.value)}
            required
            data-testid="dunning-doc-date"
          />

          <label className="dunning-doc-panel__label" htmlFor="dunning-doc-via">
            {translate('dunning.doc.delivery')}
          </label>
          <select
            id="dunning-doc-via"
            className="input"
            value={deliveryMethod}
            onChange={(event) =>
              setDeliveryMethod(event.target.value as DunningDeliveryMethod)
            }
            data-testid="dunning-doc-via"
          >
            {DUNNING_DELIVERY_METHODS.map((option) => (
              <option key={option} value={option}>
                {formatDunningDeliveryLabel(option, translate)}
              </option>
            ))}
          </select>

          <label className="dunning-doc-panel__label" htmlFor="dunning-doc-note">
            {translate('dunning.doc.noteOptional')}
          </label>
          <textarea
            id="dunning-doc-note"
            className="input"
            rows={2}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            data-testid="dunning-doc-note"
          />

          {errorKey ? (
            <p className="dunning-doc-panel__error" data-testid="dunning-doc-error">
              {translate(errorKey)}
            </p>
          ) : null}

          <div className="dunning-doc-panel__actions">
            <Button type="button" variant="outline" size="sm" onClick={closeAll}>
              {translate('common.cancel')}
            </Button>
            <Button type="submit" size="sm" data-testid="dunning-doc-continue">
              {translate('dunning.doc.continue')}
            </Button>
          </div>
        </form>
      ) : null}

      {mode === 'confirm' ? (
        <div className="dunning-doc-panel__confirm" data-testid="dunning-doc-confirm">
          <p>{translate('dunning.doc.confirmText')}</p>
          <p className="dunning-doc-panel__confirm-summary">
            {formatDunningKindLabel(kind, translate)} · {formatDisplayDate(documentedAt)} ·{' '}
            {formatDunningDeliveryLabel(deliveryMethod, translate)}
          </p>
          {errorKey ? (
            <p className="dunning-doc-panel__error" data-testid="dunning-doc-error">
              {translate(errorKey)}
            </p>
          ) : null}
          <div className="dunning-doc-panel__actions">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setMode('form')}
              data-testid="dunning-doc-confirm-back"
            >
              {translate('common.back')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleConfirm}
              data-testid="dunning-doc-confirm-submit"
            >
              {translate('dunning.doc.confirm')}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function isDunningDocumentationIntent(intent: CommunicationIntent): boolean {
  return intent === 'payment_reminder' || intent === 'dunning_notice';
}
