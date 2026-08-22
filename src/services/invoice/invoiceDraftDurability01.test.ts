/**
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P1 — lokaler Kern für
 * unfertige Rechnungsentwürfe.
 *
 * Ausschließlich synthetische, neutrale Daten. Keine reale Firma, kein realer
 * Vorgang, keine echte Workspace-Kennung.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginInvoiceDraftFinalization,
  buildInvoiceDraftRecordKey,
  completeInvoiceDraftFinalization,
  createInvoiceDraftRecord,
  deleteInvoiceDraftRecord,
  INVOICE_DRAFT_DB_VERSION,
  loadInvoiceDraftFinalizationPreparation,
  loadInvoiceDraftRecord,
  loadInvoiceDraftRecordByLocator,
  resetInvoiceDraftDurabilityDatabaseForTests,
  resolveInvoiceDraftFinalizationToExisting,
  saveInvoiceDraftRecord,
} from './invoiceDraftDurabilityService';
import { computeBufferContentHash } from '../documentFileHashService';
import {
  INVOICE_DRAFT_FORMAT_VERSION,
  INVOICE_DRAFT_PREPARATION_FORMAT_VERSION,
  INVOICE_DRAFT_PREPARATION_KIND,
  INVOICE_DRAFT_RECORD_KIND,
  type InvoiceDraftFinalizationPreparation,
  type InvoiceDraftFinalizationRequest,
  type InvoiceDraftIdentity,
  type InvoiceDraftLocator,
  type InvoiceDraftRecord,
  type ResolveInvoiceDraftFinalizationToExistingInput,
} from '../../types/invoiceDraftDurability';
import type { InvoiceDraft, InvoiceDraftPosition } from '../../types/models';

/**
 * 01P4A1 — steuerbarer Hash-Dienst. Ohne `override` bleibt das echte
 * Verhalten unverändert; mit `override` liefert er ohne Wurf einen formal
 * ungültigen Wert.
 */
const hashState = vi.hoisted(() => ({ override: null as string | null }));

vi.mock('../documentFileHashService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../documentFileHashService')>();
  return {
    ...actual,
    computeBufferContentHash: async (bytes: Uint8Array | ArrayBuffer): Promise<string> =>
      hashState.override === null ? actual.computeBufferContentHash(bytes) : hashState.override,
  };
});

const SCOPE_A = 'workspace:ws-entwurf-a';
const SCOPE_B = 'workspace:ws-entwurf-b';
const WORKSPACE_A = 'ws-entwurf-a';
const WORKSPACE_B = 'ws-entwurf-b';
const VORGANG_A = 'vg-1001';
const VORGANG_B = 'vg-1002';
const DRAFT_A = 'draft-fest-0001';
const NOW = '2026-08-20T12:00:00.000Z';
const LATER = '2026-08-20T12:05:00.000Z';

/** Ein langer, neutraler Text — er darf niemals gekürzt werden. */
const LONG_TEXT = `Hinweis ${'Beispieltext '.repeat(40)}Ende`;

function buildPosition(index: number): InvoiceDraftPosition {
  return {
    id: `pos-${index}`,
    orderPositionId: `op-${index}`,
    description: `Beispielposition ${index} — ${LONG_TEXT}`,
    plannedQuantity: 10 + index,
    executedQuantity: 5 + index,
    billedQuantity: index,
    openQuantity: 10,
    quantity: 3 + index,
    unit: 'stk' as InvoiceDraftPosition['unit'],
    unitLabel: 'Stück',
    unitPrice: 12.5 + index,
    billable: true,
  };
}

function buildDraft(overrides: Partial<InvoiceDraft> = {}): InvoiceDraft {
  return {
    id: DRAFT_A,
    vorgangId: VORGANG_A,
    vorgangTitle: 'Beispielvorgang',
    customer: 'Beispiel Kundschaft GmbH',
    baustelle: 'Musterweg 1',
    type: 'rechnung',
    taxStatus: 'standard_19',
    materialSource: 'betrieb',
    positions: [buildPosition(1), buildPosition(2), buildPosition(3)],
    issueDate: '2026-08-20',
    servicePeriodFrom: '2026-08-01',
    servicePeriodTo: '2026-08-19',
    paymentDueDate: '2026-09-03',
    paymentTermsText: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
    skontoText: '',
    customerBilling: {
      name: 'Beispiel Kundschaft GmbH',
      contactPerson: 'A. Beispiel',
      street: 'Musterweg 1',
      zip: '12345',
      city: 'Beispielstadt',
      email: 'kontakt@beispiel.example',
      phone: '030 0000000',
    },
    companySnapshot: {
      companyName: 'Beispiel Betrieb GmbH',
      legalForm: 'GmbH',
      street: 'Werkstraße 2',
      zip: '54321',
      city: 'Betriebsstadt',
      country: 'Deutschland',
      contactPerson: 'B. Beispiel',
      phone: '030 1111111',
      email: 'info@betrieb.example',
      website: '',
      taxNumber: '11/222/33333',
      vatId: 'DE000000000',
      bankName: 'Beispielbank',
      iban: 'DE00000000000000000000',
      bic: 'BEISPIELXXX',
      defaultPaymentDays: 14,
      defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
      defaultSkonto: '',
      invoiceFooterNotes: LONG_TEXT,
    } as InvoiceDraft['companySnapshot'],
    legalNotices: [LONG_TEXT],
    previousAbschlagDeductions: [],
    invoiceNumberPreview: 'Vorschau',
    introText: LONG_TEXT,
    closingText: LONG_TEXT,
    ...overrides,
  } as InvoiceDraft;
}

function identity(overrides: Partial<InvoiceDraftIdentity> = {}): InvoiceDraftIdentity {
  return {
    sourceScopeKey: SCOPE_A,
    workspaceId: WORKSPACE_A,
    vorgangId: VORGANG_A,
    invoiceType: 'rechnung',
    draftId: DRAFT_A,
    ...overrides,
  };
}

function locator(overrides: Partial<InvoiceDraftLocator> = {}): InvoiceDraftLocator {
  return {
    sourceScopeKey: SCOPE_A,
    workspaceId: WORKSPACE_A,
    vorgangId: VORGANG_A,
    invoiceType: 'rechnung',
    ...overrides,
  };
}

/** Öffnet die Datenbank von außen — wie ein defekter oder fremder Schreiber. */
async function mutateStoredRecord(
  change: (record: InvoiceDraftRecord) => void | Promise<void>,
): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('officepilot-invoice-drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const storeName = db.objectStoreNames[0]!;
  const key = buildInvoiceDraftRecordKey({
    sourceScopeKey: SCOPE_A,
    vorgangId: VORGANG_A,
    invoiceType: 'rechnung',
  });
  try {
    const current = await new Promise<InvoiceDraftRecord>((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const request = transaction.objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result as InvoiceDraftRecord);
      transaction.onerror = () => reject(transaction.error);
    });
    await change(current);
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).put(current);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    // Eine offene Verbindung würde jedes spätere deleteDatabase blockieren.
    db.close();
  }
}

async function seedRecord(): Promise<void> {
  const created = await createInvoiceDraftRecord({
    identity: identity(),
    draft: buildDraft(),
    now: NOW,
  });
  expect(created.ok, `Anlegen fehlgeschlagen: ${JSON.stringify(created)}`).toBe(true);
}

/** Liest den gespeicherten Datensatz roh — auch einen manipulierten. */
async function peekStoredRecord(): Promise<InvoiceDraftRecord | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('officepilot-invoice-drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const storeName = db.objectStoreNames[0]!;
  const key = buildInvoiceDraftRecordKey({
    sourceScopeKey: SCOPE_A,
    vorgangId: VORGANG_A,
    invoiceType: 'rechnung',
  });
  try {
    return await new Promise<InvoiceDraftRecord | undefined>((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const request = transaction.objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result as InvoiceDraftRecord | undefined);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Zerstört gezielt die Kontrolllesung **nach** dem Commit: jede Schreib-
 * transaktion läuft ungestört durch, erst die erste lesende Abfrage danach
 * wirft. Damit ist der Zeitpunkt eindeutig — unabhängig davon, wie viele
 * Vorprüfungen eine Operation vorher ausführt.
 */
function failReadAfterCommit(): { restore: () => void } {
  let written = false;
  const originalGet = IDBObjectStore.prototype.get;
  const originalPut = IDBObjectStore.prototype.put;
  const put = vi
    .spyOn(IDBObjectStore.prototype, 'put')
    .mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      written = true;
      return originalPut.call(this, value, key);
    });
  const get = vi
    .spyOn(IDBObjectStore.prototype, 'get')
    .mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
      if (written) throw new Error('simulierter Nachprüfungsfehler');
      return originalGet.call(this, key);
    });
  return {
    restore: () => {
      get.mockRestore();
      put.mockRestore();
    },
  };
}

beforeEach(async () => {
  hashState.override = null;
  await resetInvoiceDraftDurabilityDatabaseForTests();
});

afterEach(async () => {
  hashState.override = null;
  vi.restoreAllMocks();
  await resetInvoiceDraftDurabilityDatabaseForTests();
});

