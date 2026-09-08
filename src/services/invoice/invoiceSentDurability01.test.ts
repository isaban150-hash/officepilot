/**
 * INVOICE-SENT-CLOUD-DURABILITY-01B
 *
 * Zwei Lücken, ein Block:
 *
 *   1. Scheiterte der Cloud-Write nach „als versendet markieren", blieb nur
 *      ein flüchtiger React-Hinweis. Nach dem nächsten Rendern war er weg, und
 *      die Abweichung wurde nie wieder erkannt.
 *   2. Der Pull hob den Status monoton auf `versendet` an, übernahm bei einer
 *      bereits lokal bekannten Rechnung aber `sentAt`/`sentVia` nicht. Auf dem
 *      Zweitgerät entstand „Versendet — Datum —".
 *
 * Der Versandsatz ist korrigierbar. Deshalb gibt es keine „lokal gewinnt
 * immer"-Regel: Divergenz wird erkannt und dem Menschen vorgelegt, nie
 * automatisch aufgelöst. Kein Netzwerk — der Supabase-Client wird ersetzt.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Vorgang, VorgangInvoice } from '../../types/models';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { createTestVorgang } from '../../test/fixtures';
import {
  applyFinalizedInvoiceToVorgang,
  applyInvoiceSentSnapshotFromCloud,
  getVorgangInvoice,
  hydrateVorgangStore,
} from '../vorgangService';
import {
  deriveInvoiceSentCloudState,
  readInvoiceSentStateFromCloud,
  syncInvoiceSentToCloud,
} from '../invoiceSentService';
import { readInvoiceSentSnapshot, sentSnapshotsEqual } from './invoiceSentSnapshot';
import {
  WorkspaceInvoiceCloudError,
  rpcGetWorkspaceInvoiceSent,
} from './workspaceInvoiceCloudService';

const WORKSPACE = '00000000-0000-4000-8000-000000000077';
const VORGANG_ID = 'v-test-1';
const INVOICE_ID = 'inv-sent-dur-1';

const companySnapshot = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Beispiel Betrieb GmbH',
  street: 'Werkstraße 2',
  zip: '54321',
  city: 'Beispielstadt',
};

function invoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: INVOICE_ID,
    number: '2026-0012',
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-test-1',
        description: 'Beispielleistung',
        quantity: 8,
        unit: 'Stunden',
        unitPrice: 65,
        lineTotal: 520,
      },
    ],
    subtotal: 520,
    taxStatus: 'standard_19',
    amount: 618.8,
    status: 'vorbereitet',
    date: '2026-09-06',
    createdAt: '2026-09-06T10:00:00.000Z',
    issueDate: '2026-09-06',
    servicePeriodFrom: '2026-09-01',
    servicePeriodTo: '2026-09-05',
    servicePeriodConfirmed: true,
    paymentDueDate: '2099-09-20',
    customerSnapshot: {
      name: 'M5 Testbau GmbH',
      contactPerson: '',
      street: 'Musterweg 1',
      zip: '12345',
      city: 'Beispielstadt',
      email: '',
      phone: '',
    },
    companySnapshot,
    legalNotices: [],
    previousAbschlagDeductions: [],
    paymentStatus: 'offen',
    payments: [],
    ...overrides,
  };
}

/** Vollständig versendet: Status, Datum und Weg gemeinsam. */
function sent(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return invoice({
    status: 'versendet',
    sentAt: '2026-09-10',
    sentVia: 'email',
    ...overrides,
  });
}

function seed(inv: VorgangInvoice): Vorgang {
  const vorgang = createTestVorgang({ id: VORGANG_ID, invoices: [inv] });
  hydrateVorgangStore([vorgang]);
  return vorgang;
}

/* -------------------------------------------------------------------------- */
/* Der vollständige Snapshot als einzige Definition                            */
/* -------------------------------------------------------------------------- */

