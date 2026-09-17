import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { isValidRecipientEmail, normalizeRecipientEmail } from '../../services/delivery/documentDeliveryContract';
import { generateApprovedInvoicePdf, generateInvoiceCorrectionPdf, downloadInvoicePdfBytes } from '../../services/invoicePdfService';
import type { SendPhase } from '../../services/delivery/sendDocumentOrchestrator';
import type { VorgangInvoice } from '../../types/models';
import type { TranslationKey } from '../../i18n';

/**
 * EMAIL-01B3 — der Versanddialog. Er zeigt vor dem Klick alles, was gesendet
 * wird (An, Betreff, Nachricht, Anhang), und sendet ausschließlich auf den
 * expliziten „Senden"-Klick. Zusätzliche Bestätigung nur bei abweichender
 * Empfängeradresse oder Zweitversand — kein Doppel-Confirm im Normalfall.
 *
 * Die Kette selbst (PDF → Upload → Delivery → Server) läuft im Orchestrator;
 * der Dialog ruft `onSend` mit den geprüften Feldern auf.
 */
export interface SendDocumentDialogProps {
  open: boolean;
  invoice: VorgangInvoice;
  initialRecipient: string;
  /** Kanonisch vorbelegte Kundenadresse — Abweichung verlangt eine bewusste Bestätigung. */
  canonicalRecipient: string;
  initialSubject: string;
  initialBody: string;
  attachmentFilename: string;
  /** Diese Rechnung wurde bereits erfolgreich per OfficePilot versendet → Zweitversand bestätigen. */
  alreadySent: boolean;
  mode: 'send' | 'retry' | 'resume';
  /** EMAIL-01B4 — Korrekturbeleg: eigener Titel und Zweitversand-Text; Regeln identisch. */
  documentKind?: 'invoice' | 'invoice_correction';
  phase: SendPhase | null;
  busy: boolean;
  errorKey: TranslationKey | null;
  /**
   * V1-B1 — technische Diagnose (RPC-/Storage-Rohtext). Nur für Logs/Debugging
   * als data-Attribut am Fehlerelement; nie im sichtbaren Text.
   */
  errorDetail?: string;
  translate: (key: TranslationKey) => string;
  onCancel: () => void;
  onSend: (fields: { recipientEmail: string; subject: string; bodyText: string }) => void;
}

const PHASE_KEYS: Record<Exclude<SendPhase, 'draft' | 'done'>, TranslationKey> = {
  preparing: 'delivery.phase.preparing' as TranslationKey,
  uploading: 'delivery.phase.uploading' as TranslationKey,
  creating: 'delivery.phase.creating' as TranslationKey,
  sending: 'delivery.phase.sending' as TranslationKey,
  refreshing: 'delivery.phase.refreshing' as TranslationKey,
};

