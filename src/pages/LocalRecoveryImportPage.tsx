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
 */
type UiState =
  | 'inventory'
  | 'target_selected'
  | 'preparing'
  | 'prepared_validated'
  | 'download_triggered'
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

const TARGET_CHANGE_WARNING =
  'Während des Vorgangs oder danach wurde eine Änderung am Zielbereich oder ein weiterer ' +
  'Quarantänevorgang für dieses Ziel erkannt. Dieser Stand ist für keinen weiteren Schritt ' +
  'freigegeben. Beginnen Sie später vollständig neu.';

export function LocalRecoveryImportPage() {
  // Einmalige, rein lesende Momentaufnahme — kein Polling, keine Abos.
  const inventory = useMemo(() => readLocalScopeInventory(), []);
  const [markers, setMarkers] = useState<QuarantineMarker[]>(() => listQuarantineMarkers());

  const [state, setState] = useState<UiState>('inventory');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
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
          invalidateSession(
            'staging_blocked',
            'Für diesen Bereich wurde inzwischen ein unvollständiger Quarantänevorgang angelegt. Der vorbereitete Stand wurde verworfen.',
          );
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
      setMessage(
        'Der Zielbereich wurde von einer anderen Ansicht verändert. Der Vorgang wurde verworfen. Bitte wählen Sie den Bereich erneut ausdrücklich aus.',
      );
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
      const outcome = await prepareTargetBackupSession(selectedKey);
      if (generation !== generationRef.current) return; // verspätet — verwerfen
      if (!outcome.ok) {
        setMessage(`Die Zielsicherung konnte nicht erzeugt werden: ${outcome.reason}`);
        setState('blocked_error');
        return;
      }
      setPrepared(outcome.session);
      setState('prepared_validated');
    } catch {
      if (generation !== generationRef.current) return;
      setMessage('Die Zielsicherung konnte nicht erzeugt werden.');
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
      setDownloadError(null);
      setMessage(null);
      setState('download_triggered');
    } catch {
      setDownloadError(
        'Der Download konnte nicht ausgelöst werden. Es wurde nichts gespeichert — bitte erneut versuchen.',
      );
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
        invalidateSession(
          'reselect_mismatch',
          `Die gewählte Datei ist nicht die soeben erzeugte Zielsicherung (${outcome.reason}). Es wurde nichts gespeichert und nichts importiert. Bitte erzeugen Sie die Sicherung erneut.`,
        );
        return;
      }
      setVerified(outcome.session);
      setMessage(null);
      setState('reselect_confirmed');
    } catch {
      if (generation !== generationRef.current) return;
      invalidateSession(
        'reselect_mismatch',
        'Die gewählte Datei konnte nicht gelesen werden. Es wurde nichts gespeichert.',
      );
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
      const outcome = await createTargetQuarantine(verified);
      if (!outcome.ok) {
        setMessage(`Die Quarantänekopie wurde nicht angelegt: ${outcome.reason}`);
        setState('blocked_error');
        setMarkers(listQuarantineMarkers());
        return;
      }
      resultRef.current = outcome;
      setResult(outcome);
      setMarkers(listQuarantineMarkers());
      setState(
        targetChangeDetected.current || parallelMarkerDetected.current
          ? 'quarantine_complete_with_target_change'
          : 'quarantine_complete',
      );
    } catch {
      setMessage('Die Quarantänekopie wurde nicht angelegt.');
      setState('blocked_error');
    } finally {
      quarantineInFlight.current = false;
    }
  };

  const targets = inventory.copies.filter((copy) => copy.scopeType === 'workspace' && copy.valid);
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
      <div className="auth-card">
        <header className="auth-card__header">
          <p className="auth-card__brand">OfficePilot</p>
          <h1 className="auth-card__title">Zielsicherung und Quarantäne</h1>
          <p className="auth-card__subtitle">
            Diese Seite sichert ausschließlich den vorhandenen lokalen Bestand dieser Adresse und
            legt eine örtliche Quarantänekopie an. Es wird nichts importiert, nichts ersetzt und
            kein Cloud-Abgleich gestartet.
          </p>
        </header>

        <dl className="local-recovery-import-details" data-testid="import-origin">
          <DetailRow field="origin" label="Adresse" value={inventory.origin} />
        </dl>

        {markers.length > 0 ? (
          <section data-testid="import-marker-list">
            <h2 className="local-recovery-item__headline">Vorhandene Quarantänevorgänge</h2>
            {markers.map((marker) => (
              <dl
                className="local-recovery-import-details"
                key={marker.token}
                data-testid={`import-marker-${marker.token}`}
              >
                <DetailRow
                  field="status"
                  label="Status"
                  value={marker.status}
                  technical={false}
                />
                <DetailRow field="token" label="Kennung" value={marker.token} />
                <DetailRow
                  field="sourceStorageKey"
                  label="Speicherschlüssel"
                  value={marker.sourceStorageKey}
                />
              </dl>
            ))}
            <p className="form-hint">
              Vorhandene Vorgänge werden hier nur angezeigt. Diese Seite entfernt niemals einen
              Marker, eine Hülle oder eine Datei.
            </p>
          </section>
        ) : null}

        {!finished ? (
          <section>
            <h2 className="local-recovery-item__headline">1. Zielbereich auswählen</h2>
            <p className="form-hint">
              Es wird nichts vorausgewählt. Wählen Sie den Bereich ausdrücklich aus — auch dann,
              wenn nur einer angeboten wird.
            </p>
            {targets.length === 0 ? (
              <p className="form-hint" data-testid="import-no-targets">
                Auf dieser Adresse liegt kein gültiger Arbeitsbereich.
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
                      <span className="local-recovery-import-target__label">Speicherschlüssel</span>
                      <span className="local-recovery-import-target__value local-recovery-import-target__value--technical">
                        {copy.storageKey}
                      </span>
                    </span>
                    <span className="local-recovery-import-target__row" data-field="workspaceId">
                      <span className="local-recovery-import-target__label">Arbeitsbereich</span>
                      <span className="local-recovery-import-target__value local-recovery-import-target__value--technical">
                        {copy.scopeId ?? 'unbekannt'}
                      </span>
                    </span>
                    <span className="local-recovery-import-target__row" data-field="setupCompany">
                      <span className="local-recovery-import-target__label">
                        Firma (Einrichtung)
                      </span>
                      <span className="local-recovery-import-target__value">
                        {copy.setupCompanyName ?? 'ohne Angabe'}
                      </span>
                    </span>
                    <span className="local-recovery-import-target__row" data-field="profileCompany">
                      <span className="local-recovery-import-target__label">Firma (Profil)</span>
                      <span className="local-recovery-import-target__value">
                        {copy.profileCompanyName ?? 'ohne Angabe'}
                      </span>
                    </span>
                    <span className="local-recovery-import-target__row" data-field="savedAt">
                      <span className="local-recovery-import-target__label">Gespeichert am</span>
                      <span className="local-recovery-import-target__value">
                        {copy.savedAt ?? 'ohne Angabe'}
                      </span>
                    </span>
                    <span className="local-recovery-import-target__row" data-field="counts">
                      <span className="local-recovery-import-target__label">
                        Vorgänge / Dokumente
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
              label="Gewählter Bereich"
              value={selectedCopy.storageKey}
            />
          </dl>
        ) : null}

        {/* Während des eigenen Laufs wäre dieser Hinweis irreführend: der
            Vorgang ist nicht blockiert, sondern läuft bereits. */}
        {blockingMarker && !finished && state !== 'quarantining' ? (
          <div className="form-error" role="alert" data-testid="import-staging-blocked">
            <p className="local-recovery-import-detail-label">
              Für diesen Bereich läuft bereits ein unvollständiger Quarantänevorgang. Er wird hier
              nur angezeigt und nicht angetastet.
            </p>
            <dl className="local-recovery-import-details">
              <DetailRow field="token" label="Kennung" value={blockingMarker.token} />
              <DetailRow
                field="workspaceId"
                label="Arbeitsbereich"
                value={blockingMarker.workspaceId}
              />
              <DetailRow
                field="createdAt"
                label="Begonnen am"
                value={blockingMarker.createdAt}
                technical={false}
              />
              <DetailRow
                field="archiveSha256"
                label="Archiv-SHA-256"
                value={blockingMarker.archiveSha256}
              />
              <DetailRow
                field="fileCount"
                label="Erwartete Dateien"
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
            2. Zielsicherung erzeugen
          </button>
        ) : null}

        {prepared && (showDownload || showChooseFile) ? (
          <dl className="local-recovery-import-details" data-testid="import-prepare-result">
            <DetailRow
              field="storageKey"
              label="Speicherschlüssel"
              value={prepared.sourceStorageKey}
            />
            <DetailRow field="workspaceId" label="Arbeitsbereich" value={prepared.workspaceId} />
            <DetailRow
              field="fileCount"
              label="Dateien"
              value={prepared.files.length}
              technical={false}
            />
            <DetailRow
              field="archiveSha256"
              label="Archiv-SHA-256"
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
            3. Sicherung herunterladen
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
          data-testid="import-file-input"
          onChange={(event) => {
            void handleFileChosen(event.target.files?.[0]);
          }}
        />

        {showChooseFile ? (
          <>
            <p className="form-hint" data-testid="import-reselect-hint">
              Nicht die wiederherzustellende Sicherung. In diesem Schritt wird nichts importiert.
            </p>
            <button
              type="button"
              className="btn btn--outline btn--full"
              data-testid="import-choose-file"
              disabled={state === 'reselect_checking'}
              onClick={() => fileInputRef.current?.click()}
            >
              4. Die soeben heruntergeladene Zielsicherung erneut auswählen
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
            Die gewählte Datei stimmt vollständig mit der erzeugten Sicherung überein:
            Archivprüfwert, Rohzustandsprüfwert, Bereich, Zeitpunkt und alle {verified.files.length}{' '}
            Dateiprüfwerte.
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
            5. Lokale Quarantänekopie anlegen
          </button>
        ) : null}

        {state === 'quarantining' ? (
          <p className="form-hint" role="status" data-testid="import-quarantine-busy">
            Die Quarantänekopie wird angelegt. Bitte diese Seite nicht schließen.
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
            <h2 className="local-recovery-item__headline">Abschlussbericht</h2>
            {/* Quelle unverändert: result.marker, result.token und die drei
                Schlüssel aus QuarantineSuccess — nichts wird aus dem Token
                nachgerechnet und nichts erneut aus localStorage gelesen. */}
            <dl className="local-recovery-import-details">
              <DetailRow
                field="sourceStorageKey"
                label="Ziel-Speicherschlüssel"
                value={result.marker.sourceStorageKey}
              />
              <DetailRow
                field="sourceScopeKey"
                label="Ziel-Bereichsschlüssel"
                value={result.marker.sourceScopeKey}
              />
              <DetailRow
                field="workspaceId"
                label="Arbeitsbereich"
                value={result.marker.workspaceId}
              />
              <DetailRow
                field="savedAt"
                label="Gespeichert am"
                value={verified?.bundle.savedAt ?? 'ohne Angabe'}
              />
              <DetailRow
                field="archiveSha256"
                label="Archiv-SHA-256"
                value={result.marker.archiveSha256}
              />
              <DetailRow
                field="sourceRawTextSha256"
                label="Rohzustands-SHA-256"
                value={result.marker.sourceRawTextSha256}
              />
              <DetailRow
                field="fileCount"
                label="Dateien"
                value={result.marker.files.length}
                technical={false}
              />
              <DetailRow field="token" label="Quarantäne-Kennung" value={result.token} />
              <DetailRow field="markerKey" label="Marker-Schlüssel" value={result.markerKey} />
              <DetailRow field="stateKey" label="Hüllen-Schlüssel" value={result.stateKey} />
              <DetailRow
                field="quarantineScopeKey"
                label="Quarantäne-Dateibereich"
                value={result.quarantineScopeKey}
              />
              <DetailRow
                field="completedAt"
                label="Zeitpunkt"
                value={result.marker.completedAt ?? result.marker.createdAt}
              />
              <DetailRow
                field="status"
                label="Status"
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
                    <DetailRow field="fileRefId" label="FileRef-ID" value={file.fileRefId} />
                    <DetailRow
                      field="localDataKey"
                      label="Datenschlüssel"
                      value={file.localDataKey}
                    />
                    <DetailRow field="mimeType" label="MIME-Typ" value={file.mimeType} />
                    <DetailRow
                      field="fileSize"
                      label="Größe"
                      value={`${file.fileSize} Byte`}
                      technical={false}
                    />
                    <DetailRow field="sha256" label="SHA-256" value={file.sha256} />
                  </dl>
                </li>
              ))}
            </ul>

            <p className="form-hint" data-testid="import-report-note">
              Die lokale Zielsicherung wurde quarantänisiert. Es wurde nichts importiert, nichts
              ersetzt und kein Cloud-Abgleich gestartet.
            </p>

            {state === 'quarantine_complete_with_target_change' ? (
              <p className="form-error" role="alert" data-testid="import-report-target-change">
                {TARGET_CHANGE_WARNING}
              </p>
            ) : null}
          </section>
        ) : null}

        <p className="form-hint" data-testid="import-readonly-note">
          Diese Seite führt keinen Import durch, ersetzt keinen Bestand, entfernt keinen
          Quarantänevorgang, startet keine Synchronisierung und wechselt nicht in die normale
          Anwendung.
        </p>
      </div>
    </div>
  );
}
