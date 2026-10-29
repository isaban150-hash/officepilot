import { useCallback, useState } from 'react';
import { FormResumeOffer } from '../../components/forms/FormResumeOffer';
import { InvoiceNumberFormatSection } from '../../components/settings/InvoiceNumberFormatSection';
import { InvoiceNumberStartSection, initialInvoiceNumberStartText } from '../../components/settings/InvoiceNumberStartSection';
import { SettingsAccessNotice, resolveSettingsNoticeVariant } from '../../components/settings/SettingsAccessNotice';
import { SettingsPageHeader } from '../../components/settings/SettingsPageHeader';
import { useApp } from '../../context/AppContext';
import { useLeaveGuard } from '../../hooks/useLeaveGuard';
import { useResumeOffer } from '../../hooks/useResumeOffer';
import { useSettingsAccess } from '../../hooks/useSettingsAccess';
import { getInvoiceNumberSequenceSnapshot } from '../../services/invoiceNumberService';
import type { InvoiceNumberFormat } from '../../types/models';
import { SETTINGS_TARGET_PATHS } from './settingsHubConfig';

/**
 * EINRICHTUNG-01 (AP5/AP6; Vertrag 1.15, 1.21) — „Dokumente und Zahlungen › Nummernkreise“.
 *
 * Format und Startnummer der Rechnungsnummern über die FINANZ-CORE-01A-RPCs, unverändert. Der Nummernkreis ist eine
 * cloudbestätigte Einstellung (1.16): ohne bestätigte Rechte oder ohne Verbindung gesperrt, mit „Rechte nicht
 * bestätigt“. Ohne Schreibrecht bleibt alles lesbar, mit dem einheitlichen Hinweis.
 *
 * EINRICHTUNG-01 (AP8; 1.27) — ein Entwurf für beide Abschnitte (je Konto und Betrieb über die UI-Sitzung): bei Rückkehr
 * „Fortsetzen“ oder „Verwerfen“; Rückfrage beim Verlassen, solange etwas ungespeichert ist. Ausgangsstand des Formats ist
 * der lokal bekannte Cloud-Stand; die Versionsprüfung beim Speichern bleibt die Sperre gegen das Überschreiben.
 */
export const NUMBER_RANGE_SETTINGS_ROUTE = SETTINGS_TARGET_PATHS['number-ranges'];

interface NumberRangeDraft {
  start: string;
  prefix: string;
  yearInNumber: boolean;
  padding: number;
}

const DRAFT_FIELDS: readonly (keyof NumberRangeDraft & string)[] = ['start', 'prefix', 'yearInNumber', 'padding'];

function ausgangsstand(): NumberRangeDraft {
  const format = getInvoiceNumberSequenceSnapshot().format;
  return {
    start: initialInvoiceNumberStartText(),
    prefix: format?.prefix ?? '',
    yearInNumber: format?.yearInNumber ?? true,
    padding: format?.padding ?? 4,
  };
}

export function NumberRangeSettingsPage() {
  const { translate } = useApp();
  const { access, canEdit, canConfirmedAction, cloud } = useSettingsAccess();
  const variant = resolveSettingsNoticeVariant(access);
  const unconfirmed = canEdit && cloud && !canConfirmedAction;
  const editable = canEdit && (!cloud || canConfirmedAction);

  const [saved] = useState(ausgangsstand);
  const [format, setFormat] = useState<{ draft: InvoiceNumberFormat; dirty: boolean } | null>(null);
  const [start, setStart] = useState<{ text: string; dirty: boolean }>({ text: saved.start, dirty: false });
  const [uebernahme, setUebernahme] = useState<{ format: Partial<InvoiceNumberFormat> | null; start: string | null }>({ format: null, start: null });

  // Gemeldet wird nur, was tatsächlich geändert ist; ungeladene Abschnitte zählen mit ihrem Ausgangsstand.
  const current: NumberRangeDraft = {
    start: start.dirty ? start.text : saved.start,
    prefix: format?.dirty ? format.draft.prefix : saved.prefix,
    yearInNumber: format?.dirty ? format.draft.yearInNumber : saved.yearInNumber,
    padding: format?.dirty ? format.draft.padding : saved.padding,
  };
  const offer = useResumeOffer<NumberRangeDraft>({ namespace: 'number-ranges', fields: DRAFT_FIELDS, saved, current, workspaceType: 'other' });
  useLeaveGuard(editable && (start.dirty || Boolean(format?.dirty)), true);

  const onFormatChange = useCallback((draft: InvoiceNumberFormat, dirty: boolean) => setFormat({ draft, dirty }), []);
  const onStartChange = useCallback((text: string, dirty: boolean) => setStart({ text, dirty }), []);

  return (
    <div className="page settings-page settings-subpage" data-testid="settings-number-ranges-page">
      <SettingsPageHeader target="number-ranges" subtitle={translate('settings.numberRanges.page.subtitle')} />
      {variant ? <SettingsAccessNotice variant={variant} testId="settings-number-ranges-readonly" /> : null}
      {unconfirmed ? <SettingsAccessNotice variant="unconfirmed" testId="settings-number-ranges-unconfirmed" /> : null}
      {editable ? (
        <FormResumeOffer
          pending={offer.pending}
          stale={offer.stale}
          onContinue={() => {
            const werte = offer.continueDraft();
            const formatTeil: Partial<InvoiceNumberFormat> = {};
            if (werte.prefix !== undefined) formatTeil.prefix = werte.prefix;
            if (werte.yearInNumber !== undefined) formatTeil.yearInNumber = werte.yearInNumber;
            if (werte.padding !== undefined) formatTeil.padding = werte.padding;
            setUebernahme({ format: Object.keys(formatTeil).length > 0 ? formatTeil : null, start: werte.start ?? null });
          }}
          onDiscard={offer.discardDraft}
          onDismissStale={offer.dismissStale}
          testIdPrefix="settings-number-ranges"
        />
      ) : null}
      <InvoiceNumberFormatSection editable={editable} resumeDraft={uebernahme.format} onDraftChange={onFormatChange} />
      <InvoiceNumberStartSection editable={editable} resumeText={uebernahme.start} onTextChange={onStartChange} />
    </div>
  );
}