describe('01P1 — lokaler Rechnungsentwurfskern', () => {
  it('K1: der recordKey ist deterministisch und trennt Scope, Vorgang und Rechnungsart', () => {
    const base = { sourceScopeKey: SCOPE_A, vorgangId: VORGANG_A, invoiceType: 'rechnung' } as const;
    const key = buildInvoiceDraftRecordKey(base);

    expect(key.length).toBeGreaterThan(0);
    expect(buildInvoiceDraftRecordKey({ ...base })).toBe(key);

    const others = [
      buildInvoiceDraftRecordKey({ ...base, sourceScopeKey: SCOPE_B }),
      buildInvoiceDraftRecordKey({ ...base, vorgangId: VORGANG_B }),
      buildInvoiceDraftRecordKey({ ...base, invoiceType: 'abschlag' }),
    ];
    expect(new Set([key, ...others]).size).toBe(4);

    // Mehrdeutige Verkettung ausgeschlossen: ein Trennzeichen im Wert darf
    // niemals denselben Schlüssel wie eine andere Feldaufteilung erzeugen.
    const tricky = buildInvoiceDraftRecordKey({
      sourceScopeKey: 'workspace:a',
      vorgangId: 'b:c',
      invoiceType: 'rechnung',
    });
    const trickyOther = buildInvoiceDraftRecordKey({
      sourceScopeKey: 'workspace:a:b',
      vorgangId: 'c',
      invoiceType: 'rechnung',
    });
    expect(tricky).not.toBe(trickyOther);
  });

  it('K2: ein Datensatz wird vollständig geschrieben und geprüft zurückgelesen', async () => {
    const draft = buildDraft();
    const created = await createInvoiceDraftRecord({ identity: identity(), draft, now: NOW });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) return;

    expect(created.record.kind).toBe(INVOICE_DRAFT_RECORD_KIND);
    expect(created.record.formatVersion).toBe(INVOICE_DRAFT_FORMAT_VERSION);
    expect(created.record.status).toBe('active');
    expect(created.record.revision).toBe(1);
    expect(created.record.createdAt).toBe(NOW);
    expect(created.record.updatedAt).toBe(NOW);
    expect(created.record.recordKey).toBe(
      buildInvoiceDraftRecordKey({
        sourceScopeKey: SCOPE_A,
        vorgangId: VORGANG_A,
        invoiceType: 'rechnung',
      }),
    );
    expect(created.record.draftSha256).toBe(
      await computeBufferContentHash(new TextEncoder().encode(created.record.draftRawJson)),
    );

    const loaded = await loadInvoiceDraftRecord(identity());
    expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
    if (!loaded.ok) return;

    // Vollständigkeit: Positionen, Rechnungsempfänger und Firmenschnappschuss.
    expect(loaded.draft.positions.length).toBe(3);
    expect(loaded.draft.positions[0]?.description).toBe(draft.positions[0]?.description);
    expect(loaded.draft.customerBilling).toEqual(draft.customerBilling);
    expect(loaded.draft.companySnapshot).toEqual(draft.companySnapshot);
    expect(loaded.draft.introText).toBe(LONG_TEXT);
    expect(loaded.draft.legalNotices[0]).toBe(LONG_TEXT);
    expect(loaded.draft).toEqual(draft);
  });

  it('K3: die draftId bleibt beim Laden unverändert und der Eingabeentwurf wird nicht verändert', async () => {
    const draft = buildDraft();
    const snapshot = JSON.stringify(draft);
    await createInvoiceDraftRecord({ identity: identity(), draft, now: NOW });

    // Der übergebene Entwurf darf nicht mutiert worden sein.
    expect(JSON.stringify(draft)).toBe(snapshot);

    const first = await loadInvoiceDraftRecord(identity());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.draft.id).toBe(DRAFT_A);
    expect(first.record.draftId).toBe(DRAFT_A);

    // Ein verändertes Ergebnis darf den gespeicherten Stand nicht berühren.
    first.draft.positions[0]!.quantity = 999;
    first.draft.introText = 'verändert';

    const second = await loadInvoiceDraftRecord(identity());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.draft.id).toBe(DRAFT_A);
    expect(second.draft.positions[0]?.quantity).toBe(draft.positions[0]?.quantity);
    expect(second.draft.introText).toBe(LONG_TEXT);
  });

  it('K4: eine Workspace- oder Scope-Abweichung wird abgelehnt', async () => {
    await seedRecord();

    const otherScope = await loadInvoiceDraftRecord(identity({ sourceScopeKey: SCOPE_B }));
    expect(otherScope.ok).toBe(false);
    if (!otherScope.ok) expect(['not_found', 'invalid_identity']).toContain(otherScope.reason);

    // Ein in sich stimmiger fremder Bereich findet schlicht nichts.
    const foreignConsistent = await loadInvoiceDraftRecord(
      identity({ sourceScopeKey: SCOPE_B, workspaceId: WORKSPACE_B }),
    );
    expect(foreignConsistent.ok).toBe(false);
    if (!foreignConsistent.ok) expect(foreignConsistent.reason).toBe('not_found');

    /**
     * Scope A mit Workspace B ist seit 01P1A bereits als Identität
     * widersprüchlich und wird deshalb noch früher abgelehnt. Die Zusicherung
     * bleibt dieselbe — ein fremder Workspace liest und schreibt nie —, sie
     * greift nur strenger.
     */
    const otherWorkspace = await loadInvoiceDraftRecord(identity({ workspaceId: WORKSPACE_B }));
    expect(otherWorkspace.ok).toBe(false);
    if (!otherWorkspace.ok) {
      expect(['identity_mismatch', 'invalid_identity']).toContain(otherWorkspace.reason);
    }

    // Auch Schreiben und Löschen greifen nicht auf den fremden Bestand durch.
    const save = await saveInvoiceDraftRecord({
      identity: identity({ workspaceId: WORKSPACE_B }),
      draft: buildDraft(),
      expectedRevision: 1,
      now: LATER,
    });
    expect(save.ok).toBe(false);
    if (!save.ok) expect(['identity_mismatch', 'invalid_identity']).toContain(save.reason);

    const still = await loadInvoiceDraftRecord(identity());
    expect(still.ok).toBe(true);
    if (still.ok) expect(still.record.revision).toBe(1);
  });

  it('K5: Vorgang-, Rechnungsart- oder draftId-Abweichung wird abgelehnt', async () => {
    await seedRecord();

    const otherVorgang = await loadInvoiceDraftRecord(identity({ vorgangId: VORGANG_B }));
    expect(otherVorgang.ok).toBe(false);
    if (!otherVorgang.ok) expect(otherVorgang.reason).toBe('not_found');

    const otherType = await loadInvoiceDraftRecord(identity({ invoiceType: 'abschlag' }));
    expect(otherType.ok).toBe(false);
    if (!otherType.ok) expect(otherType.reason).toBe('not_found');

    const otherDraftId = await loadInvoiceDraftRecord(identity({ draftId: 'draft-fremd' }));
    expect(otherDraftId.ok).toBe(false);
    if (!otherDraftId.ok) expect(otherDraftId.reason).toBe('identity_mismatch');

    const save = await saveInvoiceDraftRecord({
      identity: identity({ draftId: 'draft-fremd' }),
      draft: buildDraft({ id: 'draft-fremd' }),
      expectedRevision: 1,
      now: LATER,
    });
    expect(save.ok).toBe(false);
    if (!save.ok) expect(save.reason).toBe('identity_mismatch');
  });

  it('K6: ein Save mit korrekter Revision erhöht sie exakt einmal', async () => {
    await seedRecord();

    const changed = buildDraft({ introText: 'Zweiter Stand' });
    const saved = await saveInvoiceDraftRecord({
      identity: identity(),
      draft: changed,
      expectedRevision: 1,
      now: LATER,
    });
    expect(saved.ok, JSON.stringify(saved)).toBe(true);
    if (!saved.ok) return;

    expect(saved.record.revision).toBe(2);
    expect(saved.record.createdAt).toBe(NOW);
    expect(saved.record.updatedAt).toBe(LATER);
    expect(saved.record.draftId).toBe(DRAFT_A);

    const loaded = await loadInvoiceDraftRecord(identity());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.record.revision).toBe(2);
    expect(loaded.draft.introText).toBe('Zweiter Stand');
  });

  it('K7: ein Save mit veralteter Revision liefert conflict und ändert nichts', async () => {
    await seedRecord();
    await saveInvoiceDraftRecord({
      identity: identity(),
      draft: buildDraft({ introText: 'Zweiter Stand' }),
      expectedRevision: 1,
      now: LATER,
    });

    const stale = await saveInvoiceDraftRecord({
      identity: identity(),
      draft: buildDraft({ introText: 'Veralteter Stand' }),
      expectedRevision: 1,
      now: LATER,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.reason).toBe('conflict');
      expect(stale.currentRevision).toBe(2);
    }

    const loaded = await loadInvoiceDraftRecord(identity());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.record.revision).toBe(2);
    expect(loaded.draft.introText).toBe('Zweiter Stand');
  });

  it('K8: zwei parallele Saves mit derselben Revision — genau einer gewinnt', async () => {
    await seedRecord();

    const [first, second] = await Promise.all([
      saveInvoiceDraftRecord({
        identity: identity(),
        draft: buildDraft({ introText: 'Variante A' }),
        expectedRevision: 1,
        now: LATER,
      }),
      saveInvoiceDraftRecord({
        identity: identity(),
        draft: buildDraft({ introText: 'Variante B' }),
        expectedRevision: 1,
        now: LATER,
      }),
    ]);

    const successes = [first, second].filter((result) => result.ok);
    const conflicts = [first, second].filter((result) => !result.ok);
    expect(successes.length, JSON.stringify([first, second])).toBe(1);
    expect(conflicts.length).toBe(1);
    for (const conflict of conflicts) {
      if (!conflict.ok) expect(conflict.reason).toBe('conflict');
    }

    const loaded = await loadInvoiceDraftRecord(identity());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.record.revision).toBe(2);
    expect(['Variante A', 'Variante B']).toContain(loaded.draft.introText);
  });

  it('K9: beschädigter Rohtext oder falscher Hash liefert corrupt', async () => {
    await seedRecord();

    // Den gespeicherten Rohtext von außen beschädigen — wie ein defekter Speicher.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('officepilot-invoice-drafts');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const storeName = db.objectStoreNames[0]!;
    const key = buildInvoiceDraftRecordKey({
      sourceScopeKey: SCOPE_A,
      vorgangId: VORGANG_A,
      invoiceType: 'rechnung',
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const read = store.get(key);
      read.onsuccess = () => {
        const record = read.result as { draftRawJson: string };
        record.draftRawJson = `${record.draftRawJson} kaputt`;
        store.put(record);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();

    const loaded = await loadInvoiceDraftRecord(identity());
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.reason).toBe('corrupt');

    // Nichts wurde repariert oder gelöscht.
    const second = await loadInvoiceDraftRecord(identity());
    expect(second.ok).toBe(false);
  });

  it('K10: abweichende Identität zwischen Umschlag und Entwurf liefert identity_mismatch', async () => {
    const mismatched = await createInvoiceDraftRecord({
      identity: identity(),
      draft: buildDraft({ vorgangId: VORGANG_B }),
      now: NOW,
    });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.reason).toBe('invalid_draft');

    const missingPositions = await createInvoiceDraftRecord({
      identity: identity(),
      draft: buildDraft({ positions: undefined as unknown as InvoiceDraft['positions'] }),
      now: NOW,
    });
    expect(missingPositions.ok).toBe(false);
    if (!missingPositions.ok) expect(missingPositions.reason).toBe('invalid_draft');

    // Ein von außen verfälschter Rohtext wird beim Laden erkannt.
    await seedRecord();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('officepilot-invoice-drafts');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const storeName = db.objectStoreNames[0]!;
    const key = buildInvoiceDraftRecordKey({
      sourceScopeKey: SCOPE_A,
      vorgangId: VORGANG_A,
      invoiceType: 'rechnung',
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const read = store.get(key);
      read.onsuccess = () => {
        const record = read.result as { draftRawJson: string; draftSha256: string };
        const parsed = JSON.parse(record.draftRawJson) as InvoiceDraft;
        parsed.id = 'draft-fremd';
        record.draftRawJson = JSON.stringify(parsed);
        store.put(record);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();

    const loaded = await loadInvoiceDraftRecord(identity());
    expect(loaded.ok).toBe(false);
    // Der Hash schlägt zuerst an — beides ist ein sicheres Nein.
    if (!loaded.ok) expect(['corrupt', 'identity_mismatch']).toContain(loaded.reason);
  });

  it('K11: Löschen verlangt vollständige Identität und aktuelle Revision', async () => {
    await seedRecord();

    const wrongWorkspace = await deleteInvoiceDraftRecord({
      identity: identity({ workspaceId: WORKSPACE_B }),
      expectedRevision: 1,
    });
    expect(wrongWorkspace.ok).toBe(false);
    // Seit 01P1A greift die Ablehnung bereits an der widersprüchlichen Identität.
    if (!wrongWorkspace.ok) {
      expect(['identity_mismatch', 'invalid_identity']).toContain(wrongWorkspace.reason);
    }

    const wrongRevision = await deleteInvoiceDraftRecord({
      identity: identity(),
      expectedRevision: 99,
    });
    expect(wrongRevision.ok).toBe(false);
    if (!wrongRevision.ok) {
      expect(wrongRevision.reason).toBe('conflict');
      expect(wrongRevision.currentRevision).toBe(1);
    }

    const stillThere = await loadInvoiceDraftRecord(identity());
    expect(stillThere.ok).toBe(true);

    const deleted = await deleteInvoiceDraftRecord({ identity: identity(), expectedRevision: 1 });
    expect(deleted.ok, JSON.stringify(deleted)).toBe(true);
    if (deleted.ok) expect(deleted.deletedRevision).toBe(1);

    const gone = await loadInvoiceDraftRecord(identity());
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.reason).toBe('not_found');

    const again = await deleteInvoiceDraftRecord({ identity: identity(), expectedRevision: 1 });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe('not_found');
  });

  it('K12: ein Speicherfehler liefert ein typisiertes Ergebnis und niemals falschen Erfolg', async () => {
    await seedRecord();

    const failing = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(() => {
      throw new Error('simulierter IndexedDB-Fehler');
    });

    const loaded = await loadInvoiceDraftRecord(identity());
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(['storage_failed', 'transaction_failed', 'storage_unavailable']).toContain(
        loaded.reason,
      );
    }

    const saved = await saveInvoiceDraftRecord({
      identity: identity(),
      draft: buildDraft({ introText: 'nach Fehler' }),
      expectedRevision: 1,
      now: LATER,
    });
    expect(saved.ok).toBe(false);

    failing.mockRestore();

    // Der Bestand ist unverändert geblieben.
    const after = await loadInvoiceDraftRecord(identity());
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.record.revision).toBe(1);
      expect(after.draft.introText).toBe(LONG_TEXT);
    }
  });
});

/* ========================================================================== *
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P1A — Wiederauffinden und
 * strenger Fehlervertrag.
 * ========================================================================== */

