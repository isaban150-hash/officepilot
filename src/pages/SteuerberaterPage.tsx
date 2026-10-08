import { useMemo, useState } from 'react';
import { Button } from '../components/ui/Button';
import { PageHeader, StatusBadge } from '../components/ui/Card';
import { RowList, RowListItem } from '../components/ui/Lists';
import { Page } from '../components/ui/Page';
import { DetailSection } from '../components/ui/Section';
import { SteuerberaterEmployeePaymentsSection } from '../components/employee/SteuerberaterEmployeePaymentsSection';
import { AccountingChecklistPanel } from '../components/accounting/AccountingChecklistPanel';
import { getAccountingChecklist } from '../services/accounting/accountingOverviewService';
import { AccountingPeriodPanel } from '../components/accounting/AccountingPeriodPanel';
import { getAccountingPeriodState } from '../services/accounting/accountingPeriodService';
import { AccountingExportPanel } from '../components/accounting/AccountingExportPanel';
import { SteuerberaterHandoverPanel } from '../components/accounting/SteuerberaterHandoverPanel';
import { evaluateAccountingExportReadiness } from '../services/accounting/accountingExportGateService';
import { exportAccountingPackage } from '../services/accounting/accountingExportRunner';
import { Select } from '../components/ui/Select';
import { ReadOnlyNotice } from '../components/ui/ReadOnlyNotice';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { isSupabaseConfigured } from '../lib/supabase';
import { resolveWorkspaceWriteAccess } from '../services/workspace/workspaceRoleService';
import type { TranslationKey } from '../i18n';
import {
  buildMonthKeyOptions,
  getDefaultSteuerberaterMonthKey,
  getSteuerberaterMonthOverview,
} from '../services/steuerberaterOverviewService';

type FlowStep = 'overview' | 'review';

/*
 * P0/P1-INTEGRITAET 01B / P3 — es gibt genau einen Exportweg: die Übergabe aus
 * STEUERBERATER-06C (`AccountingExportPanel` → `exportAccountingPackage`),
 * die den gültigen Monatsabschluss verlangt und das Gate beim Klick erneut
 * prüft. Der frühere Monatsmappen-Export im Seitenkopf lief an diesem Gate
 * vorbei und ist entfernt. „Monatsmappe vorbereiten" zeigt weiterhin nur die
 * Belegübersicht; ein Mitglied ohne Finanzrecht sieht keinen Export.
 */

