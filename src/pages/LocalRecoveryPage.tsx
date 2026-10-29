import { useMemo, useState } from 'react';
import JSZip from 'jszip';
import {
  readLocalScopeInventory,
  readLocalScopeRawCopy,
  type LocalScopeCopy,
} from '../services/storage/localScopeInventoryService';
import { buildScopeKeyFromStorageKey } from '../services/storage/localScopeBlobInventoryService';
import {
  buildLocalScopeEmergencyBackup,
  readFileRefsFromRawState,
} from '../services/storage/localScopeEmergencyExportService';
import { triggerZipDownload } from '../services/storage/localRecoveryDownloadService';
import { isRecoveryCopyReleased, recoveryBindingOf } from '../services/storage/localRecoveryAccessService';
import { useRecoveryIdentity } from '../hooks/useRecoveryIdentity';
import { RecoveryIdentityPanel } from '../components/system/RecoveryIdentityPanel';
import { DocumentLanguage } from '../components/system/DocumentLanguage';
import { SkipLink } from '../components/system/SkipLink';
import { t, type TranslationKey } from '../i18n';
import { pickRecoveryLanguage } from './localRecoveryLanguage';
import type { AppLanguage } from '../types/models';

/**
 * OFFICEPILOT-LOCAL-SCOPE-RECOVERY-01B/01D — Notfallansicht unter /local-recovery.
 *
 * Ausschließlich Diagnose und Sicherung: sie liest den lokalen Speicher der
 * aktuell geöffneten Adresse, zeigt was gefunden wurde und bietet je Kopie eine
 * unveränderte Rohdatensicherung als ZIP an. Sie übernimmt nichts, wechselt
 * keinen Scope, startet keinen Sync und schreibt nichts.
 *
 * Die Seite läuft bewusst ohne AuthProvider und ohne AppProvider — deshalb wird
 * die Sprache aus der jüngsten gültigen Kopie abgeleitet statt aus einem Store.
 *
 * EINRICHTUNG-01 (AP1, E8, EIN-07) — ohne Anmeldung nur Bestände ohne Kontobindung (Gast, Altformate) und eine
 * Anzahl der übrigen, ohne Kennungen, Namen oder Details. Die Bestände eines Kontos erscheinen erst, wenn der Server
 * die Anmeldung genau dieses Kontos bestätigt; vor jeder Sicherung eines solchen Bestands wird erneut bestätigt.
 * Offline bleibt alles Gebundene gesperrt und unverändert auf dem Gerät. Speicherschlüssel und Server-Kennungen
 * stehen nicht mehr auf der Seite.
 */
// EINRICHTUNG-01 (App-Eigenprüfung; E-9) — unveränderte Regel, jetzt gemeinsam mit /local-recovery/import.
const pickLanguage: (copies: LocalScopeCopy[]) => AppLanguage = pickRecoveryLanguage;

/**
 * Dateiname ohne vertrauliche Bestandteile: nur Scope-Art und laufende Nummer,
 * niemals Benutzer- oder Workspace-Kennungen.
 */
function zipFilename(copy: LocalScopeCopy, index: number): string {
  return `officepilot-sicherung-${copy.scopeType}-${index + 1}.zip`;
}

async function downloadRawCopyAsZip(
  rawText: string,
  zipName: string,
  innerName: string,
): Promise<void> {
  const zip = new JSZip();
  // Exakt der unveränderte Rohtext — kein Parsen, kein erneutes Stringify.
  zip.file(innerName, rawText);
  const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/zip' });
  triggerZipDownload(blob, zipName);
}

/**
 * Anzahl der Dateireferenzen einer Kopie — rein aus dem Rohtext, ohne
 * IndexedDB-Zugriff. Die Datenbank wird erst beim ausdrücklichen Klick geöffnet.
 */
function countFileRefs(storageKey: string): number {
  if (!buildScopeKeyFromStorageKey(storageKey)) return 0;
  const raw = readLocalScopeRawCopy(storageKey);
  if (raw === null) return 0;
  return readFileRefsFromRawState(raw)?.length ?? 0;
}

function scopeLabelKey(copy: LocalScopeCopy): TranslationKey {
  return `localRecovery.scope.${copy.scopeType}` as TranslationKey;
}

