import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  readLocalScopeInventory,
  type LocalScopeCopy,
} from '../services/storage/localScopeInventoryService';
import {
  createTargetQuarantine,
  listQuarantineMarkers,
  prepareTargetBackupSession,
  verifyReselectedTargetBackup,
} from '../services/storage/localScopeEmergencyQuarantineService';
import { triggerZipDownload } from '../services/storage/localRecoveryDownloadService';
import { isRecoveryCopyReleased } from '../services/storage/localRecoveryAccessService';
import { useRecoveryIdentity } from '../hooks/useRecoveryIdentity';
import { RecoveryIdentityPanel } from '../components/system/RecoveryIdentityPanel';
import { SkipLink } from '../components/system/SkipLink';
import { t } from '../i18n';
import { DocumentLanguage } from '../components/system/DocumentLanguage';
import { pickRecoveryLanguage } from './localRecoveryLanguage';
import type { AppLanguage } from '../types/models';
import {
  clearLocalRecoveryCheckpoint,
  matchLocalRecoveryCheckpoint,
  readLocalRecoveryCheckpoint,
  writeLocalRecoveryCheckpoint,
  type LocalRecoveryCheckpoint,
} from '../services/storage/localRecoveryCheckpointService';
import {
  QUARANTINE_MARKER_PREFIX,
  type PreparedTargetBackupSession,
  type QuarantineMarker,
  type QuarantineSuccess,
  type VerifiedTargetBackupSession,
} from '../types/emergencyBackupQuarantine';

/**
 * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02P3 / 02P3B — providerfreie
 * Vorbereitung von Zielsicherung und lokaler Quarantäne unter
 * /local-recovery/import.
 *
 * Diese Seite läuft bewusst ohne AuthProvider, AppProvider, BusinessStateGate
 * und Sync-Koordinator. Sie importiert ausschließlich die bereits geprüften
 * Notfalldienste — nichts aus Persistenz, Bootstrap, Restore oder Supabase.
 * Sie navigiert nicht und lädt nicht neu.
 *
 * Sie sichert und quarantänisiert ausschließlich den vorhandenen lokalen
 * Bestand. Ein Import findet hier nicht statt.
 *
 * Eine Bereinigung von staging-Vorgängen ist bewusst NICHT enthalten: solange
 * der Kern keine Sperre zwischen Erzeugung und Bereinigung besitzt, könnte
 * eine gleichzeitig laufende Quarantäne beschädigt werden. staging wird
 * deshalb nur angezeigt und blockiert.
 *
 * EINRICHTUNG-01 (AP1, E8; T-03.1) — dieselbe Freigaberegel wie auf /local-recovery: Zielbereiche sind
 * Betriebsbestände und damit gebunden. Sie erscheinen erst, wenn der Server die Anmeldung genau des Kontos
 * bestätigt, dem sie gehören (beim alten gemeinsamen Betriebsbestand: Inhaber oder Admin dieses Betriebs). Vor
 * der Vorbereitung und vor der Quarantäne wird erneut bestätigt. Marker und Wiederaufsetzpunkte gebundener
 * Bereiche bleiben ohne Freigabe unsichtbar und unangetastet.
 */
type UiState =
  | 'inventory'
  | 'target_selected'
  | 'preparing'
  | 'prepared_validated'
  | 'download_triggered'
  /** MOBILE-SAFE-RESUME-01B — Rückkehr nach verworfener Seite. */
  | 'resumed_after_download'
  | 'reselect_checking'
  | 'reselect_mismatch'
  | 'reselect_confirmed'
  | 'quarantining'
  | 'quarantine_complete'
  | 'quarantine_complete_with_target_change'
  | 'staging_blocked'
  | 'blocked_error'
  | 'session_lost';

/**
 * Deckt beide Fundarten ab und benennt keine davon fälschlich als die andere:
 * eine Änderung am Zielbereich und einen parallelen Quarantänevorgang.
 */
/**
 * OFFICEPILOT-…-02P3F — jeder lange technische Wert steht in einem eigenen
 * Element mit der seitenweiten Umbruchklasse. Verkettete Absätze liefen auf
 * dem Smartphone rechts aus der Karte, weil ein 64-stelliger Prüfwert ein
 * einziges unteilbares Wort ist.
 */
interface DetailRowProps {
  field: string;
  label: string;
  value: string | number;
  /** Nur kurze, natürlich umbrechende Werte dürfen darauf verzichten. */
  technical?: boolean;
}

function DetailRow({ field, label, value, technical = true }: DetailRowProps) {
  return (
    <div className="local-recovery-import-detail-row" data-field={field}>
      <dt className="local-recovery-import-detail-label">{label}</dt>
      <dd className={technical ? 'local-recovery-import-technical-value' : undefined}>{value}</dd>
    </div>
  );
}

