/**
 * FC01A-Nacharbeit — zwei Fehleinstufungen der Entwurfssynchronisation (CLOUD-SYNC S5),
 * gefunden in der echten lokalen App:
 *
 *  B1  Nach jeder erfolgreichen eigenen Freigabe zeigte der noch offene Editor kurz
 *      „Dieser Rechnungsentwurf wurde auf einem anderen Gerät bereits freigegeben."
 *      Ursache: Der Spiegel vermerkt den eigenen Abschluss, der Editor gleicht mit
 *      seinem Datensatz von vor der Freigabe (`active`) ab und hielt den eigenen
 *      Grabstein für ein Ende anderswo. Vertrag jetzt: Ein Grabstein mit genau der
 *      eigenen Rechnungskennung ist kein Konflikt; ein Ende anderswo bleibt sichtbar.
 *  B2  Ein Gerät, das einen Cloud-Entwurf fortsetzt und sofort ändert, sah einen
 *      Versionskonflikt „auf einem anderen Gerät geändert". Ursache: Der erste,
 *      unveränderte Stand (er setzt die Basis) wartete gebündelt und wurde von der
 *      schnellen Änderung ersetzt. Vertrag jetzt: Der erste Stand eines Entwurfs ohne
 *      Basis wird sofort abgeglichen; danach bündelt der Spiegel wie bisher.
 *
 * Neutrale Beispieldaten.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvoiceDraft } from '../../types/models';
import type { InvoiceDraftIdentity } from '../../types/invoiceDraftDurability';
import type { InvoiceDraftCloudCore, WorkspaceInvoiceDraftRow } from '../../types/invoiceDraftCloud';
import * as allowlist from '../sync/cloudSyncAllowlist';
import { mergeRemoteWorkspacePullIntoState } from '../workspace/workspaceProvisioningService';
import { applyStateToStores, buildPersistedStateSnapshot, persistAll } from '../persistenceService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from '../sync/syncOutboxService';
import { resetSyncChangeTrackerForTests } from '../sync/syncChangeTrackerService';
import { createSyncClient, resetSyncClientForTests } from '../sync/syncClientService';
import { resetStorageScopeForTests, setActiveStorageScope } from '../storage/storageScopeService';
import { testSetup } from '../../test/fixtures';
import { buildManualInvoiceDraft } from '../invoiceService';
import {
  beginInvoiceDraftFinalization,
  completeInvoiceDraftFinalization,
  createInvoiceDraftRecord,
  resetInvoiceDraftDurabilityDatabaseForTests,
  saveInvoiceDraftRecord,
} from './invoiceDraftDurabilityService';
import { stripInvoiceDraftForCloud } from './invoiceDraftCloudService';
import { getInvoiceDraftCloudEntity, resetInvoiceDraftCloudStore } from './invoiceDraftCloudStore';
import {
  applyLocalDraftCommitToMirror,
  flushInvoiceDraftCloudMirror,
  markInvoiceDraftCloudFromFinalizedRecord,
  noteInvoiceDraftCommitted,
  noteOwnInvoiceDraftFinalization,
  resetInvoiceDraftCloudBridgeForTests,
  resolveCloudDraftForEmptySlot,
} from './invoiceDraftCloudBridge';
import { useInvoiceDraftCloudState, type InvoiceDraftCloudState } from './useInvoiceDraftCloudState';
import type { InvoiceDraftDurabilitySession } from './useInvoiceDraftDurabilitySession';

const WS = 'ws-nacharbeit-fc01a';
const SCOPE = `workspace:${WS}`;
const DEVICE = 'device-nacharbeit-fc01a';
const UPDATED_AT = '2026-10-13T09:00:00.000Z';

function cloudFreigeben(): void {
  vi.spyOn(allowlist, 'isSupabaseSyncAllowed').mockImplementation(
    (type) => type === 'invoice_draft' || allowlist.SUPABASE_SYNC_ALLOWLIST.has(type),
  );
}

function freierEntwurf(overrides: Partial<InvoiceDraft> = {}): InvoiceDraft {
  const draft = buildManualInvoiceDraft(
    {
      customerId: 'cust-nach',
      billing: { name: 'Beispiel Kundschaft GmbH', contactPerson: '', street: 'Weg 1', zip: '33602', city: 'Bielefeld', email: '', phone: '' },
    },
    testSetup,
  );
  return {
    ...draft,
    id: 'draft-nach-1',
    positions: [{ id: 'manual-pos-1', description: 'Anfahrt', quantity: 1, unit: 'Pauschal', unitPrice: 45, billable: true }],
    introText: 'Einleitung A',
    ...overrides,
  };
}

function identity(draft: InvoiceDraft): InvoiceDraftIdentity {
  return { sourceScopeKey: SCOPE, workspaceId: WS, vorgangId: draft.vorgangId, invoiceType: draft.type, draftId: draft.id };
}

async function lokalAnlegen(draft: InvoiceDraft) {
  const created = await createInvoiceDraftRecord({ identity: identity(draft), draft });
  if (!created.ok) throw new Error(`anlegen: ${created.reason}`);
  return created.record;
}

async function lokalSpeichern(draft: InvoiceDraft, revision: number) {
  const saved = await saveInvoiceDraftRecord({ identity: identity(draft), draft, expectedRevision: revision });
  if (!saved.ok) throw new Error(`speichern: ${saved.reason}`);
  return saved.record;
}

function zeile(
  core: InvoiceDraftCloudCore | null,
  rowVersion: number,
  options: { id?: string; finalized?: string } = {},
): WorkspaceInvoiceDraftRow {
  return {
    workspace_id: WS,
    client_draft_id: options.id ?? core?.id ?? 'draft-nach-1',
    vorgang_id: null,
    invoice_type: 'rechnung',
    status: options.finalized ? 'finalized' : 'active',
    payload: options.finalized ? (undefined as unknown as Record<string, unknown>) : (JSON.parse(JSON.stringify(core)) as Record<string, unknown>),
    finalized_client_invoice_id: options.finalized ?? null,
    row_version: rowVersion,
    deleted: false,
    deleted_at: null,
    updated_at: UPDATED_AT,
  };
}

/** Ein Abzug wie in der App: anwenden, Baseline des Änderungsverfolgers setzen, Beobachter benachrichtigen. */
function abzug(rows: WorkspaceInvoiceDraftRow[]): void {
  const result = mergeRemoteWorkspacePullIntoState(buildPersistedStateSnapshot(), {
    workspace: null,
    members: [],
    settings: null,
    setupPayload: null,
    setupRowVersion: 0,
    setupUpdatedAt: null,
    companyProfilePayload: null,
    companyProfileRowVersion: 0,
    companyProfileUpdatedAt: null,
    vorgaenge: [],
    customers: [],
    invoiceDrafts: rows,
  } as unknown as Parameters<typeof mergeRemoteWorkspacePullIntoState>[1]);
  applyStateToStores(result.state);
  persistAll();
}