describe('01P1A — Locator und Fehlervertrag', () => {
  it('K13: ein Entwurf wird ohne bekannte draftId gefunden', async () => {
    const draft = buildDraft();
    await createInvoiceDraftRecord({ identity: identity(), draft, now: NOW });

    const found = await loadInvoiceDraftRecordByLocator(locator());
    expect(found.ok, JSON.stringify(found)).toBe(true);
    if (!found.ok) return;

    // Die draftId stammt ausschließlich aus dem geprüften Umschlag.
    expect(found.record.draftId).toBe(DRAFT_A);
    expect(found.draft.id).toBe(DRAFT_A);
    expect(found.draft).toEqual(draft);
    expect(found.record.revision).toBe(1);

    // Fremder Bereich, fremder Vorgang, fremde Rechnungsart: nichts gefunden.
    for (const other of [
      locator({ sourceScopeKey: SCOPE_B, workspaceId: WORKSPACE_B }),
      locator({ vorgangId: VORGANG_B }),
      locator({ invoiceType: 'abschlag' }),
    ]) {
      const miss = await loadInvoiceDraftRecordByLocator(other);
      expect(miss.ok).toBe(false);
      if (!miss.ok) expect(miss.reason).toBe('not_found');
    }

    // Ein fremder Workspace bei gleichem Schlüssel wird erkannt.
    const wrongWorkspace = await loadInvoiceDraftRecordByLocator(
      locator({ workspaceId: WORKSPACE_B }),
    );
    expect(wrongWorkspace.ok).toBe(false);
    if (!wrongWorkspace.ok) expect(wrongWorkspace.reason).toBe('invalid_identity');
  });

  it('K14: zwei konkurrierende Erstanlagen — genau eine gewinnt', async () => {
    const [first, second] = await Promise.all([
      createInvoiceDraftRecord({
        identity: identity({ draftId: 'draft-a' }),
        draft: buildDraft({ id: 'draft-a', introText: 'Variante A' }),
        now: NOW,
      }),
      createInvoiceDraftRecord({
        identity: identity({ draftId: 'draft-b' }),
        draft: buildDraft({ id: 'draft-b', introText: 'Variante B' }),
        now: NOW,
      }),
    ]);

    const winners = [first, second].filter((result) => result.ok);
    const losers = [first, second].filter((result) => !result.ok);
    expect(winners.length, JSON.stringify([first, second])).toBe(1);
    expect(losers.length).toBe(1);
    for (const loser of losers) {
      if (!loser.ok) expect(loser.reason).toBe('already_exists');
    }

    const found = await loadInvoiceDraftRecordByLocator(locator());
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(['draft-a', 'draft-b']).toContain(found.record.draftId);
    expect(found.draft.id).toBe(found.record.draftId);
    expect(found.record.revision).toBe(1);
  });

  it('K15: Scope und Workspace müssen zusammenpassen', async () => {
    const mismatched = identity({ sourceScopeKey: 'workspace:ws-a', workspaceId: 'ws-b' });

    const created = await createInvoiceDraftRecord({
      identity: mismatched,
      draft: buildDraft(),
      now: NOW,
    });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.reason).toBe('invalid_identity');

    const loaded = await loadInvoiceDraftRecord(mismatched);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.reason).toBe('invalid_identity');

    const byLocator = await loadInvoiceDraftRecordByLocator({
      sourceScopeKey: 'workspace:ws-a',
      workspaceId: 'ws-b',
      vorgangId: VORGANG_A,
      invoiceType: 'rechnung',
    });
    expect(byLocator.ok).toBe(false);
    if (!byLocator.ok) expect(byLocator.reason).toBe('invalid_identity');

    const saved = await saveInvoiceDraftRecord({
      identity: mismatched,
      draft: buildDraft(),
      expectedRevision: 1,
      now: LATER,
    });
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.reason).toBe('invalid_identity');

    const deleted = await deleteInvoiceDraftRecord({ identity: mismatched, expectedRevision: 1 });
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.reason).toBe('invalid_identity');
  });

  it('K16: leere oder unbekannte Rechnungsarten werden abgelehnt', async () => {
    for (const invoiceType of ['', 'phantasie', 'RECHNUNG'] as string[]) {
      const broken = identity({
        invoiceType: invoiceType as InvoiceDraftIdentity['invoiceType'],
      });
      const created = await createInvoiceDraftRecord({
        identity: broken,
        draft: buildDraft({ type: invoiceType as InvoiceDraft['type'] }),
        now: NOW,
      });
      expect(created.ok, invoiceType).toBe(false);
      if (!created.ok) expect(created.reason).toBe('invalid_identity');

      const found = await loadInvoiceDraftRecordByLocator(
        locator({ invoiceType: invoiceType as InvoiceDraftLocator['invoiceType'] }),
      );
      expect(found.ok).toBe(false);
      if (!found.ok) expect(found.reason).toBe('invalid_identity');
    }

    // Alle echten Rechnungsarten bleiben zulässig.
    for (const invoiceType of [
      'rechnung',
      'abschlag',
      'teilrechnung',
      'schluss',
      'gutschrift',
      'storno',
    ] as InvoiceDraft['type'][]) {
      const created = await createInvoiceDraftRecord({
        identity: identity({ invoiceType }),
        draft: buildDraft({ type: invoiceType }),
        now: NOW,
      });
      expect(created.ok, invoiceType).toBe(true);
    }
  });

  it('K17: ein unvollständiger Umschlag wird abgelehnt und nichts repariert', async () => {
    /**
     * `recordKey` ist der Inline-Schlüssel des Stores und kann nicht fehlen —
     * ein Datensatz ohne ihn lässt sich gar nicht erst ablegen. Stattdessen
     * prüft die Wertliste weiter unten einen nicht passenden recordKey.
     */
    const fields: (keyof InvoiceDraftRecord)[] = [
      'kind',
      'formatVersion',
      'sourceScopeKey',
      'workspaceId',
      'vorgangId',
      'invoiceType',
      'draftId',
      'revision',
      'createdAt',
      'updatedAt',
      'draftRawJson',
      'draftSha256',
      'status',
    ];

    for (const field of fields) {
      await resetInvoiceDraftDurabilityDatabaseForTests();
      await seedRecord();
      await mutateStoredRecord((record) => {
        delete (record as Record<string, unknown>)[field];
      });

      const loaded = await loadInvoiceDraftRecordByLocator(locator());
      expect(loaded.ok, `Feld ${field} fehlte und wurde akzeptiert`).toBe(false);
      if (!loaded.ok) {
        expect(['unsupported_format', 'identity_mismatch', 'corrupt']).toContain(loaded.reason);
      }
      // Nichts wurde gelöscht oder repariert.
      const again = await loadInvoiceDraftRecordByLocator(locator());
      expect(again.ok).toBe(false);
    }

    // Zusätzliche Wertprüfungen.
    const broken: [string, (record: InvoiceDraftRecord) => void][] = [
      /**
       * Der Store hält den recordKey als Inline-Schlüssel; er kann deshalb
       * nicht fehlen. Prüfbar ist die Bindung andersherum: passen die
       * Umschlagfelder nicht mehr zum Schlüssel, wird der Datensatz abgelehnt.
       */
      [
        'Felder passen nicht zum Schlüssel',
        (record) => {
          record.sourceScopeKey = 'workspace:ws-fremd';
          record.workspaceId = 'ws-fremd';
        },
      ],
      ['revision 0', (record) => { record.revision = 0; }],
      ['revision gebrochen', (record) => { record.revision = 1.5; }],
      ['status falsch', (record) => { record.status = 'archiviert' as InvoiceDraftRecord['status']; }],
      ['hash zu kurz', (record) => { record.draftSha256 = 'abc'; }],
      ['formatVersion', (record) => { record.formatVersion = 2 as InvoiceDraftRecord['formatVersion']; }],
    ];
    for (const [label, change] of broken) {
      await resetInvoiceDraftDurabilityDatabaseForTests();
      await seedRecord();
      await mutateStoredRecord(change);
      const loaded = await loadInvoiceDraftRecordByLocator(locator());
      expect(loaded.ok, label).toBe(false);
    }
  });

  it('K18: eine echte Identitätsabweichung bei gültigem Hash wird erkannt', async () => {
    for (const change of [
      (draft: InvoiceDraft) => {
        draft.id = 'draft-fremd';
      },
      (draft: InvoiceDraft) => {
        draft.vorgangId = VORGANG_B;
      },
      (draft: InvoiceDraft) => {
        draft.type = 'gutschrift';
      },
    ]) {
      await resetInvoiceDraftDurabilityDatabaseForTests();
      await seedRecord();
      await mutateStoredRecord(async (record) => {
        const parsed = JSON.parse(record.draftRawJson) as InvoiceDraft;
        change(parsed);
        record.draftRawJson = JSON.stringify(parsed);
        // Passender neuer Hash: der Hashvergleich darf hier nicht greifen.
        record.draftSha256 = await computeBufferContentHash(
          new TextEncoder().encode(record.draftRawJson),
        );
      });

      const byLocator = await loadInvoiceDraftRecordByLocator(locator());
      expect(byLocator.ok).toBe(false);
      if (!byLocator.ok) expect(byLocator.reason).toBe('identity_mismatch');

      const byIdentity = await loadInvoiceDraftRecord(identity());
      expect(byIdentity.ok).toBe(false);
      if (!byIdentity.ok) expect(byIdentity.reason).toBe('identity_mismatch');
    }
  });

  it('K19: ein nicht serialisierbarer Entwurf wird typisiert abgelehnt', async () => {
    const cyclic = buildDraft() as InvoiceDraft & { self?: unknown };
    cyclic.self = cyclic;

    const created = await createInvoiceDraftRecord({
      identity: identity(),
      draft: cyclic,
      now: NOW,
    });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.reason).toBe('invalid_draft');

    // Es wurde nichts gespeichert.
    const found = await loadInvoiceDraftRecordByLocator(locator());
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.reason).toBe('not_found');

    await seedRecord();
    const saved = await saveInvoiceDraftRecord({
      identity: identity(),
      draft: cyclic,
      expectedRevision: 1,
      now: LATER,
    });
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.reason).toBe('invalid_draft');

    const unchanged = await loadInvoiceDraftRecordByLocator(locator());
    expect(unchanged.ok).toBe(true);
    if (unchanged.ok) expect(unchanged.record.revision).toBe(1);
  });

  it('K20: keine öffentliche Operation lehnt ungeprüft ab', async () => {
    await seedRecord();

    // (a) Hashbildung scheitert.
    const encode = vi
      .spyOn(TextEncoder.prototype, 'encode')
      .mockImplementation(() => {
        throw new Error('simulierter Hashfehler');
      });
    await expect(loadInvoiceDraftRecordByLocator(locator())).resolves.toMatchObject({ ok: false });
    await expect(loadInvoiceDraftRecord(identity())).resolves.toMatchObject({ ok: false });
    await expect(
      createInvoiceDraftRecord({
        identity: identity({ vorgangId: VORGANG_B }),
        draft: buildDraft({ vorgangId: VORGANG_B }),
        now: NOW,
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      saveInvoiceDraftRecord({
        identity: identity(),
        draft: buildDraft(),
        expectedRevision: 1,
        now: LATER,
      }),
    ).resolves.toMatchObject({ ok: false });
    encode.mockRestore();

    // (b) JSON-Verarbeitung scheitert.
    const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => {
      throw new Error('simulierter JSON-Fehler');
    });
    await expect(loadInvoiceDraftRecordByLocator(locator())).resolves.toMatchObject({ ok: false });
    parse.mockRestore();

    // (c) Datenbankzugriff scheitert an jeder Stelle.
    const get = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(() => {
      throw new Error('simulierter Lesefehler');
    });
    for (const operation of [
      () => loadInvoiceDraftRecordByLocator(locator()),
      () => loadInvoiceDraftRecord(identity()),
      () =>
        createInvoiceDraftRecord({
          identity: identity({ vorgangId: VORGANG_B }),
          draft: buildDraft({ vorgangId: VORGANG_B }),
          now: NOW,
        }),
      () =>
        saveInvoiceDraftRecord({
          identity: identity(),
          draft: buildDraft(),
          expectedRevision: 1,
          now: LATER,
        }),
      () => deleteInvoiceDraftRecord({ identity: identity(), expectedRevision: 1 }),
    ]) {
      const result = await operation();
      expect(result.ok).toBe(false);
    }
    get.mockRestore();

    // (d) Die Nachprüfung nach dem abgeschlossenen Schreibvorgang scheitert.
    const afterCommit = failReadAfterCommit();
    const verifyFailed = await saveInvoiceDraftRecord({
      identity: identity(),
      draft: buildDraft({ introText: 'nach Nachprüfungsfehler' }),
      expectedRevision: 1,
      now: LATER,
    });
    expect(verifyFailed.ok).toBe(false);
    // 01P4A1: Die Transaktion war bereits abgeschlossen — der Grund ist eindeutig.
    if (!verifyFailed.ok) expect(verifyFailed.reason).toBe('committed_but_unverified');
    afterCommit.restore();

    // Der committete Stand liegt dauerhaft vor und wurde nicht entfernt.
    const stillThere = await loadInvoiceDraftRecordByLocator(locator());
    expect(stillThere.ok).toBe(true);
    if (stillThere.ok) {
      expect(stillThere.record.revision).toBe(2);
      expect(stillThere.draft.introText).toBe('nach Nachprüfungsfehler');
    }

    // (e) Dasselbe gilt für die Erstanlage.
    await resetInvoiceDraftDurabilityDatabaseForTests();
    const afterCreateCommit = failReadAfterCommit();
    const created = await createInvoiceDraftRecord({
      identity: identity(),
      draft: buildDraft(),
      now: NOW,
    });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.reason).toBe('committed_but_unverified');
    afterCreateCommit.restore();

    const createdRecord = await loadInvoiceDraftRecordByLocator(locator());
    expect(createdRecord.ok, JSON.stringify(createdRecord)).toBe(true);
    if (createdRecord.ok) {
      expect(createdRecord.record.revision).toBe(1);
      expect(createdRecord.record.status).toBe('active');
    }
  });
});

/* ========================================================================== *
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P2 — Finalisierungszustände
 * und Grabstein. Kein Cloud-Aufruf, keine automatische Wiederaufnahme, keine
 * automatische Löschung.
 * ========================================================================== */

const CLIENT_INVOICE_ID = 'cinv-0001';
const FINGERPRINT = 'fp-0001';
const STARTED_AT = '2026-08-20T12:10:00.000Z';
const FINALIZED_AT = '2026-08-20T12:11:00.000Z';
/**
 * 01P4A: Die lokale Rechnungskennung ist die Client-Kennung — der
 * Produktionsvertrag setzt `invoice.id = intent.clientInvoiceId`
 * (invoiceCloudFinalizeOrchestrator). Eine Abweichung ist damit kein gültiger
 * Abschluss mehr.
 */
const FINALIZED_INVOICE_ID = CLIENT_INVOICE_ID;

/** Gemeinsamer, gültiger Freigabekontext — fachlich opak für den Kern. */
const APPROVAL_CONTEXT: Record<string, unknown> = {
  hinweis: LONG_TEXT,
  flags: { a: true, b: false },
  liste: [1, 2, 3],
};

interface RequestOverrides {
  workspaceId?: string;
  vorgangId?: string;
  clientInvoiceId?: string;
  invoiceId?: string;
  invoiceType?: InvoiceDraft['type'];
}

function buildRequest(overrides: RequestOverrides = {}): InvoiceDraftFinalizationRequest {
  const clientInvoiceId = overrides.clientInvoiceId ?? CLIENT_INVOICE_ID;
  const invoice = {
    id: overrides.invoiceId ?? clientInvoiceId,
    type: overrides.invoiceType ?? ('rechnung' as InvoiceDraft['type']),
    number: 'Entwurf',
    subtotal: 123.45,
    amount: 146.9,
    positions: [
      { id: `inv-line-${clientInvoiceId}-op-1`, description: LONG_TEXT, quantity: 4 },
      { id: `inv-line-${clientInvoiceId}-op-2`, description: LONG_TEXT, quantity: 5 },
    ],
    introText: LONG_TEXT,
    closingText: LONG_TEXT,
  };
  const request = {
    workspaceId: overrides.workspaceId ?? WORKSPACE_A,
    vorgangId: overrides.vorgangId ?? VORGANG_A,
    clientInvoiceId,
    invoice,
  };
  return request;
}

/** Gültige Vorbereitungseingabe für `begin`. */
function preparationInput(overrides: RequestOverrides = {}): {
  request: InvoiceDraftFinalizationRequest;
  approvalContext: Record<string, unknown>;
} {
  return {
    request: buildRequest(overrides),
    approvalContext: JSON.parse(JSON.stringify(APPROVAL_CONTEXT)) as Record<string, unknown>,
  };
}

async function seedFinalizing(revision = 1): Promise<void> {
  const begun = await beginInvoiceDraftFinalization({
    identity: identity(),
    expectedRevision: revision,
    clientInvoiceId: CLIENT_INVOICE_ID,
    contentFingerprint: FINGERPRINT,
    ...preparationInput(),
    now: STARTED_AT,
  });
  expect(begun.ok, `Beginn fehlgeschlagen: ${JSON.stringify(begun)}`).toBe(true);
}

async function seedFinalized(): Promise<void> {
  await seedFinalizing();
  const done = await completeInvoiceDraftFinalization({
    identity: identity(),
    expectedRevision: 2,
    clientInvoiceId: CLIENT_INVOICE_ID,
    contentFingerprint: FINGERPRINT,
    finalizedInvoiceId: FINALIZED_INVOICE_ID,
    archiveWarning: false,
    now: FINALIZED_AT,
  });
  expect(done.ok, `Abschluss fehlgeschlagen: ${JSON.stringify(done)}`).toBe(true);
}

