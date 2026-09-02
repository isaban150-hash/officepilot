import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/Card';
import { LanguageSwitcher } from '../components/settings/LanguageSwitcher';
import { BackupExportPanel } from '../components/settings/BackupExportPanel';
import { PilotHintsPanel } from '../components/settings/PilotHintsPanel';
import { useApp } from '../context/AppContext';
import { getLastPersistSuccess } from '../services/persistenceService';
import { BACKUP_SECTION_ID } from '../services/backupSectionNavigation';
import { buildSkontoText } from '../services/invoiceTaxService';
import { validateCompanyProfileForSettings } from '../services/setupValidationService';
import { getInvoiceNumberSequenceSnapshot } from '../services/invoiceNumberService';
import {
  validateBrandingLogoFile,
  type BrandingLogoValidationError,
} from '../services/branding/brandingLogoValidation';
import { uploadBrandingAsset } from '../services/branding/brandingAssetCloudService';
import { getSyncClient } from '../services/sync/syncClientService';
import { useCompanyLogoObjectUrl } from '../hooks/useCompanyLogoObjectUrl';
import { useFormResume } from '../hooks/useFormResume';
import type { BrandingProfile, LogoAssetReference, LogoMimeType } from '../types/branding';
import { LOGO_MIME_TYPES } from '../types/branding';
import type { CompanyProfile } from '../types/models';
import type { TranslationKey } from '../i18n';

type ProfileField = keyof CompanyProfile;

