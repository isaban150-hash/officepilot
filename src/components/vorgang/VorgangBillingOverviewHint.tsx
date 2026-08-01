import { Card } from '../ui/Card';
import type { TranslationKey } from '../../i18n';
import { buildVorgangBillingPreparationView } from '../../services/contractBillingPreparationService';
import type { Vorgang } from '../../types/models';

interface VorgangBillingOverviewHintProps {
  vorgang: Vorgang;
  translate: (key: TranslationKey) => string;
  onOpenInvoices: () => void;
}

/**
 * UI-VALIDIERUNG-01 — no duplicate Abrechnung block on overview.
 * Points users to the Rechnungen tab where the full prep panel lives.
 */
export function VorgangBillingOverviewHint({
  vorgang,
  translate,
  onOpenInvoices,
}: VorgangBillingOverviewHintProps) {
  const view = buildVorgangBillingPreparationView(vorgang);
  if (!view) return null;

  return (
    <section className="section vorgang-billing-hint" data-testid="vorgang-billing-overview-hint">
      <h2 className="section__title">{translate('vorgang.billingPrep.title')}</h2>
      <Card>
        <p className="vorgang-billing-hint__text">{translate('vorgang.billingPrep.overviewHint')}</p>
        <button
          type="button"
          className="link-button"
          data-testid="vorgang-billing-open-invoices"
          onClick={onOpenInvoices}
        >
          {translate('vorgang.section.invoices')}
        </button>
      </Card>
    </section>
  );
}