describe('01P2 — Finalisierungszustände und Grabstein', () => {
  it('K21: Schlüssel, Datenbank- und Formatversion bleiben unverändert', async () => {
    expect(INVOICE_DRAFT_DB_VERSION).toBe(1);
    expect(INVOICE_DRAFT_FORMAT_VERSION).toBe(1);
    expect(
      buildInvoiceDraftRecordKey({
        sourceScopeKey: SCOPE_A,
        vorgangId: VORGANG_A,
        invoiceType: 'rechnung',
      }),
    ).toBe(
      JSON.stringify([
        INVOICE_DRAFT_RECORD_KIND,
        INVOICE_DRAFT_FORMAT_VERSION,
        SCOPE_A,
        VORGANG_A,
        'rechnung',
      ]),
    );

    // Ein Bestandsdatensatz aus 01P1/01P1A bleibt gültig und ladbar.
    await seedRecord();
    const loaded = await loadInvoiceDraftRecordByLocator(locator());
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.record.status).toBe('active');
      expect(loaded.record.finalization).toBeUndefined();
    }
  });

  it('K22: Beginn wechselt zu finalizing und erhält Rohtext und Hash bytegleich', async () => {
    await seedRecord();
    const before = await loadInvoiceDraftRecordByLocator(locator());
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const begun = await beginInvoiceDraftFinalization({
      identity: identity(),
      expectedRevision: 1,
      clientInvoiceId: CLIENT_INVOICE_ID,
      contentFingerprint: FINGERPRINT,
      ...preparationInput(),
      now: STARTED_AT,
    });
    expect(begun.ok, JSON.stringify(begun)).toBe(true);
    if (!begun.ok) return;

    expect(begun.record.status).toBe('finalizing');
    expect(begun.record.revision).toBe(2);
    expect(begun.record.draftId).toBe(DRAFT_A);
    expect(begun.record.draftRawJson).toBe(before.record.draftRawJson);
    expect(begun.record.draftSha256).toBe(before.record.draftSha256);
    expect(begun.record.finalization?.clientInvoiceId).toBe(CLIENT_INVOICE_ID);
    expect(begun.record.finalization?.contentFingerprint).toBe(FINGERPRINT);
    expect(begun.record.finalization?.startedAt).toBe(STARTED_AT);
    expect(begun.record.finalization?.finalizedAt).toBeUndefined();
    expect(begun.record.finalization?.finalizedInvoiceId).toBeUndefined();

    const loaded = await loadInvoiceDraftRecordByLocator(locator());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.record.status).toBe('finalizing');
    expect(loaded.draft).toEqual(before.draft);
  });

  it('K23: veraltete Revision beim Beginn liefert conflict und ändert nichts', async () => {
    await seedRecord();
    await saveInvoiceDraftRecord({
      identity: identity(),
      draft: buildDraft({ introText: 'Zweiter Stand' }),
      expectedRevision: 1,
      now: LATER,
    });

    const stale = await beginInvoiceDraftFinalization({
      identity: identity(),
      expectedRevision: 1,
      clientInvoiceId: CLIENT_INVOICE_ID,
      contentFingerprint: FINGERPRINT,
      ...preparationInput(),
      now: STARTED_AT,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.reason).toBe('conflict');
      expect(stale.currentRevision).toBe(2);
    }

    const loaded = await loadInvoiceDraftRecordByLocator(locator());
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.record.status).toBe('active');
      expect(loaded.record.revision).toBe(2);
      expect(loaded.record.finalization).toBeUndefined();
    }
  });

  it('K24: zwei parallele Finalisierungsstarts — genau einer gewinnt', async () => {
    await seedRecord();

    const [first, second] = await Promise.all([
      beginInvoiceDraftFinalization({
        identity: identity(),
        expectedRevision: 1,
        clientInvoiceId: 'cinv-A',
        contentFingerprint: 'fp-A',
        ...preparationInput({ clientInvoiceId: 'cinv-A' }),
        now: STARTED_AT,
      }),
      beginInvoiceDraftFinalization({
        identity: identity(),
        expectedRevision: 1,
        clientInvoiceId: 'cinv-B',
        contentFingerprint: 'fp-B',
        ...preparationInput({ clientInvoiceId: 'cinv-B' }),
        now: STARTED_AT,
      }),
    ]);

    const winners = [first, second].filter((result) => result.ok);
    const losers = [first, second].filter((result) => !result.ok);
    expect(winners.length, JSON.stringify([first, second])).toBe(1);
    for (const loser of losers) {
      if (!loser.ok) expect(['conflict', 'status_conflict']).toContain(loser.reason);
    }

    const loaded = await loadInvoiceDraftRecordByLocator(locator());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.record.status).toBe('finalizing');
    expect(loaded.record.revision).toBe(2);

    // Die Finalisierungsdaten stammen vollständig von genau einem Vorgang.
    const winner = winners[0];
    if (winner?.ok) {
      expect(loaded.record.finalization?.clientInvoiceId).toBe(
        winner.record.finalization?.clientInvoiceId,
      );
      expect(loaded.record.finalization?.contentFingerprint).toBe(
        winner.record.finalization?.contentFingerprint,
      );
    }
    expect(
      [
        ['cinv-A', 'fp-A'],
        ['cinv-B', 'fp-B'],
      ].some(
        ([id, fp]) =>
          loaded.record.finalization?.clientInvoiceId === id &&
          loaded.record.finalization?.contentFingerprint === fp,
      ),
    ).toBe(true);
  });

  it('K25: ein finalizing-Datensatz ist weder speicherbar noch löschbar', async () => {
    await seedRecord();
    await seedFinalizing();

    const saved = await saveInvoiceDraftRecord({
      identity: identity(),
      draft: buildDraft({ introText: 'Änderung während Finalisierung' }),
      expectedRevision: 2,
      now: LATER,
    });
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.reason).toBe('status_conflict');

    const deleted = await deleteInvoiceDraftRecord({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.reason).toBe('status_conflict');

    const loaded = await loadInvoiceDraftRecordByLocator(locator());
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.record.status).toBe('finalizing');
      expect(loaded.record.revision).toBe(2);
      expect(loaded.draft.introText).toBe(LONG_TEXT);
    }
  });

  it('K26: Abschluss wechselt zu finalized und erhöht die Revision einmal', async () => {
    await seedRecord();
    await seedFinalizing();

    const done = await completeInvoiceDraftFinalization({
      identity: identity(),
      expectedRevision: 2,
      clientInvoiceId: CLIENT_INVOICE_ID,
      contentFingerprint: FINGERPRINT,
      finalizedInvoiceId: FINALIZED_INVOICE_ID,
      archiveWarning: true,
      now: FINALIZED_AT,
    });
    expect(done.ok, JSON.stringify(done)).toBe(true);
    if (!done.ok) return;

    expect(done.record.status).toBe('finalized');
    expect(done.record.revision).toBe(3);
    expect(done.record.finalization?.clientInvoiceId).toBe(CLIENT_INVOICE_ID);
    expect(done.record.finalization?.contentFingerprint).toBe(FINGERPRINT);
    expect(done.record.finalization?.startedAt).toBe(STARTED_AT);
    expect(done.record.finalization?.finalizedAt).toBe(FINALIZED_AT);
    expect(done.record.finalization?.finalizedInvoiceId).toBe(FINALIZED_INVOICE_ID);
    expect(done.record.finalization?.archiveWarning).toBe(true);
  });

  it('K27: abweichende Finalisierungsidentität liefert finalization_mismatch', async () => {
    await seedRecord();
    await seedFinalizing();

    for (const wrong of [
      { clientInvoiceId: 'cinv-fremd', contentFingerprint: FINGERPRINT },
      { clientInvoiceId: CLIENT_INVOICE_ID, contentFingerprint: 'fp-fremd' },
    ]) {
      const done = await completeInvoiceDraftFinalization({
        identity: identity(),
        expectedRevision: 2,
        ...wrong,
        finalizedInvoiceId: FINALIZED_INVOICE_ID,
        archiveWarning: false,
        now: FINALIZED_AT,
      });
      expect(done.ok, JSON.stringify(wrong)).toBe(false);
      if (!done.ok) expect(done.reason).toBe('finalization_mismatch');
    }

    const loaded = await loadInvoiceDraftRecordByLocator(locator());
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.record.status).toBe('finalizing');
      expect(loaded.record.revision).toBe(2);
      expect(loaded.record.finalization?.finalizedAt).toBeUndefined();
    }
  });

  it('K28: veraltete Revision oder fremde Identität beim Abschluss wird abgelehnt', async () => {
    await seedRecord();
    await seedFinalizing();

    const staleRevision = await completeInvoiceDraftFinalization({
      identity: identity(),
      expectedRevision: 1,
      clientInvoiceId: CLIENT_INVOICE_ID,
      contentFingerprint: FINGERPRINT,
      finalizedInvoiceId: FINALIZED_INVOICE_ID,
      archiveWarning: false,
      now: FINALIZED_AT,
    });
    expect(staleRevision.ok).toBe(false);
    if (!staleRevision.ok) {
      expect(staleRevision.reason).toBe('conflict');
      expect(staleRevision.currentRevision).toBe(2);
    }

    const foreignDraftId = await completeInvoiceDraftFinalization({
      identity: identity({ draftId: 'draft-fremd' }),
      expectedRevision: 2,
      clientInvoiceId: CLIENT_INVOICE_ID,
      contentFingerprint: FINGERPRINT,
      finalizedInvoiceId: FINALIZED_INVOICE_ID,
      archiveWarning: false,
      now: FINALIZED_AT,
    });
    expect(foreignDraftId.ok).toBe(false);
    if (!foreignDraftId.ok) expect(foreignDraftId.reason).toBe('identity_mismatch');

    const loaded = await loadInvoiceDraftRecordByLocator(locator());
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.record.status).toBe('finalizing');
      expect(loaded.record.revision).toBe(2);
    }
  });

  it('K29: der Grabstein wird ohne bekannte draftId vollständig wiedergefunden', async () => {
    await seedRecord();
    await seedFinalized();

    const found = await loadInvoiceDraftRecordByLocator(locator());
    expect(found.ok, JSON.stringify(found)).toBe(true);
    if (!found.ok) return;

    expect(found.record.status).toBe('finalized');
    expect(found.record.revision).toBe(3);
    expect(found.record.draftId).toBe(DRAFT_A);
    expect(found.record.finalization?.clientInvoiceId).toBe(CLIENT_INVOICE_ID);
    expect(found.record.finalization?.contentFingerprint).toBe(FINGERPRINT);
    expect(found.record.finalization?.startedAt).toBe(STARTED_AT);
    expect(found.record.finalization?.finalizedAt).toBe(FINALIZED_AT);
    expect(found.record.finalization?.finalizedInvoiceId).toBe(FINALIZED_INVOICE_ID);
    expect(found.record.finalization?.archiveWarning).toBe(false);
    // Der vollständige Entwurf bleibt erhalten.
    expect(found.draft.positions.length).toBe(3);
    expect(found.draft.introText).toBe(LONG_TEXT);
  });

  it('K30: ein Grabstein lässt sich weder ändern, löschen noch erneut beginnen', async () => {
    await seedRecord();
    await seedFinalized();

    const saved = await saveInvoiceDraftRecord({
      identity: identity(),
      draft: buildDraft({ introText: 'Nachträgliche Änderung' }),
      expectedRevision: 3,
      now: LATER,
    });
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.reason).toBe('status_conflict');

    const deleted = await deleteInvoiceDraftRecord({ identity: identity(), expectedRevision: 3 });
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.reason).toBe('status_conflict');

    const begunAgain = await beginInvoiceDraftFinalization({
      identity: identity(),
      expectedRevision: 3,
      clientInvoiceId: 'cinv-zweiter-versuch',
      contentFingerprint: 'fp-zweiter-versuch',
      ...preparationInput({ clientInvoiceId: 'cinv-zweiter-versuch' }),
      now: STARTED_AT,
    });
    expect(begunAgain.ok).toBe(false);
    if (!begunAgain.ok) expect(begunAgain.reason).toBe('status_conflict');

    const created = await createInvoiceDraftRecord({
      identity: identity({ draftId: 'draft-neu' }),
      draft: buildDraft({ id: 'draft-neu' }),
      now: NOW,
    });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.reason).toBe('already_exists');

    const loaded = await loadInvoiceDraftRecordByLocator(locator());
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.record.status).toBe('finalized');
      expect(loaded.record.revision).toBe(3);
      expect(loaded.record.finalization?.finalizedInvoiceId).toBe(FINALIZED_INVOICE_ID);
    }
  });

  it('K31: statusabhängige Pflichtfelder werden vollständig geprüft', async () => {
    // (a) Eingaben mit leeren Kennungen werden abgelehnt.
    await seedRecord();
    for (const bad of [
      { clientInvoiceId: '', contentFingerprint: FINGERPRINT },
      { clientInvoiceId: CLIENT_INVOICE_ID, contentFingerprint: '' },
    ]) {
      const begun = await beginInvoiceDraftFinalization({
        identity: identity(),
        expectedRevision: 1,
        ...bad,
        ...preparationInput(),
        now: STARTED_AT,
      });
      expect(begun.ok, JSON.stringify(bad)).toBe(false);
      if (!begun.ok) expect(begun.reason).toBe('invalid_finalization');
    }

    // (b) Gespeicherte Datensätze mit widersprüchlichem Status werden abgelehnt.
    const cases: [string, (record: InvoiceDraftRecord) => void][] = [
      [
        'active mit Finalisierungsdaten',
        (record) => {
          record.finalization = {
            clientInvoiceId: CLIENT_INVOICE_ID,
            contentFingerprint: FINGERPRINT,
            startedAt: STARTED_AT,
          };
        },
      ],
      [
        'unbekannter Status',
        (record) => {
          record.status = 'archiviert' as InvoiceDraftRecord['status'];
        },
      ],
      [
        'finalizing ohne Finalisierungsdaten',
        (record) => {
          record.status = 'finalizing';
        },
      ],
      [
        'finalizing mit finalizedAt',
        (record) => {
          record.status = 'finalizing';
          record.finalization = {
            clientInvoiceId: CLIENT_INVOICE_ID,
            contentFingerprint: FINGERPRINT,
            startedAt: STARTED_AT,
            finalizedAt: FINALIZED_AT,
          };
        },
      ],
      [
        'finalizing mit leerer Kennung',
        (record) => {
          record.status = 'finalizing';
          record.finalization = {
            clientInvoiceId: '',
            contentFingerprint: FINGERPRINT,
            startedAt: STARTED_AT,
          };
        },
      ],
      [
        'finalized ohne finalizedInvoiceId',
        (record) => {
          record.status = 'finalized';
          record.finalization = {
            clientInvoiceId: CLIENT_INVOICE_ID,
            contentFingerprint: FINGERPRINT,
            startedAt: STARTED_AT,
            finalizedAt: FINALIZED_AT,
            archiveWarning: false,
          };
        },
      ],
      [
        'finalized ohne archiveWarning',
        (record) => {
          record.status = 'finalized';
          record.finalization = {
            clientInvoiceId: CLIENT_INVOICE_ID,
            contentFingerprint: FINGERPRINT,
            startedAt: STARTED_AT,
            finalizedAt: FINALIZED_AT,
            finalizedInvoiceId: FINALIZED_INVOICE_ID,
          };
        },
      ],
    ];

    for (const [label, change] of cases) {
      await resetInvoiceDraftDurabilityDatabaseForTests();
      await seedRecord();
      await mutateStoredRecord(change);

      const loaded = await loadInvoiceDraftRecordByLocator(locator());
      expect(loaded.ok, label).toBe(false);
      if (!loaded.ok) expect(loaded.reason).toBe('unsupported_format');

      // Nichts wurde repariert oder gelöscht.
      const again = await loadInvoiceDraftRecordByLocator(locator());
      expect(again.ok, label).toBe(false);
    }
  });

  it('K32: simulierte Fehler liefern typisierte Ergebnisse und nie ok:true', async () => {
    await seedRecord();

    // (a) Hashbildung scheitert.
    const encode = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(() => {
      throw new Error('simulierter Hashfehler');
    });
    await expect(
      beginInvoiceDraftFinalization({
        identity: identity(),
        expectedRevision: 1,
        clientInvoiceId: CLIENT_INVOICE_ID,
        contentFingerprint: FINGERPRINT,
        ...preparationInput(),
        now: STARTED_AT,
      }),
    ).resolves.toMatchObject({ ok: false });
    encode.mockRestore();

    // (b) Datenbankzugriff scheitert.
    const get = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(() => {
      throw new Error('simulierter Lesefehler');
    });
    for (const operation of [
      () =>
        beginInvoiceDraftFinalization({
          identity: identity(),
          expectedRevision: 1,
          clientInvoiceId: CLIENT_INVOICE_ID,
          contentFingerprint: FINGERPRINT,
          ...preparationInput(),
          now: STARTED_AT,
        }),
      () =>
        completeInvoiceDraftFinalization({
          identity: identity(),
          expectedRevision: 2,
          clientInvoiceId: CLIENT_INVOICE_ID,
          contentFingerprint: FINGERPRINT,
          finalizedInvoiceId: FINALIZED_INVOICE_ID,
          archiveWarning: false,
          now: FINALIZED_AT,
        }),
    ]) {
      const result = await operation();
      expect(result.ok).toBe(false);
    }
    get.mockRestore();

    // (c) Die Nachprüfung nach dem Schreiben scheitert.
    let reads = 0;
    const secondRead = vi
      .spyOn(IDBObjectStore.prototype, 'get')
      .mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
        reads += 1;
        if (reads > 1) throw new Error('simulierter Nachprüfungsfehler');
        return (
          Object.getPrototypeOf(Object.getPrototypeOf(this)) as IDBObjectStore
        ).get.call(this, key);
      });
    const verifyFailed = await beginInvoiceDraftFinalization({
      identity: identity(),
      expectedRevision: 1,
      clientInvoiceId: CLIENT_INVOICE_ID,
      contentFingerprint: FINGERPRINT,
      ...preparationInput(),
      now: STARTED_AT,
    });
    expect(verifyFailed.ok).toBe(false);
    // Hier wirft bereits die CAS-Lesung — also **vor** jedem Commit.
    if (!verifyFailed.ok) {
      expect(['storage_failed', 'transaction_failed']).toContain(verifyFailed.reason);
    }
    secondRead.mockRestore();

    // Der Datensatz existiert weiterhin und wurde nicht automatisch entfernt.
    const stillThere = await loadInvoiceDraftRecordByLocator(locator());
    expect(stillThere.ok).toBe(true);
  });
});

