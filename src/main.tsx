import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { AppErrorBoundary } from './components/system/AppErrorBoundary';
import { NetworkStatusBanner } from './components/system/NetworkStatusBanner';
import { ProductionConfigBanner } from './components/system/ProductionConfigBanner';
import { BusinessStateGate } from './components/system/BusinessStateGate';
import { RootMountDebugOverlay } from './components/system/RootMountDebugOverlay';
import './styles/tokens.css';
import './index.css';
import './styles/shell.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/heute.css';
import './styles/auth.css';
import './styles/document-upload.css';
import './styles/system.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AppErrorBoundary>
        <ProductionConfigBanner />
        <NetworkStatusBanner />
        <AuthProvider>
          {import.meta.env.DEV ? <RootMountDebugOverlay /> : null}
          <BusinessStateGate>
            <App />
          </BusinessStateGate>
        </AuthProvider>
      </AppErrorBoundary>
    </BrowserRouter>
  </StrictMode>,
);
