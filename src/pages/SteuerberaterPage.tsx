import { useMemo, useState } from 'react';
import { Button } from '../components/ui/Button';
import { PageHeader, StatusBadge } from '../components/ui/Card';
import { RowList, RowListItem } from '../components/ui/Lists';
import { Page } from '../components/ui/Page';
import { DetailSection } from '../components/ui/Section';
import { InlineNotice, ErrorState } from '../components/ui/States';
import { Select } from '../components/ui/Select';
import { ReadOnlyNotice } from '../components/ui/ReadOnlyNotice';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { isSupabaseConfigured } from '../lib/supabase';
import { resolveWorkspaceWriteAccess } from '../services/workspace/workspaceRoleService';
import { exportMonatsmappe, type MonatsmappeExportResult } from '../services/steuerberater/monatsmappeExportService';
import type { TranslationKey } from '../i18n';
import {
  buildMonthKeyOptions,
  getDefaultSteuerberaterMonthKey,
  getSteuerberaterMonthOverview,
} from '../services/steuerberaterOverviewService';

type FlowStep = 'overview' | 'review' | 'exported';

/*
 * FINANZ-CORE-DURABILITY-01D — der Export ist echt: Modell aus den kanonischen
 * Finanzdaten, ZIP mit Uebersicht.csv/Zahlungen.csv/Belegen, Download. Jeder
 * Ausgang wird benannt; ein Mitglied ohne Finanzrecht sieht keinen Export.
 */
const EXPORT_OUTCOME_KEY: Record<Exclude<MonatsmappeExportResult['outcome'], 'exported'>, TranslationKey> = {
  empty: 'steuerberater.export.empty',
  forbidden: 'steuerberater.export.forbidden',
  invalid_month: 'steuerberater.export.invalidMonth',
  data_unavailable: 'steuerberater.export.dataUnavailable',
  document_load_failed: 'steuerberater.export.documentLoadFailed',
  export_failed: 'steuerberater.export.failed',
};

