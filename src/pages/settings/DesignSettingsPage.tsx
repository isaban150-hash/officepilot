import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { SimpleConfirmDialog } from '../../components/ui/SimpleConfirmDialog';
import { SettingsAccessNotice, resolveSettingsNoticeVariant } from '../../components/settings/SettingsAccessNotice';
import { SettingsPageHeader } from '../../components/settings/SettingsPageHeader';
import { SettingsSaveBar } from '../../components/settings/SettingsSaveBar';
import { InvoiceDocumentView } from '../../components/invoice/InvoiceDocumentView';
import { useApp } from '../../context/AppContext';
import { useOptionalAuth } from '../../context/AuthContext';
import { useCompanyLogoObjectUrl } from '../../hooks/useCompanyLogoObjectUrl';
import { useFormResume } from '../../hooks/useFormResume';
import { useSettingsAccess } from '../../hooks/useSettingsAccess';
import { isSupabaseConfigured } from '../../lib/supabase';
import { getCompanyProfile } from '../../services/companyProfileService';
import { uploadBrandingAsset, type BrandingAssetError } from '../../services/branding/brandingAssetCloudService';
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
 *
 * EINRICHTUNG-01 (AP6; Vertrag 1.20, F-06/F-07, K7):
 *  - Das gespeicherte Logo zeigt „wird geladen“, „konnte nicht geladen werden“ mit „Erneut versuchen“, „Noch kein Logo“
 *    oder die Vorschau — ein Ladefehler ist nie „kein Logo“.
 *  - Der Speichervorgang ist an Konto und Betrieb vom Beginn gebunden. Wechselt eines davon zwischen Upload und
 *    Referenz, unterbleibt der Patch; die Auswahl wird verworfen (keine Vermischung zweier Betriebe).
 *  - Wird der Patch abgewiesen (Rechte entzogen, Prüfregel), bleibt die Auswahl; die Wiederholung setzt nur die
 *    Referenz auf dasselbe, inhaltsadressierte Objekt.
 *  - „Verwerfen“ verwirft die Auswahl ohne Upload.
 */
export const DESIGN_SETTINGS_ROUTE = '/einstellungen/design';

const PENDING_LOGO_ASSET_KEY = 'pendingLogoAssetId';
const PENDING_LOGO_MIME_KEY = 'pendingLogoMimeType';
/** EINRICHTUNG-01 (AP6; K7) — der Betrieb, in dessen Pfad das ausstehende Objekt liegt. */
const PENDING_LOGO_WORKSPACE_KEY = 'pendingLogoWorkspaceId';

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

function uploadErrorKey(error: BrandingAssetError): TranslationKey {
  return error === 'forbidden' ? 'settings.design.logo.error.uploadForbidden' : 'companyProfile.logoError.uploadFailed';
}

interface DesignResumeState {
  /** Entfernen ist eine Entscheidung, die den Neuaufbau überleben darf. */
  pendingLogoRemoval: boolean;
}

