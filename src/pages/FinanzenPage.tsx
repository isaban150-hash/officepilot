import { NavGroupList } from '../components/layout/NavGroupList';
import { FINANZEN_HUB_GROUPS } from '../components/layout/navConfig';
import { PageHeader } from '../components/ui/Card';
import { Page } from '../components/ui/Page';
import { useApp } from '../context/AppContext';

/**
 * UIUX-FOUNDATION-01C — Finanzen-Hub.
 *
 * Bündelt die bereits vorhandenen Finanzbereiche (Ausgaben, offene Ausgaben,
 * offene Rechnungen, Steuerberater-Monatsmappe) unter einem Hauptbereich.
 * Ausschließlich Navigation: keine Kennzahlen, keine Aggregation, keine
 * Buchführungslogik — die kommt in einem eigenen Produktblock.
 */
export function FinanzenPage() {
  const { translate } = useApp();
  return (
    <Page width="narrow" className="finanzen-page" testId="finanzen-page">
      <PageHeader title={translate('finanzen.title')} subtitle={translate('finanzen.subtitle')} />
      <NavGroupList groups={FINANZEN_HUB_GROUPS} testIdPrefix="finanzen" />
    </Page>
  );
}