/* ========================================================================== *
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4A — atomare
 * Finalisierungsvorbereitung. Kein Cloud-Aufruf, kein LocalStorage, kein
 * Neubau aus Draft, Setup oder Uhrzeit.
 * ========================================================================== */

/** Ersetzt die gespeicherte Vorbereitung mit gültig neu berechnetem Hash. */
async function rewritePreparation(
  mutate: (preparation: Record<string, unknown>) => void,
): Promise<void> {
  await mutateStoredRecord(async (record) => {
    const parsed = JSON.parse(record.preparationRawJson ?? '{}') as Record<string, unknown>;
    mutate(parsed);
    const raw = JSON.stringify(parsed);
    record.preparationRawJson = raw;
    record.preparationSha256 = await computeBufferContentHash(new TextEncoder().encode(raw));
  });
}

async function loadPreparation(expectedRevision = 2) {
  return loadInvoiceDraftFinalizationPreparation({ identity: identity(), expectedRevision });
}

describe('01P4A — atomare Finalisierungsvorbereitung', () => {
  it('K33: begin speichert die vollständige Vorbereitung atomar mit finalizing', async () => {
    await seedRecord();
    const before = await loadInvoiceDraftRecordByLocator(locator());
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const begun = await beginInvoiceDraftFinalization({
      identity: identity(),
      expectedRevision: 1,
      clientInvoiceId: CLIENT_INVOICE_ID,
      contentFingerprint: FINGERPRINT,
      ...preparationInput(),
      now: STARTED_AT,
    });
    expect(begun.ok, JSON.stringify(begun)).toBe(true);
    if (!begun.ok) return;

    expect(begun.record.status).toBe('finalizing');
    expect(begun.record.revision).toBe(2);
    // Der Entwurf selbst bleibt unangetastet.
    expect(begun.record.draftRawJson).toBe(before.record.draftRawJson);
    expect(begun.record.draftSha256).toBe(before.record.draftSha256);
    expect(typeof begun.record.preparationRawJson).toBe('string');
    expect(begun.record.preparationSha256 ?? '').toMatch(/^[0-9a-f]{64}$/);

    // Nach einem vollständigen Neuladen liegt dieselbe Vorbereitung vor.
    const loaded = await loadPreparation();
    expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.preparation.kind).toBe(INVOICE_DRAFT_PREPARATION_KIND);
    expect(loaded.preparation.formatVersion).toBe(INVOICE_DRAFT_PREPARATION_FORMAT_VERSION);
    expect(loaded.preparation.preparedAt).toBe(STARTED_AT);
    expect(loaded.record.preparationRawJson).toBe(begun.record.preparationRawJson);
  });

  it('K34: gespeichert wird der vollständige Cloud-Request, nicht nur die Rechnung', async () => {
    await seedRecord();
    await seedFinalizing();

    const loaded = await loadPreparation();
    expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
    if (!loaded.ok) return;

    const request = loaded.preparation.request;
    expect(request.workspaceId).toBe(WORKSPACE_A);
    expect(request.vorgangId).toBe(VORGANG_A);
    expect(request.clientInvoiceId).toBe(CLIENT_INVOICE_ID);
    expect(request.invoice.id).toBe(CLIENT_INVOICE_ID);
    expect(request.invoice.type).toBe('rechnung');
    // Der Request ist die äußere Hülle — nicht nur der Rechnungskandidat.
    expect(Object.keys(request).sort()).toEqual(
      ['clientInvoiceId', 'invoice', 'vorgangId', 'workspaceId'].sort(),
    );
  });

  it('K35: Rohtext und Hash stimmen; nichts wird gekürzt', async () => {
    await seedRecord();
    await seedFinalizing();

    const loaded = await loadPreparation();
    expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
    if (!loaded.ok) return;

    const raw = loaded.record.preparationRawJson ?? '';
    const hash = await computeBufferContentHash(new TextEncoder().encode(raw));
    expect(loaded.record.preparationSha256).toBe(hash);
    expect(JSON.parse(raw)).toEqual(loaded.preparation);

    const expectedRequest = buildRequest();
    expect(loaded.preparation.request).toEqual(expectedRequest);
    const positions = (
      loaded.preparation.request.invoice as unknown as {
        positions: { description: string }[];
      }
    ).positions;
    expect(positions.length).toBe(2);
    expect(positions[0]?.description).toBe(LONG_TEXT);
    expect(loaded.preparation.approvalContext).toEqual(APPROVAL_CONTEXT);
    expect(loaded.preparation.approvalContext.hinweis).toBe(LONG_TEXT);
  });

  it('K36: die Vorbereitung ist an Entwurf, Ausgangsrevision und Fingerprint gebunden', async () => {
    await seedRecord();
    const source = await loadInvoiceDraftRecordByLocator(locator());
    expect(source.ok).toBe(true);
    if (!source.ok) return;

    await seedFinalizing();
    const loaded = await loadPreparation();
    expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.preparation.preparedFromRevision).toBe(source.record.revision);
    expect(loaded.preparation.sourceDraftSha256).toBe(source.record.draftSha256);
    expect(loaded.preparation.contentFingerprint).toBe(FINGERPRINT);
    expect(loaded.preparation.contentFingerprint).toBe(
      loaded.record.finalization?.contentFingerprint,
    );
  });

  it('K37: eine ungültige Vorbereitung liefert invalid_preparation', async () => {
    const cyclic: Record<string, unknown> = { id: CLIENT_INVOICE_ID, type: 'rechnung' };
    cyclic.self = cyclic;

    const cases: [string, InvoiceDraftFinalizationRequest, unknown][] = [
      [
        'zyklische Rechnung',
        { ...buildRequest(), invoice: cyclic } as unknown as InvoiceDraftFinalizationRequest,
        {},
      ],
      ['leerer Request', {} as unknown as InvoiceDraftFinalizationRequest, {}],
      ['Request ist null', null as unknown as InvoiceDraftFinalizationRequest, {}],
      [
        'Rechnung fehlt',
        { ...buildRequest(), invoice: undefined } as unknown as InvoiceDraftFinalizationRequest,
        {},
      ],
      ['Kontext ist null', buildRequest(), null],
      ['Kontext ist ein Feld', buildRequest(), []],
      ['Kontext ist eine Zeichenkette', buildRequest(), 'kontext'],
    ];

    for (const [label, request, approvalContext] of cases) {
      await resetInvoiceDraftDurabilityDatabaseForTests();
      await seedRecord();

      const begun = await beginInvoiceDraftFinalization({
        identity: identity(),
        expectedRevision: 1,
        clientInvoiceId: CLIENT_INVOICE_ID,
        contentFingerprint: FINGERPRINT,
        request,
        approvalContext: approvalContext as Record<string, unknown>,
        now: STARTED_AT,
      });
      expect(begun.ok, label).toBe(false);
      if (!begun.ok) expect(begun.reason, label).toBe('invalid_preparation');

      // Der aktive Entwurf bleibt unverändert bearbeitbar.
      const loaded = await loadInvoiceDraftRecordByLocator(locator());
      expect(loaded.ok, label).toBe(true);
      if (loaded.ok) {
        expect(loaded.record.status, label).toBe('active');
        expect(loaded.record.revision, label).toBe(1);
        expect(loaded.record.preparationRawJson, label).toBeUndefined();
      }
    }
  });

  it('K38: zwei parallele Vorbereitungen — Request und Kontext stammen vom selben Gewinner', async () => {
    await seedRecord();

    const [first, second] = await Promise.all([
      beginInvoiceDraftFinalization({
        identity: identity(),
        expectedRevision: 1,
        clientInvoiceId: 'cinv-A',
        contentFingerprint: 'fp-A',
        request: buildRequest({ clientInvoiceId: 'cinv-A' }),
        approvalContext: { tab: 'A' },
        now: STARTED_AT,
      }),
      beginInvoiceDraftFinalization({
        identity: identity(),
        expectedRevision: 1,
        clientInvoiceId: 'cinv-B',
        contentFingerprint: 'fp-B',
        request: buildRequest({ clientInvoiceId: 'cinv-B' }),
        approvalContext: { tab: 'B' },
        now: STARTED_AT,
      }),
    ]);

    const winners = [first, second].filter((result) => result.ok);
    expect(winners.length, JSON.stringify([first, second])).toBe(1);
    for (const loser of [first, second].filter((result) => !result.ok)) {
      if (!loser.ok) expect(['conflict', 'status_conflict']).toContain(loser.reason);
    }

    const loaded = await loadPreparation();
    expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
    if (!loaded.ok) return;

    const tab = loaded.preparation.approvalContext.tab;
    expect(['A', 'B']).toContain(tab);
    // Kennung, Fingerprint, Request und Kontext dürfen niemals gemischt sein.
    expect(loaded.record.finalization?.clientInvoiceId).toBe(`cinv-${tab}`);
    expect(loaded.record.finalization?.contentFingerprint).toBe(`fp-${tab}`);
    expect(loaded.preparation.contentFingerprint).toBe(`fp-${tab}`);
    expect(loaded.preparation.request.clientInvoiceId).toBe(`cinv-${tab}`);
    expect(loaded.preparation.request.invoice.id).toBe(`cinv-${tab}`);
  });

  it('K39: beschädigter Rohtext oder falscher Hash liefert corrupt', async () => {
    for (const [label, change] of [
      [
        'kaputtes JSON',
        (record: InvoiceDraftRecord) => {
          record.preparationRawJson = '{ das ist kein JSON';
        },
      ],
      [
        'falscher Hash',
        (record: InvoiceDraftRecord) => {
          record.preparationSha256 = 'a'.repeat(64);
        },
      ],
    ] as [string, (record: InvoiceDraftRecord) => void][]) {
      await resetInvoiceDraftDurabilityDatabaseForTests();
      await seedRecord();
      await seedFinalizing();
      await mutateStoredRecord(change);

      const loaded = await loadPreparation();
      expect(loaded.ok, label).toBe(false);
      if (!loaded.ok) expect(loaded.reason, label).toBe('corrupt');
      expect('preparation' in loaded, label).toBe(false);

      // Nichts wurde repariert, ersetzt oder gelöscht.
      const again = await loadPreparation();
      expect(again.ok, label).toBe(false);
      const record = await loadInvoiceDraftRecordByLocator(locator());
      expect(record.ok, label).toBe(true);
      if (record.ok) expect(record.record.status, label).toBe('finalizing');
    }
  });

  it('K40: abweichende Bindung bei gültigem Hash wird erkannt', async () => {
    const cases: [string, (preparation: Record<string, unknown>) => void][] = [
      [
        'fremder Workspace',
        (preparation) => {
          (preparation.request as Record<string, unknown>).workspaceId = WORKSPACE_B;
        },
      ],
      [
        'fremder Vorgang',
        (preparation) => {
          (preparation.request as Record<string, unknown>).vorgangId = VORGANG_B;
        },
      ],
      [
        'fremde clientInvoiceId',
        (preparation) => {
          (preparation.request as Record<string, unknown>).clientInvoiceId = 'cinv-fremd';
        },
      ],
      [
        'fremde Rechnungs-ID',
        (preparation) => {
          const request = preparation.request as { invoice: Record<string, unknown> };
          request.invoice.id = 'cinv-fremd';
        },
      ],
      [
        'fremde Rechnungsart',
        (preparation) => {
          const request = preparation.request as { invoice: Record<string, unknown> };
          request.invoice.type = 'abschlag';
        },
      ],
      [
        'fremder Fingerprint',
        (preparation) => {
          preparation.contentFingerprint = 'fp-fremd';
        },
      ],
      [
        'fremder Entwurfs-Hash',
        (preparation) => {
          preparation.sourceDraftSha256 = 'b'.repeat(64);
        },
      ],
    ];

    for (const [label, change] of cases) {
      await resetInvoiceDraftDurabilityDatabaseForTests();
      await seedRecord();
      await seedFinalizing();
      await rewritePreparation(change);

      const loaded = await loadPreparation();
      expect(loaded.ok, label).toBe(false);
      if (!loaded.ok) {
        expect(['identity_mismatch', 'invalid_preparation'], label).toContain(loaded.reason);
      }

      const record = await loadInvoiceDraftRecordByLocator(locator());
      expect(record.ok, label).toBe(true);
      if (record.ok) expect(record.record.status, label).toBe('finalizing');
    }
  });

  it('K41: unbekannte Formatversion der Vorbereitung liefert unsupported_preparation', async () => {
    for (const [label, change] of [
      [
        'unbekannte Version',
        (preparation: Record<string, unknown>) => {
          preparation.formatVersion = 99;
        },
      ],
      [
        'unbekannte Art',
        (preparation: Record<string, unknown>) => {
          preparation.kind = 'fremde-huelle';
        },
      ],
    ] as [string, (preparation: Record<string, unknown>) => void][]) {
      await resetInvoiceDraftDurabilityDatabaseForTests();
      await seedRecord();
      await seedFinalizing();
      const before = await loadInvoiceDraftRecordByLocator(locator());
      expect(before.ok, label).toBe(true);
      await rewritePreparation(change);

      const loaded = await loadPreparation();
      expect(loaded.ok, label).toBe(false);
      if (!loaded.ok) expect(loaded.reason, label).toBe('unsupported_preparation');

      // Nichts repariert, nichts gelöscht, kein Rückfall auf active.
      const after = await loadInvoiceDraftRecordByLocator(locator());
      expect(after.ok, label).toBe(true);
      if (after.ok && before.ok) {
        expect(after.record.status, label).toBe('finalizing');
        expect(after.record.draftRawJson, label).toBe(before.record.draftRawJson);
      }
    }
  });

  it('K42: jede Ladeoperation liefert ein frisches, getrenntes Objekt', async () => {
    await seedRecord();
    await seedFinalizing();

    const first = await loadPreparation();
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;

    const rawBefore = first.record.preparationRawJson;
    (first.preparation as { preparedAt: string }).preparedAt = 'manipuliert';
    (first.preparation.request as { workspaceId: string }).workspaceId = 'ws-manipuliert';
    (first.preparation.approvalContext as Record<string, unknown>).hinweis = 'manipuliert';

    const second = await loadPreparation();
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.preparation.preparedAt).toBe(STARTED_AT);
    expect(second.preparation.request.workspaceId).toBe(WORKSPACE_A);
    expect(second.preparation.approvalContext.hinweis).toBe(LONG_TEXT);
    expect(second.preparation).not.toBe(first.preparation);
    expect(second.record.preparationRawJson).toBe(rawBefore);
  });

  it('K43: complete erhöht die Revision einmal und bewahrt die Vorbereitung bytegleich', async () => {
    await seedRecord();
    await seedFinalizing();
    const before = await loadPreparation();
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const done = await completeInvoiceDraftFinalization({
      identity: identity(),
      expectedRevision: 2,
      clientInvoiceId: CLIENT_INVOICE_ID,
      contentFingerprint: FINGERPRINT,
      finalizedInvoiceId: FINALIZED_INVOICE_ID,
      archiveWarning: false,
      now: FINALIZED_AT,
    });
    expect(done.ok, JSON.stringify(done)).toBe(true);
    if (!done.ok) return;

    expect(done.record.status).toBe('finalized');
    expect(done.record.revision).toBe(3);
    expect(done.record.preparationRawJson).toBe(before.record.preparationRawJson);
    expect(done.record.preparationSha256).toBe(before.record.preparationSha256);

    // Der Grabstein bleibt über den Locator vollständig auffindbar.
    const tomb = await loadInvoiceDraftRecordByLocator(locator());
    expect(tomb.ok).toBe(true);
    if (tomb.ok) {
      expect(tomb.record.status).toBe('finalized');
      expect(tomb.record.preparationRawJson).toBe(before.record.preparationRawJson);
    }

    // Auch nach dem Abschluss bleibt die Vorbereitung ladbar — für
    // Wiederaufnahme, Prüfung und Archivnachholung.
    const afterComplete = await loadPreparation(3);
    expect(afterComplete.ok, JSON.stringify(afterComplete)).toBe(true);
    if (afterComplete.ok) {
      expect(afterComplete.preparation).toEqual(before.preparation);
    }
  });

  it('K44: ohne gültige Vorbereitung ist kein Abschluss möglich', async () => {
    const cases: [string, (record: InvoiceDraftRecord) => void | Promise<void>][] = [
      [
        'fehlende Vorbereitung',
        (record) => {
          delete record.preparationRawJson;
          delete record.preparationSha256;
        },
      ],
      [
        'beschädigter Rohtext',
        (record) => {
          record.preparationRawJson = '{ kaputt';
        },
      ],
      [
        'falscher Hash',
        (record) => {
          record.preparationSha256 = 'c'.repeat(64);
        },
      ],
    ];

    for (const [label, change] of cases) {
      await resetInvoiceDraftDurabilityDatabaseForTests();
      await seedRecord();
      await seedFinalizing();
      await mutateStoredRecord(change);

      const done = await completeInvoiceDraftFinalization({
        identity: identity(),
        expectedRevision: 2,
        clientInvoiceId: CLIENT_INVOICE_ID,
        contentFingerprint: FINGERPRINT,
        finalizedInvoiceId: FINALIZED_INVOICE_ID,
        archiveWarning: false,
        now: FINALIZED_AT,
      });
      expect(done.ok, label).toBe(false);
      if (!done.ok) {
        expect(['unsupported_preparation', 'corrupt'], label).toContain(done.reason);
      }

      // Der finalizing-Datensatz bleibt unverändert und blockiert.
      const record = await loadInvoiceDraftRecordByLocator(locator());
      expect(record.ok, label).toBe(true);
      if (record.ok) {
        expect(record.record.status, label).toBe('finalizing');
        expect(record.record.revision, label).toBe(2);
        expect(record.record.finalization?.finalizedAt, label).toBeUndefined();
      }
    }
  });

  it('K45: simulierte Fehler liefern typisierte Ergebnisse und nie ok:true', async () => {
    await seedRecord();

    // (a) Hashbildung der Vorbereitung scheitert.
    const encode = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(() => {
      throw new Error('simulierter Hashfehler');
    });
    const hashFailed = await beginInvoiceDraftFinalization({
      identity: identity(),
      expectedRevision: 1,
      clientInvoiceId: CLIENT_INVOICE_ID,
      contentFingerprint: FINGERPRINT,
      ...preparationInput(),
      now: STARTED_AT,
    });
    expect(hashFailed.ok).toBe(false);
    encode.mockRestore();

    // Der Entwurf blieb aktiv — ohne halbe Vorbereitung.
    const afterHash = await loadInvoiceDraftRecordByLocator(locator());
    expect(afterHash.ok).toBe(true);
    if (afterHash.ok) {
      expect(afterHash.record.status).toBe('active');
      expect(afterHash.record.preparationRawJson).toBeUndefined();
    }

    // (b) Ein widersprüchlicher Request wird vor jedem Schreiben abgelehnt.
    const wrongRequest = await beginInvoiceDraftFinalization({
      identity: identity(),
      expectedRevision: 1,
      clientInvoiceId: CLIENT_INVOICE_ID,
      contentFingerprint: FINGERPRINT,
      request: buildRequest({ workspaceId: WORKSPACE_B }),
      approvalContext: {},
      now: STARTED_AT,
    });
    expect(wrongRequest.ok).toBe(false);
    if (!wrongRequest.ok) {
      expect(['identity_mismatch', 'invalid_preparation']).toContain(wrongRequest.reason);
    }

    // (c) Datenbankzugriff scheitert — auch beim Laden der Vorbereitung.
    await seedFinalizing();
    const get = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(() => {
      throw new Error('simulierter Lesefehler');
    });
    const readFailed = await loadPreparation();
    expect(readFailed.ok).toBe(false);
    if (!readFailed.ok) {
      expect(['storage_unavailable', 'storage_failed', 'transaction_failed']).toContain(
        readFailed.reason,
      );
    }
    get.mockRestore();

    // (d) Die Nachprüfung nach dem Schreiben scheitert.
    await resetInvoiceDraftDurabilityDatabaseForTests();
    await seedRecord();
    let reads = 0;
    const laterRead = vi
      .spyOn(IDBObjectStore.prototype, 'get')
      .mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
        reads += 1;
        if (reads > 2) throw new Error('simulierter Nachprüfungsfehler');
        return (
          Object.getPrototypeOf(Object.getPrototypeOf(this)) as IDBObjectStore
        ).get.call(this, key);
      });
    const verifyFailed = await beginInvoiceDraftFinalization({
      identity: identity(),
      expectedRevision: 1,
      clientInvoiceId: CLIENT_INVOICE_ID,
      contentFingerprint: FINGERPRINT,
      ...preparationInput(),
      now: STARTED_AT,
    });
    expect(verifyFailed.ok).toBe(false);
    laterRead.mockRestore();

    const stillThere = await loadInvoiceDraftRecordByLocator(locator());
    expect(stillThere.ok).toBe(true);
  });

  it('K46: die lokale Rechnungs-ID muss die Client-Kennung sein', async () => {
    await seedRecord();
    await seedFinalizing();

    const diverging = await completeInvoiceDraftFinalization({
      identity: identity(),
      expectedRevision: 2,
      clientInvoiceId: CLIENT_INVOICE_ID,
      contentFingerprint: FINGERPRINT,
      finalizedInvoiceId: 'inv-2026-0007',
      archiveWarning: false,
      now: FINALIZED_AT,
    });
    expect(diverging.ok, JSON.stringify(diverging)).toBe(false);
    if (!diverging.ok) expect(diverging.reason).toBe('finalization_mismatch');

    // Der Datensatz wurde dabei nicht verändert.
    const unchanged = await loadInvoiceDraftRecordByLocator(locator());
    expect(unchanged.ok).toBe(true);
    if (unchanged.ok) {
      expect(unchanged.record.status).toBe('finalizing');
      expect(unchanged.record.revision).toBe(2);
      expect(unchanged.record.finalization?.finalizedInvoiceId).toBeUndefined();
    }

    // Mit der Client-Kennung gelingt derselbe Abschluss.
    const done = await completeInvoiceDraftFinalization({
      identity: identity(),
      expectedRevision: 2,
      clientInvoiceId: CLIENT_INVOICE_ID,
      contentFingerprint: FINGERPRINT,
      finalizedInvoiceId: CLIENT_INVOICE_ID,
      archiveWarning: false,
      now: FINALIZED_AT,
    });
    expect(done.ok, JSON.stringify(done)).toBe(true);
    if (done.ok) {
      expect(done.record.finalization?.finalizedInvoiceId).toBe(CLIENT_INVOICE_ID);
    }
  });
});

