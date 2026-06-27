import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AppProvider } from './context/AppContext';
import { hydrateStoresFromStorage } from './services/persistenceService';
import './index.css';

const initialSetup = hydrateStoresFromStorage();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AppProvider initialSetup={initialSetup}>
        <App />
      </AppProvider>
    </BrowserRouter>
  </StrictMode>,
);
