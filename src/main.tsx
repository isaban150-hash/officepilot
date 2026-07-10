import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { AppErrorBoundary } from './components/system/AppErrorBoundary';
import { NetworkStatusBanner } from './components/system/NetworkStatusBanner';
import { ProductionConfigBanner } from './components/system/ProductionConfigBanner';
import { hydrateStoresFromStorage } from './services/persistenceService';
import { ensureDefaultAdminUser } from './services/auth/authService';
import { isBetaTestMode } from './config/betaTestMode';
import './styles/tokens.css';
import './index.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/heute.css';
import './styles/auth.css';
import './styles/document-upload.css';
import './styles/system.css';

function BootstrapLoading() {
  return (
    <div className="bootstrap-loading" data-testid="bootstrap-loading">
      <p className="bootstrap-loading__text">OfficePilot wird geladen…</p>
    </div>
  );
}

interface BootstrapErrorProps {
  message: string;
  onRetry: () => void;
}

function BootstrapError({ message, onRetry }: BootstrapErrorProps) {
  return (
    <div className="system-page" data-testid="bootstrap-error">
      <div className="system-page__card">
        <h1 className="system-page__title">Start fehlgeschlagen</h1>
        <p className="system-page__text">{message}</p>
        <button type="button" className="btn btn--primary btn--full" onClick={onRetry}>
          Erneut versuchen
        </button>
      </div>
    </div>
  );
}

function BootstrapApp() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialSetup] = useState(() => hydrateStoresFromStorage());

  useEffect(() => {
    void (async () => {
      try {
        await ensureDefaultAdminUser();
        if (isBetaTestMode()) {
          const { login, getCurrentSession } = await import('./services/auth/authService');
          if (!getCurrentSession()) {
            const { DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD } = await import(
              './services/auth/authService'
            );
            await login(DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
          }
        }
        setReady(true);
      } catch (bootstrapError) {
        setError(
          bootstrapError instanceof Error
            ? bootstrapError.message
            : 'OfficePilot konnte nicht gestartet werden.',
        );
      }
    })();
  }, []);

  if (error) {
    return (
      <BootstrapError
        message={error}
        onRetry={() => {
          setError(null);
          window.location.reload();
        }}
      />
    );
  }

  if (!ready) {
    return <BootstrapLoading />;
  }

  return (
    <BrowserRouter>
      <AppErrorBoundary>
        <ProductionConfigBanner />
        <NetworkStatusBanner />
        <AuthProvider>
          <AppProvider initialSetup={initialSetup}>
            <App />
          </AppProvider>
        </AuthProvider>
      </AppErrorBoundary>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BootstrapApp />
  </StrictMode>,
);
