/**
 * PRODUCT-BASIS-FIRMENPROFIL-01D — die Unterseite `/einstellungen/kommunikation`.
 *
 * Alles, was den E-Mail-Versand von Dokumenten vorbelegt, an einem Ort:
 * Absender-Anzeigename, Antwortadresse (Reply-To), Standard-Betreff und
 * -Nachricht — alles Felder des kanonischen `CompanyProfile` (01B/EMAIL-01B4).
 *
 * Der **technische** Absender (From) wird von der Versandarchitektur gesetzt
 * (feste OfficeTakt-Adresse) und ist hier bewusst nicht konfigurierbar. Was hier
 * steht, wirkt auf **neue** Versandentwürfe; bereits versendete Dokumente bleiben
 * unverändert.
 *
 * EINRICHTUNG-01 (AP6; Vertrag 1.22):
 *  - E-01 Anzeigename und Antwortadresse gelten für alle E-Mails aus OfficeTakt, auch für Rechnungen; im Rechnungs-PDF
 *    stehen die Firmendaten vom Zeitpunkt der Freigabe (wie `sendDocumentCore`).
 *  - E-02/E-04 Betreffe (255 Codepunkte, einzeilig) und Anzeigename mit sichtbarem Fehler am Feld.
 *  - E-03 (E18, K4) Eine neue Antwortadresse gilt erst nach Bestätigung per Einmal-Link; bis dahin antworten Empfänger
 *    an die bestätigte Anmelde-E-Mail des Inhabers. Der Stand kommt vom Server.
 *  - E-05 Kommunikationssprache des Betriebs bestimmt die Vorgabetexte; die Oberflächensprache wirkt nicht.
 *  - E-06 Hinweis, wenn der Versandserver im Testmodus läuft.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { MailTestModeNotice } from '../../components/communication/MailTestModeNotice';
import { SettingsAccessNotice, resolveSettingsNoticeVariant } from '../../components/settings/SettingsAccessNotice';
import { SettingsPageHeader } from '../../components/settings/SettingsPageHeader';
import { SettingsSaveBar } from '../../components/settings/SettingsSaveBar';
import { Button } from '../../components/ui/Button';
import { useApp } from '../../context/AppContext';
import { useFocusFieldFromHash } from '../../hooks/useFocusFieldFromHash';
import { useFormResume } from '../../hooks/useFormResume';
import { useSettingsAccess } from '../../hooks/useSettingsAccess';
import { changedProfileFields, useProfileFormBase } from '../../hooks/useProfileFormBase';
import {
  COMMUNICATION_LANGUAGES,
  COMPANY_PROFILE_TEXT_LIMITS,
  findCompanyProfileTextLimitViolations,
  resolveProfileCommunicationLanguage,
  resolveProfileSenderDisplayName,
  textInputMaxLength,
  validateCompanyProfileOptionalFields,
} from '../../services/company/companyProfileSettingsContract';
import {
  PLACEHOLDERS_BY_KIND,
  buildDefaultEmailSignature,
  composeDeliveryMail,
  resolveMailTemplate,
  type MailTemplateKind,
} from '../../services/delivery/deliveryMailComposer';
import {
  loadReplyToStatus,
  requestReplyToConfirmation,
  type ReplyToRequestResult,
  type ReplyToStatus,
} from '../../services/delivery/replyToConfirmationService';
import { getLastPersistSuccess } from '../../services/persistenceService';
import { PREVIEW_INVOICE_NUMBER } from '../../services/settings/settingsDocumentPreview';
import { t as translateIn, type TranslationKey } from '../../i18n';
import type { CommunicationLanguage, CompanyProfile } from '../../types/models';
import { MAILBOX_RETURN_PARAMS } from './MailboxSettingsPage';
import { SETTINGS_TARGET_PATHS } from './settingsHubConfig';

export const COMMUNICATION_SETTINGS_ROUTE = SETTINGS_TARGET_PATHS.communication;

/**
 * EINRICHTUNG-01 (AP5; Z-F11) — der OAuth-Rückweg der Edge Function endet weiter auf dieser Adresse
 * (`?postfach=…&grund=…&oauth=…`). Trägt die Adresse einen dieser Parameter, geht es mit allen Parametern zum Postfach.
 */
