import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { AppErrorBoundary } from './components/system/AppErrorBoundary';
import { NetworkStatusBanner } from './components/system/NetworkStatusBanner';
import { StagingBanner } from './components/system/StagingBanner';
import { ProductionConfigBanner } from './components/system/ProductionConfigBanner';
import { RootShell } from './RootShell';
import './styles/tokens.css';
import './index.css';
import './styles/shell.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/heute.css';
import './styles/workpages.css';
import './styles/auth.css';
import './styles/document-upload.css';
import './styles/bank-statement.css';
import './styles/employee-payments.css';
import './styles/system.css';
/* VISUAL-DESIGN-02B — Pilot fuer Shell und Startseite, bewusst zuletzt geladen. */
import './styles/visual-pilot-02b.css';

function AppRoot() {
  return (
    <AppErrorBoundary>
      <StagingBanner />
      <ProductionConfigBanner />
      <NetworkStatusBanner />
      {/* RootShell entscheidet zuerst ueber /local-recovery - vor jedem Bootstrap. */}
      <RootShell />
    </AppErrorBoundary>
  );
}

/*
 * EINRICHTUNG-01 (AP8; Vertrag 1.27) — Daten-Router mit einer einzigen Sammelroute: Der Baum darunter (RootShell, App
 * mit seinen <Routes>) bleibt unverändert; nur so steht `useBlocker` für den Verlassen-Schutz (App-Links, Menüs,
 * Browser-Zurück und -Vor) zur Verfügung.
 */
const router = createBrowserRouter([{ path: '*', element: <AppRoot /> }]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
