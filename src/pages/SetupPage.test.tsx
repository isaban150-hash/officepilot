import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { AppProvider } from '../context/AppContext';
import { AuthProvider } from '../context/AuthContext';
import App from '../App';
import { SetupPage } from './SetupPage';
import { hydrateCompanyProfileStore } from '../services/companyProfileService';
import { resetInvoiceNumberSequence } from '../services/invoiceNumberService';
import { resetCommunicationHistoryStore } from '../services/communicationHistoryStore';
import { resetKnowledgeStore } from '../services/knowledgeStore';
import { loginAsDefaultAdmin } from '../test/authFixtures';
import { createDefaultSetupWizardDraft } from '../types/setup';

const incompleteSetup = { ...DEFAULT_SETUP, setupComplete: false };
const completeSetup = {
  ...DEFAULT_SETUP,
  setupComplete: true,
  setupVersion: 1,
  companyName: 'Fertig GmbH',
};

type Mount = { container: HTMLDivElement; root: Root };

function renderApp(initialSetup = incompleteSetup): Mount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={['/setup']}>
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

function renderSetupPage(initialSetup = incompleteSetup): Mount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={['/setup']}>
        <AppProvider initialSetup={initialSetup}>
          <Routes>
            <Route path="/setup" element={<SetupPage />} />
            <Route path="/" element={<div data-testid="heute-page">Heute</div>} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

function setInputValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function fillCompanyStep(container: ParentNode): void {
  setInputValue(container.querySelector('[data-testid="setup-companyName"]') as HTMLInputElement, 'Muster GmbH');
  setInputValue(container.querySelector('[data-testid="setup-contactPerson"]') as HTMLInputElement, 'Max Mustermann');
  setInputValue(container.querySelector('[data-testid="setup-street"]') as HTMLInputElement, 'Hauptstraße 1');
  setInputValue(container.querySelector('[data-testid="setup-zip"]') as HTMLInputElement, '80331');
  setInputValue(container.querySelector('[data-testid="setup-city"]') as HTMLInputElement, 'München');
  setInputValue(container.querySelector('[data-testid="setup-email"]') as HTMLInputElement, 'info@muster.de');
}

describe('FirstRunWizard / SetupPage', () => {
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
    if (mounted) {
      act(() => {
        mounted!.root.unmount();
      });
      mounted.container.remove();
      mounted = undefined;
    }
  });

  it('shows wizard on first start', () => {
    mounted = renderApp(incompleteSetup);
    expect(mounted.container.querySelector('[data-testid="first-run-wizard"]')).not.toBeNull();
  });

  it('shows branding and step progress bar', () => {
    mounted = renderSetupPage(incompleteSetup);
    expect(mounted.container.querySelector('.setup-brand__title')?.textContent).toBe('OfficePilot');
    expect(mounted.container.querySelector('[data-testid="setup-progress-bar"]')).not.toBeNull();
    expect(mounted.container.textContent).toContain('Schritt 1 von 5');
  });

  it('blocks next step when required company fields are missing', () => {
    mounted = renderSetupPage(incompleteSetup);
    act(() => {
      (mounted!.container.querySelector('[data-testid="setup-next"]') as HTMLButtonElement).click();
    });
    expect(mounted.container.textContent).toContain('Bitte Firmenname angeben');
    expect(mounted.container.querySelector('[data-testid="setup-taxNumber"]')).toBeNull();
  });

  it('loads existing profile values into wizard', () => {
    const draft = createDefaultSetupWizardDraft(
      { ...incompleteSetup, companyName: 'Bestehend GmbH' },
      {
        ...DEFAULT_COMPANY_PROFILE,
        companyName: 'Bestehend GmbH',
        contactPerson: 'Erika Beispiel',
        email: 'kontakt@bestehend.de',
      },
    );
    expect(draft.companyName).toBe('Bestehend GmbH');
    expect(draft.contactPerson).toBe('Erika Beispiel');
  });

  it('completes setup and navigates away from wizard', () => {
    mounted = renderSetupPage(incompleteSetup);
    fillCompanyStep(mounted.container);
    act(() => {
      (mounted!.container.querySelector('[data-testid="setup-next"]') as HTMLButtonElement).click();
    });
    setInputValue(mounted.container.querySelector('[data-testid="setup-taxNumber"]') as HTMLInputElement, '123/456/78901');
    act(() => {
      (mounted!.container.querySelector('[data-testid="setup-next"]') as HTMLButtonElement).click();
    });
    setInputValue(mounted.container.querySelector('[data-testid="setup-iban"]') as HTMLInputElement, 'DE89370400440532013000');
    act(() => {
      (mounted!.container.querySelector('[data-testid="setup-next"]') as HTMLButtonElement).click();
    });
    setInputValue(mounted.container.querySelector('[data-testid="setup-lastInvoiceNumber"]') as HTMLInputElement, '12');
    act(() => {
      (mounted!.container.querySelector('[data-testid="setup-next"]') as HTMLButtonElement).click();
    });
    act(() => {
      (mounted!.container.querySelector('[data-testid="setup-next"]') as HTMLButtonElement).click();
    });
    expect(mounted.container.querySelector('[data-testid="heute-page"]')).not.toBeNull();
  });

  it('does not show wizard after setup is complete', () => {
    mounted = renderApp(completeSetup);
    expect(mounted.container.querySelector('[data-testid="first-run-wizard"]')).toBeNull();
  });
});
