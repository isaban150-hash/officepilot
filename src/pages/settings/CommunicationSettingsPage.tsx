/**
 * PRODUCT-BASIS-FIRMENPROFIL-01D — die Unterseite `/einstellungen/kommunikation`.
 *
 * Alles, was den E-Mail-Versand von Dokumenten vorbelegt, an einem Ort:
 * Absender-Anzeigename, Antwortadresse (Reply-To), Standard-Betreff und
 * -Nachricht — alles Felder des kanonischen `CompanyProfile` (01B/EMAIL-01B4).
 *
 * Der **technische** Absender (From) wird von der Versandarchitektur gesetzt
 * (`send-document`: feste OfficePilot-Adresse, Anzeigename und Reply-To aus dem
 * historischen Rechnungs-Snapshot, fail-closed). Er ist hier bewusst nicht
 * konfigurierbar und wird nur als solcher erklaert. Was hier steht, wirkt auf
 * **neue** Versandentwuerfe; bereits versendete Dokumente bleiben unveraendert.
 */
import { useMemo, useState } from 'react';
import { MailboxSettingsSection } from '../../components/communication/MailboxSettingsSection';
import { Button } from '../../components/ui/Button';
import { PageHeader } from '../../components/ui/Card';
import { ReadOnlyNotice } from '../../components/ui/ReadOnlyNotice';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { useFormResume } from '../../hooks/useFormResume';
import { isSupabaseConfigured } from '../../lib/supabase';
import {
  COMPANY_PROFILE_TEXT_LIMITS,
  resolveProfileReplyToEmail,
  resolveProfileSenderDisplayName,
  validateCompanyProfileOptionalFields,
} from '../../services/company/companyProfileSettingsContract';
import {
  PLACEHOLDERS_BY_KIND,
  buildDefaultEmailSignature,
  composeDeliveryMail,
  resolveMailTemplate,
  type MailTemplateKind,
} from '../../services/delivery/deliveryMailComposer';
import { getLastPersistSuccess } from '../../services/persistenceService';
import { PREVIEW_INVOICE_NUMBER } from '../../services/settings/settingsDocumentPreview';
import { resolveWorkspaceWriteAccess } from '../../services/workspace/workspaceRoleService';
import type { TranslationKey } from '../../i18n';
import type { CompanyProfile } from '../../types/models';

export const COMMUNICATION_SETTINGS_ROUTE = '/einstellungen/kommunikation';

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

/** Beispielwerte nur für die Vorschau in den Einstellungen. */
const PREVIEW_VALUES: Record<'invoice' | 'offer' | 'letter', { documentNumber?: string; documentTitle?: string; customerName: string }> = {
  invoice: { documentNumber: PREVIEW_INVOICE_NUMBER, customerName: 'Beispiel Kunde GmbH' },
  offer: { documentNumber: 'AN-2026-0001', documentTitle: 'Badsanierung', customerName: 'Beispiel Kunde GmbH' },
  letter: { documentTitle: 'Terminbestätigung', customerName: 'Beispiel Kunde GmbH' },
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
  };
}

