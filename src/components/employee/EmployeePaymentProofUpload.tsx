/**
 * P1 MITARBEITERZAHLUNGEN — „Unterschriebene Quittung hochladen".
 *
 * Datei oder Kamera → bestehende Prüfung/Vorschau → ausdrücklich „Als Nachweis
 * speichern" → direkt archiviert und der Zahlung zugeordnet. Die Zielzahlung
 * steht in der Adresse (`?zahlung=…&nachweis=1`); ein Neuladen nach dem
 * Kamerawechsel öffnet deshalb wieder genau dieses Feld.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { InlineNotice } from '../ui/States';
import type { TranslationKey } from '../../i18n';
import type { PendingDocumentIntake } from '../../services/pendingDocumentIntakeService';
import {
  cancelEmployeePaymentProofUpload,
  prepareEmployeePaymentProofUpload,
  saveEmployeePaymentProofUpload,
  type EmployeeProofPrepareError,
  type EmployeeProofSaveError,
  type EmployeeProofUploadDeps,
} from '../../services/employee/employeePaymentProofUploadService';
import { fillText } from './employeePaymentUi';

interface Props {
  paymentId: string;
  deps: EmployeeProofUploadDeps;
  translate: (key: TranslationKey) => string;
  onSaved: (result: { documentId: string; reusedExisting: boolean }) => void;
  onCancel: () => void;
}

const PREPARE_ERRORS: Record<EmployeeProofPrepareError, TranslationKey> = {
  not_permitted: 'employeePayment.proof.notPermitted' as TranslationKey,
  not_found: 'employeePayment.error.notFound' as TranslationKey,
  reversed: 'employeePayment.error.reversed' as TranslationKey,
  too_large: 'employeePayment.proof.tooLarge' as TranslationKey,
  invalid_type: 'employeePayment.proof.invalidType' as TranslationKey,
  preview_failed: 'employeePayment.proof.error' as TranslationKey,
};

const SAVE_ERRORS: Record<EmployeeProofSaveError, TranslationKey> = {
  not_permitted: 'employeePayment.proof.notPermitted' as TranslationKey,
  not_found: 'employeePayment.error.notFound' as TranslationKey,
  reversed: 'employeePayment.error.reversed' as TranslationKey,
  in_progress: 'employeePayment.proof.processing' as TranslationKey,
  duplicate_inbox: 'employeePayment.proof.duplicateInbox' as TranslationKey,
  proof_is_receipt: 'employeePayment.error.proofIsReceipt' as TranslationKey,
  intake_failed: 'employeePayment.proof.error' as TranslationKey,
  filing_failed: 'employeePayment.proof.error' as TranslationKey,
  archive_failed: 'employeePayment.proof.error' as TranslationKey,
  link_failed: 'employeePayment.proof.notLinked' as TranslationKey,
};

export function EmployeePaymentProofUpload({ paymentId, deps, translate: t, onSaved, onCancel }: Props) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef<PendingDocumentIntake | null>(null);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  const [phase, setPhase] = useState<'idle' | 'processing' | 'ready' | 'saving'>('idle');
  const [fileName, setFileName] = useState('');
  const [duplicateDocument, setDuplicateDocument] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);

  /* Eine nicht gespeicherte Vorschau wird beim Verlassen verworfen — nichts bleibt liegen. */
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (pendingRef.current) cancelEmployeePaymentProofUpload(pendingRef.current);
      pendingRef.current = null;
    };
  }, []);

  const discardPending = () => {
    if (pendingRef.current) cancelEmployeePaymentProofUpload(pendingRef.current);
    pendingRef.current = null;
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    discardPending();
    setError(null);
    setDuplicateDocument(false);
    setFileName(file.name);
    setPhase('processing');
    const result = await prepareEmployeePaymentProofUpload(paymentId, file, deps);
    if (!mountedRef.current) {
      // Inzwischen geschlossen: die Vorschau nicht liegen lassen.
      if (result.ok) cancelEmployeePaymentProofUpload(result.pending);
      return;
    }
    if (!result.ok) {
      setError(PREPARE_ERRORS[result.error]);
      setPhase('idle');
      return;
    }
    pendingRef.current = result.pending;
    setDuplicateDocument(result.duplicate?.type === 'document');
    if (result.duplicate?.type === 'inbox') {
      discardPending();
      setError(SAVE_ERRORS.duplicate_inbox);
      setPhase('idle');
      return;
    }
    setPhase('ready');
  };

  const handleSave = async () => {
    const pending = pendingRef.current;
    if (!pending || savingRef.current) return;
    savingRef.current = true;
    setPhase('saving');
    setError(null);
    try {
      const result = await saveEmployeePaymentProofUpload(paymentId, pending, deps);
      pendingRef.current = null;
      if (!result.ok) {
        setError(SAVE_ERRORS[result.error]);
        setPhase('idle');
        return;
      }
      onSaved({ documentId: result.documentId, reusedExisting: result.reusedExisting });
    } finally {
      savingRef.current = false;
    }
  };

  const handleCancel = () => {
    discardPending();
    onCancel();
  };

  const busy = phase === 'processing' || phase === 'saving';

  return (
    <div className="employee-proof-upload" data-testid="employee-proof-upload">
      <p className="form-hint">{t('employeePayment.proof.uploadIntro')}</p>
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="employee-proof-upload__input"
        data-testid="employee-proof-upload-camera-input"
        onChange={(event) => {
          void handleFile(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,image/*"
        className="employee-proof-upload__input"
        data-testid="employee-proof-upload-file-input"
        onChange={(event) => {
          void handleFile(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      <div className="employee-proof-upload__choose">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => cameraRef.current?.click()} data-testid="employee-proof-upload-camera">
          {t('employeePayment.proof.takePhoto')}
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => fileRef.current?.click()} data-testid="employee-proof-upload-file">
          {t('employeePayment.proof.chooseFile')}
        </Button>
      </div>
      {phase === 'processing' ? (
        <p className="form-hint" role="status" data-testid="employee-proof-upload-processing">
          {t('employeePayment.proof.processing')}
        </p>
      ) : null}
      {phase === 'ready' || phase === 'saving' ? (
        <div className="employee-proof-upload__ready" data-testid="employee-proof-upload-ready">
          <p className="employee-proof-upload__name">{fillText(t('employeePayment.proof.ready'), { name: fileName })}</p>
          {duplicateDocument ? (
            <InlineNotice tone="info" testId="employee-proof-upload-duplicate">
              {t('employeePayment.proof.duplicate')}
            </InlineNotice>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p className="form-error" role="alert" data-testid="employee-proof-upload-error">
          {t(error)}
        </p>
      ) : null}
      <div className="employee-proof-upload__actions">
        <Button variant="secondary" size="sm" disabled={phase === 'saving'} onClick={handleCancel} data-testid="employee-proof-upload-cancel">
          {t('employeePayment.proof.cancel')}
        </Button>
        <Button
          size="sm"
          disabled={phase !== 'ready'}
          loading={phase === 'saving'}
          onClick={() => void handleSave()}
          data-testid="employee-proof-upload-save"
        >
          {t('employeePayment.proof.saveAsProof')}
        </Button>
      </div>
    </div>
  );
}