export function LocalRecoveryPage() {
  // Einmalige Momentaufnahme: kein Polling, keine Abos, keine Schreibvorgänge.
  const inventory = useMemo(() => readLocalScopeInventory(), []);
  const storageKeys = useMemo(() => inventory.copies.map((copy) => copy.storageKey), [inventory]);
  const { identity, confirm, login, logout, loginBusy, loginError } = useRecoveryIdentity(storageKeys);

  const released = useMemo(
    () => inventory.copies.filter((copy) => isRecoveryCopyReleased(copy.storageKey, identity)),
    [inventory, identity],
  );
  const hiddenBoundCount = inventory.copies.length - released.length;
  // Die Sprache nur aus sichtbaren Beständen — gebundene werden ohne Freigabe nicht ausgewertet.
  const lang = pickLanguage(released);

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [fileSummary, setFileSummary] = useState<string | null>(null);
  const [exportBlocked, setExportBlocked] = useState(false);

  const fileRefCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const copy of released) {
      counts.set(copy.storageKey, copy.valid ? countFileRefs(copy.storageKey) : 0);
    }
    return counts;
  }, [released]);

  /** Gebundene Bestände: unmittelbar vor der Sicherung erneut beim Server bestätigen (T-02.2). */
  const releasedNow = async (copy: LocalScopeCopy): Promise<boolean> => {
    if (recoveryBindingOf(copy.storageKey).kind === 'unbound') return true;
    const now = await confirm();
    const ok = isRecoveryCopyReleased(copy.storageKey, now);
    setExportBlocked(!ok);
    return ok;
  };

  const handleDownload = async (copy: LocalScopeCopy, index: number) => {
    setBusyKey(copy.storageKey);
    try {
      if (!(await releasedNow(copy))) return;
      const raw = readLocalScopeRawCopy(copy.storageKey);
      if (raw === null) return;
      await downloadRawCopyAsZip(
        raw,
        zipFilename(copy, index),
        `officepilot-rohdaten-${copy.scopeType}-${index + 1}.json`,
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleFileDownload = async (copy: LocalScopeCopy, index: number) => {
    setBusyKey(copy.storageKey);
    try {
      if (!(await releasedNow(copy))) return;
      const raw = readLocalScopeRawCopy(copy.storageKey);
      if (raw === null) return;
      const result = await buildLocalScopeEmergencyBackup({
        storageKey: copy.storageKey,
        rawText: raw,
        origin: inventory.origin,
        exportedAt: new Date().toISOString(),
        index,
      });
      if (!result.ok || !result.blob || !result.filename || !result.manifest) {
        setFileSummary(t('localRecovery.files.failed', lang));
        return;
      }
      triggerZipDownload(result.blob, result.filename);
      const { found, missing, readError, invalid } = result.manifest.summary;
      // Die Zusammenfassung bleibt stehen, bis der Nutzer erneut exportiert.
      setFileSummary(
        `${t('localRecovery.files.saved', lang)}: ${found} — ` +
          `${t('localRecovery.files.missing', lang)}: ${missing} — ` +
          `${t('localRecovery.files.readError', lang)}: ${readError} — ` +
          `${t('localRecovery.files.invalid', lang)}: ${invalid}`,
      );
    } finally {
      setBusyKey(null);
    }
  };

  const companyLabel = (copy: LocalScopeCopy): string =>
    copy.setupCompanyName ?? copy.profileCompanyName ?? t('localRecovery.value.noCompany', lang);

  return (
    <div className="auth-page" data-testid="local-recovery-page">
      {/* EINRICHTUNG-01 (AP9; 1.31, Q-03) — die Notfallseite steht vor dem App-Rahmen. */}
      <DocumentLanguage language={lang} />
      {/* EINRICHTUNG-01 (AP9-Nacharbeit; 1.32) — erstes fokussierbares Element: Sprung zur Überschrift der Karte. */}
      <SkipLink
        href="#local-recovery-title"
        label={t('a11y.skipToContent', lang)}
        findTarget={() => document.getElementById('local-recovery-title')}
      />
      <div className="auth-card">
        <header className="auth-card__header">
          <p className="auth-card__brand">OfficeTakt</p>
          <h1 className="auth-card__title" id="local-recovery-title" tabIndex={-1}>
            {t('localRecovery.title', lang)}
          </h1>
          <p className="auth-card__subtitle">{t('localRecovery.intro', lang)}</p>
        </header>

        <p className="form-hint" data-testid="local-recovery-origin">
          {t('localRecovery.origin', lang)}: {inventory.origin}
        </p>
        <p className="form-hint" data-testid="local-recovery-origin-note">
          {t('localRecovery.originNote', lang)}
        </p>

        <RecoveryIdentityPanel
          identity={identity}
          lang={lang}
          hiddenBoundCount={hiddenBoundCount}
          loginBusy={loginBusy}
          loginError={loginError}
          onLogin={login}
          onLogout={async () => {
            setExportBlocked(false);
            await logout();
          }}
        />

        {inventory.copies.length === 0 ? (
          <p className="form-hint" data-testid="local-recovery-empty">
            {t('localRecovery.empty', lang)}
          </p>
        ) : null}

        {exportBlocked ? (
          <p className="form-error" role="alert" data-testid="local-recovery-export-blocked">
            {t('localRecovery.exportBlocked', lang)}
          </p>
        ) : null}

        <ul className="local-recovery-list">
          {released.map((copy, index) => (
            <li
              key={copy.storageKey}
              className="local-recovery-item"
              data-testid={`local-recovery-copy-${copy.storageKey}`}
              data-scope={copy.scopeType}
            >
              {/* Firma und Bereich stehen vorn, damit nicht versehentlich die
                  leere Guest-Kopie gesichert wird. */}
              <p className="local-recovery-item__headline">
                {companyLabel(copy)} — {t(scopeLabelKey(copy), lang)}
              </p>

              {copy.scopeType === 'legacy_setup' ? (
                <p className="form-hint" data-testid="local-recovery-legacy-note">
                  {t('localRecovery.legacySetupNote', lang)}
                </p>
              ) : null}

              {copy.valid ? (
                <dl className="local-recovery-item__facts">
                  <div>
                    <dt>{t('localRecovery.field.scope', lang)}</dt>
                    <dd>{t(scopeLabelKey(copy), lang)}</dd>
                  </div>
                  <div>
                    <dt>{t('localRecovery.field.company', lang)}</dt>
                    <dd>{companyLabel(copy)}</dd>
                  </div>
                  {copy.scopeType === 'legacy_setup' ? null : (
                    <div>
                      <dt>{t('localRecovery.field.profileCompany', lang)}</dt>
                      <dd>{copy.profileCompanyName ?? '—'}</dd>
                    </div>
                  )}
                  <div>
                    <dt>{t('localRecovery.field.setupComplete', lang)}</dt>
                    <dd>
                      {copy.setupComplete
                        ? t('localRecovery.value.yes', lang)
                        : t('localRecovery.value.no', lang)}
                    </dd>
                  </div>
                  {copy.scopeType === 'legacy_setup' ? (
                    <>
                      <div>
                        <dt>{t('localRecovery.field.language', lang)}</dt>
                        <dd>{copy.language ?? '—'}</dd>
                      </div>
                      <div>
                        <dt>{t('localRecovery.field.industry', lang)}</dt>
                        <dd>{copy.industry ?? '—'}</dd>
                      </div>
                      <div>
                        <dt>{t('localRecovery.field.taxStatus', lang)}</dt>
                        <dd>{copy.taxStatus ?? '—'}</dd>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <dt>{t('localRecovery.field.savedAt', lang)}</dt>
                        <dd>{copy.savedAt ?? '—'}</dd>
                      </div>
                      <div>
                        <dt>{t('localRecovery.field.version', lang)}</dt>
                        <dd>{copy.stateVersion ?? '—'}</dd>
                      </div>
                      <div>
                        <dt>{t('localRecovery.field.counts', lang)}</dt>
                        <dd>
                          {copy.vorgangCount} / {copy.documentCount} / {copy.orderCount}
                        </dd>
                      </div>
                    </>
                  )}
                  <div>
                    <dt>{t('localRecovery.field.rawLength', lang)}</dt>
                    <dd>{copy.rawLength}</dd>
                  </div>
                </dl>
              ) : (
                <p className="form-error" role="alert">
                  {t('localRecovery.broken', lang)}
                </p>
              )}

              <button
                type="button"
                className="btn btn--outline btn--full"
                data-testid={`local-recovery-download-${copy.storageKey}`}
                disabled={busyKey === copy.storageKey}
                onClick={() => {
                  void handleDownload(copy, index);
                }}
              >
                {t('localRecovery.downloadZip', lang)}
              </button>

              {(fileRefCounts.get(copy.storageKey) ?? 0) > 0 ? (
                <button
                  type="button"
                  className="btn btn--outline btn--full"
                  data-testid={`local-recovery-download-files-${copy.storageKey}`}
                  disabled={busyKey === copy.storageKey}
                  onClick={() => {
                    void handleFileDownload(copy, index);
                  }}
                >
                  {t('localRecovery.downloadWithFiles', lang)} (
                  {fileRefCounts.get(copy.storageKey) ?? 0})
                </button>
              ) : null}
            </li>
          ))}
        </ul>

        {fileSummary ? (
          <p className="form-hint" role="status" data-testid="local-recovery-file-summary">
            {fileSummary}
          </p>
        ) : null}

        <p className="form-hint" data-testid="local-recovery-indexeddb-note">
          {t('localRecovery.indexedDbNote', lang)}
        </p>
        <p className="form-hint" data-testid="local-recovery-readonly-note">
          {t('localRecovery.readOnlyNote', lang)}
        </p>

        {/*
          OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02P3 — ausdrücklicher Einstieg in
          die Sicherungs- und Quarantänevorbereitung. Ein gewöhnlicher Link: er
          löst nichts von selbst aus, leitet nicht um und führt nicht in die
          normale App. Diese Seite hier bleibt unverändert rein lesend.
        */}
        <a
          className="btn btn--outline btn--full"
          href="/local-recovery/import"
          data-testid="local-recovery-import-link"
        >
          {t('localRecovery.importLink', lang)}
        </a>
        <p className="form-hint" data-testid="local-recovery-import-note">
          {t('localRecovery.importNote', lang)}
        </p>
      </div>
    </div>
  );
}
