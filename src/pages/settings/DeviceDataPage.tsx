import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { SettingsPageHeader } from '../../components/settings/SettingsPageHeader';
import { Button } from '../../components/ui/Button';
import { SimpleConfirmDialog } from '../../components/ui/SimpleConfirmDialog';
import { useApp } from '../../context/AppContext';
import { useOptionalAuth } from '../../context/AuthContext';
import type { TranslationKey } from '../../i18n';
import { isSupabaseConfigured } from '../../lib/supabase';
import { flushInvoiceDraftCloudMirror } from '../../services/invoice/invoiceDraftCloudBridge';
import { buildPersistedStateSnapshot } from '../../services/persistenceService';
import { getSyncOutboxSnapshot } from '../../services/sync/syncOutboxService';
import { getSyncCoordinator, isSyncIdentityHaltReport } from '../../services/sync/syncCoordinator';
import { runSyncFromUi } from '../../services/sync/syncUiService';
import { holdAccountSessionLock, releaseAccountSessionLock } from '../../services/storage/accountSessionLock';
import { readLocalAccountDrafts, type LocalAccountDrafts } from '../../services/storage/localAccountDataService';
import { getActiveStorageKey } from '../../services/storage/storageScopeService';
import {
  browserExclusiveLock,
  defaultDeviceRemove,
  DEVICE_REMOVAL_CHANNEL,
  deviceOutboxCounts,
  evaluateDeviceRemoval,
  getDeviceBackup,
  inspectDeviceData,
  recordDeviceSyncVerification,
  removeDeviceData,
  storedDeviceFingerprint,
  type DeviceRemovalBlock,
} from '../../services/storage/deviceDataService';
import { getWorkspaceStoreSnapshot } from '../../services/workspace/workspaceStore';
import { SETTINGS_TARGET_PATHS } from './settingsHubConfig';

/**
 * EINRICHTUNG-01 (AP8; Verträge 1.29, 1.28; K6; X-05; Abschluss 22 zu WEISS E-13) — „Daten › Daten auf diesem Gerät“.
 *
 * Zeigt die Bestände dieses Kontos auf diesem Gerät (Betriebe, Größe, letzter Abgleich, offene und abgewiesene
 * Änderungen); andere Konten nur als Anzahl, ohne Kennungen. „Daten von diesem Gerät entfernen“ nur, wenn nichts
 * davon nur auf diesem Gerät liegt (siehe `deviceDataService`); eine Sicherung schaltet das nie frei. „Abgleich jetzt
 * prüfen“ gleicht den aktiven Betrieb vollständig ab und hält den Nachweis für diese Sitzung fest. Mit
 * Eingabebestätigung (das angezeigte Wort). Im lokalen Betrieb ohne Cloud gibt es keine zweite Kopie: Die Seite zeigt den
 * Bestand und den Weg zur Sicherung, aber kein Entfernen.
 */
export const DEVICE_DATA_ROUTE = SETTINGS_TARGET_PATHS.device;