/** Ein hochgeladenes, noch nicht referenziertes Objekt — mit dem Betrieb, in dessen Pfad es liegt. */
interface PendingLogoUpload {
  reference: LogoAssetReference;
  workspaceId: string;
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

function currentWorkspaceId(): string | null {
  return getSyncClient().serverWorkspaceId ?? null;
}

export function DesignSettingsPage() {
  const { companyProfile, setup, updateCompanyProfile, translate, showToast } = useApp();
  const workspaceId = getSyncClient().serverWorkspaceId;
  const userId = useOptionalAuth()?.user?.id ?? null;
  /** Das Konto des letzten Renders — für den Abgleich nach dem Upload (K7). */
  const liveUserIdRef = useRef<string | null>(userId);
  liveUserIdRef.current = userId;

  // EINRICHTUNG-01 (AP5; 1.16) — reaktiv: Rolle, Lizenz und Löschantrag wirken ohne Neuladen.
  const { access, canEdit: editable } = useSettingsAccess();
  const noticeVariant = resolveSettingsNoticeVariant(access);

  const resume = useFormResume<DesignResumeState>({
    namespace: 'designSettings',
    fields: ['pendingLogoRemoval'],
    saved: { pendingLogoRemoval: false },
    workspaceType: 'other',
    extraKeys: [PENDING_LOGO_ASSET_KEY, PENDING_LOGO_MIME_KEY, PENDING_LOGO_WORKSPACE_KEY],
  });

  const [pendingRemoval, setPendingRemoval] = useState<boolean>(
    () => resume.restored.pendingLogoRemoval === true,
  );
  const [prepared, setPrepared] = useState<PreparedBrandingLogo | null>(null);
  const [preparedUrl, setPreparedUrl] = useState<string | null>(null);
  const [pendingUpload, setPendingUpload] = useState<PendingLogoUpload | null>(() => {
    const assetId = resume.restoredExtras[PENDING_LOGO_ASSET_KEY];
    const mimeType = resume.restoredExtras[PENDING_LOGO_MIME_KEY];
    const uploadWorkspace = resume.restoredExtras[PENDING_LOGO_WORKSPACE_KEY];
    if (typeof assetId !== 'string' || !assetId.trim()) return null;
    if (typeof mimeType !== 'string' || !isLogoMimeType(mimeType)) return null;
    // K7 — nur ein Objekt aus dem Pfad des aktuellen Betriebs wird wieder aufgenommen.
    if (typeof uploadWorkspace !== 'string' || !uploadWorkspace || uploadWorkspace !== currentWorkspaceId()) return null;
    return { reference: { assetId, mimeType }, workspaceId: uploadWorkspace };
  });
  const pendingLogoRef = pendingUpload?.reference ?? null;
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);
  // EINRICHTUNG-01 (AP9; 1.30) — Speicherfehler als bleibender Hinweis an der Speicherleiste, nicht als Toast.
  const [saveError, setSaveError] = useState<TranslationKey | null>(null);
  const inFlight = useRef(false);

  resume.observe(
    { pendingLogoRemoval: pendingRemoval },
    {
      [PENDING_LOGO_ASSET_KEY]: pendingUpload?.reference.assetId ?? null,
      [PENDING_LOGO_MIME_KEY]: pendingUpload?.reference.mimeType ?? null,
      [PENDING_LOGO_WORKSPACE_KEY]: pendingUpload?.workspaceId ?? null,
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
    // FINANZ-CORE-01A (EIN-09) — dieselben Standardwerte wie eine neue Rechnung.
    () => buildSettingsDocumentPreviewModel({ profile: companyProfile, logo: previewLogo, setup }),
    [companyProfile, previewLogo, setup],
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
      setPendingUpload(null);
      setPendingRemoval(false);
    } finally {
      setProcessing(false);
    }
  };

  const handleRemove = () => {
    if (!editable) return;
    setErrorKey(null);
    setPrepared(null);
    setPendingUpload(null);
    setPendingRemoval(true);
  };

  const handleKeep = () => {
    setPendingRemoval(false);
  };

  // EINRICHTUNG-01 (AP8; 1.28) — „Logo entfernen“ erst nach Rückfrage; wirksam wird es weiterhin mit „Speichern“.
  const [entfernenFragen, setEntfernenFragen] = useState(false);

  /** F-07.2 — „Verwerfen“: Auswahl und Entfernung zurücknehmen, ohne Upload. */
  const handleDiscard = () => {
    if (saving) return;
    setErrorKey(null);
    setPrepared(null);
    setPendingUpload(null);
    setPendingRemoval(false);
    // EINRICHTUNG-01 (AP9; 1.30) — mit dem Verwerfen gilt auch der Hinweis des letzten Speicherversuchs nicht mehr.
    setSaveError(null);
    resume.clearResume();
  };

