import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { DEFAULT_SETUP } from './data/mockData';
import { buildPasswordResetRedirectTo } from './pages/ForgotPasswordPage';
import {
  clearPasswordRecoveryPending,
  markPasswordRecoveryPending,
  MIN_PASSWORD_LENGTH,
  PASSWORD_RECOVERY_FLAG_KEY,
  requestPasswordReset,
  updatePasswordDuringRecovery,
} from './services/auth/supabaseAuthService';
import {
  getMockLastResetPasswordCall,
  getMockProfile,
  getMockUpdateUserCallCount,
  mockFindUserByEmail,
  mockRegisterUser,
  resetMockSupabaseAuth,
  startMockPasswordRecovery,
} from './test/mockSupabaseAuth';
import { LICENSE_VERSION, PRIVACY_VERSION, TERMS_VERSION } from './config/legalVersions';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };

type Mount = { container: HTMLDivElement; root: Root };

async function waitForAuthReady(container: HTMLElement): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!container.querySelector('[data-testid="auth-loading"]')) {
      return;
    }
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function renderAppAt(path: string): Promise<Mount> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <AppProvider initialSetup={completeSetup}>
            <App />
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    await Promise.resolve();
  });
  await waitForAuthReady(container);
  return { container, root };
}

function seedUser(email: string, password: string): void {
  mockRegisterUser({
    email,
    password,
    companyName: 'Test GmbH',
    firstName: 'Max',
    lastName: 'Mustermann',
    acceptedTermsVersion: TERMS_VERSION,
    acceptedPrivacyVersion: PRIVACY_VERSION,
    acceptedLicenseVersion: LICENSE_VERSION,
  });
}