/* ========================================================================== *
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4A1 — Lebenszyklus und
 * Post-Commit-Vertrag. Keine automatische Reparatur, keine automatische
 * Löschung, kein Retry im Kern.
 * ========================================================================== */

describe('01P4A1 — Lebenszyklus und Post-Commit-Vertrag', () => {
  it('K47: finalizing verlangt exakt preparedFromRevision + 1', async () => {
    await seedRecord();
    await seedFinalizing();

    // Positivfall: die Gleichung gilt unmittelbar nach begin.
    const before = await loadPreparation(2);
    expect(before.ok, JSON.stringify(before)).toBe(true);
    if (!before.ok) return;
    expect(before.record.revision).toBe(before.preparation.preparedFromRevision + 1);

    // Manipuliert: Revision 20 bei preparedFromRevision 1.
    await mutateStoredRecord((record) => {
      record.revision = 20;
    });

    const loaded = await loadPreparation(20);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.reason).toBe('corrupt');
      expect(loaded.detail).toBe('revision');
    }

    const done = await completeInvoiceDraftFinalization({
      identity: identity(),
      expectedRevision: 20,
      clientInvoiceId: CLIENT_INVOICE_ID,
      contentFingerprint: FINGERPRINT,
      finalizedInvoiceId: CLIENT_INVOICE_ID,
      archiveWarning: false,
      now: FINALIZED_AT,
    });
    expect(done.ok).toBe(false);
    if (!done.ok) {
      expect(done.reason).toBe('corrupt');
      expect(done.detail).toBe('revision');
    }

    // Nichts repariert, keine Revision angepasst, nichts gelöscht.
    const stored = await peekStoredRecord();
    expect(stored?.revision).toBe(20);
    expect(stored?.status).toBe('finalizing');
  });

  it('K48: finalized verlangt exakt preparedFromRevision + 2', async () => {
    await seedRecord();
    await seedFinalized();

    const before = await loadPreparation(3);
    expect(before.ok, JSON.stringify(before)).toBe(true);
    if (!before.ok) return;
    expect(before.record.revision).toBe(before.preparation.preparedFromRevision + 2);

    await mutateStoredRecord((record) => {
      record.revision = 50;
    });

    const loaded = await loadPreparation(50);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.reason).toBe('corrupt');
      expect(loaded.detail).toBe('revision');
    }

    const stored = await peekStoredRecord();
    expect(stored?.revision).toBe(50);
    expect(stored?.status).toBe('finalized');
  });

  it('K49: preparedAt muss startedAt entsprechen', async () => {
    await seedRecord();
    await seedFinalizing();
    await rewritePreparation((preparation) => {
      preparation.preparedAt = '2026-08-20T13:00:00.000Z';
    });

    const loaded = await loadPreparation();
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.reason).toBe('corrupt');
      expect(loaded.detail).toBe('preparedAt');
    }

    const done = await completeInvoiceDraftFinalization({
      identity: identity(),
      expectedRevision: 2,
      clientInvoiceId: CLIENT_INVOICE_ID,
      contentFingerprint: FINGERPRINT,
      finalizedInvoiceId: CLIENT_INVOICE_ID,
      archiveWarning: false,
      now: FINALIZED_AT,
    });
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.reason).toBe('corrupt');

    // Keine aktuelle Uhrzeit als Reparatur.
    const stored = await peekStoredRecord();
    expect(stored?.status).toBe('finalizing');
    expect(stored?.finalization?.startedAt).toBe(STARTED_AT);
    expect(JSON.parse(stored?.preparationRawJson ?? '{}').preparedAt).toBe(
      '2026-08-20T13:00:00.000Z',
    );
  });

  it('K50: updatedAt ist an startedAt beziehungsweise finalizedAt gebunden', async () => {
    await seedRecord();
    await seedFinalizing();
    const finalizing = await loadInvoiceDraftRecordByLocator(locator());
    expect(finalizing.ok).toBe(true);
    if (finalizing.ok) expect(finalizing.record.updatedAt).toBe(STARTED_AT);

    await mutateStoredRecord((record) => {
      record.updatedAt = '2026-08-20T13:30:00.000Z';
    });
    const brokenFinalizing = await loadInvoiceDraftRecordByLocator(locator());
    expect(brokenFinalizing.ok).toBe(false);
    if (!brokenFinalizing.ok) expect(brokenFinalizing.reason).toBe('unsupported_format');

    await resetInvoiceDraftDurabilityDatabaseForTests();
    await seedRecord();
    await seedFinalized();
    const finalized = await loadInvoiceDraftRecordByLocator(locator());
    expect(finalized.ok).toBe(true);
    if (finalized.ok) expect(finalized.record.updatedAt).toBe(FINALIZED_AT);

    await mutateStoredRecord((record) => {
      record.updatedAt = STARTED_AT;
    });
    const brokenFinalized = await loadInvoiceDraftRecordByLocator(locator());
    expect(brokenFinalized.ok).toBe(false);
    if (!brokenFinalized.ok) expect(brokenFinalized.reason).toBe('unsupported_format');
  });

  it('K51: ein aktiver Entwurf darf keine Vorbereitungsfelder tragen', async () => {
    const cases: [string, (record: InvoiceDraftRecord) => void][] = [
      [
        'beide Felder',
        (record) => {
          record.preparationRawJson = '{"kind":"x"}';
          record.preparationSha256 = 'd'.repeat(64);
        },
      ],
      [
        'nur Rohtext',
        (record) => {
          record.preparationRawJson = '{"kind":"x"}';
        },
      ],
      [
        'nur Hash',
        (record) => {
          record.preparationSha256 = 'd'.repeat(64);
        },
      ],
    ];

    for (const [label, change] of cases) {
      await resetInvoiceDraftDurabilityDatabaseForTests();
      await seedRecord();
      await mutateStoredRecord(change);

      const loaded = await loadInvoiceDraftRecordByLocator(locator());
      expect(loaded.ok, label).toBe(false);
      if (!loaded.ok) expect(loaded.reason, label).toBe('unsupported_format');

      // save trägt einen solchen Datensatz nicht weiter.
      const saved = await saveInvoiceDraftRecord({
        identity: identity(),
        draft: buildDraft({ introText: 'Weitertragen verboten' }),
        expectedRevision: 1,
        now: LATER,
      });
      expect(saved.ok, label).toBe(false);

      const stored = await peekStoredRecord();
      expect(stored?.revision, label).toBe(1);
      expect(stored?.status, label).toBe('active');
    }
  });

  it('K52: Vorbereitungsfelder gelten nur gemeinsam; Legacy bleibt lesbar und gesperrt', async () => {
    // (a) Nur eines der beiden Felder ist ungültig.
    for (const [label, change] of [
      [
        'nur Rohtext',
        (record: InvoiceDraftRecord) => {
          delete record.preparationSha256;
        },
      ],
      [
        'nur Hash',
        (record: InvoiceDraftRecord) => {
          delete record.preparationRawJson;
        },
      ],
    ] as [string, (record: InvoiceDraftRecord) => void][]) {
      await resetInvoiceDraftDurabilityDatabaseForTests();
      await seedRecord();
      await seedFinalizing();
      await mutateStoredRecord(change);

      const loaded = await loadInvoiceDraftRecordByLocator(locator());
      expect(loaded.ok, label).toBe(false);
      if (!loaded.ok) expect(loaded.reason, label).toBe('unsupported_format');

      const stored = await peekStoredRecord();
      expect(stored?.status, label).toBe('finalizing');
    }

    // (b) Legacy-finalizing ohne beide Felder: lesbar, aber gesperrt.
    await resetInvoiceDraftDurabilityDatabaseForTests();
    await seedRecord();
    await seedFinalizing();
    await mutateStoredRecord((record) => {
      delete record.preparationRawJson;
      delete record.preparationSha256;
    });

    const legacyFinalizing = await loadInvoiceDraftRecordByLocator(locator());
    expect(legacyFinalizing.ok, JSON.stringify(legacyFinalizing)).toBe(true);
    if (legacyFinalizing.ok) expect(legacyFinalizing.record.status).toBe('finalizing');

    const preparation = await loadPreparation();
    expect(preparation.ok).toBe(false);
    if (!preparation.ok) {
      expect(preparation.reason).toBe('unsupported_preparation');
      expect(preparation.detail).toBe('missing');
    }

    const done = await completeInvoiceDraftFinalization({
      identity: identity(),
      expectedRevision: 2,
      clientInvoiceId: CLIENT_INVOICE_ID,
      contentFingerprint: FINGERPRINT,
      finalizedInvoiceId: CLIENT_INVOICE_ID,
      archiveWarning: false,
      now: FINALIZED_AT,
    });
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.reason).toBe('unsupported_preparation');

    const saved = await saveInvoiceDraftRecord({
      identity: identity(),
      draft: buildDraft({ introText: 'gesperrt' }),
      expectedRevision: 2,
      now: LATER,
    });
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.reason).toBe('status_conflict');

    // (c) Legacy-finalized ohne beide Felder: ebenso.
    await resetInvoiceDraftDurabilityDatabaseForTests();
    await seedRecord();
    await seedFinalized();
    await mutateStoredRecord((record) => {
      delete record.preparationRawJson;
      delete record.preparationSha256;
    });

    const legacyFinalized = await loadInvoiceDraftRecordByLocator(locator());
    expect(legacyFinalized.ok, JSON.stringify(legacyFinalized)).toBe(true);
    if (legacyFinalized.ok) expect(legacyFinalized.record.status).toBe('finalized');

    const finalizedPreparation = await loadPreparation(3);
    expect(finalizedPreparation.ok).toBe(false);
    if (!finalizedPreparation.ok) {
      expect(finalizedPreparation.reason).toBe('unsupported_preparation');
      expect(finalizedPreparation.detail).toBe('missing');
    }

    // Nichts gelöscht, nichts repariert.
    const stored = await peekStoredRecord();
    expect(stored?.status).toBe('finalized');
    expect(stored?.preparationRawJson).toBeUndefined();
  });

  it('K53: ein formal ungültiger Hashwert wird vor dem Schreiben abgelehnt', async () => {
    for (const bad of ['invalid-hash', 'abc', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
      await resetInvoiceDraftDurabilityDatabaseForTests();
      await seedRecord();
      hashState.override = bad;

      const begun = await beginInvoiceDraftFinalization({
        identity: identity(),
        expectedRevision: 1,
        clientInvoiceId: CLIENT_INVOICE_ID,
        contentFingerprint: FINGERPRINT,
        ...preparationInput(),
        now: STARTED_AT,
      });
      expect(begun.ok, bad).toBe(false);
      if (!begun.ok) {
        expect(begun.reason, bad).toBe('storage_failed');
        expect(begun.detail, bad).toBe('hash');
      }

      // create und save gelten einheitlich.
      const created = await createInvoiceDraftRecord({
        identity: identity({ vorgangId: VORGANG_B, draftId: 'draft-neu' }),
        draft: buildDraft({ id: 'draft-neu', vorgangId: VORGANG_B }),
        now: NOW,
      });
      expect(created.ok, bad).toBe(false);
      if (!created.ok) expect(created.reason, bad).toBe('storage_failed');

      const saved = await saveInvoiceDraftRecord({
        identity: identity(),
        draft: buildDraft({ introText: 'mit kaputtem Hash' }),
        expectedRevision: 1,
        now: LATER,
      });
      expect(saved.ok, bad).toBe(false);
      if (!saved.ok) expect(saved.reason, bad).toBe('storage_failed');

      hashState.override = null;
      const stored = await peekStoredRecord();
      expect(stored?.status, bad).toBe('active');
      expect(stored?.revision, bad).toBe(1);
      expect(stored?.preparationRawJson, bad).toBeUndefined();
    }
  });

  it('K54: Nachprüfungsfehler nach dem Commit von begin liefert committed_but_unverified', async () => {
    await seedRecord();

    // Vorprüfung und CAS-Transaktion gelingen; erst die Kontrolllesung wirft.
    const spy = failReadAfterCommit();
    const begun = await beginInvoiceDraftFinalization({
      identity: identity(),
      expectedRevision: 1,
      clientInvoiceId: CLIENT_INVOICE_ID,
      contentFingerprint: FINGERPRINT,
      ...preparationInput(),
      now: STARTED_AT,
    });
    spy.restore();

    expect(begun.ok, JSON.stringify(begun)).toBe(false);
    if (!begun.ok) expect(begun.reason).toBe('committed_but_unverified');

    // Der Stand ist dauerhaft vorhanden — kein zweiter Schreibversuch nötig.
    const reloaded = await loadInvoiceDraftRecordByLocator(locator());
    expect(reloaded.ok, JSON.stringify(reloaded)).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.record.status).toBe('finalizing');
    expect(reloaded.record.revision).toBe(2);
    expect(reloaded.record.finalization?.clientInvoiceId).toBe(CLIENT_INVOICE_ID);
    expect(reloaded.record.finalization?.contentFingerprint).toBe(FINGERPRINT);

    const preparation = await loadPreparation();
    expect(preparation.ok, JSON.stringify(preparation)).toBe(true);
    if (preparation.ok) {
      expect(preparation.preparation.request).toEqual(buildRequest());
      expect(preparation.preparation.approvalContext).toEqual(APPROVAL_CONTEXT);
    }
  });

  it('K55: Nachprüfungsfehler nach dem Commit von complete liefert committed_but_unverified', async () => {
    await seedRecord();
    await seedFinalizing();
    const before = await loadPreparation();
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const spy = failReadAfterCommit();
    const done = await completeInvoiceDraftFinalization({
      identity: identity(),
      expectedRevision: 2,
      clientInvoiceId: CLIENT_INVOICE_ID,
      contentFingerprint: FINGERPRINT,
      finalizedInvoiceId: CLIENT_INVOICE_ID,
      archiveWarning: false,
      now: FINALIZED_AT,
    });
    spy.restore();

    expect(done.ok, JSON.stringify(done)).toBe(false);
    if (!done.ok) expect(done.reason).toBe('committed_but_unverified');

    const reloaded = await loadInvoiceDraftRecordByLocator(locator());
    expect(reloaded.ok, JSON.stringify(reloaded)).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.record.status).toBe('finalized');
    expect(reloaded.record.revision).toBe(3);
    expect(reloaded.record.finalization?.finalizedInvoiceId).toBe(CLIENT_INVOICE_ID);
    expect(reloaded.record.preparationRawJson).toBe(before.record.preparationRawJson);
    expect(reloaded.record.preparationSha256).toBe(before.record.preparationSha256);
  });

  it('K56: Eingaben werden nicht mutiert und geladene Vorbereitungen bleiben getrennt', async () => {
    await seedRecord();

    const request = buildRequest();
    const approvalContext = JSON.parse(JSON.stringify(APPROVAL_CONTEXT)) as Record<
      string,
      unknown
    >;
    const requestBefore = JSON.stringify(request);
    const contextBefore = JSON.stringify(approvalContext);

    const begun = await beginInvoiceDraftFinalization({
      identity: identity(),
      expectedRevision: 1,
      clientInvoiceId: CLIENT_INVOICE_ID,
      contentFingerprint: FINGERPRINT,
      request,
      approvalContext,
      now: STARTED_AT,
    });
    expect(begun.ok, JSON.stringify(begun)).toBe(true);

    expect(JSON.stringify(request)).toBe(requestBefore);
    expect(JSON.stringify(approvalContext)).toBe(contextBefore);

    // Eine äußere Mutation der Eingabe wirkt nicht auf den gespeicherten Stand.
    (request.invoice as unknown as { id: string }).id = 'cinv-nachtraeglich';
    (approvalContext as { hinweis: string }).hinweis = 'nachträglich';

    const loaded = await loadPreparation();
    expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.preparation.request.invoice.id).toBe(CLIENT_INVOICE_ID);
    expect(loaded.preparation.approvalContext.hinweis).toBe(LONG_TEXT);

    // Und eine Mutation der geladenen Vorbereitung wirkt nicht zurück.
    (loaded.preparation.request as { vorgangId: string }).vorgangId = 'vg-manipuliert';
    const again = await loadPreparation();
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.preparation.request.vorgangId).toBe(VORGANG_A);
      expect(again.preparation).not.toBe(loaded.preparation);
    }
  });
});

