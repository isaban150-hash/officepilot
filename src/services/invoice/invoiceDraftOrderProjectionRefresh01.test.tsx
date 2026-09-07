/**
 * INVOICE-DRAFT-ORDER-PROJECTION-REFRESH-01B — der Entwurf holt die Fakten nach.
 *
 * Realbefund auf iPhone/Safari: Ein Rechnungsentwurf wurde geöffnet, bevor eine
 * ausgeführte Menge erfasst war. Danach wurden im Auftrag 20 Stunden als
 * ausgeführt gespeichert und über einen vollständigen Reload nachgewiesen — der
 * Entwurf zeigte beim erneuten Öffnen weiterhin „noch nicht erfasst" und 0.
 *
 * Ursache: Ein vorhandener dauerhafter Entwurf wird unverändert
 * wiederhergestellt; `buildInvoiceDraftForType` läuft dann nicht mehr. Die
 * Auftragsprojektionen im Entwurf — Planmenge, Ausführung, bereits
 * abgerechnet, Planrest — blieben auf dem Stand ihrer Erzeugung stehen.
 *
 * Der Unterschied, um den es geht: **Fakten des Auftrags werden nachgeholt, die
 * Entscheidung des Nutzers nicht angetastet.** Ohne nachweisbare Herkunft einer
 * Menge lässt sich nicht sagen, ob eine 0 bewusst gewählt wurde — also bleibt
 * sie.
 *
 * Synthetische Daten, kein Netz.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  useInvoiceDraftDurabilitySession,
  type InvoiceDraftDurabilitySession,
  type InvoiceDraftDurabilitySessionInput,
} from './useInvoiceDraftDurabilitySession';
import {
  loadInvoiceDraftRecordByLocator,
  resetInvoiceDraftDurabilityDatabaseForTests,
} from './invoiceDraftDurabilityService';
import { refreshDraftOrderProjection } from '../invoiceService';
import { buildInvoiceDraftForType, applyAllOpenPositionsToDraft } from '../invoiceService';
import {
  addInvoiceToVorgang,
  getVorgangById,
  hydrateVorgangStore,
  updateOrderPositionExecutedQuantity,
} from '../vorgangService';
import { setActiveStorageScope } from '../storage/storageScopeService';
import {
  createAbschlagInvoice,
  createOrderPosition,
  createTestVorgang,
  testSetup,
} from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import type { InvoiceDraft, InvoiceDraftLocator } from '../../types/models';

const WORKSPACE = 'ws-projection-refresh';
const SCOPE = `workspace:${WORKSPACE}`;
const VORGANG = 'v-test-1';

function locator(): InvoiceDraftLocator {
  return {
    sourceScopeKey: SCOPE,
    workspaceId: WORKSPACE,
    vorgangId: VORGANG,
    invoiceType: 'rechnung',
  } as InvoiceDraftLocator;
}

/** Der Realgerät-Auftrag: 20 Stunden geplant, Ausführung läuft, nichts erfasst. */
function seedVorgang(overrides: Parameters<typeof createOrderPosition>[0] = {}): void {
  hydrateVorgangStore([
    createTestVorgang({
      id: VORGANG,
      status: 'in_bearbeitung',
      executionStartedAt: '2026-09-01T08:00:00.000Z',
      orderPositions: [
        createOrderPosition({
          id: 'op-test-1',
          description: 'Montage- und Anpassungsarbeiten an Rohrleitungen',
          plannedQuantity: 20,
          unit: 'Stunden',
          unitPrice: 100,
          ...overrides,
        }),
      ],
    }),
  ]);
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: InvoiceDraftDurabilitySession | null = null;

function Probe({ input }: { input: InvoiceDraftDurabilitySessionInput }) {
  latest = useInvoiceDraftDurabilitySession(input);
  return null;
}

async function settle(rounds = 25): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Öffnet die Sitzung für denselben Locator — wie „Rechnung vorbereiten". */
async function openSession(): Promise<InvoiceDraftDurabilitySession> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const input: InvoiceDraftDurabilitySessionInput = {
    locator: locator(),
    createDraft: () => buildInvoiceDraftForType(VORGANG, testSetup, 'rechnung'),
  };
  await act(async () => {
    root!.render(<Probe input={input} />);
  });
  await settle();
  expect(latest, 'Sitzung fehlt').not.toBeNull();
  return latest as InvoiceDraftDurabilitySession;
}

async function closeSession(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  host?.remove();
  host = null;
  latest = null;
}

function firstPosition(draft: InvoiceDraft | null) {
  expect(draft, 'Entwurf fehlt').not.toBeNull();
  const position = draft!.positions.find((p) => p.orderPositionId === 'op-test-1');
  expect(position, 'Position fehlt im Entwurf').toBeDefined();
  return position!;
}

