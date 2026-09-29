/**
 * SYNC-AUTOMATIK-01A-FIX2 — Öffnen/Neuladen eines Tabs über den **echten**
 * Anmelde-Start (Cloud-Bootstrap) erhöht die Schreibgeneration nicht.
 *
 * Browserbefund nach FIX1: Schon das blosse Öffnen von Tab B sperrte Tab A.
 * Der FIX1-Test hatte nur den lokalen Ladepfad nachgestellt. Beim Anmelde-
 * Start läuft zusätzlich der Cloud-Bootstrap; dessen Schreibpfad
 * `applyPersistedStateFromSync(merged)` legte das Firmenprofil in der Form des
 * Cloud-Payloads ab — ohne die beim Laden ergänzten `currency` und
 * `defaultTaxStatus`. Fachlich gleich, im Fingerabdruck verschieden.
 *
 * Hier laufen zwei (bzw. drei) getrennte Modulinstanzen als Tabs mit
 * gemeinsamem `localStorage` durch `bootstrapBusinessState` und
 * `bootstrapWorkspaceCloudSyncIfNeeded` — wie im Browser. Die Cloud ist ein
 * kleiner RPC-Ersatz über die vorhandenen Test-Stubs; kein Netzwerk.
 *
 * Neutrale Beispieldaten.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETUP } from '../../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import * as rpcStore from '../../test/mockProfileStore';
import { buildBusinessContentFingerprint } from '../persistenceService';

const USER = 'tabs-fix2-user';
const WS = 'tabs-fix2-ws';
const KEY = `officepilot-state:workspace:${WS}`;
const T0 = '2026-09-01T10:00:00.000Z';

interface Row {
  payload: Record<string, unknown>;
  row_version: number;
  updated_at: string;
}

let cloud: {
  workspaceVersion: number;
  setup: Row;
  profile: Row;
  settings: null | { settings: Record<string, unknown>; version: number; updated_at: string };
  customers: Map<string, Row>;
};

function resetCloud(): void {
  cloud = {
    workspaceVersion: 1,
    setup: { payload: { ...DEFAULT_SETUP, companyName: 'Beispiel Betrieb GmbH', setupComplete: true, setupVersion: 1 }, row_version: 1, updated_at: T0 },
    // Wie ein älterer Cloud-Payload: ohne `currency` und `defaultTaxStatus`.
    profile: { payload: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Beispiel Betrieb GmbH' }, row_version: 1, updated_at: T0 },
    settings: null,
    customers: new Map(),
  };
}

function workspaceRow() {
  return { id: WS, name: 'Beispiel Betrieb GmbH', owner_user_id: USER, created_at: T0, updated_at: T0, version: cloud.workspaceVersion };
}
const member = { workspace_id: WS, user_id: USER, role: 'owner', status: 'active', created_at: T0, updated_at: T0 };

function registerCloud(): void {
  rpcStore.registerMockRpcHandler('ensure_personal_workspace', () => ({ workspace: workspaceRow(), member, created: false }));
  rpcStore.registerMockRpcHandler('pull_workspace_sync_state', () => ({
    workspace: workspaceRow(),
    members: [member],
    settings: cloud.settings ? { workspace_id: WS, ...cloud.settings } : null,
    vorgaenge: [],
    customers: [...cloud.customers.entries()].map(([id, row]) => ({
      workspace_id: WS,
      customer_id: id,
      payload: row.payload,
      row_version: row.row_version,
      deleted: false,
      deleted_at: null,
      updated_at: row.updated_at,
      updated_by: USER,
    })),
    setup: { workspace_id: WS, ...cloud.setup },
    company_profile: { workspace_id: WS, ...cloud.profile },
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
      // Wie der Server: Kennung aus `customer_id`, erwartete Version exakt prüfen.
      const id = String(payload.customer_id);
      const previous = cloud.customers.get(id);
      if (Number(args.p_row_version ?? 0) !== (previous?.row_version ?? 0)) {
        throw new Error('Versionskonflikt customer');
      }
      const next = (previous?.row_version ?? 0) + 1;
      cloud.customers.set(id, { payload, row_version: next, updated_at: now });
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

/** Ein Browser-Tab: frische Module, Anmelde-Start wie im Gate, gemeinsamer localStorage. */
async function openTab() {
  vi.resetModules();
  const bootstrap = await import('../storage/storageBootstrapService');
  const cloudBootstrap = await import('../workspace/workspaceCloudBootstrapService');
  const persistence = await import('../persistenceService');
  const customers = await import('../customerService');
  const syncUi = await import('./syncUiService');
  bootstrap.bootstrapBusinessState({ userId: USER });
  const result = await cloudBootstrap.bootstrapWorkspaceCloudSyncIfNeeded();
  expect(result.status).toBe('ready');
  // Nacharbeiten des Starts (Prüfsummen, Dateipflege) abwarten.
  await new Promise((resolve) => setTimeout(resolve, 30));
  return {
    persistence,
    syncUi,
    save(name: string) {
      return customers.createCustomer({ name, street: 'Beispielweg 1', zip: '20000', city: 'Beispielstadt' });
    },
  };
}