/* ========================================================================== *
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4E2B — Auflösung einer
 * lokalen Operationskennung B auf eine kanonische Rechnungskennung A.
 *
 * Der Übergang hat **noch keine produktive Aufrufstelle**: es existiert kein
 * Serverausgang `existing_same_operation`. Er ist ausschließlich der lokale,
 * atomare Baustein dafür.
 * ========================================================================== */

const CANONICAL_INVOICE_ID = 'cinv-fremd-0002';
const CANONICAL_CLOUD_ID = 'cloud-row-e2b';
const CANONICAL_ROW_VERSION = 4;
const RESOLVED_AT = '2026-08-22T09:00:00.000Z';

function resolveInput(overrides: Record<string, unknown> = {}): Parameters<
  typeof resolveInvoiceDraftFinalizationToExisting
>[0] {
  return {
    identity: identity(),
    expectedRevision: 2,
    clientInvoiceId: CLIENT_INVOICE_ID,
    contentFingerprint: FINGERPRINT,
    finalizedInvoiceId: CANONICAL_INVOICE_ID,
    canonicalCloudInvoiceId: CANONICAL_CLOUD_ID,
    canonicalRowVersion: CANONICAL_ROW_VERSION,
    archiveWarning: false,
    now: RESOLVED_AT,
    ...overrides,
  } as Parameters<typeof resolveInvoiceDraftFinalizationToExisting>[0];
}

/** Frischer aktiver Datensatz plus begonnene Finalisierung (Revision 2). */
async function seedFinalizingFromScratch(): Promise<void> {
  await seedRecord();
  await seedFinalizing();
}

async function readRecord(): Promise<InvoiceDraftRecord> {
  const loaded = await loadInvoiceDraftRecord(identity());
  expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
  if (!loaded.ok) throw new Error('unerreichbar');
  return loaded.record;
}

