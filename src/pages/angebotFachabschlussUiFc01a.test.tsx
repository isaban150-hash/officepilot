/**
 * FINANZ-CORE-01A — Fachabschluss Angebote, Oberfläche (ANG-12, ANG-14, ANG-16 … ANG-19).
 *
 *  U12a ein Neurendern während der Ablage verliert ihr Ergebnis nicht (Effekt an der Kennung)
 *  U12b fehlgeschlagene Ablage: Hinweis mit „Erneut ablegen"; der zweite Versuch legt ab
 *  U13  bekannte, aber fehlende Ablage: eigener Hinweis mit „Erneut prüfen"
 *  U14  Annahme abgelehnt: übersetzte Meldung ohne Rohtext des Servers
 *  U16  Einzelpreis: eine dritte Nachkommastelle ist nicht tippbar, Tausenderpunkte bleiben es
 *  U17  Menge 0: Hinweis an der Position
 *  U18  die Angebotsliste liest nach einer Änderung im Speicher neu
 *  U19  Auftragskopf: Summe mit Bezug (bei Annahme, brutto); mit Nachträgen der aktuelle Netto-Wert
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../context/AppContext';
import { createCompanyProfileFromSetup } from '../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../data/mockData';
import { t } from '../i18n';
import { NumericInput } from '../components/ui/NumericInput';
import { VorgangOrderFactsCard } from '../components/vorgang/VorgangOrderFactsCard';
import { hydrateCompanyProfileStore, resetCompanyProfile } from '../services/companyProfileService';
import { resetDocuments } from '../services/documentService';
import { persistAll } from '../services/persistenceService';
import * as offerArchive from '../services/offer/offerArchiveService';
import type { OfferArchiveResult } from '../services/offer/offerArchiveService';
import * as offerAccept from '../services/offer/offerAcceptCloudService';
import { finalizeOfferWithCloud } from '../services/offer/offerFinalizeCloudService';
import { addOfferDraft, getOfferById, resetOffers } from '../services/offer/offerService';
import { resetSyncChangeTrackerForTests } from '../services/sync/syncChangeTrackerService';
import { resetSyncClientForTests } from '../services/sync/syncClientService';
import { hydrateSyncOutbox } from '../services/sync/syncOutboxService';
import { hydrateWorkspaceStore, resetWorkspaceStore } from '../services/workspace/workspaceStore';
import { clearMockRpcHandlers, registerMockRpcHandler } from '../test/mockProfileStore';
import { createOrderPosition, createTestVorgang } from '../test/fixtures';
import { alsInhaber } from '../test/workspaceRoleTestUtils';
import type { CompanyDocument, ConfirmedOrderAmendment } from '../types/models';
import { AngebotDetailPage } from './AngebotDetailPage';
import { AngebotEditorPage } from './AngebotEditorPage';
import { AngebotePage } from './AngebotePage';

const WORKSPACE = '2e49b0a1-dbee-4649-aa4e-68064d52c8f5';

function entwurf(): string {
  const r = addOfferDraft(WORKSPACE, {
    customerId: 'cust-1',
    customer: { name: 'Muster Baustoffe GmbH', contactPerson: '', street: 'Musterweg 1', zip: '33602', city: 'Bielefeld', email: 'kunde@example.invalid', phone: '' },
    title: 'Badsanierung EG',
    baustelle: 'Musterweg 1, Bielefeld',
    positions: [{ id: 'p1', description: 'Demontage', quantity: 4, unit: 'Stunden', unitPrice: 55 }],
    taxStatus: 'standard_19',
    offerDate: '2026-10-01',
    validUntil: '2099-12-31',
  } as never);
  if (!r.success) throw new Error('Entwurf fehlt');
  return r.offer.id;
}

async function freigegebenesAngebot(): Promise<string> {
  const id = entwurf();
  registerMockRpcHandler('finalize_workspace_offer', (args) => {
    const payload = {
      ...(args.p_payload as Record<string, unknown>),
      status: 'freigegeben',
      offerNumber: 'AN-2026-0001',
      offerSequenceNumber: 1,
      contentFingerprint: args.p_fingerprint,
      finalizedAt: '2026-10-01T10:00:00.000Z',
    };
    const row = {
      workspace_id: WORKSPACE,
      client_offer_id: String(args.p_offer_id),
      client_customer_id: 'cust-1',
      offer_number: 'AN-2026-0001',
      offer_sequence_number: 1,
      status: 'freigegeben',
      payload,
      row_version: 2,
      deleted: false,
      deleted_at: null,
      updated_at: '2026-10-01T10:00:00.000Z',
    };
    return { row, row_version: 2, replayed: false };
  });
  const fin = await finalizeOfferWithCloud(id);
  if (!fin.ok) throw new Error(`Freigabe im Test fehlgeschlagen: ${JSON.stringify(fin)}`);
  hydrateSyncOutbox([]);
  return id;
}

function ablageDokument(offerId: string): CompanyDocument {
  return {
    id: offerArchive.buildOfferArchiveDocumentId(offerId),
    title: 'AN-2026-0001 – Angebot',
    category: 'sonstiges',
    classifiedKind: 'angebot',
    linkedOfferId: offerId,
    issuer: 'Beispiel Haustechnik GmbH',
    recognizedText: '',
    issueDate: '2026-10-01',
    validUntil: null,
    digitalFolder: { id: 'dig-offer', name: 'Angebote', path: '/Angebote/' },
    paperFolder: { folderId: 'paper-kunden', register: 'Sonstiges', label: 'Kunden' },
    tags: [],
    linkedCompany: 'Muster Baustoffe GmbH',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-10-01T10:00:00.000Z',
  } as CompanyDocument;
}

let container: HTMLDivElement;
let root: Root | null = null;

const warte = () => new Promise((r) => setTimeout(r, 0));

async function zeige(path: string, routePath: string, element: Parameters<typeof createElement>[0]): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(
          AppProvider,
          { initialSetup: DEFAULT_SETUP },
          createElement(Routes, null, createElement(Route, { path: routePath, element: createElement(element as never) })),
        ),
      ),
    );
  });
  await act(async () => {
    await warte();
  });
}

const el = (id: string) => container.querySelector(`[data-testid="${id}"]`);

async function klick(id: string): Promise<void> {
  const knopf = el(id) as HTMLButtonElement | null;
  if (!knopf) throw new Error(`fehlt: ${id}`);
  await act(async () => {
    knopf.click();
    await warte();
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  resetOffers();
  resetDocuments();
  resetCompanyProfile();
  resetSyncChangeTrackerForTests();
  hydrateSyncOutbox([]);
  clearMockRpcHandlers();
  offerArchive.resetOfferArchiveForTests();
  resetWorkspaceStore();
  hydrateWorkspaceStore({ workspace: { id: WORKSPACE, name: 'Test', ownerUserId: 'user-1' } as never });
  resetSyncClientForTests({
    deviceId: 'device-test',
    workspaceId: WORKSPACE,
    serverWorkspaceId: WORKSPACE,
    createdAt: '2026-09-01T00:00:00.000Z',
    syncPolicy: 'cloud_ready',
  });
  hydrateCompanyProfileStore({
    ...createCompanyProfileFromSetup(DEFAULT_SETUP),
    companyName: 'Beispiel Haustechnik GmbH',
    street: 'Musterstrasse 5',
    zip: '33602',
    city: 'Bielefeld',
  });
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
  clearMockRpcHandlers();
  vi.restoreAllMocks();
});

describe('ANG-12 / ANG-13 — Ablage auf der Detailseite', () => {
  it('U12a: ein Neurendern während der Ablage verliert ihr Ergebnis nicht', async () => {
    const id = await freigegebenesAngebot();
    alsInhaber();
    let loese: (r: OfferArchiveResult) => void = () => undefined;
    const ablage = vi
      .spyOn(offerArchive, 'ensureOfferArchived')
      .mockImplementation(() => new Promise<OfferArchiveResult>((resolve) => { loese = resolve; }));
    await zeige(`/angebote/${id}`, '/angebote/:offerId', AngebotDetailPage);
    expect(el('offer-archive-pending')).not.toBeNull();

    // Ein Abgleich/Speichern rendert die Seite neu — bisher verwarf das das Ergebnis der Ablage.
    await act(async () => {
      persistAll();
      await warte();
    });
    await act(async () => {
      loese({ ok: true, document: ablageDokument(id), created: true });
      await warte();
    });
    expect(el('offer-archive-open')).not.toBeNull();
    expect(el('offer-archive-pending')).toBeNull();
    expect(ablage).toHaveBeenCalledTimes(1);
  });

  it('U12b: fehlgeschlagene Ablage — „Erneut ablegen" legt im zweiten Versuch ab', async () => {
    const id = await freigegebenesAngebot();
    alsInhaber();
    const ablage = vi
      .spyOn(offerArchive, 'ensureOfferArchived')
      .mockResolvedValueOnce({ ok: false, reason: 'pdf_failed' })
      .mockResolvedValueOnce({ ok: true, document: ablageDokument(id), created: true });
    await zeige(`/angebote/${id}`, '/angebote/:offerId', AngebotDetailPage);

    expect(el('offer-archive-failed')?.textContent).toContain(t('offer.detail.archiveFailed', 'de'));
    expect(el('offer-archive-retry')?.textContent).toBe(t('offer.detail.archiveRetry', 'de'));
    await klick('offer-archive-retry');
    expect(ablage).toHaveBeenCalledTimes(2);
    expect(el('offer-archive-failed')).toBeNull();
    expect(el('offer-archive-open')).not.toBeNull();
  });

  it('U13: bekannte, aber fehlende Ablage — eigener Hinweis, „Erneut prüfen"', async () => {
    const id = await freigegebenesAngebot();
    alsInhaber();
    vi.spyOn(offerArchive, 'ensureOfferArchived').mockResolvedValue({ ok: false, reason: 'archive_missing' });
    await zeige(`/angebote/${id}`, '/angebote/:offerId', AngebotDetailPage);
    expect(el('offer-archive-failed')?.textContent).toContain(t('offer.detail.archiveMissing', 'de'));
    expect(el('offer-archive-retry')?.textContent).toBe(t('offer.detail.archiveRecheck', 'de'));
  });
});

describe('ANG-14 — Annahme ohne Rohtext', () => {
  it('U14: abgelehnte Annahme zeigt die übersetzte Meldung, nicht den Servertext', async () => {
    const id = await freigegebenesAngebot();
    alsInhaber();
    vi.spyOn(offerArchive, 'ensureOfferArchived').mockResolvedValue({ ok: false, reason: 'pdf_failed' });
    vi.spyOn(offerAccept, 'acceptOfferWithCloud').mockResolvedValue({
      ok: false,
      reason: 'server_rejected',
      message: 'Angebot kann im Zustand storniert nicht angenommen werden',
    });
    await zeige(`/angebote/${id}`, '/angebote/:offerId', AngebotDetailPage);
    await klick('offer-accept');
    await klick('offer-accept-confirm');
    const fehler = el('offer-accept-error')?.textContent ?? '';
    expect(fehler).toBe(t('offer.accept.notAcceptable', 'de'));
    expect(fehler).not.toContain('Zustand storniert');
    expect(getOfferById(id)?.status).toBe('freigegeben');
  });
});

describe('ANG-16 / ANG-17 — Editor', () => {
  function tippeIn(input: HTMLInputElement, text: string): void {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    act(() => input.focus());
    if (text === '') {
      act(() => {
        setter.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      return;
    }
    for (let length = 1; length <= text.length; length += 1) {
      act(() => {
        setter.call(input, text.slice(0, length));
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
  }

  it('U16: höchstens zwei Nachkommastellen — die dritte wird abgewiesen, Tausenderpunkte bleiben tippbar', () => {
    const werte: number[] = [];
    root = createRoot(container);
    act(() => {
      root!.render(
        createElement(NumericInput, {
          id: 'preis',
          mode: 'decimal',
          strict: true,
          maxFractionDigits: 2,
          value: 0,
          onChange: (value: number) => werte.push(value),
          'data-testid': 'preis',
        }),
      );
    });
    const input = el('preis') as HTMLInputElement;
    tippeIn(input, '12,345');
    expect(input.value).toBe('12,34');
    expect(werte.at(-1)).toBe(12.34);

    tippeIn(input, '');
    tippeIn(input, '1.200,50');
    expect(input.value).toBe('1.200,50');
    expect(werte.at(-1)).toBe(1200.5);
  });

  it('U16: der Angebotseditor begrenzt den Einzelpreis auf Cent', () => {
    alsInhaber();
    root = createRoot(container);
    act(() => {
      root!.render(
        createElement(
          MemoryRouter,
          { initialEntries: ['/angebote/neu'] },
          createElement(
            AppProvider,
            { initialSetup: DEFAULT_SETUP },
            createElement(Routes, null, createElement(Route, { path: '/angebote/neu', element: createElement(AngebotEditorPage) })),
          ),
        ),
      );
    });
    const preis = el('offer-position-0-unit-price') as HTMLInputElement;
    tippeIn(preis, '2,015');
    expect(preis.value).toBe('2,01');
  });

  it('U17: Menge 0 — Hinweis an der Position', () => {
    alsInhaber();
    root = createRoot(container);
    act(() => {
      root!.render(
        createElement(
          MemoryRouter,
          { initialEntries: ['/angebote/neu'] },
          createElement(
            AppProvider,
            { initialSetup: DEFAULT_SETUP },
            createElement(Routes, null, createElement(Route, { path: '/angebote/neu', element: createElement(AngebotEditorPage) })),
          ),
        ),
      );
    });
    expect(el('offer-position-0-zero-hint')).toBeNull();
    tippeIn(el('offer-position-0-quantity') as HTMLInputElement, '');
    expect(el('offer-position-0-zero-hint')?.textContent).toBe(t('offer.editor.positionZeroHint', 'de'));
  });
});

describe('ANG-18 — Angebotsliste', () => {
  it('U18: die Liste liest nach einer Änderung im Speicher neu', async () => {
    await zeige('/angebote', '/angebote', AngebotePage);
    expect(el('offer-empty')).not.toBeNull();
    let id = '';
    await act(async () => {
      id = entwurf(); // speichert (persistAll) — wie ein Abzug aus der Cloud
      await warte();
    });
    expect(el(`offer-row-${id}`)).not.toBeNull();
  });
});

describe('ANG-19 / F-04 — Auftragskopf', () => {
  function karte(vorgang: ReturnType<typeof createTestVorgang>): void {
    root = createRoot(container);
    act(() => {
      root!.render(
        createElement(
          MemoryRouter,
          null,
          createElement(AppProvider, { initialSetup: DEFAULT_SETUP }, createElement(VorgangOrderFactsCard, { vorgang })),
        ),
      );
    });
  }

  const nachtrag = {
    cloudId: 'cloud-n1',
    clientAmendmentId: 'n1',
    vorgangId: 'v-test-1',
    sequenceNo: 1,
    status: 'confirmed',
    title: 'Mehrleistung',
    positions: [{ id: 'op-n1', changeType: 'add', description: 'Zusatz', plannedQuantity: 2, unit: 'Stunden', unitPrice: 50 }],
    contentFingerprint: 'fp',
    confirmedAt: '2026-10-05T10:00:00.000Z',
    confirmedBy: 'user-1',
    rowVersion: 1,
  } as unknown as ConfirmedOrderAmendment;

  it('U19: Summe bei Annahme (brutto); ohne Nachtrag kein zweiter Wert', () => {
    karte(
      createTestVorgang({
        orderNumber: 'AU-2026-0001',
        sourceOfferId: 'offer-1',
        sourceOfferNumber: 'AN-2026-0001',
        contractTotals: { subtotal: 360, taxRate: 19, tax: 68.4, total: 428.4 },
        orderPositions: [createOrderPosition({ plannedQuantity: 4, unitPrice: 90 })],
      } as never),
    );
    expect(container.textContent).toContain(t('vorgang.order.totalAtAcceptance', 'de'));
    expect(el('vorgang-order-total')?.textContent).toContain('428,40');
    expect(el('vorgang-order-current-net')).toBeNull();
  });

  it('U19: mit bestätigtem Nachtrag zusätzlich der aktuelle Netto-Auftragswert; manueller Auftrag „bei Anlage"', () => {
    karte(
      createTestVorgang({
        orderNumber: 'AU-2026-0002',
        contractTotals: { subtotal: 360, taxRate: 19, tax: 68.4, total: 428.4 },
        orderPositions: [
          createOrderPosition({ plannedQuantity: 4, unitPrice: 90 }),
          createOrderPosition({ id: 'op-n1', description: 'Zusatz', plannedQuantity: 2, unitPrice: 50, sourceAmendmentId: 'n1' }),
        ],
        confirmedOrderAmendments: [nachtrag],
      } as never),
    );
    expect(container.textContent).toContain(t('vorgang.order.totalAtCreation', 'de'));
    expect(container.textContent).toContain(t('vorgang.order.currentNet', 'de'));
    expect(el('vorgang-order-current-net')?.textContent).toContain('460,00');
  });
});
