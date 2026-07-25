import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { DataRow } from '../ui/Card';
import type { TranslationKey } from '../../i18n';
import { updateOrderAmendmentDraft } from '../../services/orderAmendmentService';

interface OrderAmendmentHeaderFormProps {
  vorgangId: string;
  amendmentId: string;
  title: string;
  reason?: string;
  disabled?: boolean;
  translate: (key: TranslationKey) => string;
  onUpdated: () => void;
  onToast: (message: string) => void;
}

export function OrderAmendmentHeaderForm({
  vorgangId,
  amendmentId,
  title,
  reason,
  disabled = false,
  translate,
  onUpdated,
  onToast,
}: OrderAmendmentHeaderFormProps) {
  const titleId = useId();
  const reasonId = useId();
  const titleErrorId = useId();
  const formErrorId = useId();

  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(title);
  const [reasonDraft, setReasonDraft] = useState(reason ?? '');
  const [titleError, setTitleError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  useEffect(() => {
    if (!editing) {
      setTitleDraft(title);
      setReasonDraft(reason ?? '');
      setTitleError(null);
      setFormError(null);
    }
  }, [title, reason, editing]);

  const openEdit = () => {
    if (disabled) return;
    setTitleDraft(title);
    setReasonDraft(reason ?? '');
    setTitleError(null);
    setFormError(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    if (saving) return;
    setEditing(false);
    setTitleDraft(title);
    setReasonDraft(reason ?? '');
    setTitleError(null);
    setFormError(null);
  };

  const saveEdit = async () => {
    if (savingRef.current || saving || disabled) return;
    const trimmedTitle = titleDraft.trim();
    if (!trimmedTitle) {
      setTitleError(translate('orderAmendment.header.titleRequired'));
      setFormError(null);
      queueMicrotask(() => {
        document.getElementById(titleId)?.focus();
      });
      return;
    }

    savingRef.current = true;
    setSaving(true);
    setTitleError(null);
    setFormError(null);
    try {
      const result = await Promise.resolve(
        updateOrderAmendmentDraft(vorgangId, amendmentId, {
          title: trimmedTitle,
          reason: reasonDraft,
        }),
      );
      if (!result.success) {
        setFormError(translate('orderAmendment.header.saveFailed'));
        savingRef.current = false;
        setSaving(false);
        return;
      }
      setEditing(false);
      onUpdated();
      onToast(translate('orderAmendment.updated'));
      savingRef.current = false;
      setSaving(false);
    } catch {
      setFormError(translate('orderAmendment.header.saveFailed'));
      savingRef.current = false;
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div className="order-amendment-header" data-testid="order-amendment-header">
        <DataRow label={translate('orderAmendment.field.title')} value={title} />
        {reason ? (
          <DataRow label={translate('orderAmendment.field.reason')} value={reason} />
        ) : null}
        <div className="order-amendment-actions order-amendment-actions--secondary">
          <Button
            variant="outline"
            disabled={disabled}
            onClick={openEdit}
            data-testid="order-amendment-edit-draft"
          >
            {translate('orderAmendment.editDraft')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="order-amendment-header order-amendment-header--editing"
      data-testid="order-amendment-header-editing"
    >
      <h3 className="section__subtitle">{translate('orderAmendment.header.sectionTitle')}</h3>
      {formError ? (
        <p
          id={formErrorId}
          className="invoice-hint invoice-hint--warning"
          role="alert"
          data-testid="order-amendment-header-error"
        >
          {formError}
        </p>
      ) : null}
      <label className="form-group" htmlFor={titleId}>
        <span>{translate('orderAmendment.field.titleRequired')}</span>
        <input
          id={titleId}
          className="input"
          data-testid="order-amendment-title"
          value={titleDraft}
          disabled={disabled || saving}
          aria-invalid={titleError ? true : undefined}
          aria-describedby={titleError ? titleErrorId : undefined}
          onChange={(event) => {
            setTitleDraft(event.target.value);
            if (titleError) setTitleError(null);
          }}
        />
      </label>
      {titleError ? (
        <p
          id={titleErrorId}
          className="field-error"
          role="alert"
          data-testid="order-amendment-title-error"
        >
          {titleError}
        </p>
      ) : null}
      <label className="form-group" htmlFor={reasonId}>
        <span>{translate('orderAmendment.field.reason')}</span>
        <textarea
          id={reasonId}
          className="input"
          data-testid="order-amendment-reason"
          value={reasonDraft}
          disabled={disabled || saving}
          rows={3}
          aria-describedby={`${reasonId}-hint`}
          onChange={(event) => setReasonDraft(event.target.value)}
        />
      </label>
      <p id={`${reasonId}-hint`} className="order-amendment-section__muted">
        {translate('orderAmendment.field.reasonHint')}
      </p>
      <div className="order-amendment-actions order-amendment-actions--secondary">
        <Button
          disabled={disabled || saving}
          loading={saving}
          onClick={() => void saveEdit()}
          data-testid="order-amendment-save-header"
        >
          {translate('orderAmendment.header.save')}
        </Button>
        <Button
          variant="ghost"
          disabled={disabled || saving}
          onClick={cancelEdit}
          data-testid="order-amendment-cancel-header"
        >
          {translate('orderAmendment.cancelEdit')}
        </Button>
      </div>
    </div>
  );
}