function entwurfsAuftraege() {
  return getSyncOutboxSnapshot().filter((entry) => entry.entityType === 'invoice_draft' && entry.status !== 'completed');
}

/** Der geöffnete Editor: sein Sitzungsdatensatz bleibt bis zum Seitenwechsel der Stand vor der Freigabe. */
function editorSitzung(record: Awaited<ReturnType<typeof lokalAnlegen>>, draft: InvoiceDraft): InvoiceDraftDurabilitySession {
  return {
    draft,
    record,
    status: 'saved',
    readOnly: false,
    blocked: false,
    restored: false,
    issue: null,
    mutateDraft: vi.fn(),
    flush: vi.fn(async () => ({ ok: true, outcome: 'no_changes' }) as never),
  };
}

const roots: Root[] = [];
let zustand: InvoiceDraftCloudState | null = null;

function Editor({ session }: { session: InvoiceDraftDurabilitySession }) {
  zustand = useInvoiceDraftCloudState({ session, onReload: () => undefined });
  return <div data-testid="editor" data-conflict={zustand.conflict?.kind ?? 'none'} />;
}

async function editorOeffnen(session: InvoiceDraftDurabilitySession): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    const root = createRoot(container);
    roots.push(root);
    root.render(<Editor session={session} />);
    await Promise.resolve();
  });
  return container;
}

