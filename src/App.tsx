import { Navigate, Route, Routes } from 'react-router-dom';
import { getCachedSetup } from './services/persistenceService';
import { t } from './i18n';
import { AppShell } from './components/layout/AppShell';
import { ReadOnlyRouteGuard } from './components/system/ReadOnlyRouteGuard';
import { useAuth } from './context/AuthContext';
import { useApp } from './context/AppContext';
import { AccessBlockedPage } from './pages/AccessBlockedPage';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { LicenseExpiredPage } from './pages/LicenseExpiredPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { WaitingApprovalPage } from './pages/WaitingApprovalPage';
import { OffeneAusgabenPage } from './pages/OffeneAusgabenPage';
import { AusgabeDetailPage } from './pages/AusgabeDetailPage';
import { AusgabeNeuPage } from './pages/AusgabeNeuPage';
import { AusgabenPage } from './pages/AusgabenPage';
import { AssistentPage } from './pages/AssistentPage';
import { AufgabenPage } from './pages/AufgabenPage';
import { SchreibenPage } from './pages/SchreibenPage';
import { BriefEditorPage } from './pages/BriefEditorPage';
import { BriefDetailPage } from './pages/BriefDetailPage';
import { AngebotePage } from './pages/AngebotePage';
import { AngebotEditorPage } from './pages/AngebotEditorPage';
import { AngebotDetailPage } from './pages/AngebotDetailPage';
import { DokumentDetailPage } from './pages/DokumentDetailPage';
import { DokumentePage } from './pages/DokumentePage';
import { DokumentNeuPage } from './pages/DokumentNeuPage';
import { DocumentAddPage } from './pages/DocumentAddPage';
import { DocumentUploadPage } from './pages/DocumentUploadPage';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { EingangPage } from './pages/EingangPage';
import { EinstellungenPage } from './pages/EinstellungenPage';
import { CompanySettingsPage } from './pages/settings/CompanySettingsPage';
import { DesignSettingsPage } from './pages/settings/DesignSettingsPage';
import { InvoiceSettingsPage } from './pages/settings/InvoiceSettingsPage';
import { AccountSettingsPage } from './pages/settings/AccountSettingsPage';
import { AccountSecurityPage } from './pages/settings/AccountSecurityPage';
import { AccountLanguagePage } from './pages/settings/AccountLanguagePage';
import { AccountSessionsPage } from './pages/settings/AccountSessionsPage';
import { AccountDeletePage, WAITING_ACCOUNT_DELETE_ROUTE, WaitingAccountDeletePage } from './pages/settings/AccountDeletePage';
import { DataExportPage } from './pages/settings/DataExportPage';
import { LeaveGuardHost } from './components/system/LeaveGuardHost';
import { AccountSessionLockHost } from './components/system/AccountSessionLockHost';
import { RouteFocus } from './components/system/RouteFocus';
import { DeviceDataPage } from './pages/settings/DeviceDataPage';
import { WorkspaceDeletePage } from './pages/settings/WorkspaceDeletePage';
import { BackupSettingsPage } from './pages/settings/BackupSettingsPage';
import { ChartOfAccountsSettingsPage } from './pages/settings/ChartOfAccountsSettingsPage';
import { MailboxSettingsPage } from './pages/settings/MailboxSettingsPage';
import { NumberRangeSettingsPage } from './pages/settings/NumberRangeSettingsPage';
import { OfferSettingsPage } from './pages/settings/OfferSettingsPage';
import { LetterSettingsPage } from './pages/settings/LetterSettingsPage';
import { VersionPage } from './pages/settings/VersionPage';
import { LEGACY_OPERATING_SETTINGS_ROUTE, SETTINGS_HUB_ROUTE, SETTINGS_TARGET_PATHS } from './pages/settings/settingsHubConfig';
import { CommunicationSettingsPage } from './pages/settings/CommunicationSettingsPage';
import { FirmendatenLegacyRoute } from './pages/settings/FirmendatenLegacyRoute';
import { HeutePage } from './pages/HeutePage';
import { KundenDetailPage, KundenLegacyLinkResolver } from './pages/KundenDetailPage';
import { KundenPage } from './pages/KundenPage';
import { SteuerberaterPage } from './pages/SteuerberaterPage';
import { MehrPage } from './pages/MehrPage';
import { BankStatementPage } from './pages/BankStatementPage';
import { MitarbeiterzahlungenPage } from './pages/MitarbeiterzahlungenPage';
import { FinanzenPage } from './pages/FinanzenPage';
import { PapierarchivPage } from './pages/PapierarchivPage';
import { KommunikationPage } from './pages/KommunikationPage';
import { KommunikationEmailComposePage } from './pages/KommunikationEmailComposePage';
import { KommunikationEmailDetailPage } from './pages/KommunikationEmailDetailPage';
import { KommunikationInboundEmailPage } from './pages/KommunikationInboundEmailPage';
import { InvoiceDetailPage } from './pages/InvoiceDetailPage';
import { OffeneRechnungenPage } from './pages/OffeneRechnungenPage';
import { ManualInvoicePage } from './pages/ManualInvoicePage';
import { RechnungPage } from './pages/RechnungPage';
import { SearchPage } from './pages/SearchPage';
import { ScanPage } from './pages/ScanPage';
import { SetupPage } from './pages/SetupPage';
import { SyncPage } from './pages/SyncPage';
import { AuftragEditorPage } from './pages/AuftragEditorPage';
import { WissenPage } from './pages/WissenPage';
import { VorgaengePage } from './pages/VorgaengePage';
import { VorgangDetailPage } from './pages/VorgangDetailPage';
import { LegacyInboxDetailRedirect } from './routing/LegacyInboxDetailRedirect';
import { ImpressumPage } from './pages/legal/ImpressumPage';
import { DatenschutzPage } from './pages/legal/DatenschutzPage';
import { AgbPage } from './pages/legal/AgbPage';
import { LizenzbedingungenPage } from './pages/legal/LizenzbedingungenPage';
import { NotFoundPage } from './pages/system/NotFoundPage';
import { ProfileUnavailablePage } from './pages/ProfileUnavailablePage';
import { LegalConsentPage } from './pages/LegalConsentPage';
import { hasCurrentLegalConsent } from './services/auth/legalConsentService';
import { AuthenticatedLoginRedirect, LoginRedirect, PendingLoginRedirect } from './routing/authRedirects';
import { InvitationPage } from './pages/InvitationPage';
import { TEAM_SETTINGS_ROUTE, TeamSettingsPage } from './pages/settings/TeamSettingsPage';
import { PLATFORM_ADMIN_ROUTE } from './pages/AdminUsersPage';

function PublicAuthRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      {/* EINRICHTUNG-01 (AP4, Weg C) — Einladungslink ohne Anmeldung: Anmelden oder Registrieren, dann zurück. */}
      <Route path="/einladung/:token" element={<InvitationPage />} />
      {/* EINRICHTUNG-01 (AP2, A-12.1) — die aufgerufene Seite bleibt das Rücksprungziel. */}
      <Route path="*" element={<LoginRedirect />} />
    </Routes>
  );
}

function PasswordRecoveryRoutes() {
  return (
    <Routes>
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="*" element={<Navigate to="/reset-password" replace />} />
    </Routes>
  );
}

function PendingRoutes() {
  return (
    <Routes>
      <Route path="/waiting-approval" element={<WaitingApprovalPage />} />
      {/* EINRICHTUNG-01 (AP7; 1.25, L-01.6) — ein wartendes Konto löscht sich selbst, ohne Zugang zu einem Betrieb. */}
      <Route path={WAITING_ACCOUNT_DELETE_ROUTE} element={<WaitingAccountDeletePage />} />
      {/* EINRICHTUNG-01 (AP4, M-03.4) — auch ein wartendes Konto nimmt eine Einladung an (Weg C). */}
      <Route path="/einladung/:token" element={<InvitationPage />} />
      {/* … und kehrt nach der Anmeldung über den Einladungslink dorthin zurück. */}
      <Route path="/login" element={<PendingLoginRedirect />} />
      <Route path="*" element={<Navigate to="/waiting-approval" replace />} />
    </Routes>
  );
}

function BlockedRoutes() {
  return (
    <Routes>
      <Route path="/access-blocked" element={<AccessBlockedPage />} />
      <Route path="*" element={<Navigate to="/access-blocked" replace />} />
    </Routes>
  );
}

function LicenseExpiredRoutes() {
  return (
    <Routes>
      <Route path="/license-expired" element={<LicenseExpiredPage />} />
      <Route path="*" element={<Navigate to="/license-expired" replace />} />
    </Routes>
  );
}

function SetupRoutes() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="*" element={<Navigate to="/setup" replace />} />
    </Routes>
  );
}

