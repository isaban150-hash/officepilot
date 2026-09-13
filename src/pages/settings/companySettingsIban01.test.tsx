import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as supabaseLib from '../../lib/supabase';
import { AppProvider } from '../../context/AppContext';
import { AuthProvider } from '../../context/AuthContext';
import { BETA_TEST_COMPANY_PROFILE, BETA_TEST_SETUP } from '../../config/betaTestMode';
import { CompanySettingsPage } from './CompanySettingsPage';
import { getCompanyProfile, hydrateCompanyProfileStore } from '../../services/companyProfileService';
import { validateCompanyProfileForSettings } from '../../services/setupValidationService';

/*
 * SETTINGS-01B5 — von der abgelösten Firmendaten-Seite auf die kanonische
 * Firmenprofil-Seite migriert. Die Autofill-Regel (DOM-Wert zählt beim
 * Absenden) lebt jetzt in `CompanySettingsPage.handleSubmit`.
 */

const VALID_IBAN = 'DE89370400440532013000';

type Mount = { container: HTMLDivElement; root: Root };

function mountFirmendaten(): Mount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={['/einstellungen/firma']}>
        <AuthProvider>
          <AppProvider initialSetup={BETA_TEST_SETUP}>
            <Routes>
              <Route path="/einstellungen/firma" element={<CompanySettingsPage />} />
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

describe('BUGFIX-FIRMENDATEN-IBAN-01 — auf der Firmenprofil-Seite (SETTINGS-01B5)', () => {
  let mounted: Mount | null = null;

  beforeEach(() => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
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
    vi.restoreAllMocks();
  });

  it('validation and settings field share the iban property name', () => {
    const profile = {
      ...BETA_TEST_COMPANY_PROFILE,
      iban: VALID_IBAN,
    };
    const result = validateCompanyProfileForSettings(profile, 0);
    expect(result.errors.iban).toBeUndefined();
    expect(result.valid).toBe(true);

    mounted = mountFirmendaten();
    const input = mounted.container.querySelector('#settings-company-iban') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.name).toBe('iban');
  });

  it('saves IBAN when the DOM is filled without React onChange (autofill)', () => {
    mounted = mountFirmendaten();
    const input = mounted.container.querySelector('#settings-company-iban') as HTMLInputElement;
    expect(input.value).toBe('');

    // Ein anderes Feld wird regulär bearbeitet (Formular dirty) …
    const phone = mounted.container.querySelector('#settings-company-phone') as HTMLInputElement;
    act(() => {
      setNativeInputValue(phone, '089 555');
      phone.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // … die IBAN kommt nur per Autofill ins DOM, ohne React onChange.
    setNativeInputValue(input, VALID_IBAN);
    expect(input.value).toBe(VALID_IBAN);

    const form = mounted.container.querySelector('form') as HTMLFormElement;
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(mounted.container.querySelector('.form-error')).toBeNull();
    expect(getCompanyProfile().phone).toBe('089 555');
    expect(getCompanyProfile().iban).toBe(VALID_IBAN);
  });

  it('still reports ibanRequired when DOM and draft are both empty', () => {
    mounted = mountFirmendaten();
    const phone = mounted.container.querySelector('#settings-company-phone') as HTMLInputElement;
    act(() => {
      setNativeInputValue(phone, '089 555');
      phone.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const form = mounted.container.querySelector('form') as HTMLFormElement;
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    const error = mounted.container.querySelector('[data-testid="settings-company-iban-error"]');
    expect(error?.textContent).toMatch(/Bitte IBAN angeben/i);
    expect(getCompanyProfile().iban).toBe('');
  });
});
