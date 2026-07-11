import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { WaitingApprovalPage } from './pages/WaitingApprovalPage';
import {
  approveUser,
  login,
  registerPendingTestUser,
} from './test/authFixtures';

type Mount = { container: HTMLDivElement; root: Root };

async function renderWaitingPage(): Promise<Mount> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={['/waiting-approval']}>
        <AuthProvider>
          <Routes>
            <Route path="/waiting-approval" element={<WaitingApprovalPage />} />
            <Route path="/license-expired" element={<div data-testid="license-expired-page" />} />
            <Route path="/" element={<div data-testid="main-app" />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return { container, root };
}

describe('SUPABASE-AUTH-07 WaitingApprovalPage', () => {
  let mounted: Mount | undefined;

  afterEach(() => {
    if (mounted) {
      act(() => mounted!.root.unmount());
      mounted.container.remove();
      mounted = undefined;
    }
  });

  it('leitet nach Freischaltung von der Warteseite weiter', async () => {
    const user = await registerPendingTestUser('waiting-refresh@example.com');
    await login('waiting-refresh@example.com', 'TestPasswort1');
    mounted = await renderWaitingPage();
    expect(mounted.container.querySelector('[data-testid="waiting-approval-page"]')).not.toBeNull();

    await approveUser(user.id);
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = await renderWaitingPage();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (mounted.container.querySelector('[data-testid="main-app"]')) {
        break;
      }
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(mounted.container.querySelector('[data-testid="main-app"]')).not.toBeNull();
  });
});
