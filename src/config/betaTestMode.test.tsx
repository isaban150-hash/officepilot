import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import App from '../App';
import { AppProvider } from '../context/AppContext';
import { AuthProvider } from '../context/AuthContext';
import {
  BETA_TEST_SETUP,
  isBetaTestMode,
} from '../config/betaTestMode';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import {
  getCompanyProfile,
  hydrateCompanyProfileStore,
} from '../services/companyProfileService';
import {
  clearPersistedState,
  hydrateStoresFromStorage,
} from '../services/persistenceService';
import { resetInvoiceNumberSequence } from '../services/invoiceNumberService';
import { resetCommunicationHistoryStore } from '../services/communicationHistoryStore';
import { resetKnowledgeStore } from '../services/knowledgeStore';
import { loginAsDefaultAdmin } from '../test/authFixtures';

type Mount = { container: HTMLDivElement; root: Root };

function renderAppAt(path: string, initialSetup = DEFAULT_SETUP): Mount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <AppProvider initialSetup={initialSetup}>
            <App />
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

describe('betaTestMode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('ist ohne Flag inaktiv', () => {
    vi.stubEnv('VITE_BETA_TEST_MODE', '');
    expect(isBetaTestMode()).toBe(false);
  });

  it('ist mit VITE_BETA_TEST_MODE=true aktiv', () => {
    vi.stubEnv('VITE_BETA_TEST_MODE', 'true');
    expect(isBetaTestMode()).toBe(true);
  });
});

describe('betaTestMode – persistence bootstrap', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE });
    resetInvoiceNumberSequence();
    resetCommunicationHistoryStore();
    resetKnowledgeStore();
    await loginAsDefaultAdmin();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearPersistedState();
  });

  it('ohne Beta-Flag: Setup startet unvollständig', () => {
    vi.stubEnv('VITE_BETA_TEST_MODE', '');
    const setup = hydrateStoresFromStorage();
    expect(setup.setupComplete).toBe(false);
  });

  it('mit Beta-Flag: Setup wird übersprungen und Testfirma geladen', () => {
    vi.stubEnv('VITE_BETA_TEST_MODE', 'true');
    const setup = hydrateStoresFromStorage();
    expect(setup.setupComplete).toBe(true);
    expect(setup.companyName).toBe(BETA_TEST_SETUP.companyName);
    expect(setup.industry).toBe('Handwerk – Sanitär/Heizung');
    expect(setup.language).toBe('de');
    expect(setup.communicationChannel).toBe('email');

    const profile = getCompanyProfile();
    expect(profile.contactPerson).toBe('Max Mustermann');
    expect(profile.companyName).toBe('Musterbetrieb GmbH');
  });
});

describe('betaTestMode – routing', () => {
  let mounted: Mount | undefined;

  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE });
    resetInvoiceNumberSequence();
    resetCommunicationHistoryStore();
    resetKnowledgeStore();
    await loginAsDefaultAdmin();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (mounted) {
      act(() => {
        mounted!.root.unmount();
      });
      mounted.container.remove();
      mounted = undefined;
    }
    clearPersistedState();
  });

  it('ohne Beta-Flag: Setup-Wizard erscheint bei unvollständigem Setup', () => {
    vi.stubEnv('VITE_BETA_TEST_MODE', '');
    mounted = renderAppAt('/setup', { ...DEFAULT_SETUP, setupComplete: false });
    expect(mounted.container.querySelector('[data-testid="first-run-wizard"]')).not.toBeNull();
  });

  it('mit Beta-Flag: Heute-Seite wird angezeigt, kein Wizard', () => {
    vi.stubEnv('VITE_BETA_TEST_MODE', 'true');
    const setup = hydrateStoresFromStorage();
    mounted = renderAppAt('/', setup);
    expect(mounted.container.querySelector('[data-testid="first-run-wizard"]')).toBeNull();
    expect(mounted.container.querySelector('[data-testid="heute-page"]')).not.toBeNull();
  });
});
