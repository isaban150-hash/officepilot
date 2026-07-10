import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { useAuth } from './context/AuthContext';
import { useApp } from './context/AppContext';
import { AccessBlockedPage } from './pages/AccessBlockedPage';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { LicenseExpiredPage } from './pages/LicenseExpiredPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { WaitingApprovalPage } from './pages/WaitingApprovalPage';
import { OffeneAusgabenPage } from './pages/OffeneAusgabenPage';
import { AusgabeDetailPage } from './pages/AusgabeDetailPage';
import { AusgabeNeuPage } from './pages/AusgabeNeuPage';
import { AusgabenPage } from './pages/AusgabenPage';
import { AssistentPage } from './pages/AssistentPage';
import { AufgabenPage } from './pages/AufgabenPage';
import { DokumentDetailPage } from './pages/DokumentDetailPage';
import { DokumentePage } from './pages/DokumentePage';
import { DokumentNeuPage } from './pages/DokumentNeuPage';
import { DocumentUploadPage } from './pages/DocumentUploadPage';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { EingangPage } from './pages/EingangPage';
import { FirmendatenPage } from './pages/FirmendatenPage';
import { HeutePage } from './pages/HeutePage';
import { MailImportPage } from './pages/MailImportPage';
import { MehrPage } from './pages/MehrPage';
import { PapierarchivPage } from './pages/PapierarchivPage';
import { KommunikationPage } from './pages/KommunikationPage';
import { InvoiceDetailPage } from './pages/InvoiceDetailPage';
import { OffeneRechnungenPage } from './pages/OffeneRechnungenPage';
import { RechnungPage } from './pages/RechnungPage';
import { SearchPage } from './pages/SearchPage';
import { ScanPage } from './pages/ScanPage';
import { SetupPage } from './pages/SetupPage';
import { SyncPage } from './pages/SyncPage';
import { WissenPage } from './pages/WissenPage';
import { VorgaengePage } from './pages/VorgaengePage';
import { VorgangDetailPage } from './pages/VorgangDetailPage';
import { LegacyInboxDetailRedirect } from './routing/LegacyInboxDetailRedirect';
import { ImpressumPage } from './pages/legal/ImpressumPage';
import { DatenschutzPage } from './pages/legal/DatenschutzPage';
import { AgbPage } from './pages/legal/AgbPage';
import { LizenzbedingungenPage } from './pages/legal/LizenzbedingungenPage';
import { NotFoundPage } from './pages/system/NotFoundPage';

function PublicAuthRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}

function PendingRoutes() {
  return (
    <Routes>
      <Route path="/waiting-approval" element={<WaitingApprovalPage />} />
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
  const { user, isAuthenticated, isAllowed } = useAuth();

  if (!isAuthenticated) {
    return <PublicAuthRoutes />;
  }

  if (user?.status === 'pending') {
    return <PendingRoutes />;
  }

  if (user?.status === 'blocked') {
    return <BlockedRoutes />;
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
        <Route path="/scan" element={<ScanPage />} />
        <Route path="/suche" element={<SearchPage />} />
        <Route path="/mehr" element={<MehrPage />} />
        <Route path="/mail-import" element={<MailImportPage />} />
        <Route path="/ablage" element={<EingangPage />} />
        <Route path="/ablage/:id" element={<EingangDetailPage />} />
        <Route path="/eingang" element={<Navigate to="/ablage" replace />} />
        <Route path="/eingang/:id" element={<LegacyInboxDetailRedirect />} />
        <Route path="/analyse" element={<Navigate to="/assistent" replace />} />
        <Route path="/aufgaben" element={<AufgabenPage />} />
        <Route path="/vorgaenge" element={<VorgaengePage />} />
        <Route path="/vorgaenge/:id" element={<VorgangDetailPage />} />
        <Route path="/vorgaenge/:id/rechnung" element={<RechnungPage />} />
        <Route path="/vorgaenge/:id/rechnungen/:invoiceId" element={<InvoiceDetailPage />} />
        <Route path="/rechnungen/offen" element={<OffeneRechnungenPage />} />
        <Route path="/dokumente" element={<DokumentePage />} />
        <Route path="/dokumente/upload" element={<DocumentUploadPage />} />
        <Route path="/dokumente/neu" element={<DokumentNeuPage />} />
        <Route path="/dokumente/:id" element={<DokumentDetailPage />} />
        <Route path="/ausgaben" element={<AusgabenPage />} />
        <Route path="/ausgaben/offen" element={<OffeneAusgabenPage />} />
        <Route path="/ausgaben/neu" element={<AusgabeNeuPage />} />
        <Route path="/ausgaben/:id" element={<AusgabeDetailPage />} />
        <Route path="/papierarchiv" element={<PapierarchivPage />} />
        <Route path="/assistent" element={<AssistentPage />} />
        <Route path="/kommunikation" element={<KommunikationPage />} />
        <Route path="/wissen" element={<WissenPage />} />
        <Route path="/firmendaten" element={<FirmendatenPage />} />
        <Route path="/synchronisation" element={<SyncPage />} />
        <Route path="/admin/users" element={<AdminUsersPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/register" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/impressum" element={<ImpressumPage />} />
      <Route path="/datenschutz" element={<DatenschutzPage />} />
      <Route path="/agb" element={<AgbPage />} />
      <Route path="/lizenzbedingungen" element={<LizenzbedingungenPage />} />
      <Route path="/documents/upload" element={<Navigate to="/dokumente/upload" replace />} />
      <Route path="*" element={<AppRoutes />} />
    </Routes>
  );
}