beforeEach(async () => {
  resetTestStores();
  localStorage.clear();
  setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE });
  await resetInvoiceDraftDurabilityDatabaseForTests();
  seedVorgang();
});

afterEach(async () => {
  await closeSession();
});

describe('INVOICE-DRAFT-ORDER-PROJECTION-REFRESH-01B — der Realgerät-Fall', () => {
  /*
   * R1/R2 — genau der beobachtete Ablauf: Entwurf zuerst, Ausführung danach.
   * Die Fakten müssen nachkommen, die gespeicherte Menge darf es nicht.
   */
  it('R1/R2: eine später erfasste Ausführung erscheint beim Wiederaufnehmen', async () => {
    let session = await openSession();
    expect(firstPosition(session.draft).executedQuantity).toBeUndefined();
    expect(firstPosition(session.draft).quantity).toBe(0);
    await closeSession();

    expect(updateOrderPositionExecutedQuantity(VORGANG, 'op-test-1', 20).success).toBe(true);

    session = await openSession();
    const position = firstPosition(session.draft);

    expect(position.executedQuantity, 'Der Entwurf blieb auf dem alten Stand').toBe(20);
    expect(position.plannedQuantity).toBe(20);
    expect(position.billedQuantity).toBe(0);
    expect(position.openQuantity).toBe(20);
    expect(position.quantity, 'Die gespeicherte Menge wurde still verändert').toBe(0);
  });

  /*
   * R3 — die Gegenprobe. Eine bewusst gesetzte Menge ist eine Entscheidung und
   * bleibt sie, auch wenn der Auftrag inzwischen etwas anderes nahelegt.
   */
  it('R3: eine bewusst gesetzte Menge überlebt den Refresh', async () => {
    let session = await openSession();
    const positionId = firstPosition(session.draft).id;
    await act(async () => {
      session.mutateDraft((prev) => ({
        ...prev,
        positions: prev.positions.map((p) => (p.id === positionId ? { ...p, quantity: 7 } : p)),
      }));
    });
    await settle();
    expect(firstPosition(latest!.draft).quantity).toBe(7);
    await closeSession();

    updateOrderPositionExecutedQuantity(VORGANG, 'op-test-1', 20);

    session = await openSession();
    expect(firstPosition(session.draft).quantity, 'Die Nutzereingabe ging verloren').toBe(7);
    expect(firstPosition(session.draft).executedQuantity).toBe(20);
  });

  it('R4/R5: ein zwischenzeitlich veränderter Abrechnungsstand wird nachgeführt', async () => {
    updateOrderPositionExecutedQuantity(VORGANG, 'op-test-1', 20);
    let session = await openSession();
    expect(firstPosition(session.draft).billedQuantity).toBe(0);
    expect(firstPosition(session.draft).openQuantity).toBe(20);
    await closeSession();

    // Eine andere Rechnung wurde inzwischen freigegeben.
    addInvoiceToVorgang(
      VORGANG,
      createAbschlagInvoice('op-test-1', 5, { id: 'inv-zwischen', number: 'AR-1' }),
    );

    session = await openSession();
    const position = firstPosition(session.draft);

    expect(position.billedQuantity, 'Der Abrechnungsstand blieb alt').toBe(5);
    expect(position.openQuantity, 'Der Planrest blieb alt').toBe(15);
    /*
     * Die Menge stammt aus der Vorbelegung bei der Erzeugung (20, weil die
     * Ausführung damals schon erfasst war). Der Refresh rechnet sie **nicht**
     * auf den neuen Ist-Rest von 15 herunter — auch eine vorbelegte Menge ist
     * ein Stand, den der Nutzer gesehen und stehen gelassen hat.
     */
    expect(position.quantity, 'Die gespeicherte Menge wurde nachgerechnet').toBe(20);
  });

  it('R6: eine geänderte Planmenge wird in der Projektion nachgeführt', async () => {
    let session = await openSession();
    expect(firstPosition(session.draft).plannedQuantity).toBe(20);
    await closeSession();

    seedVorgang({ plannedQuantity: 30 });

    session = await openSession();
    expect(firstPosition(session.draft).plannedQuantity).toBe(30);
    expect(firstPosition(session.draft).openQuantity).toBe(30);
  });

  /*
   * R7 — der Nutzen des Refresh: Die bestehende Sammelaktion arbeitet danach
   * mit den aktuellen Fakten, ohne dass eine neue Mengenregel entsteht.
   */
  it('R7: „Alle Positionen übernehmen" nutzt den aufgefrischten Stand', async () => {
    let session = await openSession();
    await closeSession();

    updateOrderPositionExecutedQuantity(VORGANG, 'op-test-1', 20);

    session = await openSession();
    const applied = applyAllOpenPositionsToDraft(session.draft!);

    expect(firstPosition(applied).quantity, 'Die Sammelaktion sah den alten Stand').toBe(20);
  });
});