export function SendDocumentDialog(props: SendDocumentDialogProps) {
  const { open, translate, busy } = props;
  const [recipient, setRecipient] = useState(props.initialRecipient);
  const [subject, setSubject] = useState(props.initialSubject);
  const [body, setBody] = useState(props.initialBody);
  const [fieldError, setFieldError] = useState<TranslationKey | null>(null);
  const [confirmStep, setConfirmStep] = useState<'recipient' | 'resend' | null>(null);
  const recipientRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setRecipient(props.initialRecipient);
    setSubject(props.initialSubject);
    setBody(props.initialBody);
    setFieldError(null);
    setConfirmStep(null);
    // Fokus auf das erste Feld — bei fehlender Adresse genau dort, wo Eingabe nötig ist.
    const frame = window.requestAnimationFrame(() => recipientRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open, props.initialRecipient, props.initialSubject, props.initialBody]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) props.onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, props]);

  if (!open) return null;

  const normalizedRecipient = normalizeRecipientEmail(recipient);
  const recipientDiffers = Boolean(props.canonicalRecipient) && normalizedRecipient !== props.canonicalRecipient;

  const validate = (): boolean => {
    if (!normalizedRecipient) {
      setFieldError('delivery.dialog.recipientMissing' as TranslationKey);
      recipientRef.current?.focus();
      return false;
    }
    if (!isValidRecipientEmail(normalizedRecipient)) {
      setFieldError('delivery.dialog.recipientInvalid' as TranslationKey);
      recipientRef.current?.focus();
      return false;
    }
    if (!subject.trim()) {
      setFieldError('delivery.dialog.subjectRequired' as TranslationKey);
      return false;
    }
    if (!body.trim()) {
      setFieldError('delivery.dialog.bodyRequired' as TranslationKey);
      return false;
    }
    setFieldError(null);
    return true;
  };

  const submit = () => {
    props.onSend({ recipientEmail: normalizedRecipient, subject: subject.trim(), bodyText: body });
  };

  const handleSendClick = () => {
    if (busy) return;
    if (!validate()) return;
    // Bewusste Bestätigung nur, wenn wirklich etwas Ungewöhnliches vorliegt.
    if (confirmStep === null) {
      if (recipientDiffers) {
        setConfirmStep('recipient');
        return;
      }
      if (props.alreadySent && props.mode !== 'resume') {
        setConfirmStep('resend');
        return;
      }
    } else if (confirmStep === 'recipient' && props.alreadySent && props.mode !== 'resume') {
      setConfirmStep('resend');
      return;
    }
    submit();
  };

  const handlePdf = async () => {
    // Historischer Beleg: Rechnung bzw. Korrekturbeleg über die bestehende Engine.
    const result = isCorrection ? await generateInvoiceCorrectionPdf(props.invoice) : await generateApprovedInvoicePdf(props.invoice);
    if (result.ok) downloadInvoicePdfBytes(result.bytes, result.filename);
  };

  const phaseKey = props.phase && props.phase !== 'draft' && props.phase !== 'done' ? PHASE_KEYS[props.phase] : null;
  const isCorrection = props.documentKind === 'invoice_correction';
  const titleKey = (isCorrection ? 'delivery.correction.dialog.title' : 'delivery.dialog.title') as TranslationKey;
  const resendKey = (isCorrection ? 'delivery.correction.confirmResend' : 'delivery.dialog.confirmResend') as TranslationKey;

  return (
    <div className="vorgang-dialog-backdrop" role="presentation" onClick={() => !busy && props.onCancel()}>
      <form
        className="vorgang-dialog send-document-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="send-document-dialog-title"
        aria-busy={busy || undefined}
        data-testid="send-document-dialog"
        data-document-kind={props.documentKind ?? 'invoice'}
        noValidate
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          handleSendClick();
        }}
      >
        <h3 id="send-document-dialog-title" className="vorgang-dialog__title">
          {translate(titleKey)}
        </h3>
        {props.mode === 'retry' ? (
          <p className="vorgang-dialog__subtitle" data-testid="send-document-retry-hint">{translate('delivery.dialog.retryHint' as TranslationKey)}</p>
        ) : props.mode === 'resume' ? (
          <p className="vorgang-dialog__subtitle" data-testid="send-document-resume-hint">{translate('delivery.dialog.resumeHint' as TranslationKey)}</p>
        ) : null}

        <div className="settings-form__field">
          <label htmlFor="send-document-recipient">{translate('delivery.dialog.recipient' as TranslationKey)}</label>
          <input
            id="send-document-recipient"
            ref={recipientRef}
            type="email"
            inputMode="email"
            autoComplete="email"
            className={`input${fieldError?.startsWith('delivery.dialog.recipient') ? ' input--error' : ''}`}
            value={recipient}
            placeholder={translate('delivery.dialog.recipientPlaceholder' as TranslationKey)}
            disabled={busy}
            aria-describedby="send-document-recipient-hint"
            onChange={(event) => {
              setRecipient(event.target.value);
              setConfirmStep(null);
              if (fieldError) setFieldError(null);
            }}
            data-testid="send-document-recipient"
          />
          <p className="form-hint" id="send-document-recipient-hint">
            {props.initialRecipient ? translate('delivery.dialog.recipientHint' as TranslationKey) : translate('delivery.dialog.recipientMissing' as TranslationKey)}
          </p>
        </div>

        <div className="settings-form__field">
          <label htmlFor="send-document-subject">{translate('delivery.dialog.subject' as TranslationKey)}</label>
          <input
            id="send-document-subject"
            type="text"
            className="input"
            value={subject}
            maxLength={255}
            disabled={busy}
            onChange={(event) => setSubject(event.target.value)}
            data-testid="send-document-subject"
          />
        </div>

        <div className="settings-form__field">
          <label htmlFor="send-document-body">{translate('delivery.dialog.body' as TranslationKey)}</label>
          <textarea
            id="send-document-body"
            className="input send-document-dialog__body"
            rows={7}
            value={body}
            maxLength={20000}
            disabled={busy}
            onChange={(event) => setBody(event.target.value)}
            data-testid="send-document-body"
          />
        </div>

        <div className="send-document-dialog__attachment" data-testid="send-document-attachment">
          <span className="data-row__label">{translate('delivery.dialog.attachment' as TranslationKey)}</span>
          <span className="send-document-dialog__filename" data-testid="send-document-attachment-name">📎 {props.attachmentFilename}</span>
          <Button type="button" variant="ghost" onClick={() => void handlePdf()} disabled={busy} data-testid="send-document-pdf">
            {translate('delivery.action.pdf' as TranslationKey)}
          </Button>
          <p className="form-hint">{translate('delivery.dialog.attachmentHint' as TranslationKey)}</p>
        </div>

        {fieldError ? (
          <p className="form-error" role="alert" data-testid="send-document-field-error">{translate(fieldError)}</p>
        ) : null}
        {props.errorKey ? (
          <p className="form-error" role="alert" data-testid="send-document-error" data-error-detail={props.errorDetail || undefined}>
            {translate(props.errorKey)}
          </p>
        ) : null}
        {phaseKey ? (
          <p className="hint-text" role="status" aria-live="polite" data-testid="send-document-phase">{translate(phaseKey)}</p>
        ) : null}

        {confirmStep ? (
          <div className="invoice-hint invoice-hint--warning send-document-dialog__confirm" role="alert" data-testid={`send-document-confirm-${confirmStep}`}>
            {translate(confirmStep === 'recipient' ? ('delivery.dialog.confirmRecipientChanged' as TranslationKey) : resendKey)}
          </div>
        ) : null}

        <div className="send-document-dialog__actions">
          <Button type="button" variant="outline" onClick={props.onCancel} disabled={busy} data-testid="send-document-cancel">
            {translate('delivery.action.cancel' as TranslationKey)}
          </Button>
          <Button type="submit" disabled={busy} loading={busy} data-testid="send-document-send">
            {translate((confirmStep ? 'delivery.action.confirmSend' : 'delivery.action.send') as TranslationKey)}
          </Button>
        </div>
      </form>
    </div>
  );
}