  const handleSave = async () => {
    if (!editable || !dirty || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setSaveError(null);
    setErrorKey(null);
    // K7 — Konto und Betrieb vom Beginn dieses Speichervorgangs.
    const bound = { userId: liveUserIdRef.current, workspaceId: currentWorkspaceId() };
    const bindingChanged = () => liveUserIdRef.current !== bound.userId || currentWorkspaceId() !== bound.workspaceId;
    try {
      // Entfernen nimmt auch das Alt-Bild mit — sonst erschiene es überraschend wieder (D-023).
      const removal = pendingRemoval && !prepared && !pendingLogoRef;
      let branding: ReturnType<typeof getCompanyProfile>['branding'];

      if (removal) {
        // FINANZ-CORE-01A (EIN-03) — das Branding im Augenblick des Speicherns, nicht vom Seitenstart.
        branding = withoutLogoReference(getCompanyProfile().branding) ?? {};
      } else {
        let reference: LogoAssetReference | null = null;
        if (pendingUpload) {
          if (pendingUpload.workspaceId === bound.workspaceId) {
            reference = pendingUpload.reference;
          } else {
            // Das ausstehende Objekt liegt im Pfad eines anderen Betriebs — nie hier referenzieren.
            setPendingUpload(null);
            if (!prepared) {
              setErrorKey('settings.design.logo.error.bindingChanged');
              return;
            }
          }
        }
        if (!reference && prepared) {
          if (!bound.workspaceId) {
            setErrorKey('companyProfile.logoError.noWorkspace');
            return;
          }
          const uploaded = await uploadBrandingAsset({
            workspaceId: bound.workspaceId,
            blob: prepared.blob,
            mimeType: prepared.mimeType,
          });
          if (!uploaded.ok) {
            setErrorKey(uploadErrorKey(uploaded.error));
            return;
          }
          reference = uploaded.reference;
          // Merken (mit dem Betrieb): Eine Wiederholung setzt nur noch die Referenz auf dasselbe Objekt.
          setPendingUpload({ reference: uploaded.reference, workspaceId: bound.workspaceId });
        }
        if (!reference) return;

        // K7 — Konto oder Betrieb gewechselt: kein Patch, keine Referenz im anderen Betrieb; die Auswahl gehört nicht dorthin.
        if (bindingChanged()) {
          setPrepared(null);
          setPendingUpload(null);
          setPendingRemoval(false);
          setErrorKey('settings.design.logo.error.bindingChanged');
          return;
        }
        // K7 — Rechte während des Uploads entzogen (Rolle, Lizenz, Löschantrag): kein Patch, die Auswahl bleibt.
        const accessNow = resolveWorkspaceWriteAccess({ userId: bound.userId ?? undefined, cloudConfigured: isSupabaseConfigured() });
        if (!accessNow.canWrite) {
          setErrorKey('settings.design.logo.error.notApplied');
          return;
        }
        branding = withLogoReference(getCompanyProfile().branding, reference);
      }

      /*
       * FIRMENPROFIL-01D — ein neues Logo ist eine Asset-Referenz und wird die
       * einzige aktive Branding-Wahrheit: Der Legacy-`logoDataUrl` wird dabei
       * aus dem Profil genommen, damit er nicht in neue Rechnungs-Snapshots
       * weitergeschrieben wird. Bestehende Snapshots tragen ihre eigene Kopie.
       */
      const result = updateCompanyProfile({ branding, logoDataUrl: '' });
      if (!result.success) {
        // Abgewiesen: Fehlertext, die Auswahl bleibt für einen weiteren Versuch (F-07.3).
        setErrorKey(result.errorKey as TranslationKey);
        return;
      }
      setPrepared(null);
      setPendingUpload(null);
      setPendingRemoval(false);
      resume.clearResume();
      if (!getLastPersistSuccess()) {
        setSaveError('persist.failed.userAction');
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
  /* F-06 — Zustand des gespeicherten Logos: lädt, Fehler, vorhanden. */
  const savedView: 'loading' | 'error' | 'ready' | 'none' = !showSavedLogo
    ? 'none'
    : savedLogo.status === 'error'
      ? 'error'
      : savedLogo.status === 'ready' && savedLogo.url
        ? 'ready'
        : savedLogo.status === 'missing'
          ? 'none'
          : 'loading';
  const notApplied = Boolean(errorKey && pendingLogoRef && prepared);

  return (
    <div className="page settings-page settings-subpage" data-testid="settings-design-page">
      <SettingsPageHeader target="logo" subtitle={translate('settings.design.page.subtitle')} backTestId="settings-design-back" />

      {!editable && noticeVariant ? <SettingsAccessNotice variant={noticeVariant} testId="settings-design-readonly" /> : null}

      {/* ---------------- Firmenlogo ---------------- */}
      <section className="settings-form__section settings-design__section" data-testid="settings-design-logo">
        <h2 className="settings-form__legend">{translate('settings.design.section.logo')}</h2>

        <div className="settings-design__logo-row">
          <div className="settings-design__logo-frame" data-testid="settings-design-logo-frame" aria-busy={savedView === 'loading'}>
            {showPendingLogo ? (
              <img src={preparedUrl ?? undefined} alt="" className="settings-design__logo-img" data-testid="settings-design-logo-pending" />
            ) : savedView === 'ready' || (savedView === 'error' && savedLogo.url) ? (
              <img
                src={savedLogo.url}
                alt=""
                className="settings-design__logo-img"
                data-testid="settings-design-logo-current"
                data-source={savedLogo.source}
              />
            ) : savedView === 'loading' ? (
              <span className="settings-design__logo-empty" role="status" data-testid="settings-design-logo-loading">
                {translate('settings.design.logo.loading')}
              </span>
            ) : savedView === 'error' ? (
              <span className="settings-design__logo-empty" data-testid="settings-design-logo-unavailable">
                {translate('settings.design.logo.loadError')}
              </span>
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
            ) : savedView === 'ready' ? (
              <p className="hint-text">{translate('settings.design.logo.current')}</p>
            ) : null}
            {savedView === 'error' ? (
              <div className="form-error" role="alert" data-testid="settings-design-logo-load-error">
                <p>
                  {translate(savedLogo.url ? 'settings.design.logo.loadErrorFallback' : 'settings.design.logo.loadError')}
                </p>
                <Button type="button" variant="outline" onClick={savedLogo.retry} data-testid="settings-design-logo-retry">
                  {translate('settings.design.logo.retry')}
                </Button>
              </div>
            ) : null}
            <p className="hint-text">{translate('settings.design.logo.hint')}</p>
            {errorKey ? (
              <p className="form-error" role="alert" data-testid="settings-design-logo-error">
                {translate(errorKey)}
              </p>
            ) : null}
            {notApplied ? (
              <p className="hint-text" data-testid="settings-design-logo-not-applied">
                {translate('settings.design.logo.notAppliedHint')}
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
              <Button type="button" variant="outline" onClick={() => setEntfernenFragen(true)} disabled={processing || saving} data-testid="settings-design-logo-remove">
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

      <SimpleConfirmDialog
        open={entfernenFragen}
        title={translate('confirm.logoRemove.title')}
        message={translate('confirm.logoRemove.text')}
        confirmLabel={translate('confirm.logoRemove.action')}
        cancelLabel={translate('common.cancel')}
        confirmTestId="settings-design-logo-remove-confirm"
        cancelTestId="settings-design-logo-remove-cancel"
        dialogTestId="settings-design-logo-remove-dialog"
        onConfirm={() => {
          setEntfernenFragen(false);
          handleRemove();
          return true;
        }}
        onCancel={() => setEntfernenFragen(false)}
      />
      {editable ? (
        <SettingsSaveBar
          dirty={dirty}
          saving={saving}
          saveDisabled={processing}
          onDiscard={handleDiscard}
          onSave={() => void handleSave()}
          testIdPrefix="settings-design"
          draftKept
          error={saveError ? translate(saveError) : null}
        />
      ) : null}
    </div>
  );
}
