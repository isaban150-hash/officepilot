import { Card, DataRow } from '../ui/Card';
import type { TranslationKey } from '../../i18n';
import { buildVorgangBillingPreparationView } from '../../services/contractBillingPreparationService';
import type { Vorgang } from '../../types/models';

interface VorgangBillingPreparationPanelProps {
  vorgang: Vorgang;
  translate: (key: TranslationKey) => string;
}

export function VorgangBillingPreparationPanel({
  vorgang,
  translate,
}: VorgangBillingPreparationPanelProps) {
  const view = buildVorgangBillingPreparationView(vorgang);
  if (!view) return null;

  return (
    <section className="section vorgang-billing-prep" data-testid="vorgang-billing-prep">
      <h2 className="section__title">{translate('vorgang.billingPrep.title')}</h2>
      <Card>
        <DataRow
          label={translate('vorgang.billingPrep.progressBilling')}
          value={
            view.progressBillingAllowed
              ? translate('vorgang.billingPrep.yes')
              : translate('vorgang.billingPrep.no')
          }
        />
        {view.progressBillingRule ? (
          <DataRow
            label={translate('vorgang.billingPrep.progressRule')}
            value={view.progressBillingRule}
          />
        ) : null}
        {view.paymentDue ? (
          <DataRow
            label={translate('vorgang.billingPrep.paymentDue')}
            value={view.paymentDue}
          />
        ) : null}
        {view.skonto ? (
          <DataRow
            label={translate('vorgang.billingPrep.skonto')}
            value={view.skonto}
          />
        ) : null}
        <DataRow
          label={translate('vorgang.billingPrep.finalInvoice')}
          value={
            view.finalInvoicePlanned
              ? translate('vorgang.billingPrep.yes')
              : translate('vorgang.billingPrep.no')
          }
        />
        {view.paymentTermsSummary ? (
          <DataRow
            label={translate('vorgang.billingPrep.termsSummary')}
            value={view.paymentTermsSummary}
          />
        ) : null}
        {view.otherTerms.map((term) => (
          <DataRow
            key={term}
            label={translate('vorgang.billingPrep.otherTerm')}
            value={term}
          />
        ))}
      </Card>
    </section>
  );
}