function isLogoMimeType(value: string): value is LogoMimeType {
  return (LOGO_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * BRANDING-01E-2 — die Logo-Referenz setzen, ohne den Branding-Block zu
 * überschreiben. Eine gesetzte `primaryColor` darf ein Logowechsel nicht
 * mitnehmen.
 */
function withLogoReference(
  branding: BrandingProfile | undefined,
  logo: LogoAssetReference,
): BrandingProfile {
  return { ...branding, logo };
}

/**
 * Die Logo-Referenz entfernen.
 *
 * Bleibt danach kein gültiges Unterfeld übrig, wird `{}` gesetzt und **nicht**
 * der Schlüssel weggelassen: Nur `{}` ist nach D-022 das ausdrückliche Leeren;
 * ein fehlender Schlüssel bedeutet serverseitig „bewahren".
 *
 * Gab es vorher gar kein Branding, entsteht auch keines — es gibt dann nichts
 * zu leeren.
 */
function withoutLogoReference(branding: BrandingProfile | undefined): BrandingProfile | undefined {
  if (!branding) return undefined;
  const { logo: _logo, ...rest } = branding;
  return rest;
}

/** Fehlercodes des Validators werden hier — und nur hier — zu Nutzertexten. */
const LOGO_ERROR_KEYS: Record<BrandingLogoValidationError, TranslationKey> = {
  file_too_large: 'companyProfile.logoError.tooLarge',
  unsupported_mime: 'companyProfile.logoError.unsupportedType',
  signature_mismatch: 'companyProfile.logoError.contentMismatch',
  invalid_file: 'companyProfile.logoError.unreadable',
};

const TEXT_FIELDS: { key: ProfileField; labelKey: TranslationKey; type?: string }[] = [
  { key: 'companyName', labelKey: 'companyProfile.companyName' },
  { key: 'legalForm', labelKey: 'companyProfile.legalForm' },
  { key: 'managingDirector', labelKey: 'companyProfile.managingDirector' },
  { key: 'street', labelKey: 'companyProfile.street' },
  { key: 'zip', labelKey: 'companyProfile.zip' },
  { key: 'city', labelKey: 'companyProfile.city' },
  { key: 'country', labelKey: 'companyProfile.country' },
  { key: 'contactPerson', labelKey: 'companyProfile.contactPerson' },
  { key: 'phone', labelKey: 'companyProfile.phone', type: 'tel' },
  { key: 'email', labelKey: 'companyProfile.email', type: 'email' },
  { key: 'website', labelKey: 'companyProfile.website', type: 'url' },
  { key: 'taxNumber', labelKey: 'companyProfile.taxNumber' },
  { key: 'vatId', labelKey: 'companyProfile.vatId' },
  { key: 'bankName', labelKey: 'companyProfile.bankName' },
  { key: 'iban', labelKey: 'companyProfile.iban' },
  { key: 'bic', labelKey: 'companyProfile.bic' },
  { key: 'defaultPaymentTerms', labelKey: 'companyProfile.defaultPaymentTerms' },
  { key: 'taxFreeNotice', labelKey: 'companyProfile.taxFreeNotice' },
];

function focusBackupSection(): void {
  const el = document.getElementById(BACKUP_SECTION_ID);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (typeof el.focus === 'function') {
    el.focus({ preventScroll: true });
  }
}

/**
 * MOBILE-RESUME-STATE-02B — genau diese Felder dürfen wiederaufgenommen werden.
 *
 * Eine ausdrückliche Liste, keine Ableitung aus dem Profil: `branding` ist ein
 * geschlossener Unterblock mit eigenem Vertrag und hat in einem flachen
 * Oberflächenzustand nichts zu suchen, `logoDataUrl` ist ein Altlastenbild.
 * Was hier nicht steht, verlässt den Arbeitsspeicher nicht.
 */
const RESUMABLE_PROFILE_FIELDS = [
  'companyName',
  'legalForm',
  'managingDirector',
  'street',
  'zip',
  'city',
  'country',
  'contactPerson',
  'phone',
  'email',
  'website',
  'taxNumber',
  'vatId',
  'bankName',
  'iban',
  'bic',
  'defaultPaymentDays',
  'defaultPaymentTerms',
  'defaultSkonto',
  'skontoEnabled',
  'skontoPercent',
  'skontoDays',
  'taxFreeNotice',
  'invoiceFooterNotes',
] as const satisfies readonly (keyof CompanyProfile & string)[];

/**
 * Das bereits hochgeladene, aber noch nicht gespeicherte Logo.
 *
 * Zwei einzeln benannte Primitive, kein serialisiertes Objekt. Ohne sie führt
 * ein Neuaufbau nach einem gescheiterten Speicherversuch zu einem zweiten
 * Upload — und da Assets unveränderlich und nicht löschbar sind, bliebe das
 * erste für immer verwaist.
 */
const PENDING_LOGO_ASSET_KEY = 'pendingLogoAssetId';
const PENDING_LOGO_MIME_KEY = 'pendingLogoMimeType';

export function FirmendatenPage() {
  const { companyProfile, updateCompanyProfile, translate, showToast } = useApp();
  const location = useLocation();

  const resume = useFormResume<CompanyProfile>({
    namespace: 'companyProfile',
    fields: RESUMABLE_PROFILE_FIELDS,
    saved: companyProfile,
    workspaceType: 'other',
    extraKeys: [PENDING_LOGO_ASSET_KEY, PENDING_LOGO_MIME_KEY],
  });

  /*
   * Der gespeicherte Stand ist die Grundlage; darüber liegen — nur wenn der
   * Basisabgleich stimmt — die erlaubten ungespeicherten Werte. Die Struktur
   * des Profils bleibt dabei vollständig, es werden ausschliesslich bekannte
   * Felder überschrieben.
   */
  const [draft, setDraft] = useState<CompanyProfile>(() => ({
    ...companyProfile,
    ...resume.restored,
  }));
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  /*
   * Eigener Zustand: Ein Logo-Fehler darf einen offenen Firmendaten- oder
   * IBAN-Fehler nicht überschreiben — und umgekehrt.
   */
  const [logoErrorKey, setLogoErrorKey] = useState<TranslationKey | null>(null);

  /*
   * BRANDING-01E-2 — drei getrennte Zustände, weil sie drei verschiedene Dinge
   * bedeuten:
   *
   *   selectedLogoFile   die gewählte, noch nicht hochgeladene Datei
   *   selectedLogoUrl    ihre Vorschau (Object-URL, muss freigegeben werden)
   *   pendingLogoRef     ein bereits erfolgreich hochgeladenes Asset, dessen
   *                      Profil-Speicherung noch aussteht
   *
   * `pendingLogoRef` ist keine Bequemlichkeit, sondern notwendig: Assets sind
   * unveränderlich und nicht löschbar. Ohne diesen Zustand erzeugte jeder
   * erneute Speicherversuch nach einem Fehler ein weiteres totes Objekt im
   * Bucket.
   */
  const [selectedLogoFile, setSelectedLogoFile] = useState<File | null>(null);
  const [selectedLogoUrl, setSelectedLogoUrl] = useState<string | null>(null);
  const [pendingLogoRef, setPendingLogoRef] = useState<LogoAssetReference | null>(() => {
    const assetId = resume.restoredExtras[PENDING_LOGO_ASSET_KEY];
    const mimeType = resume.restoredExtras[PENDING_LOGO_MIME_KEY];
    // Nur ein vollständig gültiges Paar wird übernommen — nichts Halbes.
    if (typeof assetId !== 'string' || !assetId.trim()) return null;
    if (typeof mimeType !== 'string' || !isLogoMimeType(mimeType)) return null;
    return { assetId, mimeType };
  });

  /*
   * Der aktuelle Stand geht einmal je Render an die UI-Sitzung. `selectedLogoFile`
   * und `selectedLogoUrl` bleiben bewusst draussen: Eine `File` lässt sich nach
   * einem Neuaufbau nicht rekonstruieren, und eine vorgetäuschte Auswahl wäre
   * schlimmer als gar keine. Fehlermeldungen ebenso wenig — sie entstehen bei
   * der nächsten Prüfung neu.
   */
  resume.observe(draft, {
    [PENDING_LOGO_ASSET_KEY]: pendingLogoRef?.assetId ?? null,
    [PENDING_LOGO_MIME_KEY]: pendingLogoRef?.mimeType ?? null,
  });

  const workspaceId = getSyncClient().serverWorkspaceId;
  const savedLogo = useCompanyLogoObjectUrl({
    workspaceId,
    logo: draft.branding?.logo,
    logoDataUrl: draft.logoDataUrl,
  });

  /* Vorschau der gewählten Datei — eigener Lebenszyklus, eigene Freigabe. */
  useEffect(() => {
    if (!selectedLogoFile) {
      setSelectedLogoUrl(null);
      return;
    }
    const url = URL.createObjectURL(selectedLogoFile);
    setSelectedLogoUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [selectedLogoFile]);

  useEffect(() => {
    if (location.hash !== `#${BACKUP_SECTION_ID}`) return;
    const frame = window.requestAnimationFrame(() => {
      focusBackupSection();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [location.hash, location.key]);

  const handleChange = (key: ProfileField, value: string | number | boolean) => {
    setDraft((prev) => {
      const next = { ...prev, [key]: value };
      if (key === 'skontoEnabled' || key === 'skontoPercent' || key === 'skontoDays') {
        next.defaultSkonto = buildSkontoText(next);
      }
      return next;
    });
  };

  /**
   * BRANDING-01C — geprüft wird vor dem Lesen, nicht danach.
   *
   * Die Datei wird erst vollständig eingelesen, wenn Grösse, Typ und
   * tatsächliche Anfangsbytes stimmen. Scheitert etwas, bleibt der Entwurf
   * unangetastet: kein neues Logo, keine halbe Vorschau, nichts Gespeichertes.
   * Persistiert wird ohnehin erst beim Absenden des Formulars.
   */
  const handleLogoUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const file = input.files?.[0] ?? null;
    setLogoErrorKey(null);
    if (!file) return;

    const validation = await validateBrandingLogoFile(file);
    if (!validation.valid) {
      setLogoErrorKey(LOGO_ERROR_KEYS[validation.error]);
      // Dieselbe Datei soll erneut auswählbar sein.
      input.value = '';
      return;
    }

    if (!isLogoMimeType(file.type)) {
      // Sollte der Validator bereits ausschliessen; hier nur die Typgrenze.
      setLogoErrorKey('companyProfile.logoError.unsupportedType');
      input.value = '';
      return;
    }

    /*
     * BRANDING-01E-2 — hier wird **nichts** hochgeladen und nichts am Entwurf
     * geändert. Das Asset ist unveränderlich und nicht löschbar; ein Upload
     * beim blossen Durchprobieren würde bleibende Objekte erzeugen. Auch die
     * Formularzusage bleibt damit gültig: Wirksam wird alles erst beim
     * Speichern.
     *
     * Eine andere Datei verwirft eine bereits hochgeladene, aber noch nicht
     * gespeicherte Referenz. Das dazugehörige Asset bleibt als Waise im Bucket
     * — löschen ist in V1 nicht möglich, und ein Löschversuch wäre nur ein
     * weiterer Fehlerpfad.
     */
    setPendingLogoRef(null);
    setSelectedLogoFile(file);
  };

  const handleLogoRemove = () => {
    setLogoErrorKey(null);
    /*
     * „Logo entfernen" heisst aus Nutzersicht: kein Logo mehr. Deshalb geht
     * auch das Legacy-Logo — sonst erschiene nach dem Entfernen überraschend
     * das alte wieder, und niemand könnte erklären, warum (D-023).
     *
     * Das hochgeladene Asset selbst bleibt im Bucket. Entfernt wird die
     * Referenz, nicht die Datei.
     */
    setSelectedLogoFile(null);
    setPendingLogoRef(null);
    setDraft((prev) => ({
      ...prev,
      logoDataUrl: '',
      branding: withoutLogoReference(prev.branding),
    }));
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorKey(null);

    // Browsers may autofill IBAN into the DOM without firing onChange, so
    // React draft.iban can stay empty while the field still looks filled.
    const ibanField = event.currentTarget.elements.namedItem('iban');
    const ibanFromDom =
      ibanField instanceof HTMLInputElement ? ibanField.value : undefined;
    const iban = (ibanFromDom ?? draft.iban ?? '').toString();

    const payload = {
      ...draft,
      iban,
      defaultSkonto: draft.skontoEnabled ? buildSkontoText(draft) : '',
    };

    const validation = validateCompanyProfileForSettings(
      payload,
      getInvoiceNumberSequenceSnapshot().lastIssuedNumber,
    );
    if (!validation.valid) {
      const firstError = Object.values(validation.errors)[0];
      if (firstError) setErrorKey(firstError);
      return;
    }

    /*
     * BRANDING-01E-2 — der Upload steht bewusst **nach** der Profilvalidierung.
     *
     * Ein Asset ist unveränderlich und nicht löschbar. Wenn die IBAN nicht
     * stimmt, darf dafür kein bleibendes Objekt im Bucket entstehen. Erst wenn
     * das Profil grundsätzlich speicherbar ist, wird hochgeladen.
     */
    let logoReference = pendingLogoRef;
    if (selectedLogoFile && !logoReference) {
      if (!workspaceId) {
        // Keine erfundene Kennung, keine halbe Referenz — die Datei bleibt gewählt.
        setLogoErrorKey('companyProfile.logoError.noWorkspace');
        return;
      }
      if (!isLogoMimeType(selectedLogoFile.type)) {
        setLogoErrorKey('companyProfile.logoError.unsupportedType');
        return;
      }

      const uploaded = await uploadBrandingAsset({
        workspaceId,
        blob: selectedLogoFile,
        mimeType: selectedLogoFile.type,
      });
      if (!uploaded.ok) {
        /*
         * Nichts am Profil ändern: Das bestehende Logo bleibt, wie es war. Die
         * gewählte Datei bleibt im Zustand, damit ein erneuter Versuch möglich
         * ist, ohne sie neu auszuwählen.
         */
        setLogoErrorKey('companyProfile.logoError.uploadFailed');
        return;
      }
      logoReference = uploaded.reference;
      // Merken, damit ein Fehlschlag beim Speichern keinen zweiten Upload auslöst.
      setPendingLogoRef(uploaded.reference);
    }

    if (logoReference) {
      payload.branding = withLogoReference(payload.branding, logoReference);
    }

    const result = updateCompanyProfile(payload);
    if (!result.success) {
      // `pendingLogoRef` bleibt absichtlich stehen — der nächste Versuch nutzt dasselbe Asset.
      setErrorKey(result.errorKey as TranslationKey);
      return;
    }
    setSelectedLogoFile(null);
    setPendingLogoRef(null);
    setLogoErrorKey(null);
    setDraft({ ...result.profile });
    /*
     * Der gespeicherte Stand ist jetzt die Wahrheit. Der Wiederaufnahmeentwurf
     * wird verworfen, damit ein späterer Neuaufbau nicht die alten Werte
     * darüberlegt — samt der Logo-Referenz, die nun im Profil steht.
     */
    resume.clearResume();
    if (!getLastPersistSuccess()) {
      showToast(translate('persist.failed.userAction'));
      return;
    }
    showToast(translate('companyProfile.saved'));
  };

  return (
    <div className="page">
      <Link to="/" className="back-link">
        ← {translate('common.back')}
      </Link>

      <PageHeader
        title={translate('companyProfile.title')}
        subtitle={translate('companyProfile.subtitle')}
      />

      <LanguageSwitcher />

      <PilotHintsPanel />

      <BackupExportPanel />

      <form className="company-profile-form" onSubmit={handleSubmit}>
        {TEXT_FIELDS.map(({ key, labelKey, type = 'text' }) => (
          <fieldset key={key} className="form-group">
            <label htmlFor={`profile-${key}`}>{translate(labelKey)}</label>
            <input
              id={`profile-${key}`}
              name={key}
              type={type}
              className="input"
              value={String(draft[key] ?? '')}
              onChange={(e) => handleChange(key, e.target.value)}
              autoComplete={key === 'iban' ? 'off' : undefined}
              required={key === 'companyName'}
            />
          </fieldset>
        ))}

        <fieldset className="form-group">
          <label htmlFor="profile-payment-days">{translate('companyProfile.defaultPaymentDays')}</label>
          <input
            id="profile-payment-days"
            type="number"
            min="0"
            className="input"
            value={draft.defaultPaymentDays}
            onChange={(e) => handleChange('defaultPaymentDays', Number(e.target.value) || 0)}
          />
        </fieldset>

        <fieldset className="form-group company-profile-form__skonto">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={Boolean(draft.skontoEnabled)}
              onChange={(e) => handleChange('skontoEnabled', e.target.checked)}
            />
            {translate('companyProfile.skontoEnabled')}
          </label>
          {draft.skontoEnabled && (
            <div className="form-row">
              <div>
                <label htmlFor="profile-skonto-percent">{translate('companyProfile.skontoPercent')}</label>
                <input
                  id="profile-skonto-percent"
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  className="input"
                  value={draft.skontoPercent ?? 0}
                  onChange={(e) => handleChange('skontoPercent', Number(e.target.value) || 0)}
                />
              </div>
              <div>
                <label htmlFor="profile-skonto-days">{translate('companyProfile.skontoDays')}</label>
                <input
                  id="profile-skonto-days"
                  type="number"
                  min="1"
                  className="input"
                  value={draft.skontoDays ?? 0}
                  onChange={(e) => handleChange('skontoDays', Number(e.target.value) || 0)}
                />
              </div>
            </div>
          )}
          {draft.skontoEnabled && buildSkontoText(draft) && (
            <p className="hint-text">{buildSkontoText(draft)}</p>
          )}
        </fieldset>

        <fieldset className="form-group">
          <label htmlFor="profile-footer">{translate('companyProfile.invoiceFooterNotes')}</label>
          <textarea
            id="profile-footer"
            className="input company-profile-form__textarea"
            rows={3}
            value={draft.invoiceFooterNotes}
            onChange={(e) => handleChange('invoiceFooterNotes', e.target.value)}
          />
        </fieldset>

        <fieldset className="form-group">
          <label htmlFor="profile-logo-file">{translate('companyProfile.logoUpload')}</label>
          <input
            id="profile-logo-file"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="input"
            onChange={handleLogoUpload}
          />
          <p className="hint-text">{translate('companyProfile.logoHint')}</p>
          {logoErrorKey && (
            <p className="form-error" data-testid="company-logo-error">
              {translate(logoErrorKey)}
            </p>
          )}
          {/*
            * Anzeigereihenfolge: die eben gewählte Datei, dann das gespeicherte
            * Branding-Asset, dann das Legacy-Logo. Die oberste Ebene ist reiner
            * Formularzustand — sie zeigt, was beim Speichern übernommen würde.
            */}
          {selectedLogoUrl ? (
            <>
              <img
                src={selectedLogoUrl}
                alt=""
                className="company-profile-form__logo-preview"
                data-testid="company-logo-preview"
                data-logo-source="selected"
              />
              <p className="hint-text" data-testid="company-logo-pending">
                {translate('companyProfile.logoPendingHint')}
              </p>
            </>
          ) : (
            savedLogo.url && (
              <img
                src={savedLogo.url}
                alt=""
                className="company-profile-form__logo-preview"
                data-testid="company-logo-preview"
                data-logo-source={savedLogo.source}
              />
            )
          )}

          {savedLogo.fallbackUsed && !selectedLogoUrl && (
            <p className="hint-text" data-testid="company-logo-fallback">
              {translate(
                savedLogo.source === 'legacy'
                  ? 'companyProfile.logoFallbackNotice'
                  : 'companyProfile.logoMissingNotice',
              )}
            </p>
          )}

          {(selectedLogoUrl || savedLogo.url || draft.branding?.logo) && (
            /*
              * Das frühere Freitextfeld war der einzige Weg, ein Logo wieder
              * loszuwerden — und zugleich ein Weg, jede Prüfung zu umgehen.
              * Es entfällt; das Entfernen bleibt als eigene Schaltfläche.
              * Wirksam wird es wie jede andere Änderung erst beim Speichern.
              */
            <Button
              type="button"
              variant="outline"
              onClick={handleLogoRemove}
              data-testid="company-logo-remove"
            >
              {translate('companyProfile.logoRemove')}
            </Button>
          )}
        </fieldset>

        {errorKey && <p className="form-error">{translate(errorKey)}</p>}

        <Button type="submit" fullWidth>
          {translate('common.save')}
        </Button>
      </form>
    </div>
  );
}
