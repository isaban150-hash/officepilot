import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { PageHeader } from '../../components/ui/Card';
import { InvoiceDocumentView } from '../../components/invoice/InvoiceDocumentView';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { useCompanyLogoObjectUrl } from '../../hooks/useCompanyLogoObjectUrl';
import { useFormResume } from '../../hooks/useFormResume';
import { isSupabaseConfigured } from '../../lib/supabase';
import { uploadBrandingAsset } from '../../services/branding/brandingAssetCloudService';
import {
  prepareBrandingLogo,
  type BrandingLogoPrepareError,
  type PreparedBrandingLogo,
} from '../../services/branding/brandingLogoImageProcessing';
import { withLogoReference, withoutLogoReference } from '../../services/branding/brandingProfileEdit';
import { resolveProfileDocumentTemplate } from '../../services/company/companyProfileSettingsContract';
import { getLastPersistSuccess } from '../../services/persistenceService';
import { buildSettingsDocumentPreviewModel } from '../../services/settings/settingsDocumentPreview';
import { getSyncClient } from '../../services/sync/syncClientService';
import { resolveWorkspaceWriteAccess } from '../../services/workspace/workspaceRoleService';
import { LOGO_MIME_TYPES, type HistoricalInvoiceLogoSource, type LogoAssetReference, type LogoMimeType } from '../../types/branding';
import type { TranslationKey } from '../../i18n';

/**
 * SETTINGS-01B3 — die Design-Unterseite `/einstellungen/design`.
 *
 * Drei ruhige Bereiche: Firmenlogo, Dokumentvorlage, Vorschau. Das Logo
 * läuft über die bestehende Branding-Architektur (unveränderliche Assets im
 * Workspace-Bucket, Referenz im `BrandingProfile`, Snapshot je Rechnung).
 * Ablauf: wählen → prüfen/verkleinern → lokaler Pending-Entwurf → Vorschau →
 * **Speichern** (Upload, Referenz, Profil, Sync). Ein bereits hochgeladenes
 * Asset wird beim Retry wiederverwendet (`pendingLogoRef`, auch über einen
 * Neuaufbau). Historische Assets werden nie gelöscht.
 */
export const DESIGN_SETTINGS_ROUTE = '/einstellungen/design';

const PENDING_LOGO_ASSET_KEY = 'pendingLogoAssetId';
const PENDING_LOGO_MIME_KEY = 'pendingLogoMimeType';

/** Innere Breite des Vorschaudokuments — eine A4-ähnliche Seite bei 96 dpi. */
export const PREVIEW_SHEET_WIDTH_PX = 794;

function isLogoMimeType(value: string): value is LogoMimeType {
  return (LOGO_MIME_TYPES as readonly string[]).includes(value);
}

const PREPARE_ERROR_KEYS: Record<BrandingLogoPrepareError, TranslationKey> = {
  file_too_large: 'settings.design.logo.error.inputTooLarge',
  unsupported_mime: 'companyProfile.logoError.unsupportedType',
  signature_mismatch: 'companyProfile.logoError.contentMismatch',
  invalid_file: 'companyProfile.logoError.unreadable',
  decode_failed: 'settings.design.logo.error.decode',
  too_large_after_processing: 'settings.design.logo.error.tooLargeAfterProcessing',
};

interface DesignResumeState {
  /** Entfernen ist eine Entscheidung, die den Neuaufbau überleben darf. */
  pendingLogoRemoval: boolean;
}

/** Skaliert die A4-breite Vorschau proportional in die verfügbare Breite. */
function useScaledPreview(): { hostRef: React.RefObject<HTMLDivElement | null>; scale: number; height: number } {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      const width = host.clientWidth;
      const nextScale = width > 0 ? Math.min(1, width / PREVIEW_SHEET_WIDTH_PX) : 1;
      setScale(nextScale);
      const sheet = host.querySelector<HTMLDivElement>('.settings-preview__sheet');
      sheetRef.current = sheet;
      if (sheet) setHeight(Math.ceil(sheet.scrollHeight * nextScale));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    if (sheetRef.current) observer.observe(sheetRef.current);
    return () => observer.disconnect();
  }, []);

  return { hostRef, scale, height };
}

