/**
 * SYNC-AUTOMATIK-01A-FIX3 — Testhilfe: mehrere Browser-Tabs über den echten
 * Anmelde-Start, mit einer kleinen Cloud nach Serververtrag.
 *
 * Ein Tab ist eine frische Modulinstanz (`vi.resetModules`) mit eigenem
 * Arbeitsspeicher; alle Tabs teilen sich `localStorage` — wie im Browser.
 * Die Cloud antwortet über die vorhandenen RPC-Stubs (kein Netzwerk):
 * Kunden-ID aus `customer_id`, exakte `row_version`-Prüfung.
 *
 * Nur für Tests. Neutrale Beispieldaten.
 */
import { expect, vi } from 'vitest';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import * as rpcStore from './mockProfileStore';

interface Row {
  payload: Record<string, unknown>;
  row_version: number;
  updated_at: string;
}

export interface MultiTabCloud {
  workspaceVersion: number;
  setup: Row;
  profile: Row;
  settings: null | { settings: Record<string, unknown>; version: number; updated_at: string };
  customers: Map<string, Row>;
  /** 01A-FIX4 — Vorgänge wie auf dem Server: `vorgang_id` + Nutzlast, exakte Versionsprüfung. */
  vorgaenge: Map<string, Row>;
}

export interface StoredHeader {
  businessRevision: number | undefined;
  writeGeneration: number | undefined;
  savedAt: string | undefined;
}