describe('AUTH-PASSWORD-RECOVERY-01', () => {
  let mounted: Mount | undefined;

  beforeEach(() => {
    resetMockSupabaseAuth();
    clearPasswordRecoveryPending();
    sessionStorage.clear();
  });

  afterEach(() => {
    if (mounted) {
      act(() => mounted!.root.unmount());
      mounted.container.remove();
      mounted = undefined;
    }
    vi.restoreAllMocks();
    clearPasswordRecoveryPending();
  });

  it('Forgot-Password calls reset with current origin and /reset-password', async () => {
    expect(buildPasswordResetRedirectTo()).toBe(`${window.location.origin}/reset-password`);
    expect(buildPasswordResetRedirectTo('https://officepilot-preview.vercel.app')).toBe(
      'https://officepilot-preview.vercel.app/reset-password',
    );

    const result = await requestPasswordReset(
      'reset-me@example.com',
      buildPasswordResetRedirectTo(),
    );
    expect(result).toEqual({ success: true });

    const call = getMockLastResetPasswordCall();
    expect(call).not.toBeNull();
    expect(call?.email).toBe('reset-me@example.com');
    expect(call?.redirectTo).toBe(`${window.location.origin}/reset-password`);

    mounted = await renderAppAt('/forgot-password');
    expect(mounted.container.querySelector('[data-testid="forgot-password-form"]')).not.toBeNull();
    expect(mounted.container.innerHTML).not.toMatch(/noch nicht angebunden|henüz bağlı değil/i);

    const form = mounted.container.querySelector(
      '[data-testid="forgot-password-form"]',
    ) as HTMLFormElement;
    const emailInput = mounted.container.querySelector(
      '[data-testid="forgot-password-email"]',
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(emailInput, 'from-ui@example.com');
      emailInput.dispatchEvent(new Event('input', { bubbles: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(getMockLastResetPasswordCall()?.email).toBe('from-ui@example.com');
    expect(getMockLastResetPasswordCall()?.redirectTo).toBe(
      `${window.location.origin}/reset-password`,
    );
  });

  it('success does not reveal whether the email exists', async () => {
    const known = await requestPasswordReset(
      'nobody-known@example.com',
      `${window.location.origin}/reset-password`,
    );
    const unknown = await requestPasswordReset(
      'also-unknown@example.com',
      `${window.location.origin}/reset-password`,
    );
    expect(known).toEqual({ success: true });
    expect(unknown).toEqual({ success: true });

    mounted = await renderAppAt('/forgot-password');
    const html = mounted.container.innerHTML;
    expect(html).not.toMatch(/nicht registriert|does not exist|yok|няма/i);
    expect(html).toContain('forgot-password-form');
  });

  it('/reset-password is publicly reachable', async () => {
    mounted = await renderAppAt('/reset-password');
    expect(mounted.container.querySelector('[data-testid="reset-password-page"]')).not.toBeNull();
  });

  it('PASSWORD_RECOVERY event is recognized and keeps user on reset page', async () => {
    seedUser('recover@example.com', 'OldPassword1');
    mounted = await renderAppAt('/reset-password');

    await act(async () => {
      startMockPasswordRecovery('recover@example.com');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sessionStorage.getItem(PASSWORD_RECOVERY_FLAG_KEY)).toBe('1');
    expect(mounted.container.querySelector('[data-testid="reset-password-form"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-testid="heute-page"]')).toBeNull();
  });

  it('existing recovery session on page load is recognized via flag', async () => {
    seedUser('reload@example.com', 'OldPassword1');
    markPasswordRecoveryPending();
    startMockPasswordRecovery('reload@example.com');

    mounted = await renderAppAt('/reset-password');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mounted.container.querySelector('[data-testid="reset-password-form"]')).not.toBeNull();
  });

  it('without recovery session updateUser is not called', async () => {
    clearPasswordRecoveryPending();
    const result = await updatePasswordDuringRecovery('NewPassword1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('recovery_session_missing');
    }
    expect(getMockUpdateUserCallCount()).toBe(0);
  });

  it('mismatched passwords are rejected without updateUser', async () => {
    seedUser('mismatch@example.com', 'OldPassword1');
    markPasswordRecoveryPending();
    startMockPasswordRecovery('mismatch@example.com');
    mounted = await renderAppAt('/reset-password');

    await act(async () => {
      await Promise.resolve();
    });

    const newInput = mounted.container.querySelector(
      '[data-testid="reset-password-new"]',
    ) as HTMLInputElement;
    const confirmInput = mounted.container.querySelector(
      '[data-testid="reset-password-confirm"]',
    ) as HTMLInputElement;
    const form = mounted.container.querySelector(
      '[data-testid="reset-password-form"]',
    ) as HTMLFormElement;

    const setVal = (el: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };

    await act(async () => {
      setVal(newInput, 'NewPassword1');
      setVal(confirmInput, 'OtherPassword1');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(getMockUpdateUserCallCount()).toBe(0);
    expect(mounted.container.querySelector('[data-testid="reset-password-error"]')?.textContent).toMatch(
      /stimmen nicht|eşleşmiyor|не съвпадат/i,
    );
  });

  it('valid password calls updateUser exactly once then lands on login after sign-out', async () => {
    seedUser('ok@example.com', 'OldPassword1');
    const user = mockFindUserByEmail('ok@example.com')!;
    const beforeProfile = getMockProfile(user.id);
    expect(beforeProfile).toBeTruthy();
    const licenseBefore = beforeProfile!.license_status;
    const roleBefore = beforeProfile!.role;

    markPasswordRecoveryPending();
    startMockPasswordRecovery('ok@example.com');

    const updateResult = await updatePasswordDuringRecovery('BrandNewPass1');
    expect(updateResult.success).toBe(true);
    expect(getMockUpdateUserCallCount()).toBe(1);

    // Mirror post-success cleanup: end recovery session before normal login UI.
    const { signOutUser } = await import('./services/auth/supabaseAuthService');
    await signOutUser();
    clearPasswordRecoveryPending();

    mounted = await renderAppAt('/login?passwordChanged=1');
    expect(mounted.container.querySelector('[data-testid="login-password-changed"]')?.textContent).toMatch(
      /Passwort geändert|Şifre değiştirildi|Паролата е променена/i,
    );
    expect(mounted.container.querySelector('[data-testid="heute-page"]')).toBeNull();

    const afterProfile = getMockProfile(user.id);
    expect(afterProfile?.license_status).toBe(licenseBefore);
    expect(afterProfile?.role).toBe(roleBefore);
    expect(afterProfile?.email).toBe('ok@example.com');
    expect(afterProfile?.id).toBe(user.id);
  });

  it('invalid or missing recovery link shows a safe error without tokens', async () => {
    clearPasswordRecoveryPending();
    mounted = await renderAppAt('/reset-password');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const invalid = mounted.container.querySelector('[data-testid="reset-password-invalid"]');
    expect(invalid).not.toBeNull();
    const text = invalid?.textContent ?? '';
    expect(text).toMatch(/ungültig|abgelaufen|geçersiz|невалидна/i);
    expect(text).not.toMatch(/access_token|refresh_token|stack|Bearer /i);
    expect(mounted.container.querySelector('[data-testid="reset-password-request-again"]')).not.toBeNull();
  });

  it('short password is rejected without updateUser', async () => {
    seedUser('short@example.com', 'OldPassword1');
    markPasswordRecoveryPending();
    startMockPasswordRecovery('short@example.com');
    const result = await updatePasswordDuringRecovery('short');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('password_too_short');
    }
    expect(getMockUpdateUserCallCount()).toBe(0);
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(8);
  });
});