describe('01P4E2B — Auflösung auf eine kanonische Fremdrechnung', () => {
  it('L1: der eigene Complete-Pfad bleibt unverändert und bedeutet own', async () => {
    await seedFinalizingFromScratch();
    const before = await readRecord();

    const done = await completeInvoiceDraftFinalization({
      identity: identity(),
      expectedRevision: 2,
      clientInvoiceId: CLIENT_INVOICE_ID,
      contentFingerprint: FINGERPRINT,
      finalizedInvoiceId: FINALIZED_INVOICE_ID,
      archiveWarning: false,
      now: FINALIZED_AT,
    });
    expect(done.ok, JSON.stringify(done)).toBe(true);

    const record = await readRecord();
    expect(record.status).toBe('finalized');
    expect(record.revision).toBe(3);
    expect(record.finalization?.finalizedInvoiceId).toBe(CLIENT_INVOICE_ID);
    // Ein eigener Grabstein trägt keine kanonischen Fremdfelder.
    expect(record.finalization?.canonicalCloudInvoiceId).toBeUndefined();
    expect(record.finalization?.canonicalRowVersion).toBeUndefined();
    expect(record.preparationRawJson).toBe(before.preparationRawJson);
    expect(record.preparationSha256).toBe(before.preparationSha256);

    // Ohne `resolution` gilt der Grabstein weiterhin als eigener Abschluss.
    expect(record.finalization?.resolution ?? 'own').toBe('own');

    // Der bestehende Complete öffnet sich nicht für fremde Kennungen.
    await resetInvoiceDraftDurabilityDatabaseForTests();
    await seedFinalizingFromScratch();
    const foreign = await completeInvoiceDraftFinalization({
      identity: identity(),
      expectedRevision: 2,
      clientInvoiceId: CLIENT_INVOICE_ID,
      contentFingerprint: FINGERPRINT,
      finalizedInvoiceId: CANONICAL_INVOICE_ID,
      archiveWarning: false,
      now: FINALIZED_AT,
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.reason).toBe('finalization_mismatch');
  });

  it('L2: der Fremdauflösungsweg schreibt einen terminalen Grabstein', async () => {
    await seedFinalizingFromScratch();

    const result = await resolveInvoiceDraftFinalizationToExisting(resolveInput());
    expect(result.ok, JSON.stringify(result)).toBe(true);

    const record = await readRecord();
    expect(record.status).toBe('finalized');
    expect(record.revision).toBe(3);
    expect(record.finalization?.clientInvoiceId).toBe(CLIENT_INVOICE_ID);
    expect(record.finalization?.finalizedInvoiceId).toBe(CANONICAL_INVOICE_ID);
    expect(record.finalization?.resolution).toBe('resolved_to_existing');
    expect(record.finalization?.canonicalCloudInvoiceId).toBe(CANONICAL_CLOUD_ID);
    expect(record.finalization?.canonicalRowVersion).toBe(CANONICAL_ROW_VERSION);
    expect(record.finalization?.finalizedAt).toBe(RESOLVED_AT);
    expect(record.finalization?.archiveWarning).toBe(false);
  });

  it('L3: Entwurf, Vorbereitung und Hashes bleiben bytegleich', async () => {
    await seedFinalizingFromScratch();
    const before = await readRecord();

    const result = await resolveInvoiceDraftFinalizationToExisting(resolveInput());
    expect(result.ok, JSON.stringify(result)).toBe(true);

    const after = await readRecord();
    expect(after.draftRawJson).toBe(before.draftRawJson);
    expect(after.draftSha256).toBe(before.draftSha256);
    expect(after.preparationRawJson).toBe(before.preparationRawJson);
    expect(after.preparationSha256).toBe(before.preparationSha256);
    expect(after.finalization?.clientInvoiceId).toBe(before.finalization?.clientInvoiceId);
    expect(after.finalization?.contentFingerprint).toBe(before.finalization?.contentFingerprint);
    expect(after.finalization?.startedAt).toBe(before.finalization?.startedAt);

    // Die Vorbereitung bleibt unverändert ladbar.
    const preparation = await loadInvoiceDraftFinalizationPreparation({
      identity: identity(),
      expectedRevision: 3,
    });
    expect(preparation.ok, JSON.stringify(preparation)).toBe(true);
    if (preparation.ok) {
      expect(preparation.preparation.request.clientInvoiceId).toBe(CLIENT_INVOICE_ID);
    }
  });

  it('L4: Eingaben werden ohne Coercion und ohne Default geprüft', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['finalizedInvoiceId fehlt', { finalizedInvoiceId: undefined }],
      ['finalizedInvoiceId leer', { finalizedInvoiceId: '' }],
      ['finalizedInvoiceId Whitespace', { finalizedInvoiceId: ` ${CANONICAL_INVOICE_ID} ` }],
      ['finalizedInvoiceId === B', { finalizedInvoiceId: CLIENT_INVOICE_ID }],
      ['canonicalCloudInvoiceId fehlt', { canonicalCloudInvoiceId: undefined }],
      ['canonicalCloudInvoiceId leer', { canonicalCloudInvoiceId: '' }],
      ['canonicalCloudInvoiceId Whitespace', { canonicalCloudInvoiceId: ' cloud ' }],
      ['canonicalRowVersion fehlt', { canonicalRowVersion: undefined }],
      ['canonicalRowVersion String', { canonicalRowVersion: '4' }],
      ['canonicalRowVersion 0', { canonicalRowVersion: 0 }],
      ['canonicalRowVersion negativ', { canonicalRowVersion: -1 }],
      ['canonicalRowVersion Bruch', { canonicalRowVersion: 4.5 }],
      ['canonicalRowVersion NaN', { canonicalRowVersion: Number.NaN }],
      ['canonicalRowVersion Infinity', { canonicalRowVersion: Number.POSITIVE_INFINITY }],
      ['finalizedAt leer', { now: '' }],
      ['archiveWarning falscher Typ', { archiveWarning: 'nein' }],
      ['falsche Operationskennung', { clientInvoiceId: 'cinv-anders' }],
      ['falscher contentFingerprint', { contentFingerprint: 'fp-anders' }],
    ];

    for (const [label, overrides] of cases) {
      await resetInvoiceDraftDurabilityDatabaseForTests();
      await seedRecord();
      await seedFinalizing();

      const result = await resolveInvoiceDraftFinalizationToExisting(resolveInput(overrides));
      expect(result.ok, label).toBe(false);

      const record = await readRecord();
      expect(record.status, label).toBe('finalizing');
      expect(record.revision, label).toBe(2);
    }
  });

  it('L5: der CAS-Übergang lehnt jeden abweichenden Ausgangsstand ohne Mutation ab', async () => {
    // Datensatz fehlt.
    await resetInvoiceDraftDurabilityDatabaseForTests();
    const missing = await resolveInvoiceDraftFinalizationToExisting(resolveInput());
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('not_found');

    // active statt finalizing.
    await resetInvoiceDraftDurabilityDatabaseForTests();
    await seedRecord();
    const active = await resolveInvoiceDraftFinalizationToExisting(resolveInput());
    expect(active.ok).toBe(false);
    if (!active.ok) expect(active.reason).toBe('status_conflict');

    // Falsche Ausgangsrevision.
    await seedFinalizing();
    const wrongRevision = await resolveInvoiceDraftFinalizationToExisting(
      resolveInput({ expectedRevision: 5 }),
    );
    expect(wrongRevision.ok).toBe(false);
    if (!wrongRevision.ok) expect(wrongRevision.reason).toBe('conflict');
    expect((await readRecord()).revision).toBe(2);

    // Fremde Identität.
    const foreignIdentity = await resolveInvoiceDraftFinalizationToExisting(
      resolveInput({ identity: identity({ vorgangId: 'vg-fremd' }) }),
    );
    expect(foreignIdentity.ok).toBe(false);

    // Erfolgreicher Erstübergang erhöht die Revision genau einmal.
    const first = await resolveInvoiceDraftFinalizationToExisting(resolveInput());
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect((await readRecord()).revision).toBe(3);

    // Ein bestehender eigener Grabstein wird nie überschrieben.
    await resetInvoiceDraftDurabilityDatabaseForTests();
    await seedRecord();
    await seedFinalized();
    const ownTombstone = await resolveInvoiceDraftFinalizationToExisting(
      resolveInput({ expectedRevision: 3 }),
    );
    expect(ownTombstone.ok).toBe(false);
    const still = await readRecord();
    expect(still.revision).toBe(3);
    expect(still.finalization?.finalizedInvoiceId).toBe(CLIENT_INVOICE_ID);
  });

  it('L6: dieselbe Auflösung wird idempotent bestätigt', async () => {
    await seedFinalizingFromScratch();
    const first = await resolveInvoiceDraftFinalizationToExisting(resolveInput());
    expect(first.ok, JSON.stringify(first)).toBe(true);

    const repeat = await resolveInvoiceDraftFinalizationToExisting(resolveInput());
    expect(repeat.ok, JSON.stringify(repeat)).toBe(true);

    const record = await readRecord();
    expect(record.revision).toBe(3);
    expect(record.finalization?.finalizedAt).toBe(RESOLVED_AT);
    expect(record.finalization?.finalizedInvoiceId).toBe(CANONICAL_INVOICE_ID);
  });

  it('L7: eine widersprüchliche Wiederholung wird blockiert', async () => {
    const conflicting: Array<[string, Record<string, unknown>]> = [
      ['andere finalizedInvoiceId', { finalizedInvoiceId: 'cinv-fremd-9999' }],
      ['andere Cloud-ID', { canonicalCloudInvoiceId: 'cloud-anders' }],
      ['andere rowVersion', { canonicalRowVersion: 9 }],
      ['andere Operationskennung', { clientInvoiceId: 'cinv-anders' }],
      ['anderer contentFingerprint', { contentFingerprint: 'fp-anders' }],
    ];

    for (const [label, overrides] of conflicting) {
      await resetInvoiceDraftDurabilityDatabaseForTests();
      await seedRecord();
      await seedFinalizing();
      const first = await resolveInvoiceDraftFinalizationToExisting(resolveInput());
      expect(first.ok, label).toBe(true);

      const conflict = await resolveInvoiceDraftFinalizationToExisting(resolveInput(overrides));
      expect(conflict.ok, label).toBe(false);

      const record = await readRecord();
      expect(record.revision, label).toBe(3);
      expect(record.finalization?.finalizedInvoiceId, label).toBe(CANONICAL_INVOICE_ID);
      expect(record.finalization?.canonicalCloudInvoiceId, label).toBe(CANONICAL_CLOUD_ID);
      expect(record.finalization?.canonicalRowVersion, label).toBe(CANONICAL_ROW_VERSION);
    }
  });

  it('L8: die Formatvalidierung bleibt rückwärtskompatibel und lehnt Halbformen ab', async () => {
    expect(INVOICE_DRAFT_FORMAT_VERSION).toBe(1);

    // Ein alter eigener Grabstein ohne resolution bleibt lesbar.
    await seedRecord();
    await seedFinalized();
    const legacy = await readRecord();
    expect(legacy.finalization?.resolution).toBeUndefined();

    const base = await (async () => {
      await resetInvoiceDraftDurabilityDatabaseForTests();
      await seedRecord();
      await seedFinalizing();
      const done = await resolveInvoiceDraftFinalizationToExisting(resolveInput());
      expect(done.ok, JSON.stringify(done)).toBe(true);
      return readRecord();
    })();

    const invalid: Array<[string, Record<string, unknown>]> = [
      ['resolved ohne A', { finalizedInvoiceId: undefined }],
      ['resolved ohne Cloud-ID', { canonicalCloudInvoiceId: undefined }],
      ['resolved ohne rowVersion', { canonicalRowVersion: undefined }],
      ['resolved mit rowVersion 0', { canonicalRowVersion: 0 }],
      ['A === B', { finalizedInvoiceId: CLIENT_INVOICE_ID }],
      ['unbekannter resolution-Wert', { resolution: 'irgendwas' }],
      ['eigener Grabstein mit Cloud-ID', { resolution: 'own', finalizedInvoiceId: CLIENT_INVOICE_ID }],
    ];

    for (const [label, overrides] of invalid) {
      await mutateStoredRecord((record) => {
        record.finalization = {
          ...base.finalization,
          ...overrides,
        } as InvoiceDraftRecord['finalization'];
      });
      const loaded = await loadInvoiceDraftRecord(identity());
      expect(loaded.ok, label).toBe(false);
      if (!loaded.ok) expect(loaded.reason, label).toBe('unsupported_format');
    }

    // Kanonische Felder dürfen bei finalizing nicht auftreten.
    await resetInvoiceDraftDurabilityDatabaseForTests();
    await seedRecord();
    await seedFinalizing();
    const finalizing = await readRecord();
    await mutateStoredRecord((record) => {
      record.finalization = {
        ...finalizing.finalization!,
        canonicalCloudInvoiceId: CANONICAL_CLOUD_ID,
        canonicalRowVersion: CANONICAL_ROW_VERSION,
      };
    });
    const early = await loadInvoiceDraftRecord(identity());
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.reason).toBe('unsupported_format');
  });

  it('L9: ein Nachprüfungsfehler nach dem Commit liefert committed_but_unverified', async () => {
    await seedFinalizingFromScratch();
    const spy = failReadAfterCommit();

    const result = await resolveInvoiceDraftFinalizationToExisting(resolveInput());
    spy.restore();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('committed_but_unverified');

    // Der Schreibvorgang war dennoch dauerhaft — die Wiederholung bestätigt ihn.
    const record = await readRecord();
    expect(record.status).toBe('finalized');
    expect(record.revision).toBe(3);
    expect(record.finalization?.finalizedInvoiceId).toBe(CANONICAL_INVOICE_ID);

    const repeat = await resolveInvoiceDraftFinalizationToExisting(resolveInput());
    expect(repeat.ok, JSON.stringify(repeat)).toBe(true);
    expect((await readRecord()).revision).toBe(3);
  });

  /*
   * L10 prüft ausschließlich die tatsächliche Architekturgrenze: der Kern darf
   * keinen externen Zustand lesen. Eine Kommentarformulierung ist kein
   * Sicherheitsbeweis und wird deshalb nicht geprüft. Die Reihenfolge „erst A
   * lokal persistieren, dann Grabstein" ist ein Vertrag des Aufrufers und wird
   * erst im späteren Coordinator-Sprint end-to-end geprüft.
   */
  it('L10: der Kern liest keinen externen Zustand', async () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/services/invoice/invoiceDraftDurabilityService.ts'),
      'utf8',
    );

    // Konkrete Importmuster — keine frei vorkommenden Wörter.
    for (const moduleName of ['persistenceService', 'vorgangService']) {
      expect(
        new RegExp(`(import[^;]*from\\s*['"][^'"]*${moduleName}['"])|(import\\(['"][^'"]*${moduleName}['"]\\))`).test(
          source,
        ),
        moduleName,
      ).toBe(false);
    }

    // Konkretes Aufrufmuster statt bloßer Zeichenkette.
    expect(/\bbuildPersistedStateSnapshot\s*\(/.test(source)).toBe(false);
  });

  it('L10b: es gibt kein Eingabefeld canonicalInvoicePersisted', () => {
    const input: ResolveInvoiceDraftFinalizationToExistingInput = {
      identity: identity(),
      expectedRevision: 2,
      clientInvoiceId: CLIENT_INVOICE_ID,
      contentFingerprint: FINGERPRINT,
      finalizedInvoiceId: CANONICAL_INVOICE_ID,
      canonicalCloudInvoiceId: CANONICAL_CLOUD_ID,
      canonicalRowVersion: CANONICAL_ROW_VERSION,
      archiveWarning: false,
      // @ts-expect-error Der Kern nimmt keine Persistenzzusicherung entgegen.
      canonicalInvoicePersisted: true,
    };
    expect(input.finalizedInvoiceId).toBe(CANONICAL_INVOICE_ID);
  });
});
