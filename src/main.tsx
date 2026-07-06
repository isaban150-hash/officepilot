import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
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

function BootstrapApp() {
  const [ready, setReady] = useState(false);
  const [initialSetup] = useState(() => hydrateStoresFromStorage());

  useEffect(() => {
    void (async () => {
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
    })();
  }, []);

  if (!ready) {
    return null;
  }

  return (
    <BrowserRouter>
      <AuthProvider>
        <AppProvider initialSetup={initialSetup}>
          <App />
        </AppProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BootstrapApp />
  </StrictMode>,
);
