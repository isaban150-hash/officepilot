import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { BETA_TEST_COMPANY_PROFILE, BETA_TEST_SETUP } from './config/betaTestMode';
import { FirmendatenPage } from './pages/FirmendatenPage';
import { getCompanyProfile, hydrateCompanyProfileStore } from './services/companyProfileService';
import { validateCompanyProfileForSettings } from './services/setupValidationService';
import { resetTestStores } from './test/resetStores';

const VALID_IBAN = 'DE89370400440532013000';

type Mount = { container: HTMLDivElement; root: Root };

function mountFirmendaten(): Mount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={['/firmendaten']}>
        <AuthProvider>
          <AppProvider initialSetup={BETA_TEST_SETUP}>
            <Routes>
              <Route path="/firmendaten" element={<FirmendatenPage />} />
            </Routes>
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  descriptor?.set?.call(input, value);
}

describe('BUGFIX-FIRMENDATEN-IBAN-01', () => {
  let mounted: Mount | null = null;

  beforeEach(() => {
    resetTestStores();
    hydrateCompanyProfileStore({
      ...BETA_TEST_COMPANY_PROFILE,
      iban: '',
    });
  });

  afterEach(() => {
    if (mounted) {
      act(() => {
        mounted!.root.unmount();
      });
      mounted.container.remove();
      mounted = null;
    }
  });

  it('validation and Firmendaten field share the iban property name', () => {
    const profile = {
      ...BETA_TEST_COMPANY_PROFILE,
      iban: VALID_IBAN,
    };
    const result = validateCompanyProfileForSettings(profile, 0);
    expect(result.errors.iban).toBeUndefined();
    expect(result.valid).toBe(true);

    mounted = mountFirmendaten();
    const input = mounted.container.querySelector('#profile-iban') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.name).toBe('iban');
  });

  it('saves IBAN when the DOM is filled without React onChange (autofill)', () => {
    mounted = mountFirmendaten();
    const input = mounted.container.querySelector('#profile-iban') as HTMLInputElement;
    expect(input.value).toBe('');

    // Simulate browser autofill: DOM value changes, React draft stays empty.
    setNativeInputValue(input, VALID_IBAN);
    expect(input.value).toBe(VALID_IBAN);

    const submit = mounted.container.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;
    act(() => {
      submit.click();
    });

    expect(mounted.container.querySelector('.form-error')).toBeNull();
    expect(getCompanyProfile().iban).toBe(VALID_IBAN);
  });

  it('still reports ibanRequired when DOM and draft are both empty', () => {
    mounted = mountFirmendaten();
    const submit = mounted.container.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;
    act(() => {
      submit.click();
    });

    const error = mounted.container.querySelector('.form-error');
    expect(error?.textContent).toMatch(/Bitte IBAN angeben/i);
    expect(getCompanyProfile().iban).toBe('');
  });
});
