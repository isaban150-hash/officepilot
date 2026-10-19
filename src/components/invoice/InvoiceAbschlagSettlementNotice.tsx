/**
 * FINANZ-CORE-01A (WEISS-Nacharbeit N02/D1) — welche abgezogenen Abschläge noch nicht
 * beglichen sind, sichtbar vor der Freigabe der Schlussrechnung.
 *
 * Die Freigabeprüfung meldet nur „ein Abschlag ist nicht bezahlt". Hier steht, welcher
 * es ist und wie viel offen ist — und was der Nutzer tun kann.
 */
import type { TranslationKey } from '../../i18n';
import type { AbschlagSettlement } from '../../services/invoice/abschlagSettlement';
import { formatEuroAmount } from '../../utils/displayFormat';
import { InlineNotice } from '../ui/States';

interface Props {
  unsettled: readonly AbschlagSettlement[];
  translate: (key: TranslationKey) => string;
}

export function InvoiceAbschlagSettlementNotice({ unsettled, translate }: Props) {
  if (unsettled.length === 0) return null;
  return (
    <InlineNotice
      tone="warning"
      title={translate('invoice.abschlagUnsettled.title')}
      testId="invoice-abschlag-unsettled"
    >
      <ul className="invoice-abschlag-unsettled__list">
        {unsettled.map((entry) => (
          <li key={entry.invoiceId} data-testid={`invoice-abschlag-unsettled-${entry.invoiceId}`}>
            {[
              entry.abschlagNumber
                ? translate('invoice.abschlagUnsettled.label').replace('{number}', String(entry.abschlagNumber))
                : translate('invoice.abschlagUnsettled.labelPlain'),
              entry.invoiceNumber,
              translate('invoice.abschlagUnsettled.open').replace('{amount}', formatEuroAmount(entry.open)),
              entry.skontoUnclear ? translate('invoice.abschlagUnsettled.skontoUnclear') : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </li>
        ))}
      </ul>
      <p>{translate('invoice.abschlagUnsettled.hint')}</p>
      {unsettled.some((entry) => entry.skontoUnclear) ? (
        <p data-testid="invoice-abschlag-skonto-unclear">{translate('invoice.abschlagUnsettled.skontoUnclearHint')}</p>
      ) : null}
    </InlineNotice>
  );
}