async function ruhe(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** Die eigene Freigabe wie der Koordinator: begin (Kennung eingefroren), complete, Spiegelvermerk. */
async function eigeneFreigabe(draft: InvoiceDraft, revision: number, expectedDraftRowVersion: number, clientInvoiceId: string) {
  const begun = await beginInvoiceDraftFinalization({
    identity: identity(draft),
    expectedRevision: revision,
    clientInvoiceId,
    contentFingerprint: 'fp-nach',
    request: {
      workspaceId: WS,
      vorgangId: null,
      clientInvoiceId,
      clientDraftId: draft.id,
      expectedDraftRowVersion,
      invoice: { id: clientInvoiceId, type: 'rechnung' },
    },
    approvalContext: {},
  });
  if (!begun.ok) throw new Error(begun.reason);
  noteOwnInvoiceDraftFinalization(draft.id, clientInvoiceId);
  const done = await completeInvoiceDraftFinalization({
    identity: identity(draft),
    expectedRevision: begun.record.revision,
    clientInvoiceId,
    contentFingerprint: 'fp-nach',
    finalizedInvoiceId: clientInvoiceId,
    archiveWarning: false,
  });
  if (!done.ok) throw new Error(done.reason);
  return done.record;
}

beforeEach(async () => {
  localStorage.clear();
  resetStorageScopeForTests();
  setActiveStorageScope({ type: 'workspace', workspaceId: WS });
  resetSyncOutboxForTests([]);
  resetSyncChangeTrackerForTests();
  resetSyncClientForTests({ ...createSyncClient(), deviceId: DEVICE, workspaceId: WS, serverWorkspaceId: WS });
  resetInvoiceDraftCloudStore();
  resetInvoiceDraftCloudBridgeForTests();
  await resetInvoiceDraftDurabilityDatabaseForTests();
  persistAll();
  zustand = null;
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = '';
  resetInvoiceDraftCloudBridgeForTests();
  vi.restoreAllMocks();
});

describe('FC01A-Nacharbeit B1 — eigene Freigabe im offenen Editor', () => {
  async function offenerSynchronisierterEditor() {
    cloudFreigeben();
    const draft = freierEntwurf();
    const record = await lokalAnlegen(draft);
    abzug([zeile(stripInvoiceDraftForCloud(draft), 1)]);
    expect(applyLocalDraftCommitToMirror(record, draft)).toBe('in_sync');
    const container = await editorOeffnen(editorSitzung(record, draft));
    await ruhe();
    expect(zustand?.conflict).toBeNull();
    return { draft, record, container };
  }

  it('E1 — eigene Freigabe: kein „auf einem anderen Gerät bereits freigegeben", kein Konfliktvermerk, kein Sendeauftrag', async () => {
    const { draft, record, container } = await offenerSynchronisierterEditor();

    const finalized = await eigeneFreigabe(draft, record.revision, 1, 'inv-eigen');
    await act(async () => {
      markInvoiceDraftCloudFromFinalizedRecord(finalized);
    });
    await ruhe();

    expect(getInvoiceDraftCloudEntity(draft.id)).toMatchObject({ status: 'finalized', finalizedClientInvoiceId: 'inv-eigen', core: null });
    expect(zustand?.conflict, 'der eigene Abschluss ist kein Ende anderswo').toBeNull();
    expect(container.querySelector('[data-testid="editor"]')?.getAttribute('data-conflict')).toBe('none');
    expect(getInvoiceDraftCloudEntity(draft.id)?.conflict).toBeUndefined();
    persistAll();
    expect(entwurfsAuftraege()).toEqual([]);
  });

  it('E2 — anderswo freigegeben (Abzug bringt den Grabstein einer fremden Rechnung): der Konflikt bleibt sichtbar', async () => {
    const { draft, container } = await offenerSynchronisierterEditor();

    await act(async () => {
      abzug([zeile(null, 2, { id: draft.id, finalized: 'inv-fremd' })]);
    });
    await ruhe();

    expect(zustand?.conflict).toMatchObject({ kind: 'finalized', remote: { finalizedClientInvoiceId: 'inv-fremd' } });
    expect(container.querySelector('[data-testid="editor"]')?.getAttribute('data-conflict')).toBe('finalized');
  });

  it('E3 — eigene Freigabe begonnen, aber der Abzug bringt die Rechnung eines anderen Geräts: weiterhin Konflikt', async () => {
    const { draft } = await offenerSynchronisierterEditor();
    noteOwnInvoiceDraftFinalization(draft.id, 'inv-eigen');

    await act(async () => {
      abzug([zeile(null, 2, { id: draft.id, finalized: 'inv-fremd' })]);
    });
    await ruhe();

    expect(zustand?.conflict).toMatchObject({ kind: 'finalized', remote: { finalizedClientInvoiceId: 'inv-fremd' } });
  });

  it('E4 — Server festgeschrieben, lokaler Abschluss offen: der eigene Grabstein kommt per Abzug und bleibt kein Konflikt', async () => {
    const { draft } = await offenerSynchronisierterEditor();
    noteOwnInvoiceDraftFinalization(draft.id, 'inv-eigen');

    await act(async () => {
      abzug([zeile(null, 2, { id: draft.id, finalized: 'inv-eigen' })]);
    });
    await ruhe();

    expect(zustand?.conflict).toBeNull();
    expect(getInvoiceDraftCloudEntity(draft.id)?.conflict).toBeUndefined();
  });

  it('E5 — Bereichswechsel leert die vermerkten eigenen Freigaben (nichts Altes wirkt in einen neuen Spiegel)', async () => {
    const { draft } = await offenerSynchronisierterEditor();
    noteOwnInvoiceDraftFinalization(draft.id, 'inv-eigen');
    for (const root of roots.splice(0)) {
      await act(async () => {
        root.unmount();
      });
    }

    resetInvoiceDraftCloudStore();
    const record = await lokalSpeichern({ ...draft, introText: 'nach dem Wechsel' }, 1);
    abzug([zeile(null, 2, { id: draft.id, finalized: 'inv-eigen' })]);
    await editorOeffnen(editorSitzung(record, { ...draft, introText: 'nach dem Wechsel' }));
    await ruhe();

    expect(zustand?.conflict).toMatchObject({ kind: 'finalized' });
  });
});

describe('FC01A-Nacharbeit B2 — Cloud-Entwurf fortsetzen und sofort ändern', () => {
  it('S1 — Gerät B setzt fort und ändert sofort: kein Versionskonflikt, genau ein Sendeauftrag mit der Änderung', async () => {
    cloudFreigeben();
    const a = freierEntwurf();
    abzug([zeile(stripInvoiceDraftForCloud(a), 1)]);
    const b = resolveCloudDraftForEmptySlot(null, 'rechnung');
    expect(b?.id).toBe(a.id);

    // So meldet die Sitzung das Anlegen (`adopt`), dann folgt die schnelle erste Änderung.
    const record0 = await lokalAnlegen(b!);
    noteInvoiceDraftCommitted(record0, b!);
    expect(getInvoiceDraftCloudEntity(a.id)?.localLink, 'die Basis steht sofort fest').toBeDefined();
    persistAll();
    expect(entwurfsAuftraege(), 'der eben geladene Stand reist nicht zurück').toEqual([]);

    const geaendert = { ...b!, introText: 'Sofort geändert' };
    const record1 = await lokalSpeichern(geaendert, record0.revision);
    noteInvoiceDraftCommitted(record1, geaendert);
    expect(flushInvoiceDraftCloudMirror()).toEqual(['mirrored']);

    expect(getInvoiceDraftCloudEntity(a.id)?.conflict).toBeUndefined();
    expect(getInvoiceDraftCloudEntity(a.id)?.core?.introText).toBe('Sofort geändert');
    persistAll();
    expect(entwurfsAuftraege().map((entry) => [entry.entityId, entry.operation])).toEqual([[a.id, 'update']]);
  });

  it('S2 — neuer lokaler Entwurf (dem Spiegel unbekannt): weiterhin gebündelt, kein Sofortversand des leeren Stands', async () => {
    cloudFreigeben();
    const neu = freierEntwurf({ id: 'draft-nach-neu' });
    const record0 = await lokalAnlegen(neu);
    noteInvoiceDraftCommitted(record0, neu);
    const geaendert = { ...neu, introText: 'Erste Eingabe' };
    const record1 = await lokalSpeichern(geaendert, record0.revision);
    noteInvoiceDraftCommitted(record1, geaendert);
    expect(getInvoiceDraftCloudEntity(neu.id), 'vor dem Bündelungsende noch nichts gespiegelt').toBeNull();

    expect(flushInvoiceDraftCloudMirror()).toEqual(['created']);
    expect(getInvoiceDraftCloudEntity(neu.id)?.core?.introText).toBe('Erste Eingabe');
  });

  it('S3 — Spiegel ohne Basis und lokal abweichender Inhalt: weiterhin sichtbarer Konflikt, nie still überschrieben', async () => {
    cloudFreigeben();
    const a = freierEntwurf();
    abzug([zeile(stripInvoiceDraftForCloud(a), 1)]);
    const lokal = { ...a, introText: 'lokal anders' };
    const record = await lokalAnlegen(lokal);

    noteInvoiceDraftCommitted(record, lokal);

    expect(getInvoiceDraftCloudEntity(a.id)?.conflict).toMatchObject({ kind: 'version' });
    expect(getInvoiceDraftCloudEntity(a.id)?.core?.introText).toBe('Einleitung A');
  });
});