export function LocalRecoveryImportPage() {
  // Einmalige, rein lesende Momentaufnahme — kein Polling, keine Abos.
  const inventory = useMemo(() => readLocalScopeInventory(), []);
  const [markers, setMarkers] = useState<QuarantineMarker[]>(() => listQuarantineMarkers());
  // EINRICHTUNG-01 (E8) — Freigabe für alle Bereiche, die die Seite nennen könnte: Bestände und Markerquellen.
  const storageKeys = useMemo(
    () => [...new Set([...inventory.copies.map((copy) => copy.storageKey), ...markers.map((marker) => marker.sourceStorageKey)])],
    [inventory, markers],
  );
  const { identity, confirm, login, logout, loginBusy, loginError } = useRecoveryIdentity(storageKeys);
  const allTargets = inventory.copies.filter((copy) => copy.scopeType === 'workspace' && copy.valid);
  const targets = allTargets.filter((copy) => isRecoveryCopyReleased(copy.storageKey, identity));
  const hiddenTargetCount = allTargets.length - targets.length;
  const visibleMarkers = markers.filter((marker) => isRecoveryCopyReleased(marker.sourceStorageKey, identity));
  /*
   * EINRICHTUNG-01 (App-Eigenprüfung; Vertrag 1.31, E-9) — Sprache wie auf /local-recovery: die des jüngsten
   * freigegebenen Bestands, ohne Freigabe Deutsch. Ereignis-Zuhörer und Wiederaufsetzpunkt lesen sie über die Ref.
   */
  const lang = pickRecoveryLanguage(targets);
  const langRef = useRef<AppLanguage>(lang);
  useEffect(() => {
    langRef.current = lang;
  }, [lang]);

  const [state, setState] = useState<UiState>('inventory');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  /** MOBILE-SAFE-RESUME-01B — nur Anzeigewerte des gewählten Zielbestands. */
  const selectedCompanyNameRef = useRef<string>('');
  const selectedSavedAtRef = useRef<string | null>(null);
  const [resumedCheckpoint, setResumedCheckpoint] = useState<LocalRecoveryCheckpoint | null>(
    null,
  );
  const [prepared, setPrepared] = useState<PreparedTargetBackupSession | null>(null);
  const [verified, setVerified] = useState<VerifiedTargetBackupSession | null>(null);
  const [result, setResult] = useState<QuarantineSuccess | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /**
   * Monoton steigende Generation. Jede Promise merkt sich ihren Stand; ein
   * verspätetes Ergebnis darf niemals eine Sitzung wiederherstellen.
   */
  const generationRef = useRef(0);
  /** Synchrone Riegel — der React-Zustand steht im selben Tipp noch nicht. */
  const prepareInFlight = useRef(false);
  const verifyInFlight = useRef(false);
  const quarantineInFlight = useRef(false);
  /** Kurzzeitige Sperre gegen den zweiten Klick desselben Tipps. */
  const downloadInFlight = useRef(false);
  /**
   * Dauerhafter Nachweis für genau diese vorbereitete Sitzung: erst wenn der
   * Download tatsächlich ausgelöst wurde, darf eine Datei geprüft werden.
   * Getrennt von der kurzzeitigen Sperre, damit ein fehlgeschlagener Download
   * wiederholbar bleibt.
   */
  const downloadTriggeredRef = useRef(false);
  /** Nur festhalten, niemals als Abbruch der laufenden Kernfunktion deuten. */
  const targetChangeDetected = useRef(false);
  /** Fremder Quarantänevorgang für dasselbe Ziel, während dieser lief. */
  const parallelMarkerDetected = useRef(false);
  /** Für den storage-Zuhörer, der ohne Neuregistrierung auskommen muss. */
  const selectedKeyRef = useRef<string | null>(null);
  const resultRef = useRef<QuarantineSuccess | null>(null);

  const resetSessionRefs = useCallback(() => {
    downloadInFlight.current = false;
    downloadTriggeredRef.current = false;
  }, []);

  const invalidateSession = useCallback(
    (next: UiState, text: string | null) => {
      generationRef.current += 1;
      resetSessionRefs();
      setPrepared(null);
      setVerified(null);
      setDownloadError(null);
      setMessage(text);
      setState(next);
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    [resetSessionRefs],
  );

  useEffect(
    () => () => {
      // Unmount entwertet jede noch laufende Promise.
      generationRef.current += 1;
      resetSessionRefs();
      selectedKeyRef.current = null;
      resultRef.current = null;
      targetChangeDetected.current = false;
      parallelMarkerDetected.current = false;
    },
    [resetSessionRefs],
  );

  /**
   * storage-Ereignisse melden ausschließlich Änderungen anderer Tabs. Sie sind
   * Frühwarnung, niemals Sicherheitsbeweis — verbindlich bleiben die
   * vollständigen Hashvergleiche im Kern.
   *
   * Drei klar getrennte Fälle: Quarantänemarker eines anderen Tabs, Änderung
   * während einer laufenden Quarantäne und Änderung davor beziehungsweise
   * danach.
   */
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      const key = event.key;

      if (key !== null && key.startsWith(QUARANTINE_MARKER_PREFIX)) {
        // Rein lesende Aktualisierung: kein Bereinigen, kein IndexedDB.
        const next = listQuarantineMarkers();
        setMarkers(next);
        /**
         * Nach dem Abschluss bleibt der Bericht unangetastet: weder `result`
         * noch `verified` werden gelöscht und der Zustand wechselt nicht.
         */
        if (resultRef.current) return;
        /**
         * Während der Quarantäne wird nichts entwertet: die laufende
         * Kernfunktion ist nicht abbrechbar, und ein Löschen von `prepared`
         * oder `verified` würde den späteren Bericht unvollständig machen.
         * Der Fund wird nur vermerkt und danach als Warnung ausgewiesen.
         */
        if (quarantineInFlight.current) {
          parallelMarkerDetected.current = true;
          return;
        }
        const current = selectedKeyRef.current;
        if (
          current &&
          next.some(
            (marker) => marker.status === 'staging' && marker.sourceStorageKey === current,
          )
        ) {
          invalidateSession('staging_blocked', t('localRecoveryImport.msg.stagingCreated', langRef.current));
        }
        return;
      }

      const current = selectedKeyRef.current;
      if (!current) return;
      if (key !== null && key !== current) return;

      if (quarantineInFlight.current) {
        // Die laufende Kernfunktion kann nicht abgebrochen werden. Nur merken.
        targetChangeDetected.current = true;
        return;
      }

      if (resultRef.current) {
        // Nach dem Abschluss bleibt der Bericht vollständig erhalten.
        targetChangeDetected.current = true;
        setState('quarantine_complete_with_target_change');
        return;
      }

      generationRef.current += 1;
      resetSessionRefs();
      // Auch die Ref leeren: ein späteres Ereignis des alten Schlüssels darf
      // nicht mehr als Ereignis des aktuellen Ziels gelten.
      selectedKeyRef.current = null;
      setSelectedKey(null);
      setPrepared(null);
      setVerified(null);
      setDownloadError(null);
      setMessage(t('localRecoveryImport.msg.targetChangedElsewhere', langRef.current));
      setState('session_lost');
      if (fileInputRef.current) fileInputRef.current.value = '';
    };

    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [invalidateSession, resetSessionRefs]);

  const stagingForKey = (storageKey: string): QuarantineMarker | undefined =>
    markers.find((marker) => marker.status === 'staging' && marker.sourceStorageKey === storageKey);

  /**
   * Während der Quarantäne und nach dem Abschluss ist die Auswahl gesperrt.
   *
   * Während `prepare` oder `verify` bleibt sie bewusst offen: ein Zielwechsel
   * ist dort ein legitimer Abbruch. Er erhöht die Generation, wodurch das
   * verspätete Ergebnis des alten Ziels verworfen wird.
   */
  const selectionLocked =
    quarantineInFlight.current ||
    result !== null ||
    state === 'quarantining' ||
    state === 'quarantine_complete' ||
    state === 'quarantine_complete_with_target_change';

  const handleSelect = (copy: LocalScopeCopy) => {
    if (quarantineInFlight.current || resultRef.current !== null) {
      return;
    }
    generationRef.current += 1;
    resetSessionRefs();
    setPrepared(null);
    setVerified(null);
    setResult(null);
    resultRef.current = null;
    setMessage(null);
    setDownloadError(null);
    // Alle Risikovermerke gehören zur alten Sitzung.
    targetChangeDetected.current = false;
    parallelMarkerDetected.current = false;
    if (fileInputRef.current) fileInputRef.current.value = '';
    selectedKeyRef.current = copy.storageKey;
    // MOBILE-SAFE-RESUME-01B — Anzeigewerte für einen späteren Wiederaufsetzpunkt.
    selectedCompanyNameRef.current = copy.setupCompanyName ?? copy.profileCompanyName ?? '';
    selectedSavedAtRef.current = copy.savedAt ?? null;
    // Eine neue Zielwahl macht jeden alten Wiederaufsetzpunkt ungültig.
    clearLocalRecoveryCheckpoint();
    setSelectedKey(copy.storageKey);
    setState(stagingForKey(copy.storageKey) ? 'staging_blocked' : 'target_selected');
  };

  const handlePrepare = async () => {
    if (prepareInFlight.current || !selectedKey) return;
    if (stagingForKey(selectedKey)) return;
    prepareInFlight.current = true;
    resetSessionRefs();
    const generation = generationRef.current;
    setState('preparing');
    setMessage(null);
    setDownloadError(null);
    try {
      // EINRICHTUNG-01 (E8) — unmittelbar vor der Vorbereitung erneut beim Server bestätigen.
      const bestaetigt = await confirm();
      if (generation !== generationRef.current) return;
      if (!isRecoveryCopyReleased(selectedKey, bestaetigt)) {
        setMessage(t('localRecoveryImport.msg.confirmBeforeBackupFailed', lang));
        setState('blocked_error');
        return;
      }
      const outcome = await prepareTargetBackupSession(selectedKey);
      if (generation !== generationRef.current) return; // verspätet — verwerfen
      if (!outcome.ok) {
        setMessage(t('localRecoveryImport.msg.prepareFailedReason', lang, { reason: outcome.reason }));
        setState('blocked_error');
        return;
      }
      setPrepared(outcome.session);
      /*
       * MOBILE-SAFE-RESUME-01B — die Vorbereitung schreibt bewusst **nichts**;
       * diese Zusicherung bleibt unangetastet. Der Wiederaufsetzpunkt entsteht
       * erst nach einem erfolgreich ausgelösten Download.
       */
      setState('prepared_validated');
    } catch {
      if (generation !== generationRef.current) return;
      setMessage(t('localRecoveryImport.msg.prepareFailed', lang));
      setState('blocked_error');
    } finally {
      prepareInFlight.current = false;
    }
  };

  /**
   * Zwei getrennte Riegel: `downloadInFlight` verhindert den zweiten Klick
   * desselben Tipps, `downloadTriggeredRef` hält dauerhaft fest, dass der
   * Download für genau diese Sitzung ausgelöst wurde. Scheitert der Download,
   * bleibt der dauerhafte Nachweis false und der Vorgang wiederholbar.
   */
  const handleDownload = () => {
    if (downloadInFlight.current || downloadTriggeredRef.current || !prepared) return;
    downloadInFlight.current = true;
    try {
      triggerZipDownload(prepared.zipBlob, prepared.suggestedFilename);
      downloadTriggeredRef.current = true;
      // Erst nach erfolgreichem Auslösen — ein gescheiterter Download ändert nichts.
      writeLocalRecoveryCheckpoint({
        stage: 'download_triggered',
        sourceStorageKey: prepared.sourceStorageKey,
        sourceScopeKey: prepared.sourceScopeKey,
        workspaceId: prepared.workspaceId,
        companyName: selectedCompanyNameRef.current,
        sourceRawTextSha256: prepared.sourceRawTextSha256,
        archiveSha256: prepared.archiveSha256,
        suggestedFilename: prepared.suggestedFilename,
        targetSavedAt: selectedSavedAtRef.current,
      });
      setDownloadError(null);
      setMessage(null);
      setState('download_triggered');
    } catch {
      setDownloadError(t('localRecoveryImport.msg.downloadFailed', lang));
    } finally {
      downloadInFlight.current = false;
    }
  };

  /**
   * Fail-closed: eine Datei wird ausschließlich in genau einem Zustand geprüft
   * — nach ausgelöstem Download und vor der Verifikation. Danach, während der
   * Quarantäne und nach dem Abschluss bleibt jedes weitere Dateiereignis des
   * versteckten Feldes vollständig wirkungslos.
   */
  const handleFileChosen = async (file: File | undefined) => {
    if (!file) return;
    if (resultRef.current !== null) return;
    if (quarantineInFlight.current) return;
    if (verifyInFlight.current) return;
    if (verified !== null) return;
    if (state !== 'download_triggered') return;
    if (!prepared || !downloadTriggeredRef.current) return;
    verifyInFlight.current = true;
    const generation = generationRef.current;
    setState('reselect_checking');
    try {
      const outcome = await verifyReselectedTargetBackup(prepared, file);
      if (generation !== generationRef.current) return;
      if (!outcome.ok) {
        // Ungleich: der Ablauf beginnt wieder vor der Vorbereitung.
        invalidateSession('reselect_mismatch', t('localRecoveryImport.msg.reselectMismatch', lang, { reason: outcome.reason }));
        return;
      }
      setVerified(outcome.session);
      setMessage(null);
      setState('reselect_confirmed');
    } catch {
      if (generation !== generationRef.current) return;
      invalidateSession('reselect_mismatch', t('localRecoveryImport.msg.reselectUnreadable', lang));
    } finally {
      verifyInFlight.current = false;
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleQuarantine = async () => {
    if (quarantineInFlight.current || !verified) return;
    quarantineInFlight.current = true;
    targetChangeDetected.current = false;
    parallelMarkerDetected.current = false;
    setState('quarantining');
    setMessage(null);
    try {
      // EINRICHTUNG-01 (E8) — unmittelbar vor der Quarantäne erneut beim Server bestätigen.
      const ziel = selectedKeyRef.current;
      const bestaetigt = await confirm();
      if (!ziel || !isRecoveryCopyReleased(ziel, bestaetigt)) {
        setMessage(t('localRecoveryImport.msg.confirmBeforeQuarantineFailed', lang));
        setState('blocked_error');
        return;
      }
      const outcome = await createTargetQuarantine(verified);
      if (!outcome.ok) {
        setMessage(t('localRecoveryImport.msg.quarantineFailedReason', lang, { reason: outcome.reason }));
        setState('blocked_error');
        setMarkers(listQuarantineMarkers());
        return;
      }
      resultRef.current = outcome;
      setResult(outcome);
      // Die Quarantäne ist abgeschlossen — der Wiederaufsetzpunkt ist verbraucht.
      clearLocalRecoveryCheckpoint();
      setResumedCheckpoint(null);
      setMarkers(listQuarantineMarkers());
      setState(
        targetChangeDetected.current || parallelMarkerDetected.current
          ? 'quarantine_complete_with_target_change'
          : 'quarantine_complete',
      );
    } catch {
      setMessage(t('localRecoveryImport.msg.quarantineFailed', lang));
      setState('blocked_error');
    } finally {
      quarantineInFlight.current = false;
    }
  };

  /**
   * MOBILE-SAFE-RESUME-01B — genau einmal beim Montieren. Der Punkt wird nur
   * übernommen, wenn Speicherschlüssel und Ausgangszeitpunkt des Zielbestands
   * noch übereinstimmen. Es wird **nichts** ausgeführt: keine Quarantäne, keine
   * Bereinigung, kein Cloud-Zugriff, keine Prüfsummenprüfung. Der Ablauf endet
   * auf einer sicheren Stufe, auf der die Sicherung neu vorbereitet und die
   * Quarantäne ausdrücklich erneut bestätigt werden muss.
   */
  const checkpointStartedRef = useRef(false);
  useEffect(() => {
    /*
     * EINRICHTUNG-01 (E8) — erst wenn feststeht, wer angemeldet ist, und nur auf der Ausgangsstufe: Ein laufender
     * Ablauf wird nie durch einen Wiederaufsetzpunkt ersetzt. Ohne Freigabe bleibt der Punkt unangetastet liegen;
     * nach einer bestätigten Anmeldung wird er einmal geprüft.
     */
    if (checkpointStartedRef.current) return;
    if (identity.state === 'checking') return;
    if (state !== 'inventory' || selectedKeyRef.current !== null) {
      checkpointStartedRef.current = true;
      return;
    }
    const stored = readLocalRecoveryCheckpoint();
    if (!stored) {
      checkpointStartedRef.current = true;
      return;
    }
    if (!isRecoveryCopyReleased(stored.sourceStorageKey, identity)) {
      if (identity.state === 'confirmed') checkpointStartedRef.current = true;
      return;
    }
    checkpointStartedRef.current = true;

    const match = matchLocalRecoveryCheckpoint({
      checkpoint: stored,
      targets: targets.map((copy) => ({
        storageKey: copy.storageKey,
        savedAt: copy.savedAt,
      })),
    });
    if (!match.ok) {
      // Zielbestand fehlt oder hat sich verändert: der Punkt ist wertlos.
      clearLocalRecoveryCheckpoint();
      if (match.reason === 'target_changed') {
        setMessage(t('localRecoveryImport.msg.targetChangedSinceBackup', langRef.current));
      }
      return;
    }

    selectedKeyRef.current = match.checkpoint.sourceStorageKey;
    selectedCompanyNameRef.current = match.checkpoint.companyName;
    selectedSavedAtRef.current = match.checkpoint.targetSavedAt;
    setSelectedKey(match.checkpoint.sourceStorageKey);
    setResumedCheckpoint(match.checkpoint);
    setState('resumed_after_download');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- einmal, sobald die Identität feststeht
  }, [identity]);
  const selectedCopy = targets.find((copy) => copy.storageKey === selectedKey) ?? null;
  const blockingMarker = selectedKey ? stagingForKey(selectedKey) : undefined;
  const finished = result !== null;
  const showDownload = !finished && state === 'prepared_validated' && prepared !== null;
  // Nach erfolgreicher Verifikation gibt es keinen Auswahlweg mehr.
  const showChooseFile =
    !finished &&
    prepared !== null &&
    verified === null &&
    downloadTriggeredRef.current &&
    (state === 'download_triggered' || state === 'reselect_checking');
  const showStart = !finished && state === 'reselect_confirmed' && verified !== null;
  const showPrepare =
    !finished &&
    selectedCopy !== null &&
    !blockingMarker &&
    !showDownload &&
    !showChooseFile &&
    state !== 'quarantining';

  return (
    <div className="auth-page local-recovery-import-page" data-testid="local-recovery-import-page">
      <DocumentLanguage language={lang} />
      {/* EINRICHTUNG-01 (AP9-Nacharbeit; 1.32) — erstes fokussierbares Element. App-Eigenprüfung (1.31, E-9): alle Texte
          der Seite kommen aus den Sprachdateien (`localRecoveryImport.*`), in der Sprache wie auf /local-recovery. */}
      <SkipLink
        href="#local-recovery-import-title"
        label={t('a11y.skipToContent', lang)}
        findTarget={() => document.getElementById('local-recovery-import-title')}
      />
      <div className="auth-card">
        <header className="auth-card__header">
          <p className="auth-card__brand">OfficeTakt</p>
          <h1 className="auth-card__title" id="local-recovery-import-title" tabIndex={-1}>
            {t('localRecoveryImport.title', lang)}
          </h1>
          <p className="auth-card__subtitle">{t('localRecoveryImport.intro', lang)}</p>
        </header>

        <dl className="local-recovery-import-details" data-testid="import-origin">
          <DetailRow field="origin" label={t('localRecoveryImport.label.origin', lang)} value={inventory.origin} />
        </dl>

        <RecoveryIdentityPanel
          identity={identity}
          lang={lang}
          hiddenBoundCount={hiddenTargetCount}
          loginBusy={loginBusy}
          loginError={loginError}
          onLogin={login}
          onLogout={async () => {
            // Ohne Anmeldung gehört keine laufende Sitzung mehr zu einem sichtbaren Ziel.
            if (!quarantineInFlight.current && resultRef.current === null) {
              selectedKeyRef.current = null;
              setSelectedKey(null);
              invalidateSession('inventory', null);
            }
            await logout();
          }}
        />

        {visibleMarkers.length > 0 ? (
          <section data-testid="import-marker-list">
            <h2 className="local-recovery-item__headline">{t('localRecoveryImport.markers.title', lang)}</h2>
            {visibleMarkers.map((marker) => (
              <dl
                className="local-recovery-import-details"
                key={marker.token}
                data-testid={`import-marker-${marker.token}`}
              >
                <DetailRow
                  field="status"
                  label={t('localRecoveryImport.label.status', lang)}
                  value={marker.status}
                  technical={false}
                />
                <DetailRow field="token" label={t('localRecoveryImport.label.token', lang)} value={marker.token} />
                <DetailRow
                  field="sourceStorageKey"
                  label={t('localRecoveryImport.label.storageKey', lang)}
                  value={marker.sourceStorageKey}
                />
              </dl>
            ))}
            <p className="form-hint">{t('localRecoveryImport.markers.note', lang)}</p>
          </section>
        ) : null}

        {!finished ? (
          <section>
            <h2 className="local-recovery-item__headline">{t('localRecoveryImport.step1.title', lang)}</h2>
            <p className="form-hint">{t('localRecoveryImport.step1.hint', lang)}</p>
            {targets.length === 0 ? (
              <p className="form-hint" data-testid="import-no-targets">
                {t('localRecoveryImport.noTargets', lang)}
              </p>
            ) : null}
            <ul className="local-recovery-list">
              {targets.map((copy) => (
                <li key={copy.storageKey} className="local-recovery-item">
                  <button
                    type="button"
                    className="btn btn--outline btn--full local-recovery-import-target"
                    data-testid={`import-target-option-${copy.storageKey}`}
                    disabled={selectionLocked}
                    onClick={() => handleSelect(copy)}
                  >
                    {/*
                      Eine fachliche Angabe je Zeile. Zuvor zwang die globale
                      Regel `.btn` die verketteten Spans zentriert in eine
                      einzige Zeile; auf dem Smartphone lief die Karte beidseitig
                      aus, und eine sichere Zielprüfung vor dem Antippen war
                      nicht möglich.
                    */}
                    <span className="local-recovery-import-target__row" data-field="storageKey">
                      <span className="local-recovery-import-target__label">
                        {t('localRecoveryImport.label.storageKey', lang)}
                      </span>
                      <span className="local-recovery-import-target__value local-recovery-import-target__value--technical">
                        {copy.storageKey}
                      </span>
                    </span>
                    <span className="local-recovery-import-target__row" data-field="workspaceId">
                      <span className="local-recovery-import-target__label">
                        {t('localRecoveryImport.label.workspace', lang)}
                      </span>
                      <span className="local-recovery-import-target__value local-recovery-import-target__value--technical">
                        {copy.scopeId ?? t('localRecoveryImport.value.unknown', lang)}
                      </span>
                    </span>
                    <span className="local-recovery-import-target__row" data-field="setupCompany">
                      <span className="local-recovery-import-target__label">
                        {t('localRecoveryImport.label.setupCompany', lang)}
                      </span>
                      <span className="local-recovery-import-target__value">
                        {copy.setupCompanyName ?? t('localRecoveryImport.value.none', lang)}
                      </span>
                    </span>
                    <span className="local-recovery-import-target__row" data-field="profileCompany">
                      <span className="local-recovery-import-target__label">
                        {t('localRecoveryImport.label.profileCompany', lang)}
                      </span>
                      <span className="local-recovery-import-target__value">
                        {copy.profileCompanyName ?? t('localRecoveryImport.value.none', lang)}
                      </span>
                    </span>
                    <span className="local-recovery-import-target__row" data-field="savedAt">
                      <span className="local-recovery-import-target__label">
                        {t('localRecoveryImport.label.savedAt', lang)}
                      </span>
                      <span className="local-recovery-import-target__value">
                        {copy.savedAt ?? t('localRecoveryImport.value.none', lang)}
                      </span>
                    </span>
                    <span className="local-recovery-import-target__row" data-field="counts">
                      <span className="local-recovery-import-target__label">
                        {t('localRecoveryImport.label.counts', lang)}
                      </span>
                      <span className="local-recovery-import-target__value">
                        {copy.vorgangCount} / {copy.documentCount}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {selectedCopy && !finished ? (
          <dl className="local-recovery-import-details" data-testid="import-selected-target">
            <DetailRow
              field="storageKey"
              label={t('localRecoveryImport.label.selected', lang)}
              value={selectedCopy.storageKey}
            />
          </dl>
        ) : null}

        {state === 'resumed_after_download' && resumedCheckpoint ? (
          <section className="local-recovery-import-resume" data-testid="import-resumed">
            <p className="form-hint">{t('localRecoveryImport.resumed.text', lang)}</p>
            <dl className="local-recovery-import-details">
              <DetailRow
                field="storageKey"
                label={t('localRecoveryImport.label.selected', lang)}
                value={resumedCheckpoint.sourceStorageKey}
              />
              <DetailRow
                field="workspaceId"
                label={t('localRecoveryImport.label.workspace', lang)}
                value={resumedCheckpoint.workspaceId}
              />
              <DetailRow
                field="archiveSha256"
                label={t('localRecoveryImport.label.expectedArchiveSha', lang)}
                value={resumedCheckpoint.archiveSha256}
              />
              <DetailRow
                field="suggestedFilename"
                label={t('localRecoveryImport.label.backupFilename', lang)}
                value={resumedCheckpoint.suggestedFilename}
              />
              <DetailRow
                field="savedAt"
                label={t('localRecoveryImport.label.targetSavedAt', lang)}
                value={resumedCheckpoint.targetSavedAt ?? t('localRecoveryImport.value.none', lang)}
                technical={false}
              />
            </dl>
            <p className="form-hint">{t('localRecoveryImport.resumed.hint', lang)}</p>
          </section>
        ) : null}

        {/* Während des eigenen Laufs wäre dieser Hinweis irreführend: der
            Vorgang ist nicht blockiert, sondern läuft bereits. */}
        {blockingMarker && !finished && state !== 'quarantining' ? (
          <div className="form-error" role="alert" data-testid="import-staging-blocked">
            <p className="local-recovery-import-detail-label">{t('localRecoveryImport.staging.blocked', lang)}</p>
            <dl className="local-recovery-import-details">
              <DetailRow field="token" label={t('localRecoveryImport.label.token', lang)} value={blockingMarker.token} />
              <DetailRow
                field="workspaceId"
                label={t('localRecoveryImport.label.workspace', lang)}
                value={blockingMarker.workspaceId}
              />
              <DetailRow
                field="createdAt"
                label={t('localRecoveryImport.label.startedAt', lang)}
                value={blockingMarker.createdAt}
                technical={false}
              />
              <DetailRow
                field="archiveSha256"
                label={t('localRecoveryImport.label.archiveSha', lang)}
                value={blockingMarker.archiveSha256}
              />
              <DetailRow
                field="fileCount"
                label={t('localRecoveryImport.label.expectedFiles', lang)}
                value={blockingMarker.files.length}
                technical={false}
              />
            </dl>
          </div>
        ) : null}

        {showPrepare ? (
          <button
            type="button"
            className="btn btn--outline btn--full"
            data-testid="import-prepare"
            disabled={state === 'preparing'}
            onClick={() => {
              void handlePrepare();
            }}
          >
            {t('localRecoveryImport.step2.action', lang)}
          </button>
        ) : null}

        {prepared && (showDownload || showChooseFile) ? (
          <dl className="local-recovery-import-details" data-testid="import-prepare-result">
            <DetailRow
              field="storageKey"
              label={t('localRecoveryImport.label.storageKey', lang)}
              value={prepared.sourceStorageKey}
            />
            <DetailRow field="workspaceId" label={t('localRecoveryImport.label.workspace', lang)} value={prepared.workspaceId} />
            <DetailRow
              field="fileCount"
              label={t('localRecoveryImport.label.files', lang)}
              value={prepared.files.length}
              technical={false}
            />
            <DetailRow
              field="archiveSha256"
              label={t('localRecoveryImport.label.archiveSha', lang)}
              value={prepared.archiveSha256}
            />
          </dl>
        ) : null}

        {showDownload ? (
          <button
            type="button"
            className="btn btn--outline btn--full"
            data-testid="import-download"
            onClick={handleDownload}
          >
            {t('localRecoveryImport.step3.action', lang)}
          </button>
        ) : null}

        {downloadError ? (
          <p className="form-error" role="alert" data-testid="import-download-error">
            {downloadError}
          </p>
        ) : null}

        {/* Das Feld bleibt im Dokument, damit es nach jedem Fehler leerbar ist.
            Ohne ausgelösten Download lehnt handleFileChosen jede Datei ab. */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,application/zip"
          className="backup-export-panel__file-input"
          // EINRICHTUNG-01 (AP9-Nacharbeit; 1.32, 1.33) — die versteckte Datei-Eingabe trägt einen Namen (wie der Knopf)
          // und ist kein unsichtbarer Tabulatorstopp; bedient wird sie über den sichtbaren Knopf (wie in BackupExportPanel).
          aria-label={t('localRecoveryImport.fileInput.label', lang)}
          tabIndex={-1}
          data-testid="import-file-input"
          onChange={(event) => {
            void handleFileChosen(event.target.files?.[0]);
          }}
        />

        {showChooseFile ? (
          <>
            <p className="form-hint" data-testid="import-reselect-hint">
              {t('localRecoveryImport.reselect.hint', lang)}
            </p>
            <button
              type="button"
              className="btn btn--outline btn--full"
              data-testid="import-choose-file"
              disabled={state === 'reselect_checking'}
              onClick={() => fileInputRef.current?.click()}
            >
              {t('localRecoveryImport.step4.action', lang)}
            </button>
          </>
        ) : null}

        {state === 'reselect_mismatch' ? (
          <p className="form-error" role="alert" data-testid="import-reselect-mismatch">
            {message}
          </p>
        ) : null}

        {verified && showStart ? (
          <p className="form-hint" data-testid="import-verify-result">
            {t('localRecoveryImport.verify.result', lang, { count: verified.files.length })}
          </p>
        ) : null}

        {showStart ? (
          <button
            type="button"
            className="btn btn--outline btn--full"
            data-testid="import-start-quarantine"
            onClick={() => {
              void handleQuarantine();
            }}
          >
            {t('localRecoveryImport.step5.action', lang)}
          </button>
        ) : null}

        {state === 'quarantining' ? (
          <p className="form-hint" role="status" data-testid="import-quarantine-busy">
            {t('localRecoveryImport.quarantine.busy', lang)}
          </p>
        ) : null}

        {state === 'session_lost' ? (
          <p className="form-error" role="alert" data-testid="import-session-lost">
            {message}
          </p>
        ) : null}

        {state === 'blocked_error' ? (
          <p className="form-error" role="alert" data-testid="import-error">
            {message}
          </p>
        ) : null}

        {result ? (
          <section data-testid="import-report">
            <h2 className="local-recovery-item__headline">{t('localRecoveryImport.report.title', lang)}</h2>
            {/* Quelle unverändert: result.marker, result.token und die drei
                Schlüssel aus QuarantineSuccess — nichts wird aus dem Token
                nachgerechnet und nichts erneut aus localStorage gelesen. */}
            <dl className="local-recovery-import-details">
              <DetailRow
                field="sourceStorageKey"
                label={t('localRecoveryImport.label.targetStorageKey', lang)}
                value={result.marker.sourceStorageKey}
              />
              <DetailRow
                field="sourceScopeKey"
                label={t('localRecoveryImport.label.targetScopeKey', lang)}
                value={result.marker.sourceScopeKey}
              />
              <DetailRow
                field="workspaceId"
                label={t('localRecoveryImport.label.workspace', lang)}
                value={result.marker.workspaceId}
              />
              <DetailRow
                field="savedAt"
                label={t('localRecoveryImport.label.savedAt', lang)}
                value={verified?.bundle.savedAt ?? t('localRecoveryImport.value.none', lang)}
              />
              <DetailRow
                field="archiveSha256"
                label={t('localRecoveryImport.label.archiveSha', lang)}
                value={result.marker.archiveSha256}
              />
              <DetailRow
                field="sourceRawTextSha256"
                label={t('localRecoveryImport.label.rawSha', lang)}
                value={result.marker.sourceRawTextSha256}
              />
              <DetailRow
                field="fileCount"
                label={t('localRecoveryImport.label.files', lang)}
                value={result.marker.files.length}
                technical={false}
              />
              <DetailRow field="token" label={t('localRecoveryImport.label.quarantineToken', lang)} value={result.token} />
              <DetailRow field="markerKey" label={t('localRecoveryImport.label.markerKey', lang)} value={result.markerKey} />
              <DetailRow field="stateKey" label={t('localRecoveryImport.label.stateKey', lang)} value={result.stateKey} />
              <DetailRow
                field="quarantineScopeKey"
                label={t('localRecoveryImport.label.quarantineScopeKey', lang)}
                value={result.quarantineScopeKey}
              />
              <DetailRow
                field="completedAt"
                label={t('localRecoveryImport.label.completedAt', lang)}
                value={result.marker.completedAt ?? result.marker.createdAt}
              />
              <DetailRow
                field="status"
                label={t('localRecoveryImport.label.status', lang)}
                value={result.marker.status}
                technical={false}
              />
            </dl>

            <ul className="local-recovery-list">
              {result.marker.files.map((file) => (
                <li
                  className="local-recovery-item"
                  key={file.fileRefId}
                  data-file={file.fileRefId}
                >
                  <dl className="local-recovery-import-details">
                    <DetailRow field="fileRefId" label={t('localRecoveryImport.label.fileRefId', lang)} value={file.fileRefId} />
                    <DetailRow
                      field="localDataKey"
                      label={t('localRecoveryImport.label.dataKey', lang)}
                      value={file.localDataKey}
                    />
                    <DetailRow field="mimeType" label={t('localRecoveryImport.label.mimeType', lang)} value={file.mimeType} />
                    <DetailRow
                      field="fileSize"
                      label={t('localRecoveryImport.label.size', lang)}
                      value={t('localRecoveryImport.value.bytes', lang, { size: file.fileSize })}
                      technical={false}
                    />
                    <DetailRow field="sha256" label={t('localRecoveryImport.label.sha256', lang)} value={file.sha256} />
                  </dl>
                </li>
              ))}
            </ul>

            <p className="form-hint" data-testid="import-report-note">
              {t('localRecoveryImport.report.note', lang)}
            </p>

            {state === 'quarantine_complete_with_target_change' ? (
              <p className="form-error" role="alert" data-testid="import-report-target-change">
                {t('localRecoveryImport.targetChangeWarning', lang)}
              </p>
            ) : null}
          </section>
        ) : null}

        <p className="form-hint" data-testid="import-readonly-note">
          {t('localRecoveryImport.readonlyNote', lang)}
        </p>
      </div>
    </div>
  );
}