const BLOCK_TEXT: Record<DeviceRemovalBlock, TranslationKey> = {
  unsynced: 'deviceData.block.unsynced',
  not_verified: 'deviceData.block.not_verified',
  unreadable: 'deviceData.block.unreadable',
  local_only: 'deviceData.block.local_only',
  draft: 'deviceData.block.draft',
  check_failed: 'deviceData.block.check_failed',
};

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: string | null | undefined, language: string): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return '—';
  const locale = language === 'tr' ? 'tr-TR' : language === 'bg' ? 'bg-BG' : 'de-DE';
  return new Date(parsed).toLocaleString(locale, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Der laufende Stand des aktiven Bestands dieses Kontos (mit der aktuellen Warteschlange). */
function liveState(userId: string): { storageKey: string; state: object } | null {
  const storageKey = getActiveStorageKey();
  if (!storageKey.includes(userId)) return null;
  return { storageKey, state: { ...buildPersistedStateSnapshot(), syncOutbox: getSyncOutboxSnapshot() } };
}

export function DeviceDataPage() {
  const { translate, language } = useApp();
  const auth = useOptionalAuth();
  const user = auth?.user ?? null;
  const cloud = isSupabaseConfigured() && Boolean(user);
  const [revision, setRevision] = useState(0);
  const [entwuerfe, setEntwuerfe] = useState<LocalAccountDrafts | null>(null);
  const [pruefung, setPruefung] = useState<'idle' | 'running' | 'ok' | 'failed'>('idle');
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<TranslationKey | null>(null);
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!cloud || !userId) return undefined;
    let aktiv = true;
    setEntwuerfe(null);
    void readLocalAccountDrafts(userId)
      .catch((): LocalAccountDrafts => ({ ok: false, invoiceDrafts: [], uploadDrafts: [] }))
      .then((ergebnis) => {
        if (aktiv) setEntwuerfe(ergebnis);
      });
    return () => {
      aktiv = false;
    };
  }, [cloud, userId, revision]);

  const aktiverBetrieb = getWorkspaceStoreSnapshot()?.id ?? null;
  const inventar = useMemo(() => {
    void revision;
    if (!cloud || !userId) return null;
    // Der aktive Betrieb zählt mit seiner laufenden Warteschlange; andere Betriebe aus ihrem gespeicherten Bestand.
    const gespeichert = inspectDeviceData(userId);
    const live = deviceOutboxCounts(getSyncOutboxSnapshot());
    return {
      ...gespeichert,
      workspaces: gespeichert.workspaces.map((workspace) =>
        workspace.workspaceId === aktiverBetrieb ? { ...workspace, openChanges: live.open, rejectedChanges: live.rejected } : workspace,
      ),
    };
  }, [cloud, userId, revision, aktiverBetrieb]);

  const bewertung = useMemo(() => {
    void revision;
    if (!inventar || !userId) return null;
    return evaluateDeviceRemoval(userId, { live: liveState(userId), drafts: entwuerfe });
  }, [inventar, userId, entwuerfe, revision]);

  if (!cloud || !user || !userId || !inventar || !bewertung) {
    return (
      <div className="page settings-page settings-subpage" data-testid="settings-device-page">
        <SettingsPageHeader target="device" subtitle={translate('deviceData.subtitle')} />
        <p className="hint-text" data-testid="device-data-local">{translate('deviceData.local')}</p>
        <p>
          <Link to={SETTINGS_TARGET_PATHS.backup} data-testid="device-data-backup-link">{translate('deviceData.way.backup')}</Link>
        </p>
      </div>
    );
  }

  const letzterAbgleich = getSyncCoordinator().getStatus().lastSyncedAt ?? null;
  const pruefend = entwuerfe === null;
  const erlaubt = bewertung.allowed && !pruefend;

  const abgleichPruefen = async () => {
    setPruefung('running');
    setFehler(null);
    let ok = false;
    try {
      // Ein gebündelter Entwurfsstand gelangt so noch in die Warteschlange, bevor abgeglichen wird.
      flushInvoiceDraftCloudMirror();
      const report = await runSyncFromUi();
      const offen = deviceOutboxCounts(getSyncOutboxSnapshot());
      const storageKey = getActiveStorageKey();
      const fingerprint = storageKey.includes(userId) ? storedDeviceFingerprint(storageKey) : null;
      ok =
        report.errorCount === 0 &&
        report.conflictCount === 0 &&
        report.errors.length === 0 &&
        !isSyncIdentityHaltReport(report) &&
        offen.open + offen.rejected === 0 &&
        fingerprint !== null;
      if (ok && fingerprint !== null) {
        recordDeviceSyncVerification({ userId, storageKey, fingerprint, verifiedAt: new Date().toISOString() });
      }
    } catch {
      ok = false;
    }
    setPruefung(ok ? 'ok' : 'failed');
    setRevision((value) => value + 1);
  };

  const entfernen = async (): Promise<boolean> => {
    setBusy(true);
    setFehler(null);
    const ergebnis = await removeDeviceData(userId, {
      releaseOwnLock: releaseAccountSessionLock,
      reacquireOwnLock: () => holdAccountSessionLock(userId),
      logoutLocal: async () => {
        await auth?.logoutAfterDeviceDataRemoval();
      },
      broadcast: (message) => {
        try {
          const channel = new BroadcastChannel(DEVICE_REMOVAL_CHANNEL);
          channel.postMessage(message);
          channel.close();
        } catch {
          // Ohne BroadcastChannel erreicht die Nachricht keine anderen Tabs; die Sperre wartet dann vergeblich.
        }
      },
      exclusiveLock: browserExclusiveLock,
      remove: defaultDeviceRemove,
      live: () => liveState(userId),
    });
    setBusy(false);
    setDialog(false);
    if (!ergebnis.ok) {
      // Erst nach der Abmeldung gesperrt: nichts entfernt — der Hinweis „entfernt“ auf der Anmeldeseite entfällt.
      if (ergebnis.reason === 'blocked' && ergebnis.loggedOut) auth?.clearLogoutReason();
      setFehler(ergebnis.reason === 'other_tabs' ? 'deviceData.error.otherTabs' : ergebnis.reason === 'blocked' ? 'deviceData.error.blocked' : 'deviceData.error.failed');
      setRevision((value) => value + 1);
    }
    return true;
  };

  const flaechen = [
    ...inventar.workspaces.map((workspace) => ({ key: workspace.storageKey, workspace })),
    ...(inventar.accountArea ? [{ key: inventar.accountArea.storageKey, workspace: null }] : []),
  ];

  return (
    <div className="page settings-page settings-subpage" data-testid="settings-device-page">
      <SettingsPageHeader target="device" subtitle={translate('deviceData.subtitle')} />
      <section className="settings-form__section" data-testid="device-data-own">
        <p className="settings-form__legend">{translate('deviceData.own.title')}</p>
        {flaechen.length === 0 ? (
          <p className="hint-text" data-testid="device-data-empty">{translate('deviceData.own.empty')}</p>
        ) : (
          <ul className="hint-list">
            {inventar.workspaces.map((workspace) => (
              <li key={workspace.storageKey} data-testid={`device-data-workspace-${workspace.workspaceId}`}>
                <strong>{workspace.name || '—'}</strong>
                {' · '}
                {translate('deviceData.size').replace('{size}', formatSize(workspace.bytes))}
                {' · '}
                {translate('deviceData.saved').replace('{date}', formatDate(workspace.savedAt, language))}
                {' · '}
                {translate('deviceData.lastSync').replace('{date}', workspace.workspaceId === aktiverBetrieb ? formatDate(letzterAbgleich, language) : '—')}
                {' · '}
                <span data-testid={`device-data-open-${workspace.workspaceId}`}>{translate('deviceData.open').replace('{count}', String(workspace.openChanges))}</span>
                {workspace.rejectedChanges > 0 ? (
                  <>
                    {' · '}
                    {translate('deviceData.rejected').replace('{count}', String(workspace.rejectedChanges))}
                  </>
                ) : null}
              </li>
            ))}
            {inventar.accountArea ? (
              <li data-testid="device-data-account-area">
                <strong>{translate('deviceData.accountArea')}</strong>
                {' · '}
                {translate('deviceData.size').replace('{size}', formatSize(inventar.accountArea.bytes))}
              </li>
            ) : null}
          </ul>
        )}
        {inventar.otherAccounts > 0 ? (
          <p className="hint-text" data-testid="device-data-others">{translate('deviceData.others').replace('{count}', String(inventar.otherAccounts))}</p>
        ) : null}
      </section>

      <section className="settings-form__section" data-testid="device-data-remove" data-allowed={erlaubt ? 'true' : 'false'}>
        <p className="settings-form__legend">{translate('deviceData.remove.title')}</p>
        <p className="hint-text">{translate('deviceData.remove.text')}</p>
        {fehler ? <p className="auth-form__error" role="alert" data-testid="device-data-error">{translate(fehler)}</p> : null}
        {pruefend ? (
          <p className="hint-text" role="status" data-testid="device-data-checking">{translate('deviceData.checking')}</p>
        ) : bewertung.affected.length === 0 ? (
          <p className="hint-text" data-testid="device-data-ready">{translate('deviceData.remove.ready')}</p>
        ) : (
          <div data-testid="device-data-blocked">
            <p className="hint-text">{translate('deviceData.remove.blocked')}</p>
            <ul className="hint-list">
              {bewertung.affected.map((area) => {
                const backup = area.workspaceId ? getDeviceBackup(userId, area.workspaceId) : null;
                const name = area.workspaceId === null ? translate('deviceData.accountArea') : area.name || '—';
                return (
                  <li key={area.storageKey} data-testid={`device-data-affected-${area.workspaceId ?? 'account'}`} data-block={area.reasons[0]} data-reasons={area.reasons.join(' ')}>
                    <strong>{name}</strong>
                    {area.reasons.map((reason) => (
                      <span key={reason}> · {translate(BLOCK_TEXT[reason])}</span>
                    ))}
                    {backup ? (
                      <p className="form-hint" data-testid={`device-data-backup-note-${area.workspaceId}`}>
                        {translate('deviceData.backup.noUnlock').replace('{name}', backup.fileName).replace('{date}', formatDate(backup.createdAt, language))}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <p>
              <Link to={SETTINGS_TARGET_PATHS.sync} data-testid="device-data-sync-link">{translate('deviceData.way.sync')}</Link>
              {' · '}
              <Link to={SETTINGS_TARGET_PATHS.backup} data-testid="device-data-backup-link">{translate('deviceData.way.backup')}</Link>
            </p>
          </div>
        )}
        <p className="form-hint">{translate('deviceData.verify.hint')}</p>
        {pruefung === 'ok' || pruefung === 'failed' ? (
          <p className={pruefung === 'ok' ? 'auth-form__success' : 'auth-form__error'} role="status" data-testid="device-data-verify-result" data-state={pruefung}>
            {translate(pruefung === 'ok' ? 'deviceData.verify.ok' : 'deviceData.verify.failed')}
          </p>
        ) : null}
        <div className="form-actions">
          <Button type="button" variant="secondary" disabled={pruefung === 'running' || busy} loading={pruefung === 'running'} onClick={() => void abgleichPruefen()} data-testid="device-data-verify">
            {translate('deviceData.verify.action')}
          </Button>
          <Button type="button" variant="danger" disabled={!erlaubt || busy} loading={busy} onClick={() => setDialog(true)} data-testid="device-data-remove-action">
            {translate('deviceData.remove.action')}
          </Button>
        </div>
      </section>

      <SimpleConfirmDialog
        open={dialog}
        title={translate('deviceData.remove.dialogTitle')}
        message={translate('deviceData.remove.dialogText').replace('{word}', translate('deviceData.remove.word'))}
        confirmLabel={translate('deviceData.remove.action')}
        cancelLabel={translate('common.cancel')}
        confirmPhrase={translate('deviceData.remove.word')}
        confirmPhraseLabel={translate('deviceData.remove.wordLabel')}
        confirmPhraseTestId="device-data-remove-word"
        confirmTestId="device-data-remove-confirm"
        cancelTestId="device-data-remove-cancel"
        dialogTestId="device-data-remove-dialog"
        onConfirm={entfernen}
        onCancel={() => setDialog(false)}
      />
    </div>
  );
}
