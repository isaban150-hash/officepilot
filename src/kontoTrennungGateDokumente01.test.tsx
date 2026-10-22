/**
 * DOKUMENTE-01 N1 — Kontotrennung im realen Stapel AuthProvider → BusinessStateGate → App.
 *
 * WEISS-Befund: Nach Inhaber-Abmeldung und Mitglieds-Anmeldung im selben Browser
 * zeigte die App die Dokumente des Inhabers und reihte dessen Papierregister zum
 * Senden ein. Hier laufen Anmeldung, Abmeldung, Kontowechsel und Neuladen durch
 * die echten Komponenten; gestubbt sind nur die Supabase-Antworten. Jeder
 * Schreibaufruf scheitert wie in der Browserprüfung mit einem Netzfehler — der
 * Auftrag bleibt also offen und lässt sich über alle Wechsel verfolgen.
 *
 *   G1  Inhaber → Abmelden → Mitglied → Abmelden → Inhaber.
 *   G2  Direkter Kontowechsel ohne Abmelden (z. B. Anmeldung in einem anderen Tab).
 *   G3  Rollenentzug Admin → Mitglied und Rückgabe der Rolle, jeweils nach Neuladen.
 *   G4  Abzug meldet die Mitgliedschaft als entfernt: kein Betriebsbestand, kein Versand.
 *   G5  Nutzerbereich des Mitglieds mit Geschäftsdaten: bleibt liegen, wandert nicht in den Betrieb.
 *   G6  Echte Entfernung (Server verweigert den Abzug, legt wie seit 20261124 einen eigenen Betrieb an).
 *   G7  Ein Synchronisationslauf des Inhabers endet erst nach dem Wechsel: sein Ergebnis wird verworfen.
 *   G8  Rückkehr aus dem Seiten-Cache mit inzwischen anderem Konto: die Seite lädt neu.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { DEFAULT_SETUP } from './data/mockData';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { BusinessStateGate } from './components/system/BusinessStateGate';
import {
  getLastSuccessfulWorkspaceBootstrap,
  resetWorkspaceCloudBootstrapForTests,
} from './services/workspace/workspaceCloudBootstrapService';
import { getSyncCoordinator, resetSyncCoordinatorForTests } from './services/sync/syncCoordinator';
import { runSyncFromUi } from './services/sync/syncUiService';
import { pageCacheAccountDeps } from './services/auth/pageCacheAccountGuard';
import { getSyncOutboxSnapshot } from './services/sync/syncOutboxService';
import { getDocumentStoreSnapshot, hydrateDocumentStore } from './services/documentService';
import { createSeedState, persistAll, savePersistedStateToKey } from './services/persistenceService';
import { getPaperRegisterEntries, markDocumentPhysicallyFiled } from './services/officePilotMemoryService';
import { getActiveStorageAccount, getActiveStorageScope } from './services/storage/storageScopeService';
import { getWorkspaceStoreSnapshot } from './services/workspace/workspaceStore';
import { getCompanySession, recordDocumentContext } from './services/brain/companySessionService';
import { withNewEntitySync } from './services/sync/syncMetaService';
import { signOutUser } from './services/auth/supabaseAuthService';
import { resetTestStores } from './test/resetStores';
import { clearMockRpcHandlers, registerMockRpcHandler } from './test/mockProfileStore';
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  login,
  loginAsDefaultAdmin,
  registerAndApproveUser,
} from './test/authFixtures';
import { getMockCurrentSession } from './test/mockSupabaseAuth';
import type { CompanyDocument } from './types/models';
import type { WorkspaceMemberStatus, WorkspaceRole } from './types/workspace';

const WORKSPACE_ID = 'ws-n1-gate';
const COMPANY_NAME = 'Beispiel Haustechnik GmbH';
const T0 = '2026-10-01T08:00:00.000Z';
const DOC_ID = 'doc-inhaber-n1';
const DOC_TITEL = 'Lieferschein Baustoffe Oktober';
/** Testgerüst aus `registerPendingTestUser` — synthetisches Konto der Testumgebung. */
const MITGLIED_EMAIL = 'mitglied-n1@officetakt.test';
const MITGLIED_PASSWORT = 'TestPasswort1';

