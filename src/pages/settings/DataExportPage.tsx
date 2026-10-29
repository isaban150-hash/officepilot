import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { SettingsAccessNotice, resolveSettingsNoticeVariant } from '../../components/settings/SettingsAccessNotice';
import { SettingsPageHeader } from '../../components/settings/SettingsPageHeader';
import { Button } from '../../components/ui/Button';
import { useApp } from '../../context/AppContext';
import { useOptionalAuth } from '../../context/AuthContext';
import { useSettingsAccess } from '../../hooks/useSettingsAccess';
import type { TranslationKey } from '../../i18n';
import { createDefaultDataExportDeps } from '../../services/export/dataExportDeps';
import type { DataExportGap, DataExportGapKind } from '../../services/export/dataExportOverview';
import {
  buildAndDownloadDataExport,
  DATA_EXPORT_SIZE_WARNING_BYTES,
  prepareDataExport,
  type DataExportDeps,
  type DataExportFailure,
  type DataExportPrepared,
  type DataExportProgress,
} from '../../services/export/dataExportService';
import { SETTINGS_TARGET_PATHS } from './settingsHubConfig';

/**
 * EINRICHTUNG-01 (AP7; Vertrag 1.24; D-01, D-05 bis D-09) — „Daten › Export“.
 *
 * Inhaber und Admins sowie der lokale Betrieb, auch im Nur-Lesen-Betrieb (Lizenz oder Löschantrag); Mitglieder und eine
 * unbestätigte Rolle sehen nur den Hinweis. Ablauf: Vollständigkeitsprüfung (mit Fortschritt und Abbruch) → Ergebnis als
 * Liste → „Export erstellen“ bzw. „Export mit Lückenliste erstellen“ oder „Abbrechen“. Nie still unvollständig; ein
 * Abbruch oder ein Wechsel von Konto, Betrieb oder Rolle erzeugt keine Datei.
 */
export const DATA_EXPORT_ROUTE = SETTINGS_TARGET_PATHS.export;

type Stufe =
  | { stufe: 'bereit' }
  | { stufe: 'pruefung'; progress: DataExportProgress | null }
  | { stufe: 'ergebnis'; prepared: DataExportPrepared }
  | { stufe: 'erstellung'; prepared: DataExportPrepared; progress: DataExportProgress | null }
  | { stufe: 'fertig'; name: string; incomplete: boolean }
  | { stufe: 'beendet'; grund: DataExportFailure };

const GAP_TEXT: Record<DataExportGapKind, TranslationKey> = {
  sync_open: 'dataExport.gap.sync_open',
  sync_rejected: 'dataExport.gap.sync_rejected',
  sync_held: 'dataExport.gap.sync_held',
  pull_skipped: 'dataExport.gap.pull_skipped',
  pull_failed: 'dataExport.gap.pull_failed',
  persist_failed: 'dataExport.gap.persist_failed',
  file_unavailable: 'dataExport.gap.file_unavailable',
  finance_unconfirmed: 'dataExport.gap.finance_unconfirmed',
  emails_unavailable: 'dataExport.gap.emails_unavailable',
  emails_truncated: 'dataExport.gap.emails_truncated',
};

const PHASE_TEXT: Record<DataExportProgress['phase'], TranslationKey> = {
  binding: 'dataExport.progress.binding',
  pull: 'dataExport.progress.pull',
  check: 'dataExport.progress.check',
  files: 'dataExport.progress.files',
  emails: 'dataExport.progress.emails',
  csv: 'dataExport.progress.csv',
  zip: 'dataExport.progress.zip',
  download: 'dataExport.progress.download',
};

const ENDE_TEXT: Record<DataExportFailure, TranslationKey> = {
  cancelled: 'dataExport.cancelled',
  binding_changed: 'dataExport.bindingChanged',
  failed: 'dataExport.failed',
  not_allowed: 'dataExport.notAllowed',
};

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function gapText(translate: (key: TranslationKey) => string, gap: DataExportGap): string {
  // Dateien und Finanzzustände nennen den konkreten Fall; die Beschreibung stammt aus der Prüfung.
  const detail = gap.kind === 'file_unavailable' || gap.kind === 'finance_unconfirmed' ? gap.description : '';
  return translate(GAP_TEXT[gap.kind]).replace('{count}', String(gap.count ?? '')).replace('{detail}', detail);
}

