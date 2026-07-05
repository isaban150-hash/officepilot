import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { useApp } from './context/AppContext';
import { OffeneAusgabenPage } from './pages/OffeneAusgabenPage';
import { AusgabeDetailPage } from './pages/AusgabeDetailPage';
import { AusgabeNeuPage } from './pages/AusgabeNeuPage';
import { AusgabenPage } from './pages/AusgabenPage';
import { AssistentPage } from './pages/AssistentPage';
import { AufgabenPage } from './pages/AufgabenPage';
import { DokumentDetailPage } from './pages/DokumentDetailPage';
import { DokumentePage } from './pages/DokumentePage';
import { DokumentNeuPage } from './pages/DokumentNeuPage';
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
import { WissenPage } from './pages/WissenPage';
import { VorgaengePage } from './pages/VorgaengePage';
import { VorgangDetailPage } from './pages/VorgangDetailPage';

function LegacyInboxDetailRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={id ? `/ablage/${id}` : '/ablage'} replace />;
}

function AppRoutes() {
  const { setup } = useApp();

  if (!setup.setupComplete) {
    return (
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
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
        <Route path="/setup" element={<SetupPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return <AppRoutes />;
}