describe('INVOICE-DRAFT-ORDER-PROJECTION-REFRESH-01B — was der Refresh nicht tut', () => {
  it('R8: eine entfallene Auftragsposition löscht die Entwurfsposition nicht', async () => {
    let session = await openSession();
    const before = firstPosition(session.draft);
    await closeSession();

    // Der Auftrag trägt diese Position nicht mehr.
    hydrateVorgangStore([
      createTestVorgang({
        id: VORGANG,
        status: 'in_bearbeitung',
        executionStartedAt: '2026-09-01T08:00:00.000Z',
        orderPositions: [createOrderPosition({ id: 'op-anders', plannedQuantity: 5 })],
      }),
    ]);

    session = await openSession();
    const after = firstPosition(session.draft);

    expect(after, 'Die Entwurfsposition wurde still entfernt').toEqual(before);
  });

  it('R9: eine neue Auftragsposition wird nicht still übernommen', async () => {
    let session = await openSession();
    expect(session.draft!.positions).toHaveLength(1);
    await closeSession();

    hydrateVorgangStore([
      createTestVorgang({
        id: VORGANG,
        status: 'in_bearbeitung',
        executionStartedAt: '2026-09-01T08:00:00.000Z',
        orderPositions: [
          createOrderPosition({ id: 'op-test-1', plannedQuantity: 20, unitPrice: 100 }),
          createOrderPosition({ id: 'op-neu', plannedQuantity: 8 }),
        ],
      }),
    ]);

    session = await openSession();
    expect(session.draft!.positions.map((p) => p.orderPositionId)).toEqual(['op-test-1']);
  });

  it('R10: ein unveränderter Auftrag lässt den Entwurf unverändert', async () => {
    let session = await openSession();
    const before = JSON.stringify(session.draft);
    await closeSession();

    session = await openSession();

    expect(JSON.stringify(session.draft)).toBe(before);
  });

  it('R11: der bestätigte Vertragssnapshot bleibt unangetastet', async () => {
    const snapshotBefore = JSON.stringify(getVorgangById(VORGANG)?.contractConfirmation ?? null);
    await openSession();
    await closeSession();
    updateOrderPositionExecutedQuantity(VORGANG, 'op-test-1', 20);
    await openSession();

    expect(JSON.stringify(getVorgangById(VORGANG)?.contractConfirmation ?? null)).toBe(
      snapshotBefore,
    );
  });
});

describe('INVOICE-DRAFT-ORDER-PROJECTION-REFRESH-01B — Haltbarkeit und §13b', () => {
  /*
   * R12 — der aufgefrischte Stand muss über den regulären Speicherweg gehen.
   * Ein Nur-im-Speicher-Fleck wäre beim nächsten Neuladen wieder verschwunden
   * und der Fehler damit nur verdeckt.
   */
  it('R12: der aufgefrischte Stand überlebt ein erneutes Laden', async () => {
    await openSession();
    await closeSession();
    updateOrderPositionExecutedQuantity(VORGANG, 'op-test-1', 20);

    await openSession();
    await closeSession();

    // Direkt aus der Entwurfsdatenbank, ohne die Auffrischung erneut auszulösen.
    const stored = await loadInvoiceDraftRecordByLocator(locator());
    expect(stored.ok, 'Entwurf nicht gespeichert').toBe(true);
    if (!stored.ok) return;

    expect(stored.draft.positions[0]?.executedQuantity, 'Nur im Arbeitsspeicher').toBe(20);
    expect(stored.draft.positions[0]?.quantity).toBe(0);
  });

  /*
   * R13 — keine Schleife: Ein zweites Öffnen ohne Auftragsänderung darf den
   * Entwurf nicht erneut schreiben, sonst liefe bei jedem Render eine Runde
   * aus Ändern, Speichern und Neuanzeigen.
   */
  it('R13: ein zweites Öffnen ohne Änderung schreibt nicht erneut', async () => {
    await openSession();
    await closeSession();
    updateOrderPositionExecutedQuantity(VORGANG, 'op-test-1', 20);

    await openSession();
    await closeSession();
    const afterRefresh = await loadInvoiceDraftRecordByLocator(locator());
    if (!afterRefresh.ok) throw new Error('Entwurf fehlt');
    const revision = afterRefresh.record.revision;

    await openSession();
    await closeSession();
    const again = await loadInvoiceDraftRecordByLocator(locator());
    if (!again.ok) throw new Error('Entwurf fehlt');

    expect(again.record.revision, 'Der Entwurf wurde ohne Anlass erneut geschrieben').toBe(
      revision,
    );
  });

  /*
   * R14/R15 — §13b ist an den Inhalt des Entwurfs gebunden (`d7228fb`). Wird
   * die Projektion tatsächlich anders, ändert sich der Hash und die alte
   * Bestätigung gilt nicht mehr. Bleibt alles gleich, darf sie nicht grundlos
   * verfallen. Die Bindung selbst wurde nicht angetastet — geprüft wird, dass
   * der Refresh sie richtig auslöst bzw. in Ruhe lässt.
   */
  it('R14: eine tatsächliche Auffrischung verändert den Entwurfshash', async () => {
    await openSession();
    await closeSession();
    const before = await loadInvoiceDraftRecordByLocator(locator());
    if (!before.ok) throw new Error('Entwurf fehlt');

    updateOrderPositionExecutedQuantity(VORGANG, 'op-test-1', 20);
    await openSession();
    await closeSession();

    const after = await loadInvoiceDraftRecordByLocator(locator());
    if (!after.ok) throw new Error('Entwurf fehlt');
    expect(after.record.draftSha256, 'Der Hash blieb gleich trotz neuer Fakten').not.toBe(
      before.record.draftSha256,
    );
  });

  it('R15: ohne Auftragsänderung bleibt der Entwurfshash gleich', async () => {
    await openSession();
    await closeSession();
    const before = await loadInvoiceDraftRecordByLocator(locator());
    if (!before.ok) throw new Error('Entwurf fehlt');

    await openSession();
    await closeSession();

    const after = await loadInvoiceDraftRecordByLocator(locator());
    if (!after.ok) throw new Error('Entwurf fehlt');
    expect(after.record.draftSha256, 'Der Hash änderte sich ohne Anlass').toBe(
      before.record.draftSha256,
    );
  });
});