let inhaberId = '';
let mitgliedId = '';
/** Serverseitige Mitgliedschaften; der Abzug kann einen Status gezielt abweichend melden. */
const rollen = new Map<string, { role: WorkspaceRole; status: WorkspaceMemberStatus }>();
const abzugStatus = new Map<string, WorkspaceMemberStatus>();
const schreibLog: Array<{ name: string; konto: string; phase: string; args: string }> = [];
let phase = 'start';

function aktuellesKonto(): string {
  return getMockCurrentSession()?.user.id ?? 'abgemeldet';
}

function workspaceRow() {
  return {
    id: WORKSPACE_ID,
    name: COMPANY_NAME,
    owner_user_id: inhaberId,
    created_at: T0,
    updated_at: T0,
    version: 3,
  };
}

function memberRow(userId: string, status?: WorkspaceMemberStatus) {
  const rolle = rollen.get(userId);
  if (!rolle) throw new Error('Kein Zugriff auf diesen Betrieb');
  return {
    workspace_id: WORKSPACE_ID,
    user_id: userId,
    role: rolle.role,
    status: status ?? rolle.status,
    created_at: T0,
    updated_at: T0,
  };
}

/** Eigener Betrieb, den `ensure_personal_workspace` seit 20261124 einem Konto ohne aktive Mitgliedschaft anlegt. */
const EIGENER_BETRIEB = 'ws-n1-eigener-betrieb';
const eigeneBetriebe = new Set<string>();

function eigenerBetriebRow(userId: string) {
  return { id: EIGENER_BETRIEB, name: 'Eigener Betrieb', owner_user_id: userId, created_at: T0, updated_at: T0, version: 1 };
}

function eigenerBetriebMember(userId: string) {
  return { workspace_id: EIGENER_BETRIEB, user_id: userId, role: 'owner', status: 'active', created_at: T0, updated_at: T0 };
}