export function SteuerberaterPage() {
  const { translate, language } = useApp();
  /* 01B — natürliche Ein-/Mehrzahl ohne Klammerformen. */
  const countLabel = (count: number, one: TranslationKey, many: TranslationKey): string =>
    count === 1 ? translate(one) : translate(many).replace('{count}', String(count));
  const { user } = useAuth();
  const locale = language === 'tr' ? 'tr-TR' : 'de-DE';
  const defaultMonthKey = useMemo(() => getDefaultSteuerberaterMonthKey(), []);
  const monthOptions = useMemo(() => buildMonthKeyOptions(24), []);
  const financeAccess = useMemo(
    () => resolveWorkspaceWriteAccess({ userId: user?.id, cloudConfigured: isSupabaseConfigured() }),
    [user?.id],
  );

  const [selectedMonthKey, setSelectedMonthKey] = useState(defaultMonthKey);
  /* STEUERBERATER-06B — laesst den Monatsstand neu ableiten; kein zweiter Bestand. */
  const [periodToken, setPeriodToken] = useState(0);
  /* 02B-FINAL — das letzte Exportergebnis überlebt den Neuaufbau des Panels. */
  const [exportFeedback, setExportFeedback] = useState<{ monthKey: string; fileName: string | null } | null>(null);
  const [step, setStep] = useState<FlowStep>('overview');

  const overview = useMemo(
    () => getSteuerberaterMonthOverview(new Date(), locale, selectedMonthKey),
    // 02B — der Übergabestatus folgt Abschluss und Export (`periodToken`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedMonthKey, locale, periodToken],
  );

  const formatOptionLabel = (monthKey: string) =>
    getSteuerberaterMonthOverview(new Date(), locale, monthKey).monthLabel;

  return (
    <Page className="steuerberater-page" testId="steuerberater-page">
      {/*
        * UIUX-FOUNDATION-01F — Monatsmappe: Header mit Monatsstatus und einer
        * Hauptaktion je Schritt, Sections statt Card-Stapel. Exportlogik unverändert.
        */}
      <PageHeader
        title={translate('steuerberater.title')}
        subtitle={translate('steuerberater.subtitle')}
        status={
          /* REAL-PRODUCT-TEST-01B — drei Zustände aus dem kanonischen Monatsmodell: keine Belege / offen / vollständig. */
          <StatusBadge
            tone={overview.state === 'ready' ? 'success' : overview.state === 'empty' ? 'neutral' : 'warning'}
            label={
              overview.state === 'ready'
                ? translate('steuerberater.status.complete')
                : overview.state === 'empty'
                  ? translate('steuerberater.status.empty')
                  : overview.openCount === 1
                    ? translate('steuerberater.status.openOne')
                    : translate('steuerberater.status.open').replace('{count}', String(overview.openCount))
            }
            data-testid="steuerberater-month-status"
          />
        }
        primaryAction={
          step === 'overview' ? (
            <Button data-testid="steuerberater-prepare-folder" onClick={() => setStep('review')}>
              {translate('steuerberater.prepareFolderButton')}
            </Button>
          ) : undefined
        }
      />

      <section className="steuerberater-month-select" data-testid="steuerberater-month-select">
        <Select
          id="steuerberater-month"
          label={translate('steuerberater.monthSelect')}
          helperText={overview.isDefaultMonth ? translate('steuerberater.defaultMonthHint').replace('{month}', overview.monthLabel) : undefined}
          value={selectedMonthKey}
          onChange={(e) => {
            setSelectedMonthKey(e.target.value);
            setStep('overview');
          }}
          data-testid="steuerberater-month-input"
        >
          {monthOptions.map((key) => (
            <option key={key} value={key}>
              {formatOptionLabel(key)}
              {key === defaultMonthKey ? ` (${translate('steuerberater.recommended')})` : ''}
            </option>
          ))}
        </Select>
        {overview.isDefaultMonth ? <span className="sr-only" data-testid="steuerberater-default-month" /> : null}
      </section>

      <DetailSection
        title={overview.monthLabel}
        /*
         * BLOCK 2 — Zahlungen gehören in die Monatsbeschreibung.
         *
         * Ohne sie stand „Noch keine Belege" über einem Monat, dessen
         * Übergabepaket eine echte Zahlungszeile enthielt. Eine Zahlung
         * wird dabei nicht zum Beleg — sie wird nur genannt.
         */
        description={
          overview.documentCount === 0
            ? overview.paymentCount === 0
              ? translate('steuerberater.noDocuments')
              : overview.paymentCount === 1
                ? translate('steuerberater.noDocumentsButPaymentsOne')
                : translate('steuerberater.noDocumentsButPayments').replace(
                    '{count}',
                    String(overview.paymentCount),
                  )
            : [
                overview.documentCount === 1
                  ? translate('steuerberater.documentCountOne')
                  : translate('steuerberater.documentCount').replace('{count}', String(overview.documentCount)),
                countLabel(overview.invoiceCount, 'steuerberater.count.invoiceOne', 'steuerberater.count.invoiceMany'),
                countLabel(overview.expenseCount, 'steuerberater.count.expenseOne', 'steuerberater.count.expenseMany'),
                countLabel(overview.stornoCount, 'steuerberater.count.stornoOne', 'steuerberater.count.stornoMany'),
                countLabel(overview.paymentCount, 'steuerberater.count.paymentOne', 'steuerberater.count.paymentMany'),
              ].join(' · ')
        }
        surface
        testId="steuerberater-month"
      >
        <span className="sr-only">{overview.monthLabel}</span>
      </DetailSection>

      {/* P1 MITARBEITERZAHLUNGEN — eigener, neutraler Bereich; nur mit Finanzrecht. */}
      {financeAccess.canWrite ? (
        <SteuerberaterEmployeePaymentsSection
          key={`${selectedMonthKey}:${periodToken}`}
          monthKey={selectedMonthKey}
          translate={translate}
        />
      ) : null}

      {/*
        * STEUERBERATER-06A — der Kontierungsstand des gewaehlten Monats.
        * Bei jedem Rendern frisch abgeleitet; nichts davon ist festgeschrieben.
        */}
      <DetailSection
        title={translate('accounting.overview.title')}
        testId="steuerberater-accounting"
      >
        <AccountingChecklistPanel
          checklist={getAccountingChecklist(selectedMonthKey)}
          translate={translate}
        />
      </DetailSection>

      {/*
        * STEUERBERATER-06B — der Monatsabschluss.
        *
        * Eigener Abschnitt nach dem Kontierungsstand: Erst sieht der Nutzer,
        * was fehlt, dann entscheidet er. `periodToken` laesst den Stand nach
        * jeder Aktion neu ableiten — gespeichert wird hier nichts.
        */}
      <DetailSection
        title={translate('accountingPeriod.title')}
        testId="steuerberater-period"
      >
        <AccountingPeriodPanel
          key={`${selectedMonthKey}:${periodToken}`}
          state={getAccountingPeriodState(selectedMonthKey)}
          monthLabel={overview.monthLabel}
          onChanged={() => setPeriodToken((value) => value + 1)}
          translate={translate}
          closedBy={user?.id}
        />
      </DetailSection>

      {/*
        * STEUERBERATER-06C — die Uebergabe.
        *
        * Nach dem Abschluss, weil sie ihn voraussetzt. Derselbe `periodToken`:
        * Wird der Monat abgeschlossen oder wieder geoeffnet, bewertet das Gate
        * sofort neu — und beim Klick selbst noch einmal.
        */}
      <DetailSection
        title={translate('accountingExport.title')}
        testId="steuerberater-export"
      >
        <SteuerberaterHandoverPanel status={overview.handover} translate={translate} />
        <AccountingExportPanel
          key={`${selectedMonthKey}:${periodToken}`}
          readiness={evaluateAccountingExportReadiness(selectedMonthKey)}
          onCreatePackage={async () => {
            const result = await exportAccountingPackage({
              monthKey: selectedMonthKey,
              userId: user?.id,
            });
            const fileName = result.outcome === 'exported' ? result.fileName : null;
            setExportFeedback({ monthKey: selectedMonthKey, fileName });
            setPeriodToken((value) => value + 1);
            return fileName;
          }}
          translate={translate}
          canExport={financeAccess.canWrite}
          lastResult={exportFeedback?.monthKey === selectedMonthKey ? exportFeedback : null}
        />
      </DetailSection>

      {step === 'review' ? (
        <>
          <DetailSection title={translate('steuerberater.documentsIncluded')} testId="steuerberater-documents">
            {overview.documents.length === 0 ? (
              <p className="detail-empty">
                {overview.paymentCount === 0
                  ? translate('steuerberater.noDocuments')
                  : overview.paymentCount === 1
                    ? translate('steuerberater.noDocumentsButPaymentsOne')
                    : translate('steuerberater.noDocumentsButPayments').replace(
                        '{count}',
                        String(overview.paymentCount),
                      )}
              </p>
            ) : (
              <RowList>
                {overview.documents.map((doc) => (
                  <RowListItem key={doc.entryKey} to={doc.route} icon="file" title={doc.title} description={doc.kind} />
                ))}
              </RowList>
            )}
          </DetailSection>

          {overview.missingItems.length > 0 ? (
            <DetailSection title={translate('steuerberater.missingTitle')} testId="steuerberater-missing">
              <RowList>
                {overview.missingItems.map((item) => (
                  <RowListItem key={item.id} icon="warning" title={item.title} trailing={<StatusBadge tone="warning" label={translate('steuerberater.missingTitle')} icon={false} />} />
                ))}
              </RowList>
            </DetailSection>
          ) : null}

          {!financeAccess.canWrite ? (
            <section data-testid="steuerberater-export-section">
              <ReadOnlyNotice message={translate('steuerberater.export.forbidden')} testId="steuerberater-export-forbidden" />
            </section>
          ) : null}

          {overview.unclearDocuments.length > 0 ? (
            <DetailSection title={translate('steuerberater.unclearTitle')} testId="steuerberater-unclear">
              <RowList>
                {overview.unclearDocuments.map((doc) => (
                  <RowListItem key={doc.entryKey} to={doc.route} icon="info" title={doc.title} trailing={<StatusBadge tone="info" label={translate('steuerberater.unclearTitle')} icon={false} />} />
                ))}
              </RowList>
            </DetailSection>
          ) : null}

        </>
      ) : null}

      <DetailSection title={translate('steuerberater.categoriesTitle')} className="steuerberater-categories" testId="steuerberater-categories">
        <ul className="steuerberater-categories__list">
          <li>{translate('steuerberater.cat.incoming')}</li>
          <li>{translate('steuerberater.cat.outgoing')}</li>
          <li>{translate('steuerberater.cat.fuel')}</li>
          <li>{translate('steuerberater.cat.hotel')}</li>
          <li>{translate('steuerberater.cat.credit')}</li>
          <li>{translate('steuerberater.cat.bank')}</li>
          <li>{translate('steuerberater.cat.tax')}</li>
        </ul>
        <p className="steuerberater-categories__hint">{translate('steuerberater.autoSortHint')}</p>
      </DetailSection>
    </Page>
  );
}
