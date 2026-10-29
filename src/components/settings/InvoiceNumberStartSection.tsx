import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { useApp } from '../../context/AppContext';
import { isSupabaseConfigured } from '../../lib/supabase';
import {
  getCurrentInvoiceYear,
  getInvoiceNumberSequenceSnapshot,
  getNextInvoiceNumberPreview,
  hydrateInvoiceNumberSequence,
  isInvoiceNumberFormatLockedForYear,
} from '../../services/invoiceNumberService';
import { invoiceNumberRangeErrorKey } from '../../services/invoice/invoiceNumberRangeErrors';
import { WorkspaceInvoiceCloudError, rpcSetWorkspaceInvoiceNumberStart } from '../../services/invoice/workspaceInvoiceCloudService';
import { buildPersistedStateSnapshot, persistAll } from '../../services/persistenceService';
import { resolveCloudWorkspaceId } from '../../services/workspace/workspaceSyncPayloadService';
import type { TranslationKey } from '../../i18n';

/**
 * EINRICHTUNG-01 (AP6; Vertrag 1.21, V-07; Z-F5) — Startnummer des Rechnungskreises für das laufende Jahr.
 *
 * Verbindlich ist der FINANZ-CORE-01A-RPC `set_workspace_invoice_number_start` (unverändert). Er setzt die zuletzt
 * vergebene Nummer nur für ein Jahr, in dem noch keine Nummer vergeben und noch keine Startnummer gesetzt ist; sonst
 * weist er mit `invoice_number_start_locked` ab. Die Oberfläche folgt genau dem Server: Sie sperrt, sobald im Jahr eine
 * Rechnungsnummer vergeben ist, und übernimmt eine Abweisung als Sperre mit Erklärung („Der Nummernkreis ist in
 * Benutzung“). Im lokalen Betrieb ohne Cloud gilt dieselbe Regel für den Zähler auf diesem Gerät.
 */
export interface InvoiceNumberStartSectionProps {
  editable: boolean;
  /** EINRICHTUNG-01 (AP8; 1.27) — von der Seite übernommener Entwurf („Fortsetzen“). */
  resumeText?: string | null;
  /** Meldet der Seite die Eingabe und ob sie vom Ausgangsstand abweicht. */
  onTextChange?: (text: string, dirty: boolean) => void;
}

/** Der Ausgangsstand des Felds: die zuletzt vergebene Nummer des laufenden Jahres, sonst leer. */
export function initialInvoiceNumberStartText(): string {
  const year = getCurrentInvoiceYear();
  const sequence = getInvoiceNumberSequenceSnapshot();
  return sequence.year === year && sequence.lastIssuedNumber > 0 ? String(sequence.lastIssuedNumber) : '';
}

type Info = { tone: 'ok' | 'error' | 'info'; key: TranslationKey } | null;

export function InvoiceNumberStartSection({ editable, resumeText = null, onTextChange }: InvoiceNumberStartSectionProps) {
  const { translate } = useApp();
  const year = getCurrentInvoiceYear();
  const [lockedByServer, setLockedByServer] = useState(false);
  const issuedThisYear = isInvoiceNumberFormatLockedForYear(year);
  const locked = issuedThisYear || lockedByServer;
  const [ausgang, setAusgang] = useState(() => initialInvoiceNumberStartText());
  const [text, setText] = useState(ausgang);
  useEffect(() => {
    if (resumeText !== null) setText(resumeText);
  }, [resumeText]);
  useEffect(() => {
    onTextChange?.(text, text !== ausgang);
  }, [text, ausgang, onTextChange]);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<Info>(null);
  const [preview, setPreview] = useState(() => getNextInvoiceNumberPreview());

  const canEdit = editable && !locked;

  const applyLocally = (lastSequence: number) => {
    hydrateInvoiceNumberSequence({ ...getInvoiceNumberSequenceSnapshot(), year, lastIssuedNumber: lastSequence });
    persistAll();
    setPreview(getNextInvoiceNumberPreview());
    // Gespeichert: der neue Ausgangsstand (kein Entwurf mehr).
    setAusgang(String(lastSequence));
    setText(String(lastSequence));
  };

  const handleSave = async () => {
    if (!canEdit || busy) return;
    const raw = text.trim();
    if (!/^\d{1,8}$/.test(raw)) {
      setInfo({ tone: 'error', key: 'settings.numberRanges.start.invalid' });
      return;
    }
    const lastSequence = Number(raw);
    setBusy(true);
    setInfo(null);
    try {
      if (!isSupabaseConfigured()) {
        applyLocally(lastSequence);
        setInfo({ tone: 'ok', key: 'settings.numberRanges.start.saved' });
        return;
      }
      let workspaceId = '';
      try {
        workspaceId = resolveCloudWorkspaceId(buildPersistedStateSnapshot()).trim();
      } catch {
        workspaceId = '';
      }
      if (!workspaceId) {
        setInfo({ tone: 'error', key: 'settings.numberRanges.error.failed' });
        return;
      }
      const result = await rpcSetWorkspaceInvoiceNumberStart({ workspaceId, year, lastSequence });
      applyLocally(result.lastSequence);
      setInfo({ tone: result.applied ? 'ok' : 'info', key: result.applied ? 'settings.numberRanges.start.saved' : 'settings.numberRanges.start.unchanged' });
    } catch (error) {
      const detail = error instanceof WorkspaceInvoiceCloudError ? `${error.code} ${error.message}` : error instanceof Error ? error.message : '';
      const key = invoiceNumberRangeErrorKey(detail);
      if (key === 'settings.numberRanges.error.locked') setLockedByServer(true);
      setInfo({ tone: 'error', key });
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="form-group settings-form__section" data-testid="settings-number-ranges-section-start" disabled={!canEdit || busy}>
      <legend className="settings-form__legend">{translate('settings.numberRanges.start.title')}</legend>
      <p className="hint-text">{translate('settings.numberRanges.start.hint').replace('{year}', String(year))}</p>
      {locked ? (
        <p className="invoice-hint invoice-hint--warning" role="status" data-testid="settings-number-ranges-start-locked">
          {translate('settings.numberRanges.start.locked')}
        </p>
      ) : null}
      <div className="settings-form__field">
        <label htmlFor="settings-number-ranges-start">{translate('settings.numberRanges.start.label')}</label>
        <input
          id="settings-number-ranges-start"
          className="input settings-invoices__number"
          type="text"
          inputMode="numeric"
          maxLength={8}
          value={text}
          readOnly={!canEdit}
          disabled={!canEdit}
          onChange={(event) => {
            setText(event.target.value);
            setInfo(null);
          }}
          data-testid="settings-number-ranges-start"
        />
      </div>
      <p className="hint-text" data-testid="settings-number-ranges-next">
        {translate('settings.numberRanges.next')}: <strong>{preview}</strong>
      </p>
      {info ? (
        <p
          className={info.tone === 'error' ? 'form-error' : 'hint-text'}
          role={info.tone === 'error' ? 'alert' : 'status'}
          data-testid="settings-number-ranges-start-info"
        >
          {translate(info.key)}
        </p>
      ) : null}
      {canEdit ? (
        <div className="settings-form__actions">
          <Button type="button" loading={busy} disabled={busy || !text.trim()} onClick={() => void handleSave()} data-testid="settings-number-ranges-start-save">
            {translate('settings.numberRanges.start.save')}
          </Button>
        </div>
      ) : null}
    </fieldset>
  );
}
