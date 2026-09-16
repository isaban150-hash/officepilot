import { useMemo } from 'react';
import { NavGroupList } from '../components/layout/NavGroupList';
import { FINANZEN_HUB_GROUPS } from '../components/layout/navConfig';
import { PageHeader } from '../components/ui/Card';
import { MoneyDisplay } from '../components/ui/Display';
import { KpiRow, KpiTile } from '../components/ui/Kpi';
import { Page } from '../components/ui/Page';
import { useApp } from '../context/AppContext';
import { getAllExpenseOverview, summarizeExpenseOverview } from '../services/expenseOverviewService';
import { getAllInvoiceOverview, summarizeInvoiceOverview } from '../services/invoiceOverviewService';
import { getSteuerberaterMonthOverview } from '../services/steuerberaterOverviewService';

/**
 * UIUX-FOUNDATION-01C — Finanzen-Hub.
 *
 * Bündelt die bereits vorhandenen Finanzbereiche (Ausgaben, offene Ausgaben,
 * offene Rechnungen, Steuerberater-Monatsmappe) unter einem Hauptbereich.
 *
 * VISUAL-POLISH-01C — darüber die Zahlungssituation auf einen Blick: offene
 * Forderungen, überfällig, offene Ausgaben, Steuerberater-Monat. Reine Anzeige
 * der bestehenden Zusammenfassungen (keine neue Aggregation, keine
 * Buchführungslogik).
 */
export function FinanzenPage() {
  const { translate, language } = useApp();
  const invoices = useMemo(() => summarizeInvoiceOverview(getAllInvoiceOverview()), []);
  const expenses = useMemo(() => summarizeExpenseOverview(getAllExpenseOverview()), []);
  const locale = language === 'tr' ? 'tr-TR' : language === 'bg' ? 'bg-BG' : 'de-DE';
  const tax = useMemo(() => getSteuerberaterMonthOverview(new Date(), locale), [locale]);
  const monthShort = tax.monthLabel.split(' ')[0] ?? tax.monthLabel;

  return (
    <Page className="finanzen-page" testId="finanzen-page">
      <PageHeader title={translate('finanzen.title')} subtitle={translate('finanzen.subtitle')} />
      <KpiRow testId="finanzen-kpis" ariaLabel={translate('finanzen.title')} className="work-kpis work-kpis--4">
        <KpiTile
          to="/rechnungen/offen"
          label={translate('overview.openReceivables')}
          value={<MoneyDisplay value={invoices.openReceivables} />}
          hint={translate('heute.kpi.openInvoicesHint').replace('{count}', String(invoices.openInvoiceCount))}
          testId="finanzen-kpi-receivables"
        />
        <KpiTile
          to="/rechnungen/offen"
          label={translate('overview.overdueReceivables')}
          value={<MoneyDisplay value={invoices.overdueReceivables} />}
          hint={translate('heute.kpi.overdueHint').replace('{count}', String(invoices.overdueInvoiceCount))}
          tone={invoices.overdueInvoiceCount > 0 ? 'critical' : 'neutral'}
          testId="finanzen-kpi-overdue"
        />
        <KpiTile
          to="/ausgaben/offen"
          label={translate('expenseOverview.openLiabilities')}
          value={<MoneyDisplay value={expenses.openLiabilities} />}
          hint={translate('expenseOverview.openExpenseCount') + ': ' + String(expenses.openExpenseCount)}
          tone={expenses.overdueExpenseCount > 0 ? 'warning' : 'neutral'}
          testId="finanzen-kpi-expenses"
        />
        <KpiTile
          to="/steuerberater"
          label={translate('heute.kpi.tax')}
          value={`${tax.completenessPercent} %`}
          hint={monthShort}
          progress={tax.completenessPercent}
          tone={tax.state === 'ready' ? 'positive' : 'neutral'}
          testId="finanzen-kpi-tax"
        />
      </KpiRow>
      <NavGroupList groups={FINANZEN_HUB_GROUPS} testIdPrefix="finanzen" />
    </Page>
  );
}
