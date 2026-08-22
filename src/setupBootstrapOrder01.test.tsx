import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { DEFAULT_SETUP } from './data/mockData';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import type { AppPersistedState } from './types/models';
import type { UserAccount } from './types/auth';
import { BusinessStateGate } from './components/system/BusinessStateGate';
import { useApp } from './context/AppContext';
import {
  createSeedState,
  getCachedSetup,
  savePersistedStateToKey,
} from './services/persistenceService';
import { switchToWorkspaceScope } from './services/storage/storageBootstrapService';
import { buildStorageKey } from './services/storage/storageScopeService';
import { STORAGE_VERSION } from './services/sync/syncMigrationService';
import { createSyncClient } from './services/sync/syncClientService';
import { resetTestStores } from './test/resetStores';

const USER_ID = 'bootstrap-order-user';
const WORKSPACE_ID = 'bootstrap-order-ws';

const proofUser: UserAccount = {
  id: USER_ID,
  companyName: 'Proof',
  firstName: 'A',
  lastName: 'B',
  email: 'proof@example.com',
  role: 'user',
  status: 'approved',
  createdAt: '2026-07-01T10:00:00.000Z',
  updatedAt: '2026-07-01T10:00:00.000Z',
  licensePlan: 'beta',
  licenseStatus: 'active',
};

let cloudResolve: (() => void) | null = null;
let cloudReject: ((error?: unknown) => void) | null = null;
let cloudStarted = false;

vi.mock('./services/workspace/workspaceCloudBootstrapService', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./services/workspace/workspaceCloudBootstrapService')>();
  return {
    ...actual,
    bootstrapWorkspaceCloudSyncIfNeeded: vi.fn(
      () =>
        new Promise<{ status: string; reason?: string }>((resolve, reject) => {
          cloudStarted = true;
          cloudResolve = () => {
            switchToWorkspaceScope(USER_ID, WORKSPACE_ID);
            resolve({ status: 'ready' });
          };
          cloudReject = reject;
        }),
    ),
  };
});

vi.mock('./context/AuthContext', () => ({
  useAuth: () => ({
    user: proofUser,
    session: { userId: USER_ID, accessToken: 't', createdAt: '2026-07-01T10:00:00.000Z' },
    isAuthenticated: true,
    isAllowed: true,
    isAdmin: false,
    isAuthReady: true,
    profileError: false,
    login: async () => ({ success: false }),
    logout: async () => undefined,
    register: async () => ({ success: false }),
    refreshAuth: async () => undefined,
    approveUser: async () => ({ success: false }),
    blockUser: async () => ({ success: false }),
    extendLicense: async () => ({ success: false }),
    expireLicense: async () => ({ success: false }),
    grantBetaLicense: async () => ({ success: false }),
  }),
}));

function buildCompleteWorkspaceState(): AppPersistedState {
  const client = createSyncClient();
  const base = createSeedState({
    ...DEFAULT_SETUP,
    companyName: 'Proof Co',
    setupComplete: true,
    setupVersion: 1,
  });
  return {
    ...base,
    version: STORAGE_VERSION,
    syncClient: {
      ...client,
      workspaceId: WORKSPACE_ID,
      serverWorkspaceId: WORKSPACE_ID,
      cloudProvisionedAt: '2026-07-01T10:00:00.000Z',
    },
    workspace: {
      id: WORKSPACE_ID,
      name: 'Proof Workspace',
      ownerUserId: USER_ID,
      createdAt: '2026-07-01T10:00:00.000Z',
      updatedAt: '2026-07-01T10:00:00.000Z',
      version: 1,
      sync: {
        updatedAt: '2026-07-01T10:00:00.000Z',
        version: 1,
        deleted: false,
        deviceId: client.deviceId,
        workspaceId: WORKSPACE_ID,
      },
    },
    companyProfile: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Proof Co' },
    setup: {
      ...DEFAULT_SETUP,
      companyName: 'Proof Co',
      setupComplete: true,
      setupVersion: 1,
    },
    savedAt: '2026-07-01T10:00:00.000Z',
  };
}

function RoutingProbe() {
  const { setup } = useApp();
  const decision = setup.setupComplete ? 'app' : 'setup';
  return createElement('div', {
    'data-testid': 'routing-decision',
    'data-setup-complete': String(setup.setupComplete),
    'data-decision': decision,
  }, decision);
}

describe('SETUP-BOOTSTRAP-ORDER-01', () => {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    cloudResolve = null;
    cloudReject = null;
    cloudStarted = false;
    localStorage.clear();
    savePersistedStateToKey({ type: 'workspace', workspaceId: WORKSPACE_ID }, buildCompleteWorkspaceState());
    localStorage.removeItem(buildStorageKey({ type: 'user', userId: USER_ID }));
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    host?.remove();
    host = null;
    root = null;
    resetTestStores();
    localStorage.clear();
  });

  it('hält BootstrapLoading bis Workspace-Bootstrap fertig ist und routet dann nicht über User-Seed', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root!.render(
        createElement(
          MemoryRouter,
          null,
          createElement(BusinessStateGate, null, createElement(RoutingProbe)),
        ),
      );
    });

    expect(host.querySelector('[data-testid="bootstrap-loading"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="routing-decision"]')).toBeNull();
    expect(cloudStarted).toBe(true);
    // Während des Wartens: User-Seed kann incomplete sein — darf aber AppProvider nicht freigeben
    expect(getCachedSetup().setupComplete).toBe(false);

    await act(async () => {
      cloudResolve?.();
    });

    expect(host.querySelector('[data-testid="bootstrap-loading"]')).toBeNull();
    const probe = host.querySelector('[data-testid="routing-decision"]');
    expect(probe).not.toBeNull();
    expect(probe?.getAttribute('data-setup-complete')).toBe('true');
    expect(probe?.getAttribute('data-decision')).toBe('app');
    expect(getCachedSetup().setupComplete).toBe(true);
  });

  /**
   * OFFICEPILOT-MULTI-ORIGIN-SETUP-01B2 — früher gab das Gate nach einem Fehler
   * den lokalen Stand frei und schickte Bestandskunden in den leeren
   * Assistenten. Jetzt bleibt es sichtbar bei der Wiederherstellungsansicht.
   */
  it('zeigt nach fehlgeschlagenem Workspace-Bootstrap die Wiederherstellungsansicht statt des Assistenten', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root!.render(
        createElement(
          MemoryRouter,
          null,
          createElement(BusinessStateGate, null, createElement(RoutingProbe)),
        ),
      );
    });

    expect(host.querySelector('[data-testid="bootstrap-loading"]')).not.toBeNull();

    await act(async () => {
      cloudReject?.(new Error('bootstrap-failed'));
    });

    expect(host.querySelector('[data-testid="bootstrap-loading"]')).toBeNull();
    expect(host.querySelector('[data-testid="workspace-restore-failure"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="routing-decision"]')).toBeNull();
  });
});