function registerHandlers(): void {
  registerMockRpcHandler('ensure_personal_workspace', () => {
    const konto = aktuellesKonto();
    // Wie 20261124: Inhaber → aktive Mitgliedschaft → sonst Neuanlage eines eigenen Betriebs.
    if (rollen.get(konto)?.status !== 'active') {
      const created = !eigeneBetriebe.has(konto);
      eigeneBetriebe.add(konto);
      return { workspace: eigenerBetriebRow(konto), member: eigenerBetriebMember(konto), created };
    }
    return { workspace: workspaceRow(), member: memberRow(konto), created: false };
  });
  registerMockRpcHandler('pull_workspace_sync_state', (args) => {
    const konto = aktuellesKonto();
    if (args.p_workspace_id === EIGENER_BETRIEB) {
      return { workspace: eigenerBetriebRow(konto), members: [eigenerBetriebMember(konto)], settings: null, vorgaenge: [], setup: null, company_profile: null };
    }
    // Wie der Server: ohne aktive Mitgliedschaft kein Abzug dieses Betriebs.
    if (rollen.get(konto)?.status !== 'active') throw new Error('Kein Zugriff auf Workspace');
    return {
    workspace: workspaceRow(),
    members: [...rollen.keys()].map((userId) => memberRow(userId, abzugStatus.get(userId))),
    settings: null,
    vorgaenge: [],
    setup: {
      workspace_id: WORKSPACE_ID,
      payload: { ...DEFAULT_SETUP, companyName: COMPANY_NAME, setupComplete: true, setupVersion: 1 },
      row_version: 7,
      updated_at: T0,
    },
    company_profile: {
      workspace_id: WORKSPACE_ID,
      payload: { ...DEFAULT_COMPANY_PROFILE, companyName: COMPANY_NAME },
      row_version: 7,
      updated_at: T0,
    },
    };
  });
  for (const name of [
    'pull_workspace_invoices',
    'pull_workspace_order_amendments',
    'pull_workspace_invoice_payments',
    'pull_workspace_documents',
    'pull_workspace_accounting_assignments',
    'pull_workspace_accounting_period_closures',
  ]) {
    registerMockRpcHandler(name, () => []);
  }
  registerMockRpcHandler('pull_workspace_intake_state', () => ({}));
  registerMockRpcHandler('pull_workspace_expenses', () => ({}));
  registerMockRpcHandler('get_workspace_invoice_number_format', () => ({}));
  for (const name of [
    'upsert_workspace_sync_entity',
    'upsert_workspace_intake_entity',
    'upsert_workspace_generated_invoice_document',
    'tombstone_workspace_document',
  ]) {
    registerMockRpcHandler(name, (args) => {
      schreibLog.push({ name, konto: aktuellesKonto(), phase, args: JSON.stringify(args ?? {}) });
      // Wie die blockierten Schreibaufrufe der Browserprüfung: der Auftrag bleibt offen.
      throw new Error('Failed to fetch');
    });
  }
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let navigateTo: ((to: string) => void) | null = null;

function NavigationBridge() {
  const navigate = useNavigate();
  navigateTo = (to: string) => navigate(to);
  return null;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mountApp(path = '/dokumente'): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <NavigationBridge />
        <AuthProvider>
          <BusinessStateGate>
            <App />
          </BusinessStateGate>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
  await settle();
  return host;
}

async function unmountApp(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  host?.remove();
  host = null;
  root = null;
  navigateTo = null;
}

/** Neuladen: Speicher bleibt, Laufzeitzustand und Einmalschutz beginnen neu. */
async function neuLaden(path = '/dokumente'): Promise<HTMLDivElement> {
  await unmountApp();
  resetTestStores();
  resetWorkspaceCloudBootstrapForTests();
  resetSyncCoordinatorForTests();
  return mountApp(path);
}

async function abmelden(): Promise<void> {
  await act(async () => {
    await signOutUser();
  });
  await settle();
}

async function anmelden(email: string, passwort: string): Promise<void> {
  await act(async () => {
    await login(email, passwort);
  });
  await settle();
}

/** Archiv neu öffnen, damit die Liste aus dem aktuellen Bestand rendert. */
async function zeigeArchiv(): Promise<void> {
  await act(async () => {
    navigateTo?.('/');
  });
  await settle();
  await act(async () => {
    navigateTo?.('/dokumente');
  });
  await settle();
}

function inhaberDokument(id = DOC_ID, title = DOC_TITEL): CompanyDocument {
  return withNewEntitySync(
    {
      id,
      title,
      category: 'sonstiges',
      issuer: 'Baustoffe Beispiel KG',
      recognizedText: `${title} — vertraulicher Inhalt`,
      issueDate: '2026-10-01',
      validUntil: null,
      digitalFolder: { id: 'lieferscheine', name: 'Lieferscheine', path: '/lieferscheine' },
      paperFolder: { folderId: 'lieferscheine', register: 'L', label: 'Lieferscheine' },
      tags: [],
      linkedCompany: 'Baustoffe Beispiel KG',
      linkedVorgang: null,
      archived: false,
      createdAt: T0,
    },
    'document',
  );
}

/**
 * Die Arbeit des angemeldeten Kontos: ein Archivdokument, dazu „Papieroriginal
 * abgeheftet" — derselbe Dienst wie die Schaltfläche der Ablagekarte — und der
 * Dokumentkontext der Firmensitzung.
 */
async function arbeitenAmDokument(id = DOC_ID, title = DOC_TITEL): Promise<void> {
  await act(async () => {
    hydrateDocumentStore([...getDocumentStoreSnapshot(), inhaberDokument(id, title)]);
    persistAll();
    markDocumentPhysicallyFiled(id, 'Inhaber', inhaberDokument(id, title));
    recordDocumentContext(id);
  });
  await settle();
}

function offeneAuftraegeZu(id: string): string[] {
  return getSyncOutboxSnapshot()
    .filter((entry) => entry.status !== 'completed' && entry.entityId.includes(id))
    .map((entry) => `${entry.entityType}:${entry.entityId}`)
    .sort();
}

function gespeicherterBestand(userId: string, access: 'full' | 'member') {
  const raw = localStorage.getItem(`officepilot-state:workspace:${WORKSPACE_ID}:account:${userId}:${access}`);
  if (!raw) return null;
  return JSON.parse(raw) as {
    documents?: Array<{ id: string }>;
    syncOutbox?: Array<{ entityType: string; entityId: string; status: string }>;
  };
}

function karte(container: HTMLElement, id = DOC_ID): Element | null {
  return container.querySelector(`[data-testid="document-summary-list-${id}"]`);
}

describe('DOKUMENTE-01 N1 — Kontotrennung im Gate', () => {
  beforeEach(async () => {
    rollen.clear();
    abzugStatus.clear();
    eigeneBetriebe.clear();
    schreibLog.length = 0;
    phase = 'start';
    clearMockRpcHandlers();
    registerHandlers();
    resetWorkspaceCloudBootstrapForTests();
    resetSyncCoordinatorForTests();
    // Mitglied registrieren (meldet es an), dann der Inhaber — er ist zu Testbeginn angemeldet.
    mitgliedId = (await registerAndApproveUser(MITGLIED_EMAIL)).id;
    await signOutUser();
    await loginAsDefaultAdmin();
    inhaberId = getMockCurrentSession()?.user.id ?? '';
    expect(inhaberId, 'Testanmeldung fehlgeschlagen').not.toBe('');
    expect(mitgliedId).not.toBe(inhaberId);
    rollen.set(inhaberId, { role: 'owner', status: 'active' });
    rollen.set(mitgliedId, { role: 'member', status: 'active' });
    localStorage.clear();
  });

  afterEach(async () => {
    await unmountApp();
    vi.restoreAllMocks();
    clearMockRpcHandlers();
    resetTestStores();
    resetWorkspaceCloudBootstrapForTests();
    localStorage.clear();
  });

  it('G1 Inhaber → Abmelden → Mitglied → Abmelden → Inhaber: nichts Fremdes, Ungesendetes bleibt', async () => {
    phase = 'inhaber';
    const container = await mountApp();
    expect(container.querySelector('[data-testid="app-shell"]'), 'App nicht geöffnet').not.toBeNull();
    expect(getActiveStorageAccount()).toEqual({ userId: inhaberId, access: 'full' });

    await arbeitenAmDokument();
    await zeigeArchiv();
    expect(karte(container), 'Gegenprobe: Inhaber sieht sein Dokument').not.toBeNull();
    const papierEintrag = getPaperRegisterEntries().find((entry) => entry.documentId === DOC_ID);
    expect(papierEintrag?.physicalFiled).toBe(true);
    const inhaberAuftraege = offeneAuftraegeZu(DOC_ID);
    expect(inhaberAuftraege, 'ungesendete Aktion fehlt').toContain(`paper_register_entry:${papierEintrag!.id}`);
    const inhaberBestandVorher = localStorage.getItem(
      `officepilot-state:workspace:${WORKSPACE_ID}:account:${inhaberId}:full`,
    );

    phase = 'abgemeldet';
    await abmelden();
    phase = 'mitglied';
    await anmelden(MITGLIED_EMAIL, MITGLIED_PASSWORT);
    expect(getActiveStorageAccount()).toEqual({ userId: mitgliedId, access: 'member' });
    await zeigeArchiv();
    expect(container.querySelector('[data-testid="app-shell"]')).not.toBeNull();
    expect(karte(container), 'fremdes Dokument im Archiv').toBeNull();
    expect(container.textContent ?? '').not.toContain(DOC_TITEL);
    expect(getDocumentStoreSnapshot().map((doc) => doc.id)).not.toContain(DOC_ID);
    expect(getPaperRegisterEntries(), 'fremde Papierregister-Einträge geladen').toEqual([]);
    expect(offeneAuftraegeZu(DOC_ID), 'fremde Aufträge in der Warteschlange').toEqual([]);
    expect(getCompanySession().currentDocumentId).toBeUndefined();
    expect(
      localStorage.getItem(`officepilot-state:workspace:${WORKSPACE_ID}:account:${inhaberId}:full`),
      'Bestand des Inhabers verändert',
    ).toBe(inhaberBestandVorher);
    expect(localStorage.getItem(`officepilot-state:workspace:${WORKSPACE_ID}`)).toBeNull();

    phase = 'abgemeldet-2';
    await abmelden();
    phase = 'inhaber-2';
    await anmelden(DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    expect(getActiveStorageAccount()).toEqual({ userId: inhaberId, access: 'full' });
    await zeigeArchiv();
    expect(karte(container), 'eigenes Dokument nach erneuter Anmeldung fehlt').not.toBeNull();
    expect(getPaperRegisterEntries().find((entry) => entry.documentId === DOC_ID)?.physicalFiled).toBe(true);
    expect(offeneAuftraegeZu(DOC_ID), 'ungesendete Aktion des Inhabers verloren').toEqual(inhaberAuftraege);

    const fremdeVersuche = schreibLog.filter((call) => call.args.includes(DOC_ID) && call.konto !== inhaberId);
    expect(fremdeVersuche, 'Aufträge des Inhabers unter fremdem Konto gesendet').toEqual([]);
    expect(schreibLog.filter((call) => call.phase === 'mitglied' && call.args.includes(DOC_ID))).toEqual([]);
  });

  it('G2 direkter Kontowechsel ohne Abmelden: Firmensitzung und Bindung des Inhabers sind verworfen', async () => {
    phase = 'inhaber';
    const container = await mountApp();
    await arbeitenAmDokument();
    expect(getCompanySession().currentDocumentTitle, 'Gegenprobe: Firmensitzung trägt das Dokument').toBe(DOC_TITEL);
    expect(getLastSuccessfulWorkspaceBootstrap()).toEqual({ userId: inhaberId, workspaceId: WORKSPACE_ID, access: 'full' });

    phase = 'mitglied';
    await anmelden(MITGLIED_EMAIL, MITGLIED_PASSWORT);
    expect(aktuellesKonto()).toBe(mitgliedId);
    expect(getActiveStorageAccount()).toEqual({ userId: mitgliedId, access: 'member' });
    expect(getCompanySession().currentDocumentId).toBeUndefined();
    expect(getCompanySession().currentDocumentTitle).toBeUndefined();
    expect(getLastSuccessfulWorkspaceBootstrap()).toEqual({
      userId: mitgliedId,
      workspaceId: WORKSPACE_ID,
      access: 'member',
    });
    await zeigeArchiv();
    expect(karte(container)).toBeNull();
    expect(container.textContent ?? '').not.toContain(DOC_TITEL);
    expect(getDocumentStoreSnapshot().map((doc) => doc.id)).not.toContain(DOC_ID);
    expect(offeneAuftraegeZu(DOC_ID)).toEqual([]);
    expect(schreibLog.filter((call) => call.phase === 'mitglied' && call.args.includes(DOC_ID))).toEqual([]);
  });

  it('G3 Rollenentzug Admin → Mitglied: Admin-Bestand ruht unangetastet; mit der Rolle kehrt er zurück', async () => {
    rollen.set(mitgliedId, { role: 'admin', status: 'active' });
    await signOutUser();
    await login(MITGLIED_EMAIL, MITGLIED_PASSWORT);

    phase = 'admin';
    let container = await mountApp();
    expect(getActiveStorageAccount()).toEqual({ userId: mitgliedId, access: 'full' });
    await arbeitenAmDokument('doc-admin-n1', 'Prüfbericht Lüftung');
    const adminAuftraege = offeneAuftraegeZu('doc-admin-n1');
    expect(adminAuftraege.length).toBeGreaterThan(0);
    const adminBestandVorher = localStorage.getItem(
      `officepilot-state:workspace:${WORKSPACE_ID}:account:${mitgliedId}:full`,
    );

    // Der Inhaber entzieht die Admin-Rolle; die App lädt neu.
    rollen.set(mitgliedId, { role: 'member', status: 'active' });
    phase = 'entzogen';
    container = await neuLaden();
    expect(getActiveStorageAccount()).toEqual({ userId: mitgliedId, access: 'member' });
    await zeigeArchiv();
    expect(karte(container, 'doc-admin-n1'), 'Admin-Bestand nach Rollenentzug sichtbar').toBeNull();
    expect(getDocumentStoreSnapshot().map((doc) => doc.id)).not.toContain('doc-admin-n1');
    expect(offeneAuftraegeZu('doc-admin-n1'), 'Admin-Aufträge laufen in Mitgliedssicht').toEqual([]);
    expect(schreibLog.filter((call) => call.phase === 'entzogen' && call.args.includes('doc-admin-n1'))).toEqual([]);
    expect(
      localStorage.getItem(`officepilot-state:workspace:${WORKSPACE_ID}:account:${mitgliedId}:full`),
      'Admin-Bestand verändert oder gelöscht',
    ).toBe(adminBestandVorher);

    // Die Rolle wird zurückgegeben: Bestand und offene Aufträge sind wieder da.
    rollen.set(mitgliedId, { role: 'admin', status: 'active' });
    phase = 'zurueck';
    container = await neuLaden();
    expect(getActiveStorageAccount()).toEqual({ userId: mitgliedId, access: 'full' });
    await zeigeArchiv();
    expect(karte(container, 'doc-admin-n1')).not.toBeNull();
    expect(offeneAuftraegeZu('doc-admin-n1')).toEqual(adminAuftraege);
  });

  it('G4 Abzug meldet die Mitgliedschaft als entfernt: kein Betriebsbestand, nichts Fremdes, kein Versand', async () => {
    phase = 'inhaber';
    await mountApp();
    await arbeitenAmDokument();
    const inhaberBestand = gespeicherterBestand(inhaberId, 'full');
    expect(inhaberBestand?.documents?.map((doc) => doc.id)).toContain(DOC_ID);
    const inhaberRaw = localStorage.getItem(`officepilot-state:workspace:${WORKSPACE_ID}:account:${inhaberId}:full`);

    phase = 'abgemeldet';
    await abmelden();
    abzugStatus.set(mitgliedId, 'removed');
    phase = 'entfernt';
    await anmelden(MITGLIED_EMAIL, MITGLIED_PASSWORT);

    expect(host?.querySelector('[data-testid="workspace-restore-failure"]'), 'App nicht gesperrt').not.toBeNull();
    expect(getActiveStorageScope().type, 'Bereichswechsel trotz entfernter Mitgliedschaft').not.toBe('workspace');
    expect(getActiveStorageAccount()).toBeNull();
    expect(gespeicherterBestand(mitgliedId, 'member')).toBeNull();
    expect(gespeicherterBestand(mitgliedId, 'full')).toBeNull();
    expect(getDocumentStoreSnapshot().map((doc) => doc.id)).not.toContain(DOC_ID);
    expect(offeneAuftraegeZu(DOC_ID)).toEqual([]);
    expect(host?.textContent ?? '').not.toContain(DOC_TITEL);
    expect(schreibLog.filter((call) => call.phase === 'entfernt')).toEqual([]);
    expect(localStorage.getItem(`officepilot-state:workspace:${WORKSPACE_ID}:account:${inhaberId}:full`)).toBe(
      inhaberRaw,
    );
  });

  it('G5 Nutzerbereich des Mitglieds mit Daten eines früheren eigenen Betriebs: bleibt liegen, kommt nicht in den Betrieb', async () => {
    await signOutUser();
    await login(MITGLIED_EMAIL, MITGLIED_PASSWORT);
    const nutzerKey = `officepilot-state:user:${mitgliedId}`;
    savePersistedStateToKey(
      { type: 'user', userId: mitgliedId },
      { ...createSeedState(), documents: [inhaberDokument('doc-frueherer-betrieb', 'Beleg des früheren Betriebs')] },
    );

    phase = 'mitglied';
    const container = await mountApp();
    expect(container.querySelector('[data-testid="app-shell"]'), 'App nicht geöffnet').not.toBeNull();
    expect(getActiveStorageAccount()).toEqual({ userId: mitgliedId, access: 'member' });
    await zeigeArchiv();
    expect(karte(container, 'doc-frueherer-betrieb')).toBeNull();
    expect(getDocumentStoreSnapshot().map((doc) => doc.id)).not.toContain('doc-frueherer-betrieb');
    expect(gespeicherterBestand(mitgliedId, 'member')?.documents?.map((doc) => doc.id) ?? []).not.toContain(
      'doc-frueherer-betrieb',
    );
    const nutzerbereich = JSON.parse(localStorage.getItem(nutzerKey) ?? '{}') as { documents?: Array<{ id: string }> };
    expect(nutzerbereich.documents?.map((doc) => doc.id), 'Nutzerbereich verloren').toEqual(['doc-frueherer-betrieb']);
    expect(schreibLog.filter((call) => call.args.includes('doc-frueherer-betrieb'))).toEqual([]);
  });

  it('G6 echte Entfernung: Arbeitgeberbetrieb weg, nichts von dort sichtbar oder gesendet, Mitgliedsbereich ruht', async () => {
    await signOutUser();
    await login(MITGLIED_EMAIL, MITGLIED_PASSWORT);
    phase = 'mitglied';
    let container = await mountApp();
    expect(getActiveStorageAccount()).toEqual({ userId: mitgliedId, access: 'member' });
    await arbeitenAmDokument('doc-mitglied-n1', 'Tankquittung Oktober');
    const mitgliedKey = `officepilot-state:workspace:${WORKSPACE_ID}:account:${mitgliedId}:member`;
    const mitgliedRaw = localStorage.getItem(mitgliedKey);
    expect(mitgliedRaw).not.toBeNull();

    // Der Inhaber entfernt das Mitglied; die App des Mitglieds lädt neu.
    rollen.set(mitgliedId, { role: 'member', status: 'removed' });
    phase = 'entfernt';
    container = await neuLaden('/');
    const arbeitgeberAktiv = getActiveStorageScope().type === 'workspace' && getWorkspaceStoreSnapshot()?.id === WORKSPACE_ID;
    expect(arbeitgeberAktiv, 'Arbeitgeberbetrieb nach Entfernung weiter aktiv').toBe(false);
    expect(getDocumentStoreSnapshot().map((doc) => doc.id)).not.toContain('doc-mitglied-n1');
    expect(container.textContent ?? '').not.toContain('Tankquittung Oktober');
    expect(localStorage.getItem(mitgliedKey), 'Mitgliedsbereich verändert oder gelöscht').toBe(mitgliedRaw);
    expect(schreibLog.filter((call) => call.phase === 'entfernt' && call.args.includes(WORKSPACE_ID))).toEqual([]);
    // Bestehendes Verhalten seit 20261124: der Server legt einen eigenen Betrieb an, die App öffnet dessen Einrichtung.
    expect(getWorkspaceStoreSnapshot()?.id).toBe(EIGENER_BETRIEB);
    expect(getActiveStorageAccount()).toEqual({ userId: mitgliedId, access: 'full' });
    expect(container.querySelector('[data-testid="first-run-wizard"]')).not.toBeNull();
  });

  it('G7 ein Synchronisationslauf des Inhabers, der erst nach dem Kontowechsel endet, landet nicht beim Mitglied', async () => {
    phase = 'inhaber';
    const container = await mountApp();
    await arbeitenAmDokument();
    expect(offeneAuftraegeZu(DOC_ID).length).toBeGreaterThan(0);

    // Der nächste Lauf des Inhabers arbeitet echt, hält aber vor dem Anwenden an, bis gewechselt ist.
    const coordinator = getSyncCoordinator();
    const original = coordinator.runSync.bind(coordinator);
    let freigeben: () => void = () => undefined;
    const sperre = new Promise<void>((resolve) => {
      freigeben = resolve;
    });
    vi.spyOn(coordinator, 'runSync').mockImplementationOnce(async (state) => {
      const ergebnis = await original(state);
      await sperre;
      return ergebnis;
    });
    let lauf: Promise<unknown> = Promise.resolve();
    await act(async () => {
      lauf = runSyncFromUi();
    });
    await settle();

    phase = 'abgemeldet';
    await abmelden();
    phase = 'mitglied';
    await anmelden(MITGLIED_EMAIL, MITGLIED_PASSWORT);
    await act(async () => {
      freigeben();
      await lauf;
    });
    await settle();
    await zeigeArchiv();

    expect(getActiveStorageAccount()).toEqual({ userId: mitgliedId, access: 'member' });
    expect(container.querySelector('[data-testid="app-shell"]')).not.toBeNull();
    expect(karte(container), 'Ergebnis des Inhaberlaufs beim Mitglied angewendet').toBeNull();
    expect(getDocumentStoreSnapshot().map((doc) => doc.id)).not.toContain(DOC_ID);
    expect(offeneAuftraegeZu(DOC_ID), 'Inhaberaufträge in der Mitgliedswarteschlange').toEqual([]);
    expect(gespeicherterBestand(mitgliedId, 'member')?.documents?.map((doc) => doc.id) ?? []).not.toContain(DOC_ID);
    expect(schreibLog.filter((call) => call.konto === mitgliedId && call.args.includes(DOC_ID))).toEqual([]);
  });

  it('G8 Rückkehr aus dem Seiten-Cache: mit inzwischen anderem oder keinem Konto lädt die Seite neu', async () => {
    phase = 'inhaber';
    await mountApp();
    await arbeitenAmDokument();
    const neuladen = vi.spyOn(pageCacheAccountDeps, 'reload').mockImplementation(() => undefined);
    const gespeichert = vi.spyOn(pageCacheAccountDeps, 'readStoredSessionUserId');
    const pageshow = async (persisted: boolean) => {
      const ereignis = new Event('pageshow');
      Object.defineProperty(ereignis, 'persisted', { value: persisted });
      await act(async () => {
        window.dispatchEvent(ereignis);
      });
      await settle();
    };

    // Gegenprobe: dieselbe Sitzung wie im Arbeitsspeicher → nichts geschieht.
    gespeichert.mockResolvedValue(inhaberId);
    await pageshow(true);
    expect(neuladen).not.toHaveBeenCalled();

    // Gespeichert ist inzwischen das Mitglied (Anmeldung auf einer späteren Seite desselben Tabs).
    gespeichert.mockResolvedValue(mitgliedId);
    await pageshow(true);
    expect(neuladen, 'Seite des Inhabers aus dem Seiten-Cache weiter angezeigt').toHaveBeenCalledTimes(1);

    // Ein gewöhnliches pageshow (nicht aus dem Cache) löst nie etwas aus.
    neuladen.mockClear();
    await pageshow(false);
    expect(neuladen).not.toHaveBeenCalled();

    // Niemand mehr angemeldet → ebenfalls neu laden.
    gespeichert.mockResolvedValue(null);
    await pageshow(true);
    expect(neuladen).toHaveBeenCalledTimes(1);
  });
});