export function mailboxReturnRedirect(search: string): string | null {
  const params = new URLSearchParams(search);
  if (!MAILBOX_RETURN_PARAMS.some((name) => params.has(name))) return null;
  return `${SETTINGS_TARGET_PATHS.mailbox}${search.startsWith('?') ? search : `?${search}`}`;
}

export const COMMUNICATION_SETTINGS_FIELDS = [
  'senderDisplayName',
  'replyToEmail',
  'defaultInvoiceEmailSubject',
  'defaultInvoiceEmailBody',
  // E-MAIL-07C
  'defaultOfferEmailSubject',
  'defaultOfferEmailBody',
  'defaultLetterEmailSubject',
  'defaultLetterEmailBody',
  'emailSignature',
  // EINRICHTUNG-01 (AP6; E-05)
  'communicationLanguage',
] as const satisfies readonly (keyof CompanyProfile & string)[];

export type CommunicationSettingsDraft = Record<(typeof COMMUNICATION_SETTINGS_FIELDS)[number], string>;

export function pickCommunicationSettings(profile: CompanyProfile): CommunicationSettingsDraft {
  return Object.fromEntries(
    COMMUNICATION_SETTINGS_FIELDS.map((field) => [field, (profile[field] as string | undefined) ?? '']),
  ) as CommunicationSettingsDraft;
}

/** E-MAIL-07C — die drei einstellbaren Vorlagen und ihre Profilfelder. */
const TEMPLATE_SECTIONS: Array<{
  kind: Extract<MailTemplateKind, 'invoice' | 'offer' | 'letter'>;
  subject: 'defaultInvoiceEmailSubject' | 'defaultOfferEmailSubject' | 'defaultLetterEmailSubject';
  body: 'defaultInvoiceEmailBody' | 'defaultOfferEmailBody' | 'defaultLetterEmailBody';
}> = [
  { kind: 'invoice', subject: 'defaultInvoiceEmailSubject', body: 'defaultInvoiceEmailBody' },
  { kind: 'offer', subject: 'defaultOfferEmailSubject', body: 'defaultOfferEmailBody' },
  { kind: 'letter', subject: 'defaultLetterEmailSubject', body: 'defaultLetterEmailBody' },
];

/**
 * Beispielwerte nur für die Vorschau in den Einstellungen. EINRICHTUNG-01 (AP9; 1.31) — in der Sprache der Vorlage
 * (Kommunikationssprache), damit die Vorschau nicht zwei Sprachen mischt.
 */
function previewValues(
  kind: 'invoice' | 'offer' | 'letter',
  language: CommunicationLanguage,
): { documentNumber?: string; documentTitle?: string; customerName: string } {
  const customerName = translateIn('settings.communication.previewSample.customerName', language);
  if (kind === 'invoice') return { documentNumber: PREVIEW_INVOICE_NUMBER, customerName };
  if (kind === 'offer') {
    return { documentNumber: 'AN-2026-0001', documentTitle: translateIn('settings.communication.previewSample.offerTitle', language), customerName };
  }
  return { documentTitle: translateIn('settings.communication.previewSample.letterTitle', language), customerName };
}

const LANGUAGE_LABELS: Record<CommunicationLanguage, TranslationKey> = {
  de: 'language.de',
  tr: 'language.tr',
  bg: 'language.bg',
};

export function isCommunicationSettingsDirty(draft: CommunicationSettingsDraft, saved: CompanyProfile): boolean {
  const base = pickCommunicationSettings(saved);
  return COMMUNICATION_SETTINGS_FIELDS.some((key) => draft[key] !== base[key]);
}