function AppRoutes() {
  const { setup } = useApp();
  const {
    user,
    isAuthenticated,
    isAllowed,
    isAuthReady,
    profileError,
    passwordRecoveryPending,
    session,
    connectionIssue,
  } = useAuth();

  if (!isAuthReady) {
    const lang = getCachedSetup()?.language ?? 'de';
    return (
      <div className="bootstrap-loading" data-testid="auth-loading">
        <p className="bootstrap-loading__text">{t('common.loading.auth', lang)}</p>
      </div>
    );
  }

  if (passwordRecoveryPending) {
    return <PasswordRecoveryRoutes />;
  }

  /*
   * EINRICHTUNG-01 (AP2; A-01.1, A-10.2) — angemeldet, aber das Profil ist gerade nicht abrufbar und es gibt keinen
   * bestätigten Zwischenstand: keine Abmeldung, keine Anmeldeseite, keine Daten.
   */
  if (session && !user && connectionIssue && !profileError) {
    return (
      <Routes>
        <Route path="*" element={<ProfileUnavailablePage />} />
      </Routes>
    );
  }

  if (!isAuthenticated || profileError) {
    return <PublicAuthRoutes />;
  }

  if (user?.status === 'pending') {
    return <PendingRoutes />;
  }

  if (user?.status === 'blocked') {
    return <BlockedRoutes />;
  }

  /*
   * EINRICHTUNG-01 (AP2, EIN-19; A-13.3, A-14.1) — ohne gültige Zustimmung zur geltenden Fassung der Rechtstexte
   * erst die Zustimmungsseite, vor Warteseite, Betrieb und Abgleich.
   */
  if (user && !hasCurrentLegalConsent(user)) {
    return (
      <Routes>
        <Route path="*" element={<LegalConsentPage />} />
      </Routes>
    );
  }

  if (!isAllowed) {
    return <LicenseExpiredRoutes />;
  }

  if (!setup.setupComplete) {
    return <SetupRoutes />;
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<HeutePage />} />
        <Route path="/start" element={<Navigate to="/" replace />} />
        <Route path="/kunden" element={<KundenPage />} />
        {/* CUSTOMER-FACHOBJEKT-04E3 — specific identity routes before the legacy name path. */}
        <Route path="/kunden/customer/:customerId" element={<KundenDetailPage kind="customer" />} />
        <Route path="/kunden/legacy/:legacyKey" element={<KundenDetailPage kind="legacy" />} />
        <Route path="/kunden/orphan/:customerId" element={<KundenDetailPage kind="orphan" />} />
        <Route path="/kunden/:name" element={<KundenLegacyLinkResolver />} />
        <Route path="/steuerberater" element={<SteuerberaterPage />} />
        <Route path="/scan" element={<ReadOnlyRouteGuard><ScanPage /></ReadOnlyRouteGuard>} />
        <Route path="/suche" element={<SearchPage />} />
        <Route path="/mehr" element={<MehrPage />} />
        {/* UIUX-FOUNDATION-01C — Finanzen-Hub: reine Navigation zu bestehenden Bereichen. */}
        <Route path="/finanzen" element={<FinanzenPage />} />
        <Route path="/finanzen/kontoauszug" element={<BankStatementPage />} />
        <Route path="/finanzen/mitarbeiterzahlungen" element={<MitarbeiterzahlungenPage />} />
        {/*
         * CLOUD-SYNC S7 — der frühere manuelle Mailimport ist aus dem Produkt
         * genommen. Alte Lesezeichen und Links landen bei den Nachrichten mit dem
         * verbundenen Postfach; Dateien und Mail-Anhänge kommen über den Eingang.
         */}
        <Route path="/mail-import" element={<Navigate to="/kommunikation" replace />} />
        <Route path="/ablage" element={<EingangPage />} />
        <Route path="/ablage/:id" element={<EingangDetailPage />} />
        <Route path="/eingang" element={<Navigate to="/ablage" replace />} />
        <Route path="/eingang/:id" element={<LegacyInboxDetailRedirect />} />
        <Route path="/analyse" element={<Navigate to="/assistent" replace />} />
        <Route path="/aufgaben" element={<AufgabenPage />} />
        <Route path="/schreiben" element={<SchreibenPage />} />
        <Route path="/schreiben/neu" element={<ReadOnlyRouteGuard><BriefEditorPage /></ReadOnlyRouteGuard>} />
        <Route path="/schreiben/:letterId" element={<BriefDetailPage />} />
        <Route path="/schreiben/:letterId/bearbeiten" element={<ReadOnlyRouteGuard><BriefEditorPage /></ReadOnlyRouteGuard>} />
        {/* ANGEBOT-01B — eigene Angebote; erreichbar aus Aufträgen und Kundenakte, kein Hauptmenüpunkt. */}
        <Route path="/angebote" element={<AngebotePage />} />
        <Route path="/angebote/neu" element={<ReadOnlyRouteGuard><AngebotEditorPage /></ReadOnlyRouteGuard>} />
        <Route path="/angebote/:offerId" element={<AngebotDetailPage />} />
        <Route path="/angebote/:offerId/bearbeiten" element={<ReadOnlyRouteGuard><AngebotEditorPage /></ReadOnlyRouteGuard>} />
        <Route path="/vorgaenge" element={<VorgaengePage />} />
        <Route path="/vorgaenge/:id" element={<VorgangDetailPage />} />
        {/* AUFTRAG-02C — manuelle Auftragsanlage; der Auftrag selbst bleibt ein Vorgang. */}
        <Route path="/auftraege/neu" element={<ReadOnlyRouteGuard><AuftragEditorPage /></ReadOnlyRouteGuard>} />
        <Route path="/auftraege/entwurf/:draftId" element={<ReadOnlyRouteGuard><AuftragEditorPage /></ReadOnlyRouteGuard>} />
        <Route path="/vorgaenge/:id/rechnung" element={<ReadOnlyRouteGuard><RechnungPage /></ReadOnlyRouteGuard>} />
        <Route path="/vorgaenge/:id/rechnungen/:invoiceId" element={<InvoiceDetailPage />} />
        <Route path="/rechnungen/offen" element={<OffeneRechnungenPage />} />
        {/* MANUAL-INVOICE-UI-01B1B — die Rechnung ohne Auftrag. */}
        <Route path="/rechnungen/neu" element={<ReadOnlyRouteGuard><ManualInvoicePage /></ReadOnlyRouteGuard>} />
        {/*
          * MANUAL-INVOICE-UI-01B2 — globale Detailroute, dieselbe Seite wie der
          * Vorgangsweg. Statische Pfade stehen davor und gewinnen im Router
          * ohnehin durch ihren Rang; `neu`/`offen` sind nie eine Kennung.
          */}
        <Route path="/rechnungen/:invoiceId" element={<InvoiceDetailPage />} />
        <Route path="/dokumente" element={<DokumentePage />} />
        <Route path="/dokumente/upload" element={<ReadOnlyRouteGuard><DocumentUploadPage /></ReadOnlyRouteGuard>} />
        <Route path="/dokumente/hinzufuegen" element={<ReadOnlyRouteGuard><DocumentAddPage /></ReadOnlyRouteGuard>} />
        <Route path="/dokumente/neu" element={<ReadOnlyRouteGuard><DokumentNeuPage /></ReadOnlyRouteGuard>} />
        <Route path="/dokumente/:id" element={<DokumentDetailPage />} />
        <Route path="/ausgaben" element={<AusgabenPage />} />
        <Route path="/ausgaben/offen" element={<OffeneAusgabenPage />} />
        <Route path="/ausgaben/neu" element={<ReadOnlyRouteGuard><AusgabeNeuPage /></ReadOnlyRouteGuard>} />
        <Route path="/ausgaben/:id" element={<AusgabeDetailPage />} />
        <Route path="/papierarchiv" element={<PapierarchivPage />} />
        <Route path="/assistent" element={<AssistentPage />} />
        <Route path="/kommunikation" element={<KommunikationPage />} />
        {/* E-MAIL-07D — freie Geschäfts-E-Mail. */}
        <Route path="/kommunikation/email/neu" element={<ReadOnlyRouteGuard><KommunikationEmailComposePage /></ReadOnlyRouteGuard>} />
        <Route path="/kommunikation/email/:id" element={<KommunikationEmailDetailPage />} />
        {/* E-MAIL-07E — eingegangene E-Mail. */}
        <Route path="/kommunikation/eingang/:id" element={<KommunikationInboundEmailPage />} />
        <Route path="/wissen" element={<WissenPage />} />
        <Route path="/einstellungen" element={<EinstellungenPage />} />
        {/* SETTINGS-01B2 — kanonische Firmenprofil-Seite; /firmendaten ist Alias (ohne Hash) bzw. Legacy (mit Hash). */}
        <Route path="/einstellungen/firma" element={<CompanySettingsPage />} />
        {/* SETTINGS-01B3 — Logo, Vorlage, Vorschau. */}
        <Route path="/einstellungen/design" element={<DesignSettingsPage />} />
        <Route path="/einstellungen/rechnungen" element={<InvoiceSettingsPage />} />
        {/* FIRMENPROFIL-01D — Absender, Reply-To, Standard-E-Mail-Texte. */}
        <Route path="/einstellungen/kommunikation" element={<CommunicationSettingsPage />} />
        {/*
          * EINRICHTUNG-01 (AP5; Vertrag 1.15) — die Seite „Betrieb“ ist aufgelöst: Sprache → Mein Konto, Sicherung → Daten,
          * Synchronisation → Hilfe und Rechtliches, Kontenrahmen → Buchhaltung. Die alte Adresse führt in den Hub.
          */}
        <Route path={LEGACY_OPERATING_SETTINGS_ROUTE} element={<Navigate to={SETTINGS_HUB_ROUTE} replace />} />
        {/* EINRICHTUNG-01 (AP6; 1.21) — Vorgaben für neue Angebote, Aufträge und Briefe. */}
        <Route path={SETTINGS_TARGET_PATHS.offers} element={<OfferSettingsPage />} />
        <Route path={SETTINGS_TARGET_PATHS.letters} element={<LetterSettingsPage />} />
        <Route path={SETTINGS_TARGET_PATHS['number-ranges']} element={<NumberRangeSettingsPage />} />
        <Route path={SETTINGS_TARGET_PATHS.mailbox} element={<MailboxSettingsPage />} />
        <Route path={SETTINGS_TARGET_PATHS['chart-of-accounts']} element={<ChartOfAccountsSettingsPage />} />
        <Route path={SETTINGS_TARGET_PATHS.backup} element={<BackupSettingsPage />} />
        {/* EINRICHTUNG-01 (AP7; 1.24) — lesbarer Export mit Vollständigkeitsprüfung und Lückenliste. */}
        <Route path={SETTINGS_TARGET_PATHS.export} element={<DataExportPage />} />
        {/* EINRICHTUNG-01 (AP8; 1.29) — Daten auf diesem Gerät ansehen und entfernen. */}
        <Route path={SETTINGS_TARGET_PATHS.device} element={<DeviceDataPage />} />
        <Route path={SETTINGS_TARGET_PATHS.version} element={<VersionPage />} />
        {/* EINRICHTUNG-01 (AP3, L1; AP5) — eigenes Konto in fünf Zielen; auch im Nur-Lesen-Betrieb bedienbar (Z-08.4). */}
        <Route path={SETTINGS_TARGET_PATHS.account} element={<AccountSettingsPage />} />
        <Route path={SETTINGS_TARGET_PATHS['account-security']} element={<AccountSecurityPage />} />
        <Route path={SETTINGS_TARGET_PATHS['account-language']} element={<AccountLanguagePage />} />
        <Route path={SETTINGS_TARGET_PATHS['account-sessions']} element={<AccountSessionsPage />} />
        {/* EINRICHTUNG-01 (AP7; 1.25, 1.26) — Konto löschen und Betrieb löschen. */}
        <Route path={SETTINGS_TARGET_PATHS['account-delete']} element={<AccountDeletePage />} />
        <Route path={SETTINGS_TARGET_PATHS['workspace-delete']} element={<WorkspaceDeletePage />} />
        {/* EINRICHTUNG-01 (AP4) — Team: Mitglieder, Einladungen, Rollen, Übergabe. */}
        <Route path={TEAM_SETTINGS_ROUTE} element={<TeamSettingsPage />} />
        <Route path="/einladung/:token" element={<InvitationPage />} />
        <Route path="/firmendaten" element={<FirmendatenLegacyRoute />} />
        <Route path="/synchronisation" element={<SyncPage />} />
        <Route path={PLATFORM_ADMIN_ROUTE} element={<AdminUsersPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<AuthenticatedLoginRedirect />} />
        <Route path="/register" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <>
      {/* EINRICHTUNG-01 (AP8; 1.27) — Rückfrage bei ungespeicherten Änderungen für alle Seiten der App. */}
      <LeaveGuardHost />
      {/* EINRICHTUNG-01 (AP8; 1.29, K6) — Sitzungssperre je Konto und Nachricht beim Entfernen in einem anderen Tab. */}
      <AccountSessionLockHost />
      {/* EINRICHTUNG-01 (AP9; 1.32) — Fokus auf die Seitenüberschrift nach jedem Seitenwechsel. */}
      <RouteFocus />
      <Routes>
        <Route path="/impressum" element={<ImpressumPage />} />
        <Route path="/datenschutz" element={<DatenschutzPage />} />
        <Route path="/agb" element={<AgbPage />} />
        <Route path="/lizenzbedingungen" element={<LizenzbedingungenPage />} />
        <Route path="/documents/upload" element={<Navigate to="/dokumente/upload" replace />} />
        <Route path="*" element={<AppRoutes />} />
      </Routes>
    </>
  );
}