describe('SENT-DUR-01B — was ein vollständiger Versandsatz ist', () => {
  it('S20a: Status, gültiges Datum und gültiger Weg gemeinsam', () => {
    expect(readInvoiceSentSnapshot(sent())).toEqual({
      sentAt: '2026-09-10',
      sentVia: 'email',
    });
    expect(readInvoiceSentSnapshot(sent({ sentNote: 'Per Mail' }))).toEqual({
      sentAt: '2026-09-10',
      sentVia: 'email',
      sentNote: 'Per Mail',
    });
  });

  it('S20b: alles Unvollständige ist kein Versandsatz', () => {
    for (const broken of [
      invoice(),
      sent({ sentAt: undefined }),
      sent({ sentVia: undefined }),
      sent({ sentAt: '10.09.2026' }),
      sent({ sentAt: '2026-02-30' }),
      sent({ sentVia: 'taube' as never }),
      invoice({ status: 'vorbereitet', sentAt: '2026-09-10', sentVia: 'email' }),
    ]) {
      expect(readInvoiceSentSnapshot(broken), JSON.stringify(broken.sentAt)).toBeNull();
    }
  });

  it('S27a: eine fehlende Notiz ist etwas anderes als eine gesetzte', () => {
    const a = { sentAt: '2026-09-10', sentVia: 'email' as const };
    expect(sentSnapshotsEqual(a, { ...a })).toBe(true);
    expect(sentSnapshotsEqual(a, { ...a, sentNote: 'x' })).toBe(false);
    expect(sentSnapshotsEqual({ ...a, sentNote: 'x' }, { ...a, sentNote: 'y' })).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Zustandsableitung                                                           */
/* -------------------------------------------------------------------------- */

describe('SENT-DUR-01B — abgeleiteter Cloud-Zustand', () => {
  const local = { sentAt: '2026-09-10', sentVia: 'email' as const };

  it('S10: identische Stände sind synchron', () => {
    expect(
      deriveInvoiceSentCloudState(local, { found: true, snapshot: { ...local } }).kind,
    ).toBe('synced');
  });

  it('S4: lokal versendet, Cloud leer → pending', () => {
    expect(deriveInvoiceSentCloudState(local, { found: true, snapshot: null }).kind).toBe(
      'pending',
    );
  });

  it('S11/S12/S13/S27: jede echte Abweichung ist ein Konflikt', () => {
    for (const cloud of [
      { ...local, sentAt: '2026-09-11' },
      { ...local, sentVia: 'post' as const },
      { ...local, sentNote: 'Von Gerät B' },
    ]) {
      const state = deriveInvoiceSentCloudState(local, { found: true, snapshot: cloud });
      expect(state.kind, JSON.stringify(cloud)).toBe('conflict');
      if (state.kind !== 'conflict') continue;
      expect(state.cloud).toEqual(cloud);
    }

    // Lokal gelöschte Notiz gegen eine noch vorhandene Cloud-Notiz.
    const removed = deriveInvoiceSentCloudState(local, {
      found: true,
      snapshot: { ...local, sentNote: 'alte Notiz' },
    });
    expect(removed.kind).toBe('conflict');
  });

  it('S19: nur die Cloud hat einen Versandsatz → lokal übernehmbar', () => {
    const state = deriveInvoiceSentCloudState(null, { found: true, snapshot: { ...local } });
    expect(state.kind).toBe('cloud_only');
  });

  it('S9: fehlt die Cloud-Rechnung, gibt es nichts zu sichern', () => {
    expect(deriveInvoiceSentCloudState(local, { found: false, snapshot: null }).kind).toBe(
      'missing',
    );
  });

  it('beide Seiten ohne Versand ist kein Sonderzustand', () => {
    expect(deriveInvoiceSentCloudState(null, { found: true, snapshot: null }).kind).toBe('synced');
  });
});

/* -------------------------------------------------------------------------- */
/* Cloud-Read                                                                  */
/* -------------------------------------------------------------------------- */

describe('SENT-DUR-01B — schmaler Einzelread', () => {
  it('S25a: der Read fragt genau eine Rechnung, keine Liste', async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const client = {
      rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return {
          data: {
            found: true,
            invoice_status: 'versendet',
            sent_at: '2026-09-10',
            sent_via: 'email',
            sent_note: null,
          },
          error: null,
        };
      }),
    } as never;

    const result = await rpcGetWorkspaceInvoiceSent(
      { workspaceId: WORKSPACE, clientInvoiceId: INVOICE_ID },
      { client },
    );

    expect(result).toEqual({
      found: true,
      snapshot: { sentAt: '2026-09-10', sentVia: 'email' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('get_workspace_invoice_sent');
    expect(Object.keys(calls[0].args).sort()).toEqual(['p_client_invoice_id', 'p_workspace_id']);
    expect(calls.some((c) => c.name === 'pull_workspace_invoices')).toBe(false);
  });

  it('S21/S22: ein unvollständiger Cloud-Stand ist kein Versandsatz', async () => {
    for (const raw of [
      { found: true, invoice_status: 'versendet', sent_at: null, sent_via: 'email' },
      { found: true, invoice_status: 'versendet', sent_at: '2026-09-10', sent_via: null },
      { found: true, invoice_status: 'versendet', sent_at: '2026-09-10', sent_via: 'taube' },
      { found: true, invoice_status: 'vorbereitet', sent_at: '2026-09-10', sent_via: 'email' },
    ]) {
      const client = { rpc: vi.fn(async () => ({ data: raw, error: null })) } as never;
      const result = await rpcGetWorkspaceInvoiceSent(
        { workspaceId: WORKSPACE, clientInvoiceId: INVOICE_ID },
        { client },
      );
      expect(result.snapshot, JSON.stringify(raw)).toBeNull();
      expect(result.found).toBe(true);
    }
  });

  it('S9b: eine unbekannte Rechnung meldet found=false', async () => {
    const client = {
      rpc: vi.fn(async () => ({ data: { found: false, sent_at: null }, error: null })),
    } as never;
    expect(
      await rpcGetWorkspaceInvoiceSent(
        { workspaceId: WORKSPACE, clientInvoiceId: INVOICE_ID },
        { client },
      ),
    ).toEqual({ found: false, snapshot: null });
  });

  it('S8: ein Serverfehler wird zum Cloud-Fehler, nicht zu "nicht versendet"', async () => {
    const client = {
      rpc: vi.fn(async () => ({ data: null, error: { message: 'Kein Zugriff auf Workspace' } })),
    } as never;
    await expect(
      rpcGetWorkspaceInvoiceSent(
        { workspaceId: WORKSPACE, clientInvoiceId: INVOICE_ID },
        { client },
      ),
    ).rejects.toBeInstanceOf(WorkspaceInvoiceCloudError);
  });
});

/* -------------------------------------------------------------------------- */
/* Reconciliation über den Dienst                                              */
/* -------------------------------------------------------------------------- */

describe('SENT-DUR-01B — Reconciliation', () => {
  beforeEach(() => seed(sent()));

  it('S8b: ein nicht erreichbarer Read ergibt "unbekannt", keine Behauptung', async () => {
    const state = await readInvoiceSentStateFromCloud(VORGANG_ID, INVOICE_ID);
    expect(state.kind).toBe('unknown');
  });

  it('S7: ohne eingerichtete Cloud wird nicht gelesen', async () => {
    const supabase = await import('../../lib/supabase');
    const spy = vi.spyOn(supabase, 'isSupabaseConfigured').mockReturnValue(false);
    try {
      expect((await readInvoiceSentStateFromCloud(VORGANG_ID, INVOICE_ID)).kind).toBe(
        'not_configured',
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('S25b: der Read verändert die lokale Rechnung nicht', async () => {
    const before = JSON.stringify(getVorgangInvoice(VORGANG_ID, INVOICE_ID));
    await readInvoiceSentStateFromCloud(VORGANG_ID, INVOICE_ID);
    expect(JSON.stringify(getVorgangInvoice(VORGANG_ID, INVOICE_ID))).toBe(before);
  });

  it('S5/S15: „Jetzt sichern" nutzt dieselbe bestehende Write-RPC', async () => {
    const cloud = await import('./workspaceInvoiceCloudService');
    const spy = vi
      .spyOn(cloud, 'rpcUpdateWorkspaceInvoiceSent')
      .mockResolvedValue({} as never);
    try {
      expect(await syncInvoiceSentToCloud(VORGANG_ID, INVOICE_ID)).toBe('synced');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({
        clientInvoiceId: INVOICE_ID,
        sentAt: '2026-09-10',
        sentVia: 'email',
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('S2: ein Cloud-Fehler lässt die lokalen Versanddaten unberührt', async () => {
    const cloud = await import('./workspaceInvoiceCloudService');
    const spy = vi
      .spyOn(cloud, 'rpcUpdateWorkspaceInvoiceSent')
      .mockRejectedValue(new Error('offline'));
    try {
      expect(await syncInvoiceSentToCloud(VORGANG_ID, INVOICE_ID)).toBe('failed');
      const local = getVorgangInvoice(VORGANG_ID, INVOICE_ID)!;
      expect(local.status).toBe('versendet');
      expect(local.sentAt).toBe('2026-09-10');
      expect(local.sentVia).toBe('email');
    } finally {
      spy.mockRestore();
    }
  });

  it('S3/S18: nach einem Neustart wird die Abweichung neu berechnet', async () => {
    /*
     * Kein persistierter Marker: Der lokale Versandsatz steht im Speicher, der
     * Cloud-Stand kommt frisch aus dem Read. Es gibt nichts, das ein Neustart
     * verlieren könnte.
     */
    hydrateVorgangStore([]);
    seed(sent());
    const local = readInvoiceSentSnapshot(getVorgangInvoice(VORGANG_ID, INVOICE_ID)!);
    expect(deriveInvoiceSentCloudState(local, { found: true, snapshot: null }).kind).toBe(
      'pending',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Ausdrückliche Übernahme des Online-Standes                                   */
/* -------------------------------------------------------------------------- */

describe('SENT-DUR-01B — Online-Stand übernehmen', () => {
  it('S16: der Cloud-Versandsatz wird lokal vollständig übernommen', () => {
    seed(sent({ sentNote: 'lokale Notiz' }));
    const result = applyInvoiceSentSnapshotFromCloud(VORGANG_ID, INVOICE_ID, {
      sentAt: '2026-09-11',
      sentVia: 'post',
      sentNote: 'Von Gerät B',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.sentAt).toBe('2026-09-11');
    expect(result.invoice.sentVia).toBe('post');
    expect(result.invoice.sentNote).toBe('Von Gerät B');
    expect(result.invoice.status).toBe('versendet');
  });

  it('S28: fehlt die Cloud-Notiz, verschwindet die lokale', () => {
    seed(sent({ sentNote: 'lokale Notiz' }));
    const result = applyInvoiceSentSnapshotFromCloud(VORGANG_ID, INVOICE_ID, {
      sentAt: '2026-09-11',
      sentVia: 'post',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.sentNote).toBeUndefined();
    expect('sentNote' in result.invoice).toBe(false);
  });

  it('S16b: kein anderes Rechnungsfeld wird verändert', () => {
    seed(sent({ archiveDocumentId: 'doc-1' }));
    const before = getVorgangInvoice(VORGANG_ID, INVOICE_ID)!;
    const result = applyInvoiceSentSnapshotFromCloud(VORGANG_ID, INVOICE_ID, {
      sentAt: '2026-09-11',
      sentVia: 'post',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const strip = (inv: VorgangInvoice) => {
      const { sentAt: _a, sentVia: _b, sentNote: _c, status: _d, ...rest } = inv;
      return JSON.stringify(rest);
    };
    expect(strip(result.invoice)).toBe(strip(before));
  });

  it('S17: ein unvollständiger Snapshot wird abgewiesen', () => {
    seed(sent());
    for (const broken of [
      { sentAt: '', sentVia: 'email' as const },
      { sentAt: '2026-02-30', sentVia: 'email' as const },
      { sentAt: '2026-09-11', sentVia: 'taube' as never },
    ]) {
      const result = applyInvoiceSentSnapshotFromCloud(VORGANG_ID, INVOICE_ID, broken);
      expect(result.ok).toBe(false);
    }
    // Der lokale Stand ist unversehrt.
    expect(getVorgangInvoice(VORGANG_ID, INVOICE_ID)?.sentAt).toBe('2026-09-10');
  });
});

/* -------------------------------------------------------------------------- */
/* Pull/Merge-Integrität                                                       */
/* -------------------------------------------------------------------------- */

describe('SENT-DUR-01B — Merge erzeugt keinen halben Versand', () => {
  it('S19b: Cloud versendet + lokal vorbereitet → Status und Daten gemeinsam', () => {
    const vorgang = createTestVorgang({ id: VORGANG_ID, invoices: [invoice()] });
    const applied = applyFinalizedInvoiceToVorgang(
      vorgang,
      sent({ sentNote: 'Von Gerät B' }),
    );

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.invoice.status).toBe('versendet');
    expect(applied.invoice.sentAt).toBe('2026-09-10');
    expect(applied.invoice.sentVia).toBe('email');
    expect(applied.invoice.sentNote).toBe('Von Gerät B');
  });

  it('S21b/S22b: ein kaputter Cloud-Versand hebt den Status nicht an', () => {
    for (const broken of [
      sent({ sentAt: undefined }),
      sent({ sentVia: undefined }),
      sent({ sentAt: '10.09.2026' }),
    ]) {
      const vorgang = createTestVorgang({ id: VORGANG_ID, invoices: [invoice()] });
      const applied = applyFinalizedInvoiceToVorgang(vorgang, broken);
      expect(applied.ok).toBe(true);
      if (!applied.ok) continue;

      /*
       * Der Kern des zweiten Befunds: Niemals „Versendet — Datum —".
       * Lieber weiter „vorbereitet" als ein halber Versand.
       */
      expect(applied.invoice.status).toBe('vorbereitet');
      expect(readInvoiceSentSnapshot(applied.invoice)).toBeNull();
    }
  });

  it('S23: ein abweichender Cloud-Versand überschreibt den lokalen nicht', () => {
    const vorgang = createTestVorgang({ id: VORGANG_ID, invoices: [sent()] });
    const applied = applyFinalizedInvoiceToVorgang(
      vorgang,
      sent({ sentAt: '2026-09-11', sentVia: 'post', sentNote: 'Von Gerät B' }),
    );

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.invoice.sentAt).toBe('2026-09-10');
    expect(applied.invoice.sentVia).toBe('email');
    expect(applied.invoice.sentNote).toBeUndefined();
    expect(applied.action).toBe('noop');
  });

  it('S24: ein leerer Cloud-Versand löscht den lokalen nicht', () => {
    const vorgang = createTestVorgang({ id: VORGANG_ID, invoices: [sent()] });
    const applied = applyFinalizedInvoiceToVorgang(vorgang, invoice());

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.invoice.status).toBe('versendet');
    expect(applied.invoice.sentAt).toBe('2026-09-10');
  });

  it('S20c: eine lokal beschädigte Rechnung wird durch einen vollständigen Cloud-Stand geheilt', () => {
    // status versendet ohne Daten — genau das, was der alte Merge erzeugen konnte.
    const brokenLocal = invoice({ status: 'versendet' });
    const vorgang = createTestVorgang({ id: VORGANG_ID, invoices: [brokenLocal] });
    const applied = applyFinalizedInvoiceToVorgang(vorgang, sent());

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(readInvoiceSentSnapshot(applied.invoice)).toEqual({
      sentAt: '2026-09-10',
      sentVia: 'email',
    });
  });
});