export function SteuerberaterPage() {
  const { translate, language } = useApp();
  const { user } = useAuth();
  const locale = language === 'tr' ? 'tr-TR' : 'de-DE';
  const defaultMonthKey = useMemo(() => getDefaultSteuerberaterMonthKey(), []);
  const monthOptions = useMemo(() => buildMonthKeyOptions(24), []);
  const financeAccess = useMemo(
    () => resolveWorkspaceWriteAccess({ userId: user?.id, cloudConfigured: isSupabaseConfigured() }),
    [user?.id],
  );

  const [selectedMonthKey, setSelectedMonthKey] = useState(defaultMonthKey);
  const [step, setStep] = useState<FlowStep>('overview');
  const [isExporting, setIsExporting] = useState(false);
  const [exportResult, setExportResult] = useState<MonatsmappeExportResult | null>(null);

  const handleExport = async () => {
    if (isExporting) return;
    setIsExporting(true);
    setExportResult(null);
    try {
      const result = await exportMonatsmappe({ monthKey: selectedMonthKey, userId: user?.id });
      setExportResult(result);
      if (result.outcome === 'exported') setStep('exported');
    } finally {
      setIsExporting(false);
    }
  };

  const overview = useMemo(
    () => getSteuerberaterMonthOverview(new Date(), locale, selectedMonthKey),
    [selectedMonthKey, locale],
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
          <StatusBadge
            tone={overview.isComplete ? 'success' : 'warning'}
            label={
              overview.isComplete
                ? translate('steuerberater.status.complete')
                : translate('steuerberater.status.missing').replace('{count}', String(overview.missingCount))
            }
            data-testid="steuerberater-month-status"
          />
        }
        primaryAction={
          step === 'overview' ? (
            <Button data-testid="steuerberater-prepare-folder" onClick={() => setStep('review')}>
              {translate('steuerberater.prepareFolderButton')}
            </Button>
          ) : financeAccess.canWrite ? (
            <Button disabled={isExporting} data-testid="steuerberater-export-button" onClick={() => void handleExport()}>
              {translate('steuerberater.exportButton')}
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
            setExportResult(null);
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

      <DetailSection title={overview.monthLabel} description={translate('steuerberater.documentCount').replace('{count}', String(overview.documentCount))} surface testId="steuerberater-month">
        <span className="sr-only">{overview.monthLabel}</span>
      </DetailSection>

      {step === 'review' || step === 'exported' ? (
        <>
          <DetailSection title={translate('steuerberater.documentsIncluded')} testId="steuerberater-documents">
            {overview.documents.length === 0 ? (
              <p className="detail-empty">{translate('steuerberater.noDocuments')}</p>
            ) : (
              <RowList>
                {overview.documents.map((doc) => (
                  <RowListItem key={doc.id} to={`/ablage/${doc.id}`} icon="file" title={doc.title} description={doc.kind} />
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

          {overview.unclearDocuments.length > 0 ? (
            <DetailSection title={translate('steuerberater.unclearTitle')} testId="steuerberater-unclear">
              <RowList>
                {overview.unclearDocuments.map((doc) => (
                  <RowListItem key={doc.id} to={`/ablage/${doc.id}`} icon="info" title={doc.title} trailing={<StatusBadge tone="info" label={translate('steuerberater.unclearTitle')} icon={false} />} />
                ))}
              </RowList>
            </DetailSection>
          ) : null}

          {!financeAccess.canWrite ? (
            <section data-testid="steuerberater-export-section">
              <ReadOnlyNotice message={translate('steuerberater.export.forbidden')} testId="steuerberater-export-forbidden" />
            </section>
          ) : null}

          {exportResult && exportResult.outcome !== 'exported' ? (
            <ErrorState
              title={translate(EXPORT_OUTCOME_KEY[exportResult.outcome])}
              description={
                exportResult.outcome === 'document_load_failed' ? (
                  <ul className="steuerberater-mark-list">
                    {exportResult.failed.map((entry) => (
                      <li key={`${entry.id}-${entry.fileName}`}>
                        {entry.belegnummer || entry.id} · {entry.fileName} · {entry.detail}
                      </li>
                    ))}
                  </ul>
                ) : 'detail' in exportResult && exportResult.detail ? (
                  exportResult.detail
                ) : undefined
              }
              testId={`steuerberater-export-${exportResult.outcome}`}
            />
          ) : null}

          {step === 'exported' && exportResult?.outcome === 'exported' ? (
            <InlineNotice tone="success" title={translate('steuerberater.packageReady')} testId="steuerberater-export-result">
              <p>{translate('steuerberater.packageReadyDesc').replace('{month}', overview.monthLabel)}</p>
              <p data-testid="steuerberater-export-summary">
                {translate('steuerberater.export.summary')
                  .replace('{invoices}', String(exportResult.summary.ausgangsrechnungen))
                  .replace('{expenses}', String(exportResult.summary.eingangsbelege))
                  .replace('{stornos}', String(exportResult.summary.stornos))
                  .replace('{payments}', String(exportResult.summary.zahlungen))
                  .replace('{documents}', String(exportResult.summary.dokumente))}
              </p>
              <p className="steuerberater-export-filename">{exportResult.summary.filename}</p>
              {exportResult.summary.fehlendeDokumente.length > 0 ? (
                <ul className="steuerberater-mark-list" data-testid="steuerberater-export-missing-documents">
                  {exportResult.summary.fehlendeDokumente.map((entry) => (
                    <li key={entry.id} className="steuerberater-mark-list__item steuerberater-mark-list__item--missing">
                      {translate('steuerberater.export.missingDocument')} · {entry.belegnummer || entry.id}
                    </li>
                  ))}
                </ul>
              ) : null}
              {exportResult.summary.stornosOhneDatum.length > 0 ? (
                <ul className="steuerberater-mark-list" data-testid="steuerberater-export-stornos-ohne-datum">
                  {exportResult.summary.stornosOhneDatum.map((entry) => (
                    <li key={entry.id} className="steuerberater-mark-list__item steuerberater-mark-list__item--unclear">
                      {translate('steuerberater.export.stornoWithoutDate')} · {entry.belegnummer || entry.id}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="steuerberater-no-send" data-testid="steuerberater-no-direct-send">
                {translate('steuerberater.noDirectSend')}
              </p>
            </InlineNotice>
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
