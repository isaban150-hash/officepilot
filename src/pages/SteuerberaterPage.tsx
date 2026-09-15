import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { Card, CardMeta, CardTitle, PageHeader } from '../components/ui/Card';
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
    <div className="page steuerberater-page" data-testid="steuerberater-page">
      <PageHeader
        title={translate('steuerberater.title')}
        subtitle={translate('steuerberater.subtitle')}
      />

      <section className="steuerberater-month-select" data-testid="steuerberater-month-select">
        <label className="steuerberater-month-select__label" htmlFor="steuerberater-month">
          {translate('steuerberater.monthSelect')}
        </label>
        <select
          id="steuerberater-month"
          className="input steuerberater-month-select__input"
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
        </select>
        {overview.isDefaultMonth ? (
          <p className="steuerberater-month-select__hint" data-testid="steuerberater-default-month">
            {translate('steuerberater.defaultMonthHint').replace('{month}', overview.monthLabel)}
          </p>
        ) : null}
      </section>

      <section data-testid="steuerberater-month">
        <Card className="steuerberater-month-card">
          <CardTitle>{overview.monthLabel}</CardTitle>
          <CardMeta>
            {overview.isComplete
              ? translate('steuerberater.status.complete')
              : translate('steuerberater.status.missing').replace('{count}', String(overview.missingCount))}
          </CardMeta>
          <p className="steuerberater-month-card__count">
            {translate('steuerberater.documentCount').replace('{count}', String(overview.documentCount))}
          </p>
        </Card>
      </section>

      {step === 'overview' ? (
        <section className="steuerberater-actions" data-testid="steuerberater-actions">
          <Button
            fullWidth
            size="lg"
            data-testid="steuerberater-prepare-folder"
            onClick={() => setStep('review')}
          >
            {translate('steuerberater.prepareFolderButton')}
          </Button>
        </section>
      ) : null}

      {step === 'review' || step === 'exported' ? (
        <>
          <section className="section" data-testid="steuerberater-documents">
            <h2 className="section__title">{translate('steuerberater.documentsIncluded')}</h2>
            {overview.documents.length === 0 ? (
              <p className="steuerberater-empty">{translate('steuerberater.noDocuments')}</p>
            ) : (
              <div className="card-list">
                {overview.documents.map((doc) => (
                  <Link key={doc.id} to={`/ablage/${doc.id}`} className="card-link">
                    <Card>
                      <CardTitle>{doc.title}</CardTitle>
                      <CardMeta>{doc.kind}</CardMeta>
                    </Card>
                  </Link>
                ))}
              </div>
            )}
          </section>

          {overview.missingItems.length > 0 ? (
            <section className="section" data-testid="steuerberater-missing">
              <h2 className="section__title">{translate('steuerberater.missingTitle')}</h2>
              <ul className="steuerberater-mark-list">
                {overview.missingItems.map((item) => (
                  <li key={item.id} className="steuerberater-mark-list__item steuerberater-mark-list__item--missing">
                    ⚠ {item.title}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {overview.unclearDocuments.length > 0 ? (
            <section className="section" data-testid="steuerberater-unclear">
              <h2 className="section__title">{translate('steuerberater.unclearTitle')}</h2>
              <ul className="steuerberater-mark-list">
                {overview.unclearDocuments.map((doc) => (
                  <li key={doc.id} className="steuerberater-mark-list__item steuerberater-mark-list__item--unclear">
                    <Link to={`/ablage/${doc.id}`}>? {doc.title}</Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {step === 'review' || step === 'exported' ? (
            <section className="steuerberater-actions" data-testid="steuerberater-export-section">
              {financeAccess.canWrite ? (
                <Button
                  fullWidth
                  size="lg"
                  disabled={isExporting}
                  data-testid="steuerberater-export-button"
                  onClick={() => void handleExport()}
                >
                  {translate('steuerberater.exportButton')}
                </Button>
              ) : (
                <p className="steuerberater-empty" data-testid="steuerberater-export-forbidden">
                  {translate('steuerberater.export.forbidden')}
                </p>
              )}
            </section>
          ) : null}

          {exportResult && exportResult.outcome !== 'exported' ? (
            <Card className="steuerberater-export-result" data-testid={`steuerberater-export-${exportResult.outcome}`}>
              <CardTitle>{translate(EXPORT_OUTCOME_KEY[exportResult.outcome])}</CardTitle>
              {exportResult.outcome === 'document_load_failed' ? (
                <ul className="steuerberater-mark-list">
                  {exportResult.failed.map((entry) => (
                    <li key={`${entry.id}-${entry.fileName}`} className="steuerberater-mark-list__item steuerberater-mark-list__item--missing">
                      ⚠ {entry.belegnummer || entry.id} · {entry.fileName} · {entry.detail}
                    </li>
                  ))}
                </ul>
              ) : 'detail' in exportResult && exportResult.detail ? (
                <CardMeta>{exportResult.detail}</CardMeta>
              ) : null}
            </Card>
          ) : null}

          {step === 'exported' && exportResult?.outcome === 'exported' ? (
            <Card className="steuerberater-export-result" data-testid="steuerberater-export-result">
              <CardTitle>{translate('steuerberater.packageReady')}</CardTitle>
              <CardMeta>{translate('steuerberater.packageReadyDesc').replace('{month}', overview.monthLabel)}</CardMeta>
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
                      ⚠ {translate('steuerberater.export.missingDocument')} · {entry.belegnummer || entry.id}
                    </li>
                  ))}
                </ul>
              ) : null}
              {exportResult.summary.stornosOhneDatum.length > 0 ? (
                <ul className="steuerberater-mark-list" data-testid="steuerberater-export-stornos-ohne-datum">
                  {exportResult.summary.stornosOhneDatum.map((entry) => (
                    <li key={entry.id} className="steuerberater-mark-list__item steuerberater-mark-list__item--unclear">
                      ? {translate('steuerberater.export.stornoWithoutDate')} · {entry.belegnummer || entry.id}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="steuerberater-no-send" data-testid="steuerberater-no-direct-send">
                {translate('steuerberater.noDirectSend')}
              </p>
            </Card>
          ) : null}
        </>
      ) : null}

      <section className="steuerberater-categories" data-testid="steuerberater-categories">
        <h2 className="section__title">{translate('steuerberater.categoriesTitle')}</h2>
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
      </section>
    </div>
  );
}