export function DesignSettingsPage() {
  const { companyProfile, updateCompanyProfile, translate, showToast } = useApp();
  const { user } = useAuth();
  const workspaceId = getSyncClient().serverWorkspaceId;

  const access = useMemo(
    () => resolveWorkspaceWriteAccess({ userId: user?.id, cloudConfigured: isSupabaseConfigured() }),
    [user?.id],
  );
  const editable = access.canWrite;

  const resume = useFormResume<DesignResumeState>({
    namespace: 'designSettings',
    fields: ['pendingLogoRemoval'],
    saved: { pendingLogoRemoval: false },
    workspaceType: 'other',
    extraKeys: [PENDING_LOGO_ASSET_KEY, PENDING_LOGO_MIME_KEY],
  });

  const [pendingRemoval, setPendingRemoval] = useState<boolean>(
    () => resume.restored.pendingLogoRemoval === true,
  );
  const [prepared, setPrepared] = useState<PreparedBrandingLogo | null>(null);
  const [preparedUrl, setPreparedUrl] = useState<string | null>(null);
  const [pendingLogoRef, setPendingLogoRef] = useState<LogoAssetReference | null>(() => {
    const assetId = resume.restoredExtras[PENDING_LOGO_ASSET_KEY];
    const mimeType = resume.restoredExtras[PENDING_LOGO_MIME_KEY];
    if (typeof assetId !== 'string' || !assetId.trim()) return null;
    if (typeof mimeType !== 'string' || !isLogoMimeType(mimeType)) return null;
    return { assetId, mimeType };
  });
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);

  resume.observe(
    { pendingLogoRemoval: pendingRemoval },
    {
      [PENDING_LOGO_ASSET_KEY]: pendingLogoRef?.assetId ?? null,
      [PENDING_LOGO_MIME_KEY]: pendingLogoRef?.mimeType ?? null,
    },
  );

  /* Vorschau-URL der vorbereiteten Datei — eigener Lebenszyklus. */
  useEffect(() => {
    if (!prepared) {
      setPreparedUrl(null);
      return;
    }
    const url = URL.createObjectURL(prepared.blob);
    setPreparedUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [prepared]);

  const savedLogo = useCompanyLogoObjectUrl({
    workspaceId,
    logo: companyProfile.branding?.logo,
    logoDataUrl: companyProfile.logoDataUrl,
  });
  const hasSavedLogo = Boolean(companyProfile.branding?.logo) || Boolean(companyProfile.logoDataUrl);

  /*
   * Das Logo des Entwurfs für die Vorschau: ausstehende Datei → deren
   * Object-URL; ausstehende Entfernung → keines; sonst das gespeicherte.
   * Ein bereits hochgeladenes, noch nicht gespeichertes Asset (Retry) wird
   * über seine Referenz aufgelöst.
   */
  const previewLogo: HistoricalInvoiceLogoSource = useMemo(() => {
    if (prepared && preparedUrl) return { kind: 'legacy_data_url', dataUrl: preparedUrl };
    if (pendingLogoRef) return { kind: 'asset', reference: pendingLogoRef };
    if (pendingRemoval) return { kind: 'none' };
    if (companyProfile.branding?.logo) return { kind: 'asset', reference: companyProfile.branding.logo };
    if (companyProfile.logoDataUrl) return { kind: 'legacy_data_url', dataUrl: companyProfile.logoDataUrl };
    return { kind: 'none' };
  }, [prepared, preparedUrl, pendingLogoRef, pendingRemoval, companyProfile]);

  const previewModel = useMemo(
    () => buildSettingsDocumentPreviewModel({ profile: companyProfile, logo: previewLogo }),
    [companyProfile, previewLogo],
  );

  const { hostRef, scale, height } = useScaledPreview();

  const dirty = Boolean(prepared) || Boolean(pendingLogoRef) || (pendingRemoval && hasSavedLogo);
  const template = resolveProfileDocumentTemplate(companyProfile);

  const handleSelectFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = '';
    if (!file || !editable) return;
    setProcessing(true);
    setErrorKey(null);
    try {
      const result = await prepareBrandingLogo(file);
      if (!result.ok) {
        setErrorKey(PREPARE_ERROR_KEYS[result.error]);
        return;
      }
      // Eine neue Auswahl ersetzt einen früheren Pending-Upload und hebt eine Entfernung auf.
      setPrepared(result.logo);
      setPendingLogoRef(null);
      setPendingRemoval(false);
    } finally {
      setProcessing(false);
    }
  };

  const handleRemove = () => {
    if (!editable) return;
    setErrorKey(null);
    setPrepared(null);
    setPendingLogoRef(null);
    setPendingRemoval(true);
  };

  const handleKeep = () => {
    setPendingRemoval(false);
  };

  const handleSave = async () => {
    if (!editable || !dirty || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setErrorKey(null);
    try {
      let branding = companyProfile.branding;
      // Entfernen nimmt auch das Alt-Bild mit — sonst erschiene es überraschend wieder (D-023).
      const removal = pendingRemoval && !prepared && !pendingLogoRef;

      if (removal) {
        branding = withoutLogoReference(branding) ?? {};
      } else {
        let reference = pendingLogoRef;
        if (!reference && prepared) {
          if (!workspaceId) {
            setErrorKey('companyProfile.logoError.noWorkspace');
            return;
          }
          const uploaded = await uploadBrandingAsset({
            workspaceId,
            blob: prepared.blob,
            mimeType: prepared.mimeType,
          });
          if (!uploaded.ok) {
            setErrorKey('companyProfile.logoError.uploadFailed');
            return;
          }
          reference = uploaded.reference;
          // Merken: ein Fehlschlag beim Speichern darf keinen zweiten Upload auslösen.
          setPendingLogoRef(uploaded.reference);
          setPrepared(null);
        }
        if (!reference) return;
        branding = withLogoReference(branding, reference);
      }

      const result = updateCompanyProfile(removal ? { branding, logoDataUrl: '' } : { branding });
      if (!result.success) {
        setErrorKey(result.errorKey as TranslationKey);
        return;
      }
      setPrepared(null);
      setPendingLogoRef(null);
      setPendingRemoval(false);
      resume.clearResume();
      if (!getLastPersistSuccess()) {
        showToast(translate('persist.failed.userAction'));
        return;
      }
      showToast(translate('settings.design.saved'));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  const showPendingLogo = Boolean(prepared && preparedUrl);
  const showSavedLogo = !showPendingLogo && !pendingLogoRef && !pendingRemoval && hasSavedLogo;

  return (
    <div className="page settings-page settings-subpage" data-testid="settings-design-page">
      <Link to="/einstellungen" className="back-link" data-testid="settings-design-back">
        ← {translate('settings.backToHub')}
      </Link>
      <PageHeader title={translate('settings.design.title')} subtitle={translate('settings.design.page.subtitle')} />

      {!editable ? (
        <p className="invoice-hint invoice-hint--warning" data-testid="settings-design-readonly">
          {translate(access.reason === 'member' ? 'settings.design.readOnly' : 'settings.company.roleUnknown')}
        </p>
      ) : null}

      {/* ---------------- Firmenlogo ---------------- */}
      <section className="settings-form__section settings-design__section" data-testid="settings-design-logo">
        <h2 className="settings-form__legend">{translate('settings.design.section.logo')}</h2>

        <div className="settings-design__logo-row">
          <div className="settings-design__logo-frame" data-testid="settings-design-logo-frame">
            {showPendingLogo ? (
              <img src={preparedUrl ?? undefined} alt="" className="settings-design__logo-img" data-testid="settings-design-logo-pending" />
            ) : showSavedLogo && savedLogo.url ? (
              <img src={savedLogo.url} alt="" className="settings-design__logo-img" data-testid="settings-design-logo-current" />
            ) : pendingLogoRef ? (
              <span className="settings-design__logo-empty" data-testid="settings-design-logo-uploaded">
                {translate('settings.design.logo.pending')}
              </span>
            ) : (
              <span className="settings-design__logo-empty" data-testid="settings-design-logo-none">
                {translate('settings.design.logo.none')}
              </span>
            )}
          </div>
          <div className="settings-design__logo-meta">
            {showPendingLogo ? (
              <p className="hint-text" data-testid="settings-design-logo-pending-hint">
                {translate('settings.design.logo.pending')}
                {prepared?.resized
                  ? ` ${translate('settings.design.logo.resized')
                      .replace('{from}', `${prepared.originalWidth}×${prepared.originalHeight}`)
                      .replace('{to}', `${prepared.width}×${prepared.height}`)}`
                  : ''}
              </p>
            ) : pendingRemoval && hasSavedLogo ? (
              <p className="hint-text" data-testid="settings-design-logo-removed-hint">
                {translate('settings.design.logo.removedPending')}
              </p>
            ) : showSavedLogo ? (
              <p className="hint-text">{translate('settings.design.logo.current')}</p>
            ) : null}
            <p className="hint-text">{translate('settings.design.logo.hint')}</p>
            {errorKey ? (
              <p className="form-error" data-testid="settings-design-logo-error">
                {translate(errorKey)}
              </p>
            ) : null}
          </div>
        </div>

        {editable ? (
          <div className="settings-design__logo-actions">
            <label className="btn btn--outline settings-design__file-label" data-testid="settings-design-logo-upload-label">
              {hasSavedLogo || showPendingLogo || pendingLogoRef
                ? translate('settings.design.logo.replace')
                : translate('settings.design.logo.upload')}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="settings-design__file-input"
                disabled={processing || saving}
                data-testid="settings-design-logo-input"
                onChange={(event) => void handleSelectFile(event)}
              />
            </label>
            {(hasSavedLogo || showPendingLogo || pendingLogoRef) && !pendingRemoval ? (
              <Button type="button" variant="outline" onClick={handleRemove} disabled={processing || saving} data-testid="settings-design-logo-remove">
                {translate('settings.design.logo.remove')}
              </Button>
            ) : null}
            {pendingRemoval && hasSavedLogo ? (
              <Button type="button" variant="ghost" onClick={handleKeep} disabled={saving} data-testid="settings-design-logo-keep">
                {translate('settings.design.logo.keep')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* ---------------- Dokumentvorlage ---------------- */}
      <section className="settings-form__section settings-design__section" data-testid="settings-design-template">
        <h2 className="settings-form__legend">{translate('settings.design.section.template')}</h2>
        <div className="data-row" data-testid={`settings-design-template-${template}`}>
          <span className="data-row__label">{translate('settings.design.template.classic')}</span>
          <span className="data-row__value">{translate('settings.design.template.classicDescription')}</span>
        </div>
        <p className="hint-text">{translate('settings.design.template.more')}</p>
      </section>

      {/* ---------------- Vorschau ---------------- */}
      <section className="settings-form__section settings-design__section" data-testid="settings-design-preview">
        <h2 className="settings-form__legend">{translate('settings.design.section.preview')}</h2>
        <p className="settings-design__preview-title">{translate('settings.design.preview.title')}</p>
        <p className="hint-text">{translate('settings.design.preview.hint')}</p>
        <div className="settings-preview" ref={hostRef} style={{ height: height > 0 ? `${height}px` : undefined }}>
          <div
            className="settings-preview__sheet"
            style={{ width: `${PREVIEW_SHEET_WIDTH_PX}px`, transform: `scale(${scale})` }}
            data-testid="settings-design-preview-sheet"
          >
            <InvoiceDocumentView model={previewModel} />
          </div>
        </div>
      </section>

      {editable ? (
        <div className="settings-form__actions" data-testid="settings-design-actions">
          <span className="settings-form__dirty" data-testid="settings-design-dirty">
            {dirty ? translate('settings.company.unsavedHint') : translate('settings.company.noChanges')}
          </span>
          <Button type="button" onClick={() => void handleSave()} disabled={!dirty || saving || processing} loading={saving} data-testid="settings-design-save">
            {translate('common.save')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