export function createMultiTabCloudHarness(options: { userId: string; workspaceId: string }) {
  const { userId, workspaceId } = options;
  const storageKey = `officepilot-state:workspace:${workspaceId}`;
  const t0 = '2026-09-01T10:00:00.000Z';
  let cloud: MultiTabCloud = createCloud();

  function createCloud(): MultiTabCloud {
    return {
      workspaceVersion: 1,
      setup: { payload: { ...DEFAULT_SETUP, companyName: 'Beispiel Betrieb GmbH', setupComplete: true, setupVersion: 1 }, row_version: 1, updated_at: t0 },
      // Wie ein älterer Cloud-Payload: ohne `currency` und `defaultTaxStatus`.
      profile: { payload: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Beispiel Betrieb GmbH' }, row_version: 1, updated_at: t0 },
      settings: null,
      customers: new Map(),
      vorgaenge: new Map(),
    };
  }

  function workspaceRow() {
    return { id: workspaceId, name: 'Beispiel Betrieb GmbH', owner_user_id: userId, created_at: t0, updated_at: t0, version: cloud.workspaceVersion };
  }

  function register(): void {
    const member = { workspace_id: workspaceId, user_id: userId, role: 'owner', status: 'active', created_at: t0, updated_at: t0 };
    rpcStore.registerMockRpcHandler('ensure_personal_workspace', () => ({ workspace: workspaceRow(), member, created: false }));
    rpcStore.registerMockRpcHandler('pull_workspace_sync_state', () => ({
      workspace: workspaceRow(),
      members: [member],
      settings: cloud.settings ? { workspace_id: workspaceId, ...cloud.settings } : null,
      vorgaenge: [...cloud.vorgaenge.entries()].map(([id, row]) => ({
        workspace_id: workspaceId,
        vorgang_id: id,
        payload: row.payload,
        row_version: row.row_version,
        deleted: false,
        deleted_at: null,
        updated_at: row.updated_at,
        updated_by: userId,
      })),
      customers: [...cloud.customers.entries()].map(([id, row]) => ({
        workspace_id: workspaceId,
        customer_id: id,
        payload: row.payload,
        row_version: row.row_version,
        deleted: false,
        deleted_at: null,
        updated_at: row.updated_at,
        updated_by: userId,
      })),
      setup: { workspace_id: workspaceId, ...cloud.setup },
      company_profile: { workspace_id: workspaceId, ...cloud.profile },
    }));
    rpcStore.registerMockRpcHandler('upsert_workspace_sync_entity', (args) => {
      const type = String(args.p_entity_type);
      const payload = (args.p_payload ?? {}) as Record<string, unknown>;
      const now = '2026-09-26T12:00:00.000Z';
      if (type === 'company_setup') {
        cloud.setup = { payload: payload.payload as Record<string, unknown>, row_version: cloud.setup.row_version + 1, updated_at: now };
        return { row_version: cloud.setup.row_version, payload };
      }
      if (type === 'company_profile') {
        cloud.profile = { payload: (payload.payload ?? payload) as Record<string, unknown>, row_version: cloud.profile.row_version + 1, updated_at: now };
        return { row_version: cloud.profile.row_version, payload };
      }
      if (type === 'workspace_settings') {
        cloud.settings = { settings: (payload.settings ?? payload) as Record<string, unknown>, version: (cloud.settings?.version ?? 0) + 1, updated_at: now };
        return { row_version: cloud.settings.version, payload };
      }
      if (type === 'workspace') {
        cloud.workspaceVersion += 1;
        return { row_version: cloud.workspaceVersion, payload };
      }
      if (type === 'customer') {
        const id = String(payload.customer_id);
        const previous = cloud.customers.get(id);
        if (Number(args.p_row_version ?? 0) !== (previous?.row_version ?? 0)) {
          throw new Error('Versionskonflikt customer');
        }
        const next = (previous?.row_version ?? 0) + 1;
        cloud.customers.set(id, { payload, row_version: next, updated_at: now });
        return { row_version: next, payload };
      }
      if (type === 'vorgang') {
        // Wie der Server: Kennung aus `vorgang_id`, gespeichert wird die Nutzlast selbst.
        const id = String(payload.vorgang_id);
        const previous = cloud.vorgaenge.get(id);
        if (Number(args.p_row_version ?? 0) !== (previous?.row_version ?? 0)) {
          throw new Error('Versionskonflikt vorgang');
        }
        const next = (previous?.row_version ?? 0) + 1;
        cloud.vorgaenge.set(id, { payload: (payload.payload ?? payload) as Record<string, unknown>, row_version: next, updated_at: now });
        return { row_version: next, payload };
      }
      return { row_version: 1, payload };
    });
    for (const name of [
      'pull_workspace_invoices',
      'pull_workspace_order_amendments',
      'pull_workspace_invoice_payments',
      'pull_workspace_documents',
      'pull_workspace_accounting_assignments',
      'pull_workspace_accounting_period_closures',
    ]) {
      rpcStore.registerMockRpcHandler(name, () => []);
    }
    rpcStore.registerMockRpcHandler('pull_workspace_intake_state', () => ({}));
    rpcStore.registerMockRpcHandler('pull_workspace_expenses', () => ({}));
    rpcStore.registerMockRpcHandler('get_workspace_invoice_number_format', () => ({}));
  }

  /** Ein Browser-Tab: frische Module, Anmelde-Start wie im Gate. */
  async function openTab() {
    vi.resetModules();
    const bootstrap = await import('../services/storage/storageBootstrapService');
    const cloudBootstrap = await import('../services/workspace/workspaceCloudBootstrapService');
    const persistence = await import('../services/persistenceService');
    const customers = await import('../services/customerService');
    const syncUi = await import('../services/sync/syncUiService');
    const vorgaenge = await import('../services/vorgangService');
    bootstrap.bootstrapBusinessState({ userId });
    const result = await cloudBootstrap.bootstrapWorkspaceCloudSyncIfNeeded();
    expect(result.status).toBe('ready');
    // Nacharbeiten des Starts (Prüfsummen, Dateipflege) abwarten.
    await new Promise((resolve) => setTimeout(resolve, 30));
    return {
      persistence,
      syncUi,
      vorgaenge,
      save(name: string) {
        return customers.createCustomer({ name, street: 'Beispielweg 1', zip: '20000', city: 'Beispielstadt' });
      },
    };
  }

  function header(): StoredHeader {
    const raw = localStorage.getItem(storageKey);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return {
      businessRevision: typeof parsed.businessRevision === 'number' ? parsed.businessRevision : undefined,
      writeGeneration: typeof parsed.writeGeneration === 'number' ? parsed.writeGeneration : undefined,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : undefined,
    };
  }

  function storedCustomerNames(): string[] {
    const stored = JSON.parse(localStorage.getItem(storageKey)!) as { customers?: Array<{ name: string }> };
    return (stored.customers ?? []).map((customer) => customer.name);
  }

  return {
    storageKey,
    get cloud() {
      return cloud;
    },
    reset() {
      cloud = createCloud();
      register();
    },
    openTab,
    header,
    storedCustomerNames,
    clear() {
      rpcStore.clearMockRpcHandlers();
    },
  };
}