function generation(): number | undefined {
  const raw = localStorage.getItem(KEY);
  // 01A-FIX3 — maßgeblich ist die fachliche Revision (erstes Feld).
  const match = raw ? /^\{"businessRevision":(\d+)/.exec(raw) : null;
  return match ? Number(match[1]) : undefined;
}

function storedNames(): string[] {
  const stored = JSON.parse(localStorage.getItem(KEY)!) as { customers?: Array<{ name: string }> };
  return (stored.customers ?? []).map((customer) => customer.name);
}

// Jeder Tab lädt den vollständigen Modulgraphen neu — unter Last dauert das.
describe('SYNC-AUTOMATIK-01A-FIX2 — Anmelde-Start eines Tabs sperrt keinen anderen', { timeout: 60_000 }, () => {
  beforeEach(async () => {
    localStorage.clear();
    resetCloud();
    registerCloud();
    // Vorgeschichte: ein Gerät hat den Betrieb eingerichtet, einen Kunden angelegt und synchronisiert.
    const setupTab = await openTab();
    expect(setupTab.save('Beispiel Bestandskunde GmbH').success).toBe(true);
    await setupTab.syncUi.runSyncFromUi();
  }, 60_000);

  afterEach(() => {
    rpcStore.clearMockRpcHandlers();
    vi.resetModules();
  });

  it('1–5: Tab A geladen (Generation N), Tab B öffnet ohne Speichern → N bleibt, Tab A speichert', async () => {
    const tabA = await openTab();
    const n = generation();
    expect(n).toBeDefined();

    await openTab();
    expect(generation()).toBe(n);

    expect(tabA.save('Beispiel nach Öffnen von B GmbH').success).toBe(true);
    expect(tabA.persistence.isLocalStateStaleInThisTab()).toBe(false);
  });

  it('6–8: Tab B lädt neu (zweimal) ohne Änderung → N bleibt, Tab A speichert', async () => {
    const tabA = await openTab();
    const n = generation();
    await openTab();
    await openTab();
    await openTab();
    expect(generation()).toBe(n);
    expect(tabA.save('Beispiel nach Reload von B GmbH').success).toBe(true);
  });

  it('9–10: Bootstrap mit identischem fachlichem Inhalt (Profil in Cloud-Form) → N bleibt', async () => {
    const tabA = await openTab();
    const tabB = await openTab();
    const n = generation();
    const snapshot = tabB.persistence.buildPersistedStateSnapshot();
    const { currency: _currency, defaultTaxStatus: _taxStatus, ...cloudForm } = snapshot.companyProfile!;
    tabB.persistence.applyPersistedStateFromSync({ ...snapshot, companyProfile: cloudForm as never });
    expect(generation()).toBe(n);
    expect(tabA.save('Beispiel nach Bootstrap GmbH').success).toBe(true);
  });

  it('11–12: vollständiger Abgleich, der nur Serverversionen ändert → N bleibt', async () => {
    const tabA = await openTab();
    const tabB = await openTab();
    const n = generation();
    // Ein anderes Gerät hat denselben Inhalt erneut geschrieben: nur die Version steigt.
    for (const [id, row] of cloud.customers) cloud.customers.set(id, { ...row, row_version: row.row_version + 1 });
    await tabB.syncUi.runSyncFromUi();
    expect(generation()).toBe(n);
    expect(tabA.save('Beispiel nach Metadaten-Sync GmbH').success).toBe(true);
  });

  it('13–14: Vorgabewerte beim Laden gelten nicht als fachliche Änderung', () => {
    const base = {
      version: 6,
      setup: { ...DEFAULT_SETUP, companyName: 'Beispiel Betrieb GmbH', taxStatus: 'standard_19' },
      inboxItems: [],
      vorgaenge: [],
      tasks: [],
      documents: [],
    };
    const cloudForm = { ...base, companyProfile: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Beispiel Betrieb GmbH' } };
    const loadedForm = {
      ...base,
      companyProfile: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Beispiel Betrieb GmbH', currency: 'EUR', defaultTaxStatus: 'standard_19' },
    };
    expect(buildBusinessContentFingerprint(cloudForm)).toBe(buildBusinessContentFingerprint(loadedForm));
    // Ein abweichender, bewusst gesetzter Wert bleibt eine Änderung.
    const changed = { ...base, companyProfile: { ...loadedForm.companyProfile, defaultTaxStatus: 'standard_7' } };
    expect(buildBusinessContentFingerprint(changed)).not.toBe(buildBusinessContentFingerprint(loadedForm));
  });

  it('15–17: echter Save in Tab B → N+1, Tab A wird sicher blockiert', async () => {
    const tabA = await openTab();
    const tabB = await openTab();
    const n = generation()!;
    expect(tabB.save('Beispiel aus Tab B GmbH').success).toBe(true);
    expect(generation()).toBe(n + 1);

    const result = tabA.save('Beispiel veralteter Tab A GmbH');
    expect(result.success).toBe(false);
    expect(tabA.persistence.isLocalStateStaleInThisTab()).toBe(true);
    expect(storedNames()).toContain('Beispiel aus Tab B GmbH');
    expect(storedNames()).not.toContain('Beispiel veralteter Tab A GmbH');
  });

  it('18–19: echter fachlicher Cloud-Inhalt wird übernommen → Generation steigt, Tab A blockiert', async () => {
    const tabA = await openTab();
    const tabB = await openTab();
    const n = generation()!;
    for (const [id, row] of cloud.customers) {
      const inner = row.payload.payload as Record<string, unknown>;
      cloud.customers.set(id, { ...row, payload: { ...row.payload, payload: { ...inner, city: 'Neue Beispielstadt' } }, row_version: row.row_version + 1 });
    }
    await tabB.syncUi.runSyncFromUi();
    expect(generation()).toBe(n + 1);
    expect(tabA.save('Beispiel veraltet GmbH').success).toBe(false);
  });
});