/** Leer bleibt leer — der Contract loescht den Schluessel (bewusstes Loeschen, 01B2). */
export function buildCommunicationSettingsPayload(draft: CommunicationSettingsDraft): Partial<CompanyProfile> {
  return {
    senderDisplayName: draft.senderDisplayName.trim(),
    replyToEmail: draft.replyToEmail.trim(),
    defaultInvoiceEmailSubject: draft.defaultInvoiceEmailSubject,
    defaultInvoiceEmailBody: draft.defaultInvoiceEmailBody,
    defaultOfferEmailSubject: draft.defaultOfferEmailSubject,
    defaultOfferEmailBody: draft.defaultOfferEmailBody,
    defaultLetterEmailSubject: draft.defaultLetterEmailSubject,
    defaultLetterEmailBody: draft.defaultLetterEmailBody,
    emailSignature: draft.emailSignature,
    // Leer = Deutsch (Feld entfällt).
    communicationLanguage: (draft.communicationLanguage || undefined) as CommunicationLanguage | undefined,
  };
}

type FieldErrors = Partial<Record<string, TranslationKey>>;

/** Feldfehler eines Speicherversuchs: Formregeln (Antwortadresse, Anzeigename, Sprache) und Textgrenzen. */
function collectFieldErrors(payload: Partial<CompanyProfile>): FieldErrors {
  const errors: FieldErrors = {};
  for (const field of ['replyToEmail', 'senderDisplayName', 'communicationLanguage'] as const) {
    if (!(field in payload)) continue;
    const error = validateCompanyProfileOptionalFields({ [field]: payload[field] } as Partial<CompanyProfile>);
    if (error) errors[field] = error;
  }
  for (const violation of findCompanyProfileTextLimitViolations(payload as Record<string, unknown>)) {
    errors[violation.field] ??= violation.errorKey as TranslationKey;
  }
  return errors;
}

const REQUEST_RESULT_KEYS: Record<ReplyToRequestResult, TranslationKey> = {
  sent: 'settings.communication.replyTo.request.sent',
  not_sent: 'settings.communication.replyTo.request.notSent',
  too_early: 'settings.communication.replyTo.request.tooEarly',
  limit: 'settings.communication.replyTo.request.limit',
  already_confirmed: 'settings.communication.replyTo.request.alreadyConfirmed',
  not_synced: 'settings.communication.replyTo.request.notSynced',
  missing: 'settings.communication.replyTo.request.missing',
  forbidden: 'settings.communication.replyTo.request.forbidden',
  unavailable: 'settings.communication.replyTo.request.unavailable',
};

/** Wie oft nach dem Speichern auf den Abgleich der neuen Adresse gewartet wird, bevor der Knopf übernimmt. */
const AUTO_REQUEST_ATTEMPTS = 5;
const AUTO_REQUEST_DELAY_MS = 3000;

function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString('de-DE');
}

export function CommunicationSettingsPage() {
  const location = useLocation();
  const redirect = mailboxReturnRedirect(location.search);
  if (redirect) return <Navigate to={redirect} replace />;
  return <CommunicationSettingsForm />;
}