export function CommunicationSettingsPage() {
  const { companyProfile, updateCompanyProfile, translate, showToast, language } = useApp();
  const { user } = useAuth();
  const access = useMemo(
    () => resolveWorkspaceWriteAccess({ userId: user?.id, cloudConfigured: isSupabaseConfigured() }),
    [user?.id],
  );
  const editable = access.canWrite;

  const resume = useFormResume<CommunicationSettingsDraft>({
    namespace: 'communicationSettings',
    fields: COMMUNICATION_SETTINGS_FIELDS,
    saved: pickCommunicationSettings(companyProfile),
    workspaceType: 'other',
  });
  const [draft, setDraft] = useState<CommunicationSettingsDraft>(() => ({ ...pickCommunicationSettings(companyProfile), ...resume.restored }));
  const [error, setError] = useState<TranslationKey | null>(null);
  const [saving, setSaving] = useState(false);
  resume.observe(draft);

  const dirty = isCommunicationSettingsDirty(draft, companyProfile);
  const candidate: CompanyProfile = useMemo(() => ({ ...companyProfile, ...buildCommunicationSettingsPayload(draft) }), [companyProfile, draft]);
  const senderName = resolveProfileSenderDisplayName(candidate);
  const replyTo = resolveProfileReplyToEmail(candidate);
  const replyToIsFallback = !draft.replyToEmail.trim();
  const senderIsDerived = !draft.senderDisplayName.trim();
  const companyName = [companyProfile.companyName?.trim(), companyProfile.legalForm?.trim()].filter(Boolean).join(' ');
  const derivedSignature = buildDefaultEmailSignature(companyProfile, language);
  const t = (key: string) => translate(key as TranslationKey);

  const setField = <K extends keyof CommunicationSettingsDraft>(key: K, value: CommunicationSettingsDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setError(null);
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!editable || saving || !dirty) return;
    setSaving(true);
    try {
      const payload = buildCommunicationSettingsPayload(draft);
      const validation = validateCompanyProfileOptionalFields(payload);
      if (validation) {
        setError(validation);
        return;
      }
      const result = updateCompanyProfile(payload);
      if (!result.success) {
        setError(result.errorKey as TranslationKey);
        return;
      }
      setDraft(pickCommunicationSettings(result.profile));
      resume.clearResume();
      if (!getLastPersistSuccess()) {
        showToast(translate('persist.failed.userAction'));
        return;
      }
      showToast(translate('settings.communication.saved'));
    } finally {
      setSaving(false);
    }
  };

  const disabled = !editable || saving;

  return (
    <div className="page settings-page settings-subpage settings-communication-page" data-testid="settings-communication-page">
      <PageHeader
        title={translate('settings.communication.title')}
        subtitle={translate('settings.communication.page.subtitle')}
        backLabel={translate('settings.backToHub')}
        backHref="/einstellungen"
        backTestId="settings-communication-back"
      />

      {!editable ? (
        <ReadOnlyNotice message={translate(access.reason === 'member' ? 'settings.communication.readOnly' : 'settings.company.roleUnknown')} testId="settings-communication-readonly" />
      ) : (
        <p className="hint-text" data-testid="settings-communication-historical-hint">
          {translate('settings.communication.historicalHint')}
        </p>
      )}

      {/* E-MAIL-07E-MSA: Postfach (eigenes Formular, unabhängig vom Profil-Speichern). */}
      <MailboxSettingsSection />

      <form className="settings-form settings-communication" onSubmit={handleSubmit} noValidate>
        {/* ---------------- Absender ---------------- */}
        <fieldset className="form-group settings-form__section" data-testid="settings-communication-section-sender" disabled={disabled}>
          <legend className="settings-form__legend">{translate('settings.communication.section.sender')}</legend>
          <p className="hint-text">{translate('settings.communication.sender.hint')}</p>
          <div className="settings-form__field">
            <label htmlFor="settings-communication-senderDisplayName">{translate('settings.communication.senderDisplayName')}</label>
            <input
              id="settings-communication-senderDisplayName"
              name="senderDisplayName"
              type="text"
              className="input"
              value={draft.senderDisplayName}
              maxLength={COMPANY_PROFILE_TEXT_LIMITS.senderDisplayName}
              placeholder={resolveProfileSenderDisplayName({ ...companyProfile, senderDisplayName: '' })}
              readOnly={!editable}
              onChange={(event) => setField('senderDisplayName', event.target.value)}
              data-testid="settings-communication-senderDisplayName"
            />
            <p className="form-hint" data-testid="settings-communication-senderDisplayName-hint">
              {senderIsDerived
                ? translate('settings.communication.senderDisplayName.derived').replace('{name}', senderName || '—')
                : translate('settings.communication.senderDisplayName.custom')}
            </p>
          </div>
          <div className="settings-form__field">
            <label htmlFor="settings-communication-replyToEmail">{translate('settings.communication.replyToEmail')}</label>
            <input
              id="settings-communication-replyToEmail"
              name="replyToEmail"
              type="email"
              className={`input${error === 'companyProfile.replyToEmailInvalid' ? ' input--error' : ''}`}
              value={draft.replyToEmail}
              placeholder={companyProfile.email}
              readOnly={!editable}
              onChange={(event) => setField('replyToEmail', event.target.value)}
              data-testid="settings-communication-replyToEmail"
            />
            <p className="form-hint" data-testid="settings-communication-replyToEmail-hint">
              {replyToIsFallback
                ? translate('settings.communication.replyToEmail.fallback').replace('{email}', replyTo || '—')
                : translate('settings.communication.replyToEmail.custom')}
            </p>
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
              <dd data-testid="settings-communication-identity-replyTo">{replyTo || '—'}</dd>
            </div>
          </dl>
          <p className="form-hint" data-testid="settings-communication-identity-hint">{translate('settings.communication.identity.hint')}</p>
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
              className="input settings-invoices__textarea"
              rows={7}
              value={draft.emailSignature}
              maxLength={COMPANY_PROFILE_TEXT_LIMITS.emailSignature}
              placeholder={derivedSignature}
              readOnly={!editable}
              onChange={(event) => setField('emailSignature', event.target.value)}
              data-testid="settings-communication-emailSignature"
            />
            <p className="form-hint" data-testid="settings-communication-emailSignature-hint">
              {draft.emailSignature.trim() ? t('settings.communication.signature.custom') : t('settings.communication.signature.derived')}
            </p>
          </div>
        </fieldset>

        {/* ---------------- Vorlagen je Dokumentart (Rechnung: EMAIL-01B4, Angebot/Brief: 07C) ---------------- */}
        {TEMPLATE_SECTIONS.map((section) => {
          const fallback = resolveMailTemplate(section.kind, language);
          const preview = composeDeliveryMail({
            kind: section.kind,
            values: { companyName, ...PREVIEW_VALUES[section.kind] },
            profile: candidate,
            language,
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
                  className="input"
                  value={draft[section.subject]}
                  maxLength={COMPANY_PROFILE_TEXT_LIMITS[section.subject]}
                  placeholder={fallback.subject}
                  readOnly={!editable}
                  onChange={(event) => setField(section.subject, event.target.value)}
                  data-testid={`settings-communication-${section.subject}`}
                />
              </div>
              <div className="settings-form__field">
                <label htmlFor={`settings-communication-${section.body}`}>{t('settings.invoices.email.body')}</label>
                <textarea
                  id={`settings-communication-${section.body}`}
                  name={section.body}
                  className="input settings-invoices__textarea"
                  rows={6}
                  value={draft[section.body]}
                  maxLength={COMPANY_PROFILE_TEXT_LIMITS[section.body]}
                  placeholder={fallback.body}
                  readOnly={!editable}
                  onChange={(event) => setField(section.body, event.target.value)}
                  data-testid={`settings-communication-${section.body}`}
                />
              </div>
              <div className="settings-invoices__preview" data-testid={section.kind === 'invoice' ? 'settings-communication-email-preview' : `settings-communication-preview-${section.kind}`}>
                <p className="settings-form__legend">{t('settings.communication.template.preview')}</p>
                <p className="data-row__value" data-testid={section.kind === 'invoice' ? 'settings-communication-email-preview-subject' : `settings-communication-preview-${section.kind}-subject`}>{preview.subject}</p>
                <pre className="settings-invoices__mail-preview" data-testid={section.kind === 'invoice' ? 'settings-communication-email-preview-body' : `settings-communication-preview-${section.kind}-body`}>{preview.bodyText}</pre>
              </div>
            </fieldset>
          );
        })}

        {error ? (
          <p className="form-error" data-testid="settings-communication-error">{translate(error)}</p>
        ) : null}

        {editable ? (
          <div className="settings-form__actions">
            <span className="settings-form__dirty" data-testid="settings-communication-dirty">
              {dirty ? translate('settings.company.unsavedHint') : translate('settings.company.noChanges')}
            </span>
            <Button type="submit" disabled={!dirty || saving} loading={saving} data-testid="settings-communication-save">
              {translate('common.save')}
            </Button>
          </div>
        ) : null}
      </form>
    </div>
  );
}
