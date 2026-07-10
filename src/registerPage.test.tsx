import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { RegisterPage } from './pages/RegisterPage';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { DEFAULT_SETUP } from './data/mockData';
import {
  LICENSE_VERSION,
  PRIVACY_VERSION,
  TERMS_VERSION,
} from './config/legalVersions';
import { signUpUser } from './services/auth/authService';
import { setMockSignUpMode } from './test/mockSupabaseAuth';

type Mount = { container: HTMLDivElement; root: Root };

async function renderRegisterPage(): Promise<Mount> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter>
        <AuthProvider>
          <AppProvider initialSetup={DEFAULT_SETUP}>
            <RegisterPage />
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    await Promise.resolve();
  });
  return { container, root };
}

function setInputValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}


async function fillRequiredFields(container: ParentNode): Promise<void> {
  await act(async () => {
    setInputValue(container.querySelector('[data-testid="register-company"]') as HTMLInputElement, 'Test GmbH');
    setInputValue(container.querySelector('[data-testid="register-first-name"]') as HTMLInputElement, 'Max');
    setInputValue(container.querySelector('[data-testid="register-last-name"]') as HTMLInputElement, 'Muster');
    setInputValue(container.querySelector('[data-testid="register-email"]') as HTMLInputElement, 'register-ui@example.com');
    setInputValue(container.querySelector('[data-testid="register-password"]') as HTMLInputElement, 'TestPasswort1');
    setInputValue(container.querySelector('[data-testid="register-password-confirm"]') as HTMLInputElement, 'TestPasswort1');

    for (const testId of ['register-terms', 'register-privacy', 'register-license']) {
      const checkbox = container.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement;
      if (!checkbox.checked) {
        checkbox.click();
      }
    }
  });
}

async function submitRegisterForm(container: ParentNode): Promise<void> {
  await act(async () => {
    (container.querySelector('form.auth-form') as HTMLFormElement).requestSubmit();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('SUPABASE-AUTH-02-FIX RegisterPage', () => {
  let mounted: Mount | undefined;

  afterEach(() => {
    setMockSignUpMode('with_session');
    if (mounted) {
      act(() => mounted!.root.unmount());
      mounted.container.remove();
      mounted = undefined;
    }
  });

  it('zeigt Erfolgsmeldung bei Registrierung mit E-Mail-Bestätigung', async () => {
    setMockSignUpMode('email_confirmation');
    mounted = await renderRegisterPage();
    await fillRequiredFields(mounted.container);
    await submitRegisterForm(mounted.container);

    expect(mounted.container.querySelector('[data-testid="register-success"]')?.textContent).toContain(
      'Registrierung erfolgreich. Bitte bestätigen Sie Ihre E-Mail-Adresse.',
    );
    expect(mounted.container.querySelector('[data-testid="register-error"]')).toBeNull();
  });

  it('zeigt nach signUp keine Login-Fehlermeldung', async () => {
    setMockSignUpMode('email_confirmation');
    const result = await signUpUser({
      companyName: 'Test GmbH',
      firstName: 'Anna',
      lastName: 'Beispiel',
      email: 'signup-no-login-error@example.com',
      password: 'TestPasswort1',
      acceptedTermsVersion: TERMS_VERSION,
      acceptedPrivacyVersion: PRIVACY_VERSION,
      acceptedLicenseVersion: LICENSE_VERSION,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.outcome).toBe('email_confirmation_required');
    }

    mounted = await renderRegisterPage();
    await fillRequiredFields(mounted.container);
    setInputValue(
      mounted.container.querySelector('[data-testid="register-email"]') as HTMLInputElement,
      'signup-no-login-error-ui@example.com',
    );
    await submitRegisterForm(mounted.container);

    expect(mounted.container.textContent).not.toContain('E-Mail oder Passwort ist falsch.');
  });

  it('blockiert Registrierung bei abweichenden Passwörtern', async () => {
    mounted = await renderRegisterPage();
    await fillRequiredFields(mounted.container);
    await act(async () => {
      setInputValue(
        mounted!.container.querySelector('[data-testid="register-password-confirm"]') as HTMLInputElement,
        'AnderesPasswort1',
      );
    });
    await submitRegisterForm(mounted.container);

    expect(mounted.container.querySelector('[data-testid="register-error"]')?.textContent).toBe(
      'Die Passwörter stimmen nicht überein.',
    );
  });

  it('kann Passwort anzeigen und wieder ausblenden', async () => {
    mounted = await renderRegisterPage();
    const passwordInput = mounted.container.querySelector('[data-testid="register-password"]') as HTMLInputElement;
    const toggle = mounted.container.querySelector('[data-testid="register-password-toggle"]') as HTMLButtonElement;

    expect(passwordInput.type).toBe('password');
    expect(toggle.getAttribute('aria-label')).toBe('Passwort anzeigen');

    await act(async () => {
      toggle.click();
    });

    expect(passwordInput.type).toBe('text');
    expect(toggle.getAttribute('aria-label')).toBe('Passwort ausblenden');

    await act(async () => {
      toggle.click();
    });

    expect(passwordInput.type).toBe('password');
  });

  it('behält Legal-Checkboxen als Pflicht bei', async () => {
    mounted = await renderRegisterPage();
    await fillRequiredFields(mounted.container);
    await act(async () => {
      const terms = mounted!.container.querySelector('[data-testid="register-terms"]') as HTMLInputElement;
      if (terms.checked) {
        terms.click();
      }
    });
    await submitRegisterForm(mounted.container);

    expect(mounted.container.querySelector('[data-testid="register-error"]')?.textContent).toContain(
      'Bitte akzeptieren Sie AGB',
    );
  });
});