function CommunicationSettingsForm() {
  const { companyProfile, updateCompanyProfile, translate, showToast, language: uiLanguage } = useApp();
  // EINRICHTUNG-01 (AP5; 1.16) — reaktiv: Rolle, Lizenz und Löschantrag wirken ohne Neuladen.
  const { access, canEdit: editable, cloud, managesWorkspace } = useSettingsAccess();
  const noticeVariant = resolveSettingsNoticeVariant(access);
  useFocusFieldFromHash();

  const resume = useFormResume<CommunicationSettingsDraft>({
    namespace: 'communicationSettings',
    fields: COMMUNICATION_SETTINGS_FIELDS,
    saved: pickCommunicationSettings(companyProfile),
    workspaceType: 'other',
  });
  const [draft, setDraft] = useState<CommunicationSettingsDraft>(() => ({ ...pickCommunicationSettings(companyProfile), ...resume.restored }));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  // EINRICHTUNG-01 (AP9; 1.30) — Speicherfehler als bleibender Hinweis an der Speicherleiste, nicht als Toast.
  const [saveError, setSaveError] = useState<TranslationKey | null>(null);
  resume.observe(draft);
  // FINANZ-CORE-01A (EIN-03) — Ausgangsstand des Entwurfs; unberührte Felder folgen dem Profil.
  const baseRef = useProfileFormBase(companyProfile, pickCommunicationSettings, setDraft);

  const dirty = isCommunicationSettingsDirty(draft, companyProfile);
  const candidate: CompanyProfile = useMemo(() => ({ ...companyProfile, ...buildCommunicationSettingsPayload(draft) }), [companyProfile, draft]);
  const senderName = resolveProfileSenderDisplayName(candidate);
  const senderIsDerived = !draft.senderDisplayName.trim();
  // E-05 — Vorgabetexte, Signatur und Vorschau in der Sprache des Betriebs (die Oberflächensprache wirkt nicht).
  const mailLanguage = resolveProfileCommunicationLanguage(candidate);
  const derivedSignature = buildDefaultEmailSignature(companyProfile, mailLanguage);
  const companyName = resolveProfileSenderDisplayName({ ...companyProfile, senderDisplayName: '' });
  const t = (key: string) => translate(key as TranslationKey);

  /* ---------------- E-03 (E18, K4) — Bestätigungsstand der Antwortadresse ---------------- */
  const [status, setStatus] = useState<ReplyToStatus | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [requestInfo, setRequestInfo] = useState<{ tone: 'ok' | 'error' | 'info'; key: TranslationKey } | null>(null);
  const [requesting, setRequesting] = useState(false);
  const autoTimer = useRef<number | null>(null);
  const savedReplyTo = (companyProfile.replyToEmail ?? '').trim().toLowerCase();

  const refreshStatus = useCallback(async () => {
    if (!cloud || !managesWorkspace) {
      setStatusLoaded(true);
      return null;
    }
    const next = await loadReplyToStatus();
    setStatus(next);
    setStatusLoaded(true);
    return next;
  }, [cloud, managesWorkspace]);

  useEffect(() => {
    void refreshStatus();
    return () => {
      if (autoTimer.current !== null) window.clearTimeout(autoTimer.current);
    };
  }, [refreshStatus]);

  const sendConfirmation = useCallback(
    async (address: string, attempt = 1): Promise<void> => {
      if (!address) return;
      setRequesting(true);
      try {
        const { result: antwort } = await requestReplyToConfirmation(address, uiLanguage);
        /*
         * EINRICHTUNG-01 (Eigenprüfung; E-03) — hier ist die Adresse immer gespeichert (sonst kein Aufruf). Meldet der
         * Server trotzdem „reply_to_missing“, hat die gerade gespeicherte ERSTE Antwortadresse ihn noch nicht erreicht
         * (lokal zuerst, Abgleich danach) — derselbe Fall wie „address_mismatch“ bei einer geänderten Adresse. Vorher
         * stand dann „Bitte zuerst eine Antwortadresse eintragen und speichern“, und es wurde nicht nachgefasst.
         */
        const result: ReplyToRequestResult = antwort === 'missing' ? 'not_synced' : antwort;
        if (result === 'not_synced' && attempt < AUTO_REQUEST_ATTEMPTS) {
          // Die Profiländerung hat den Server noch nicht erreicht: kurz warten, dann erneut.
          setRequestInfo({ tone: 'info', key: 'settings.communication.replyTo.request.waiting' });
          autoTimer.current = window.setTimeout(() => void sendConfirmation(address, attempt + 1), AUTO_REQUEST_DELAY_MS);
          return;
        }
        setRequestInfo({ tone: result === 'sent' || result === 'already_confirmed' ? 'ok' : result === 'too_early' ? 'info' : 'error', key: REQUEST_RESULT_KEYS[result] });
        await refreshStatus();
      } finally {
        setRequesting(false);
      }
    },
    [refreshStatus, uiLanguage],
  );

  const setField = <K extends keyof CommunicationSettingsDraft>(key: K, value: CommunicationSettingsDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: undefined }));
  };

  /* EINRICHTUNG-01 (AP5; 1.17) — „Verwerfen“: zurück auf den gespeicherten Stand, der Entwurf entfällt. */
  const discard = () => {
    setDraft(pickCommunicationSettings(companyProfile));
    baseRef.current = pickCommunicationSettings(companyProfile);
    setErrors({});
    // EINRICHTUNG-01 (AP9; 1.30) — mit dem Verwerfen gilt auch der Hinweis des letzten Speicherversuchs nicht mehr.
    setSaveError(null);
    resume.clearResume();
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!editable || saving || !dirty) return;
    setSaving(true);
    setSaveError(null);
    try {
      // FINANZ-CORE-01A (EIN-03) — nur die geänderten Felder.
      const payload = changedProfileFields(
        buildCommunicationSettingsPayload(draft),
        buildCommunicationSettingsPayload(baseRef.current),
      );
      if (Object.keys(payload).length === 0) return;
      // E-02, E-04 — Fehler am Feld (nicht nur `maxLength`), nichts wird gespeichert.
      const fieldErrors = collectFieldErrors(payload);
      if (Object.keys(fieldErrors).length > 0) {
        setErrors(fieldErrors);
        return;
      }
      const replyToChanged = 'replyToEmail' in payload;
      const result = updateCompanyProfile(payload);
      if (!result.success) {
        setErrors({ form: result.errorKey as TranslationKey });
        return;
      }
      setErrors({});
      setDraft(pickCommunicationSettings(result.profile));
      baseRef.current = pickCommunicationSettings(result.profile);
      resume.clearResume();
      if (!getLastPersistSuccess()) {
        setSaveError('persist.failed.userAction');
        return;
      }
      showToast(translate('settings.communication.saved'));
      // E-03 — eine neu gespeicherte Antwortadresse erhält ihre Bestätigungsmail (lokal Anbieter `stub`).
      const nextAddress = (result.profile.replyToEmail ?? '').trim().toLowerCase();
      if (replyToChanged && nextAddress && cloud) {
        setRequestInfo(null);
        void sendConfirmation(nextAddress);
      } else if (replyToChanged) {
        void refreshStatus();
      }
    } finally {
      setSaving(false);
    }
  };

  const disabled = !editable || saving;
  const firstError = errors.form ?? Object.values(errors).find(Boolean) ?? null;
  const fieldError = (key: string) =>
    errors[key] ? (
      <p className="form-error" id={`settings-communication-${key}-error`} data-testid={`settings-communication-${key}-error`}>
        {translate(errors[key]!)}
      </p>
    ) : null;

  const statusConfirmed = status?.confirmed === true && status.address === savedReplyTo;
  const canResend =
    editable &&
    cloud &&
    !requesting &&
    Boolean(savedReplyTo) &&
    !statusConfirmed &&
    (!status?.canResendAt || Date.parse(status.canResendAt) <= Date.now()) &&
    (status?.sendsToday ?? 0) < 5;

  const effectiveReplyTo = statusConfirmed
    ? savedReplyTo
    : status?.effectiveMasked
      ? translate('settings.communication.replyTo.ownerLogin').replace('{email}', status.effectiveMasked)
      : translate('settings.communication.replyTo.ownerLoginUnknown');

  return (
    <div className="page settings-page settings-subpage settings-communication-page" data-testid="settings-communication-page">
      <SettingsPageHeader
        target="communication"
        subtitle={translate('settings.communication.page.subtitle')}
        backTestId="settings-communication-back"
      />

      {!editable && noticeVariant ? (
        <SettingsAccessNotice variant={noticeVariant} testId="settings-communication-readonly" />
      ) : editable ? (
        <p className="hint-text" data-testid="settings-communication-historical-hint">
          {translate('settings.communication.historicalHint')}
        </p>
      ) : null}

      {/* E-06 — Testmodus des Versandservers. */}
      <MailTestModeNotice testId="settings-communication-test-mode" />

      {/* EINRICHTUNG-01 (AP5; 1.15) — das Postfach (E-MAIL-07E-MSA) hat die eigene Seite „Kommunikation › Postfach“. */}

      <form className="settings-form settings-communication" onSubmit={handleSubmit} noValidate>
        {/* ---------------- Absender ---------------- */}
        <fieldset className="form-group settings-form__section" data-testid="settings-communication-section-sender" disabled={disabled}>
          <legend className="settings-form__legend">{translate('settings.communication.section.sender')}</legend>
          <p className="hint-text" data-testid="settings-communication-sender-hint">{translate('settings.communication.sender.hint')}</p>
          <div className="settings-form__field">
            <label htmlFor="settings-communication-senderDisplayName">{translate('settings.communication.senderDisplayName')}</label>
            <input
              id="settings-communication-senderDisplayName"
              name="senderDisplayName"
              type="text"
              className={`input${errors.senderDisplayName ? ' input--error' : ''}`}
              value={draft.senderDisplayName}
              maxLength={textInputMaxLength(COMPANY_PROFILE_TEXT_LIMITS.senderDisplayName)}
              placeholder={companyName}
              readOnly={!editable}
              aria-invalid={errors.senderDisplayName ? true : undefined}
              aria-describedby={errors.senderDisplayName ? 'settings-communication-senderDisplayName-error' : 'settings-communication-senderDisplayName-hint'}
              onChange={(event) => setField('senderDisplayName', event.target.value)}
              data-testid="settings-communication-senderDisplayName"
            />
            <p className="form-hint" id="settings-communication-senderDisplayName-hint" data-testid="settings-communication-senderDisplayName-hint">
              {senderIsDerived
                ? translate('settings.communication.senderDisplayName.derived').replace('{name}', senderName || '—')
                : translate('settings.communication.senderDisplayName.custom')}
            </p>
            {fieldError('senderDisplayName')}
          </div>
          <div className="settings-form__field">
            <label htmlFor="settings-communication-replyToEmail">{translate('settings.communication.replyToEmail')}</label>
            <input
              id="settings-communication-replyToEmail"
              name="replyToEmail"
              type="email"
              className={`input${errors.replyToEmail ? ' input--error' : ''}`}
              value={draft.replyToEmail}
              readOnly={!editable}
              aria-invalid={errors.replyToEmail ? true : undefined}
              aria-describedby={errors.replyToEmail ? 'settings-communication-replyToEmail-error' : 'settings-communication-replyToEmail-hint'}
              onChange={(event) => setField('replyToEmail', event.target.value)}
              data-testid="settings-communication-replyToEmail"
            />
            <p className="form-hint" id="settings-communication-replyToEmail-hint" data-testid="settings-communication-replyToEmail-hint">
              {draft.replyToEmail.trim()
                ? translate('settings.communication.replyToEmail.confirmHint')
                : translate('settings.communication.replyToEmail.ownerFallback')}
            </p>
            {fieldError('replyToEmail')}

            {/* E-03 — Stand der Bestätigung (nur Cloud; Inhaber und Admins). */}
            {cloud && managesWorkspace ? (
              <div className="settings-communication__reply-status" data-testid="settings-communication-replyTo-status">
                {!statusLoaded ? null : status === null ? (
                  <p className="form-hint" data-testid="settings-communication-replyTo-status-unknown">
                    {translate('settings.communication.replyTo.statusUnknown')}
                  </p>
                ) : savedReplyTo ? (
                  <>
                    <p className="form-hint" data-testid="settings-communication-replyTo-state" data-confirmed={statusConfirmed ? 'true' : 'false'}>
                      <strong>
                        {translate(statusConfirmed ? 'settings.communication.replyTo.confirmed' : 'settings.communication.replyTo.unconfirmed')}
                      </strong>
                      {!statusConfirmed && status.pending
                        ? ` — ${translate('settings.communication.replyTo.pending').replace('{date}', formatDateTime(status.lastSentAt))}`
                        : ''}
                    </p>
                    {!statusConfirmed ? (
                      <p className="form-hint" data-testid="settings-communication-replyTo-fallback">
                        {translate('settings.communication.replyTo.untilConfirmed').replace('{target}', effectiveReplyTo)}
                      </p>
                    ) : null}
                    {!statusConfirmed && editable ? (
                      <Button
                        type="button"
                        variant="outline"
                        loading={requesting}
                        disabled={!canResend}
                        onClick={() => void sendConfirmation(savedReplyTo)}
                        data-testid="settings-communication-replyTo-resend"
                      >
                        {translate('settings.communication.replyTo.resend')}
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <p className="form-hint" data-testid="settings-communication-replyTo-fallback">
                    {translate('settings.communication.replyTo.noOwnAddress').replace('{target}', effectiveReplyTo)}
                  </p>
                )}
                {status?.unavailable ? (
                  <p className="form-error" role="alert" data-testid="settings-communication-replyTo-unavailable">
                    {translate('settings.communication.replyTo.unavailable')}
                  </p>
                ) : null}
                {requestInfo ? (
                  <p
                    className={requestInfo.tone === 'error' ? 'form-error' : 'form-hint'}
                    role={requestInfo.tone === 'error' ? 'alert' : 'status'}
                    data-testid="settings-communication-replyTo-request-info"
                  >
                    {translate(requestInfo.key)}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          <dl className="settings-invoices__preview-list" data-testid="settings-communication-identity-preview">
            <div>
              <dt>{translate('settings.communication.identity.from')}</dt>
              <dd data-testid="settings-communication-identity-from">{translate('settings.communication.identity.fromValue')}</dd>
            </div>
            <div>
              <dt>{translate('settings.communication.identity.displayName')}</dt>
              <dd data-testid="settings-communication-identity-name">{senderName || '—'}</dd>
            </div>
            <div>
              <dt>{translate('settings.communication.identity.replyTo')}</dt>
              <dd data-testid="settings-communication-identity-replyTo">{cloud ? effectiveReplyTo : translate('settings.communication.replyTo.localOnly')}</dd>
            </div>
          </dl>
          <p className="form-hint" data-testid="settings-communication-identity-hint">{translate('settings.communication.identity.hint')}</p>
        </fieldset>

        {/* ---------------- E-05 — Sprache der E-Mail-Vorgaben ---------------- */}
        <fieldset className="form-group settings-form__section" data-testid="settings-communication-section-language" disabled={disabled}>
          <legend className="settings-form__legend">{translate('settings.communication.language.title')}</legend>
          <p className="hint-text">{translate('settings.communication.language.hint')}</p>
          <div className="settings-form__field">
            <label htmlFor="settings-communication-communicationLanguage">{translate('settings.communication.language')}</label>
            <select
              id="settings-communication-communicationLanguage"
              className="select input"
              value={draft.communicationLanguage || 'de'}
              disabled={!editable}
              onChange={(event) => setField('communicationLanguage', event.target.value === 'de' ? '' : event.target.value)}
              data-testid="settings-communication-communicationLanguage"
            >
              {COMMUNICATION_LANGUAGES.map((value) => (
                <option key={value} value={value}>
                  {translate(LANGUAGE_LABELS[value])}
                </option>
              ))}
            </select>
            {fieldError('communicationLanguage')}
          </div>
        </fieldset>

        {/* ---------------- E-MAIL-07C: zentrale Signatur ---------------- */}
        <fieldset className="form-group settings-form__section" data-testid="settings-communication-section-signature" disabled={disabled}>
          <legend className="settings-form__legend">{t('settings.communication.signature.title')}</legend>
          <p className="hint-text">{t('settings.communication.signature.hint')}</p>
          <div className="settings-form__field">
            <label htmlFor="settings-communication-emailSignature">{t('settings.communication.signature.label')}</label>
            <textarea
              id="settings-communication-emailSignature"
              name="emailSignature"
              className={`input settings-invoices__textarea${errors.emailSignature ? ' input--error' : ''}`}
              rows={7}
              value={draft.emailSignature}
              maxLength={textInputMaxLength(COMPANY_PROFILE_TEXT_LIMITS.emailSignature)}
              placeholder={derivedSignature}
              readOnly={!editable}
              onChange={(event) => setField('emailSignature', event.target.value)}
              data-testid="settings-communication-emailSignature"
            />
            <p className="form-hint" data-testid="settings-communication-emailSignature-hint">
              {draft.emailSignature.trim() ? t('settings.communication.signature.custom') : t('settings.communication.signature.derived')}
            </p>
            {fieldError('emailSignature')}
          </div>
        </fieldset>

        {/* ---------------- Vorlagen je Dokumentart (Rechnung: EMAIL-01B4, Angebot/Brief: 07C) ---------------- */}
        {TEMPLATE_SECTIONS.map((section) => {
          const fallback = resolveMailTemplate(section.kind, mailLanguage);
          const preview = composeDeliveryMail({
            kind: section.kind,
            values: { companyName, ...previewValues(section.kind, mailLanguage) },
            profile: candidate,
            language: mailLanguage,
          });
          const placeholders = PLACEHOLDERS_BY_KIND[section.kind].map((name) => `{{${name}}}`).join('  ');
          return (
            <fieldset
              key={section.kind}
              className="form-group settings-form__section"
              data-testid={section.kind === 'invoice' ? 'settings-communication-section-email' : `settings-communication-section-template-${section.kind}`}
              disabled={disabled}
            >
              <legend className="settings-form__legend">{t(`settings.communication.template.${section.kind}.title`)}</legend>
              <p className="hint-text">{t('settings.communication.template.hint')}</p>
              <p className="form-hint" data-testid={`settings-communication-placeholders-${section.kind}`}>
                {t('settings.communication.template.placeholders').replace('{list}', placeholders)}
              </p>
              <div className="settings-form__field">
                <label htmlFor={`settings-communication-${section.subject}`}>{t('settings.invoices.email.subject')}</label>
                <input
                  id={`settings-communication-${section.subject}`}
                  name={section.subject}
                  type="text"
                  className={`input${errors[section.subject] ? ' input--error' : ''}`}
                  value={draft[section.subject]}
                  maxLength={textInputMaxLength(COMPANY_PROFILE_TEXT_LIMITS[section.subject])}
                  placeholder={fallback.subject}
                  readOnly={!editable}
                  aria-invalid={errors[section.subject] ? true : undefined}
                  aria-describedby={errors[section.subject] ? `settings-communication-${section.subject}-error` : undefined}
                  onChange={(event) => setField(section.subject, event.target.value)}
                  data-testid={`settings-communication-${section.subject}`}
                />
                {fieldError(section.subject)}
              </div>
              <div className="settings-form__field">
                <label htmlFor={`settings-communication-${section.body}`}>{t('settings.invoices.email.body')}</label>
                <textarea
                  id={`settings-communication-${section.body}`}
                  name={section.body}
                  className={`input settings-invoices__textarea${errors[section.body] ? ' input--error' : ''}`}
                  rows={6}
                  value={draft[section.body]}
                  maxLength={textInputMaxLength(COMPANY_PROFILE_TEXT_LIMITS[section.body])}
                  placeholder={fallback.body}
                  readOnly={!editable}
                  onChange={(event) => setField(section.body, event.target.value)}
                  data-testid={`settings-communication-${section.body}`}
                />
                {fieldError(section.body)}
              </div>
              <div className="settings-invoices__preview" data-testid={section.kind === 'invoice' ? 'settings-communication-email-preview' : `settings-communication-preview-${section.kind}`}>
                <p className="settings-form__legend">{t('settings.communication.template.preview')}</p>
                <p className="data-row__value" data-testid={section.kind === 'invoice' ? 'settings-communication-email-preview-subject' : `settings-communication-preview-${section.kind}-subject`}>{preview.subject}</p>
                <pre className="settings-invoices__mail-preview" data-testid={section.kind === 'invoice' ? 'settings-communication-email-preview-body' : `settings-communication-preview-${section.kind}-body`}>{preview.bodyText}</pre>
              </div>
            </fieldset>
          );
        })}

        {firstError ? (
          <p className="form-error" role="alert" data-testid="settings-communication-error">{translate(firstError)}</p>
        ) : null}

        {editable ? <SettingsSaveBar dirty={dirty} saving={saving} onDiscard={discard} testIdPrefix="settings-communication" draftKept error={saveError ? translate(saveError) : null} /> : null}
      </form>
    </div>
  );
}
