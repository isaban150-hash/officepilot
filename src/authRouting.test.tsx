import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import App from './App';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { DEFAULT_SETUP } from './data/mockData';
import {
  approveUser,
  login,
  loginAsDefaultAdmin,
  registerPendingTestUser,
  seedDefaultAdminUser,
} from './test/authFixtures';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };

type Mount = { container: HTMLDivElement; root: Root };

async function waitForAuthReady(container: HTMLElement): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!container.querySelector('[data-testid="auth-loading"]')) {
      return;
    }
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function renderAppAt(path: string, initialSetup = completeSetup): Promise<Mount> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
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
    await Promise.resolve();
  });
  await waitForAuthReady(container);
  return { container, root };
}

describe('SUPABASE-AUTH-02 routing', () => {
  let mounted: Mount | undefined;

  afterEach(() => {
    if (mounted) {
      act(() => mounted!.root.unmount());
      mounted.container.remove();
      mounted = undefined;
    }
  });

  it('nicht eingeloggt: Weiterleitung zu Login', async () => {
    mounted = await renderAppAt('/');
    expect(mounted.container.querySelector('[data-testid="login-page"]')).not.toBeNull();
  });

  it('pending user sieht waiting approval', async () => {
    await registerPendingTestUser('pending-route@example.com');
    await login('pending-route@example.com', 'TestPasswort1');
    mounted = await renderAppAt('/');
    expect(mounted.container.querySelector('[data-testid="waiting-approval-page"]')).not.toBeNull();
  });

  it('active user kommt in App', async () => {
    await seedDefaultAdminUser();
    await loginAsDefaultAdmin();
    mounted = await renderAppAt('/', completeSetup);
    expect(mounted.container.querySelector('[data-testid="heute-page"]')).not.toBeNull();
  });

  it('normaler user kommt nicht in admin', async () => {
    const user = await registerPendingTestUser('user-admin@example.com');
    await approveUser(user.id);
    await login('user-admin@example.com', 'TestPasswort1');
    mounted = await renderAppAt('/admin/users', completeSetup);
    expect(mounted.container.querySelector('[data-testid="admin-users-denied"]')).not.toBeNull();
  });

  it('admin sieht user list', async () => {
    await loginAsDefaultAdmin();
    mounted = await renderAppAt('/admin/users', completeSetup);
    expect(mounted.container.querySelector('[data-testid="admin-users-page"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-testid="admin-users-table"]')).not.toBeNull();
  });
});