function progressText(translate: (key: TranslationKey) => string, progress: DataExportProgress | null): string {
  if (!progress) return translate('dataExport.progress.binding');
  return translate(PHASE_TEXT[progress.phase])
    .replace('{done}', String(progress.done ?? 0))
    .replace('{total}', String(progress.total ?? 0));
}

function DataExportPanel({ deps }: { deps: DataExportDeps }) {
  const { translate } = useApp();
  const [stand, setStand] = useState<Stufe>({ stufe: 'bereit' });
  const controller = useRef<AbortController | null>(null);
  const aktiv = useRef(true);

  useEffect(() => {
    aktiv.current = true;
    return () => {
      // Verlassen der Seite bricht ab: keine Datei, späte Antworten ohne Wirkung.
      aktiv.current = false;
      controller.current?.abort();
    };
  }, []);

  const pruefen = async () => {
    const abort = new AbortController();
    controller.current = abort;
    setStand({ stufe: 'pruefung', progress: null });
    const result = await prepareDataExport(deps, {
      signal: abort.signal,
      onProgress: (progress) => {
        if (aktiv.current && !abort.signal.aborted) setStand({ stufe: 'pruefung', progress });
      },
    });
    // Ein abgebrochener Lauf (oder eine verlassene Seite) setzt nichts mehr; „Abbrechen“ hat den Stand schon gesetzt.
    if (!aktiv.current || abort.signal.aborted) return;
    controller.current = null;
    setStand(result.ok ? { stufe: 'ergebnis', prepared: result.prepared } : { stufe: 'beendet', grund: result.reason });
  };

  const erstellen = async (prepared: DataExportPrepared) => {
    const abort = new AbortController();
    controller.current = abort;
    setStand({ stufe: 'erstellung', prepared, progress: null });
    const result = await buildAndDownloadDataExport(deps, prepared, {
      acceptGaps: prepared.gaps.length > 0,
      signal: abort.signal,
      onProgress: (progress) => {
        if (aktiv.current && !abort.signal.aborted) setStand({ stufe: 'erstellung', prepared, progress });
      },
    });
    // Ein abgebrochener Lauf (oder eine verlassene Seite) setzt nichts mehr; „Abbrechen“ hat den Stand schon gesetzt.
    if (!aktiv.current || abort.signal.aborted) return;
    controller.current = null;
    if (result.ok) setStand({ stufe: 'fertig', name: result.fileName, incomplete: result.incomplete });
    else setStand({ stufe: 'beendet', grund: result.reason === 'gaps_not_accepted' ? 'failed' : result.reason });
  };

  const abbrechen = () => {
    controller.current?.abort();
    controller.current = null;
    setStand({ stufe: 'beendet', grund: 'cancelled' });
  };

  const laeuft = stand.stufe === 'pruefung' || stand.stufe === 'erstellung';

  return (
    <section className="settings-form__section" data-testid="data-export-panel" data-state={stand.stufe}>
      <p className="hint-text">{translate('dataExport.intro')}</p>

      {stand.stufe === 'bereit' || stand.stufe === 'beendet' || stand.stufe === 'fertig' ? (
        <>
          {stand.stufe === 'beendet' ? (
            <p className={stand.grund === 'cancelled' ? 'hint-text' : 'auth-form__error'} role={stand.grund === 'cancelled' ? 'status' : 'alert'} data-testid="data-export-ended" data-reason={stand.grund}>
              {translate(ENDE_TEXT[stand.grund])}
            </p>
          ) : null}
          {stand.stufe === 'fertig' ? (
            <p className="auth-form__success" role="status" data-testid="data-export-success" data-incomplete={stand.incomplete ? 'true' : 'false'}>
              {translate(stand.incomplete ? 'dataExport.successIncomplete' : 'dataExport.success').replace('{name}', stand.name)}
            </p>
          ) : null}
          <p className="form-hint">{translate('dataExport.prepare.hint')}</p>
          <div className="form-actions">
            <Button type="button" onClick={() => void pruefen()} data-testid="data-export-prepare">
              {translate('dataExport.prepare')}
            </Button>
          </div>
        </>
      ) : null}

      {laeuft ? (
        <div data-testid="data-export-progress" role="status" aria-live="polite">
          <p className="hint-text" data-testid="data-export-progress-text" data-phase={stand.progress?.phase ?? 'binding'}>
            {progressText(translate, stand.progress)}
          </p>
          {stand.progress?.total ? (
            <progress max={stand.progress.total} value={stand.progress.done ?? 0} data-testid="data-export-progress-bar" />
          ) : null}
          <div className="form-actions">
            <Button type="button" variant="outline" onClick={abbrechen} data-testid="data-export-cancel">
              {translate('dataExport.cancel')}
            </Button>
          </div>
        </div>
      ) : null}

      {stand.stufe === 'ergebnis' ? (
        <div data-testid="data-export-result" data-gaps={stand.prepared.gaps.length}>
          {stand.prepared.binding.cloud ? null : <p className="hint-text" data-testid="data-export-local">{translate('dataExport.local')}</p>}
          {stand.prepared.gaps.length === 0 ? (
            <p className="auth-form__success" data-testid="data-export-complete">{translate('dataExport.result.complete')}</p>
          ) : (
            <div role="alert" data-testid="data-export-gaps">
              <p className="auth-form__error">{translate('dataExport.result.gaps')}</p>
              <ul className="hint-list" data-testid="data-export-gap-list">
                {stand.prepared.gaps.map((gap, index) => (
                  <li key={`${gap.kind}-${gap.reference ?? index}`} data-kind={gap.kind}>
                    {gapText(translate, gap)}
                  </li>
                ))}
              </ul>
              <p className="hint-text">{translate('dataExport.result.gapsHint')}</p>
              {stand.prepared.gaps.some((gap) => gap.kind.startsWith('sync_') || gap.kind === 'pull_skipped') ? (
                <p>
                  <Link to={SETTINGS_TARGET_PATHS.sync} data-testid="data-export-sync-link">{translate('dataExport.result.syncLink')}</Link>
                </p>
              ) : null}
            </div>
          )}
          <p className="form-hint" data-testid="data-export-size">
            {translate('dataExport.result.size').replace('{size}', formatSize(stand.prepared.estimatedBytes))}
          </p>
          {stand.prepared.estimatedBytes >= DATA_EXPORT_SIZE_WARNING_BYTES ? (
            <p className="settings-form__notice" role="note" data-testid="data-export-size-warning">{translate('dataExport.sizeWarning')}</p>
          ) : null}
          <div className="form-actions">
            <Button
              type="button"
              variant={stand.prepared.gaps.length > 0 ? 'outline' : 'primary'}
              onClick={() => void erstellen(stand.prepared)}
              data-testid={stand.prepared.gaps.length > 0 ? 'data-export-create-with-gaps' : 'data-export-create'}
            >
              {translate(stand.prepared.gaps.length > 0 ? 'dataExport.createWithGaps' : 'dataExport.create')}
            </Button>
            <Button type="button" variant="outline" onClick={abbrechen} data-testid="data-export-cancel-result">
              {translate('dataExport.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function DataExportPage({ deps: injected }: { deps?: DataExportDeps } = {}) {
  const { translate } = useApp();
  const auth = useOptionalAuth();
  const { access, managesWorkspace } = useSettingsAccess();
  const email = auth?.user?.email ?? '';
  const deps = useMemo(() => injected ?? createDefaultDataExportDeps({ userEmail: email }), [injected, email]);

  return (
    <div className="page settings-page settings-subpage" data-testid="settings-export-page">
      <SettingsPageHeader target="export" subtitle={translate('dataExport.subtitle')} />
      {managesWorkspace ? (
        <DataExportPanel deps={deps} />
      ) : (
        <SettingsAccessNotice
          variant={resolveSettingsNoticeVariant(access) === 'unknown' ? 'unknown' : 'role'}
          kind="hidden"
          testId="data-export-not-allowed"
        />
      )}
    </div>
  );
}