/*
 * Der Kern als reine Funktion — hier lässt sich jede Regel einzeln zeigen,
 * ohne Sitzung, Speicher und Rendern dazwischen.
 */
describe('INVOICE-DRAFT-ORDER-PROJECTION-REFRESH-01B — refreshDraftOrderProjection', () => {
  function draftWithStaleProjection(): InvoiceDraft {
    const draft = buildInvoiceDraftForType(VORGANG, testSetup, 'rechnung')!;
    return {
      ...draft,
      positions: draft.positions.map((p) => ({
        ...p,
        plannedQuantity: 1,
        executedQuantity: undefined,
        billedQuantity: 99,
        openQuantity: 1,
        quantity: 3,
      })),
    };
  }

  it('P1: nur die Projektionsfelder werden aufgefrischt', () => {
    updateOrderPositionExecutedQuantity(VORGANG, 'op-test-1', 20);
    const stale = draftWithStaleProjection();

    const result = refreshDraftOrderProjection(stale, getVorgangById(VORGANG)!);

    expect(result.changed).toBe(true);
    const position = result.draft.positions[0]!;
    expect(position.plannedQuantity).toBe(20);
    expect(position.executedQuantity).toBe(20);
    expect(position.billedQuantity).toBe(0);
    expect(position.openQuantity).toBe(20);
    expect(position.quantity, 'Die Menge wurde angetastet').toBe(3);
    expect(position.unitPrice).toBe(stale.positions[0]!.unitPrice);
    expect(position.description).toBe(stale.positions[0]!.description);
    expect(position.billable).toBe(stale.positions[0]!.billable);
  });

  it('P2: nichts ausserhalb der Positionen wird verändert', () => {
    updateOrderPositionExecutedQuantity(VORGANG, 'op-test-1', 20);
    const stale = draftWithStaleProjection();

    const { draft } = refreshDraftOrderProjection(stale, getVorgangById(VORGANG)!);

    expect({ ...draft, positions: [] }).toEqual({ ...stale, positions: [] });
  });

  it('P3: ein bereits aktueller Entwurf meldet keine Änderung', () => {
    const draft = buildInvoiceDraftForType(VORGANG, testSetup, 'rechnung')!;

    const result = refreshDraftOrderProjection(draft, getVorgangById(VORGANG)!);

    expect(result.changed, 'Unnötige Änderung gemeldet').toBe(false);
    expect(result.draft).toEqual(draft);
  });

  it('P4: ohne erfasste Ausführung bleibt das Feld leer, statt auf den Plan zu fallen', () => {
    const draft = buildInvoiceDraftForType(VORGANG, testSetup, 'rechnung')!;
    const stale = {
      ...draft,
      positions: draft.positions.map((p) => ({ ...p, executedQuantity: 5 })),
    };

    const { draft: refreshed } = refreshDraftOrderProjection(stale, getVorgangById(VORGANG)!);

    expect(refreshed.positions[0]!.executedQuantity).toBeUndefined();
  });
});
