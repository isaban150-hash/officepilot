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
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { PageHeader } from '../../components/ui/Card';
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
import { resolveDeliveryBody, resolveDeliverySubject } from '../../services/delivery/documentDeliveryDefaults';
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
] as const satisfies readonly (keyof CompanyProfile & string)[];

export interface CommunicationSettingsDraft {
  senderDisplayName: string;
  replyToEmail: string;
  defaultInvoiceEmailSubject: string;
  defaultInvoiceEmailBody: string;
}

export function pickCommunicationSettings(profile: CompanyProfile): CommunicationSettingsDraft {
  return {
    senderDisplayName: profile.senderDisplayName ?? '',
    replyToEmail: profile.replyToEmail ?? '',
    defaultInvoiceEmailSubject: profile.defaultInvoiceEmailSubject ?? '',
    defaultInvoiceEmailBody: profile.defaultInvoiceEmailBody ?? '',
  };
}

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
  const previewInvoiceLike = useMemo(
    () => ({ number: PREVIEW_INVOICE_NUMBER, companySnapshot: { companyName: companyProfile.companyName, legalForm: companyProfile.legalForm } as CompanyProfile }),
    [companyProfile.companyName, companyProfile.legalForm],
  );

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
    <div className="page settings-page settings-subpage" data-testid="settings-communication-page">
      <Link to="/einstellungen" className="back-link" data-testid="settings-communication-back">
        ← {translate('settings.backToHub')}
      </Link>
      <PageHeader title={translate('settings.communication.title')} subtitle={translate('settings.communication.page.subtitle')} />

      {!editable ? (
        <p className="invoice-hint invoice-hint--warning" data-testid="settings-communication-readonly">
          {translate(access.reason === 'member' ? 'settings.communication.readOnly' : 'settings.company.roleUnknown')}
        </p>
      ) : (
        <p className="hint-text" data-testid="settings-communication-historical-hint">
          {translate('settings.communication.historicalHint')}
        </p>
      )}

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

        {/* ---------------- Standardtexte (EMAIL-01B4, hierher verschoben) ---------------- */}
        <fieldset className="form-group settings-form__section" data-testid="settings-communication-section-email" disabled={disabled}>
          <legend className="settings-form__legend">{translate('settings.invoices.section.email')}</legend>
          <p className="hint-text">{translate('settings.invoices.email.hint')}</p>
          <div className="settings-form__field">
            <label htmlFor="settings-communication-defaultInvoiceEmailSubject">{translate('settings.invoices.email.subject')}</label>
            <input
              id="settings-communication-defaultInvoiceEmailSubject"
              name="defaultInvoiceEmailSubject"
              type="text"
              className="input"
              value={draft.defaultInvoiceEmailSubject}
              maxLength={COMPANY_PROFILE_TEXT_LIMITS.defaultInvoiceEmailSubject}
              placeholder={resolveDeliverySubject(previewInvoiceLike, language)}
              readOnly={!editable}
              onChange={(event) => setField('defaultInvoiceEmailSubject', event.target.value)}
              data-testid="settings-communication-defaultInvoiceEmailSubject"
            />
          </div>
          <div className="settings-form__field">
            <label htmlFor="settings-communication-defaultInvoiceEmailBody">{translate('settings.invoices.email.body')}</label>
            <textarea
              id="settings-communication-defaultInvoiceEmailBody"
              name="defaultInvoiceEmailBody"
              className="input settings-invoices__textarea"
              rows={6}
              value={draft.defaultInvoiceEmailBody}
              maxLength={COMPANY_PROFILE_TEXT_LIMITS.defaultInvoiceEmailBody}
              placeholder={resolveDeliveryBody(previewInvoiceLike, language)}
              readOnly={!editable}
              onChange={(event) => setField('defaultInvoiceEmailBody', event.target.value)}
              data-testid="settings-communication-defaultInvoiceEmailBody"
            />
          </div>
          <p className="form-hint">{translate('settings.invoices.email.fallbackHint')}</p>
          <div className="settings-invoices__preview" data-testid="settings-communication-email-preview">
            <p className="settings-form__legend">{translate('settings.invoices.email.preview').replace('{invoiceNumber}', PREVIEW_INVOICE_NUMBER)}</p>
            <p className="data-row__value" data-testid="settings-communication-email-preview-subject">
              {resolveDeliverySubject(previewInvoiceLike, language, candidate)}
            </p>
            <pre className="settings-invoices__mail-preview" data-testid="settings-communication-email-preview-body">
              {resolveDeliveryBody(previewInvoiceLike, language, candidate)}
            </pre>
          </div>
        </fieldset>

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
