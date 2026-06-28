import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { useApp } from './context/AppContext';
import { AnalysekartePage } from './pages/AnalysekartePage';
import { AssistentPage } from './pages/AssistentPage';
import { AufgabenPage } from './pages/AufgabenPage';
import { DokumentDetailPage } from './pages/DokumentDetailPage';
import { DokumentePage } from './pages/DokumentePage';
import { DokumentNeuPage } from './pages/DokumentNeuPage';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { EingangPage } from './pages/EingangPage';
import { FirmendatenPage } from './pages/FirmendatenPage';
import { PapierarchivPage } from './pages/PapierarchivPage';
import { InvoiceDetailPage } from './pages/InvoiceDetailPage';
import { OffeneRechnungenPage } from './pages/OffeneRechnungenPage';
import { RechnungPage } from './pages/RechnungPage';
import { SetupPage } from './pages/SetupPage';
import { VorgaengePage } from './pages/VorgaengePage';
import { VorgangDetailPage } from './pages/VorgangDetailPage';

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
        <Route path="/eingang" element={<EingangPage />} />
        <Route path="/eingang/:id" element={<EingangDetailPage />} />
        <Route path="/analyse" element={<AnalysekartePage />} />
        <Route path="/aufgaben" element={<AufgabenPage />} />
        <Route path="/vorgaenge" element={<VorgaengePage />} />
        <Route path="/vorgaenge/:id" element={<VorgangDetailPage />} />
        <Route path="/vorgaenge/:id/rechnung" element={<RechnungPage />} />
        <Route path="/vorgaenge/:id/rechnungen/:invoiceId" element={<InvoiceDetailPage />} />
        <Route path="/rechnungen/offen" element={<OffeneRechnungenPage />} />
        <Route path="/dokumente" element={<DokumentePage />} />
        <Route path="/dokumente/neu" element={<DokumentNeuPage />} />
        <Route path="/dokumente/:id" element={<DokumentDetailPage />} />
        <Route path="/papierarchiv" element={<PapierarchivPage />} />
        <Route path="/assistent" element={<AssistentPage />} />
        <Route path="/firmendaten" element={<FirmendatenPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="*" element={<Navigate to="/eingang" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return <AppRoutes />;
}
