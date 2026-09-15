/**
 * PRODUCT-BASIS-FIRMENPROFIL-01C — Rechnungsnummernformat (Abschnitt in
 * „Rechnungen & Zahlungen“). Serverwahrheit; hier nur Prefix, Jahr, Stellen,
 * Vorschau und der Sperrhinweis. Gesperrt ist das laufende Jahr, sobald es
 * Nummern traegt — dann sind die Felder nicht editierbar und der Hinweis
 * benennt den Grund; eine Aenderung gilt erst fuer noch unbenutzte Jahre.
 */
import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { useApp } from '../../context/AppContext';
import {
  loadInvoiceNumberFormat,
  saveInvoiceNumberFormat,
  type InvoiceNumberFormatState,
} from '../../services/invoice/invoiceNumberFormatCloudService';
import {
  INVOICE_NUMBER_PADDING_MAX,
  INVOICE_NUMBER_PADDING_MIN,
  INVOICE_NUMBER_PREFIX_MAX_LENGTH,
  buildInvoiceNumber,
  getCurrentInvoiceYear,
  validateInvoiceNumberFormat,
} from '../../services/invoiceNumberService';
import type { TranslationKey } from '../../i18n';
import type { InvoiceNumberFormat } from '../../types/models';

interface Props {
  editable: boolean;
}

const PADDING_OPTIONS = Array.from({ length: INVOICE_NUMBER_PADDING_MAX - INVOICE_NUMBER_PADDING_MIN + 1 }, (_, i) => INVOICE_NUMBER_PADDING_MIN + i);

export function InvoiceNumberFormatSection({ editable }: Props) {
  const { translate, showToast } = useApp();
  const [state, setState] = useState<InvoiceNumberFormatState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<InvoiceNumberFormat>({ prefix: '', yearInNumber: true, padding: 4 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadInvoiceNumberFormat().then((result) => {
      if (cancelled) return;
      if (result.outcome === 'ok') {
        setState(result.state);
        setDraft(result.state.format);
      } else {
        setLoadError('detail' in result && result.detail ? result.detail : result.outcome);
      }
    });
    return () => { cancelled = true; };
  }, []);

  const year = state?.currentYear ?? getCurrentInvoiceYear();
  const locked = state?.currentYearLocked ?? false;
  const dirty = state ? draft.prefix !== state.format.prefix || draft.yearInNumber !== state.format.yearInNumber || draft.padding !== state.format.padding : false;
  /*
   * 01C2 — das Standardformat bleibt aenderbar; ein Jahr mit Nummern traegt
   * seine eingefrorene Kopie. Die Vorschau zeigt das erste Jahr, fuer das die
   * Einstellung gilt (`effectiveFromYear`).
   */
  const canEdit = editable && state !== null;
  const effectiveYear = state?.effectiveFromYear ?? year;
  const preview = buildInvoiceNumber(draft, effectiveYear, 1);

  const handleSave = async () => {
    if (!state || saving) return;
    const validation = validateInvoiceNumberFormat(draft);
    if (validation) { setError(validation); return; }
    setSaving(true);
    setError(null);
    try {
      const result = await saveInvoiceNumberFormat(draft, state.rowVersion);
      if (result.outcome === 'ok') {
        setState(result.state);
        setDraft(result.state.format);
        showToast(translate('settings.invoices.number.saved'));
      } else if (result.outcome === 'invalid') {
        setError(result.errorKey as TranslationKey);
      } else if (result.outcome === 'locked') {
        setError('settings.invoices.number.locked');
      } else if (result.outcome === 'forbidden') {
        setError('settings.invoices.readOnly');
      } else if (result.outcome === 'version_conflict') {
        setError('settings.invoices.number.conflict');
        const reloaded = await loadInvoiceNumberFormat();
        if (reloaded.outcome === 'ok') { setState(reloaded.state); setDraft(reloaded.state.format); }
      } else {
        setError('settings.invoices.number.failed');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <fieldset className="form-group settings-form__section" data-testid="settings-invoices-section-number" disabled={!canEdit || saving}>
      <legend className="settings-form__legend">{translate('settings.invoices.number.title')}</legend>
      <p className="hint-text">{translate('settings.invoices.number.hint')}</p>
      {loadError ? (
        <p className="form-error" data-testid="settings-invoices-number-load-error">{translate('settings.invoices.number.failed')} ({loadError})</p>
      ) : null}
      {locked ? (
        <p className="invoice-hint invoice-hint--warning" data-testid="settings-invoices-number-locked">
          {translate('settings.invoices.number.lockedHint').replace('{year}', String(year)).replace('{next}', String(effectiveYear))}
        </p>
      ) : null}

      <div className="form-row">
        <label htmlFor="settings-invoices-number-prefix">{translate('settings.invoices.number.prefix')}</label>
        <input
          id="settings-invoices-number-prefix"
          className="input"
          value={draft.prefix}
          maxLength={INVOICE_NUMBER_PREFIX_MAX_LENGTH}
          placeholder="RE"
          onChange={(event) => setDraft((prev) => ({ ...prev, prefix: event.target.value.toUpperCase() }))}
          data-testid="settings-invoices-number-prefix"
          readOnly={!canEdit}
          disabled={!canEdit}
        />
      </div>
      <div className="form-row">
        <label className="checkbox-row" htmlFor="settings-invoices-number-year">
          <input
            id="settings-invoices-number-year"
            type="checkbox"
            checked={draft.yearInNumber}
            onChange={(event) => setDraft((prev) => ({ ...prev, yearInNumber: event.target.checked }))}
            data-testid="settings-invoices-number-year"
            disabled={!canEdit}
          />
          <span>{translate('settings.invoices.number.yearInNumber')}</span>
        </label>
      </div>
      <div className="form-row">
        <label htmlFor="settings-invoices-number-padding">{translate('settings.invoices.number.padding')}</label>
        <select
          id="settings-invoices-number-padding"
          className="input"
          value={draft.padding}
          onChange={(event) => setDraft((prev) => ({ ...prev, padding: Number(event.target.value) }))}
          data-testid="settings-invoices-number-padding"
          disabled={!canEdit}
        >
          {PADDING_OPTIONS.map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
      </div>
      <p className="hint-text" data-testid="settings-invoices-number-preview">
        {translate('settings.invoices.number.preview')}: <strong>{preview}</strong>
        {locked ? ` (${translate('settings.invoices.number.previewNextYear').replace('{year}', String(effectiveYear))})` : ''}
      </p>
      {state?.lockedYears.length ? (
        <ul className="settings-list" data-testid="settings-invoices-number-locked-years">
          {state.lockedYears.map((entry) => (
            <li key={entry.year}>{entry.year}: {buildInvoiceNumber(entry.format, entry.year, Math.max(entry.lastSequence, 1))}</li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="form-error" data-testid="settings-invoices-number-error">{translate(error)}</p>
      ) : null}
      {canEdit ? (
        <div className="settings-form__actions">
          <Button type="button" disabled={!dirty || saving} loading={saving} onClick={() => void handleSave()} data-testid="settings-invoices-number-save">
            {translate('settings.invoices.number.save')}
          </Button>
        </div>
      ) : null}
    </fieldset>
  );
}
