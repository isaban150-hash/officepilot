import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { hydrateCompanyProfileStore } from '../services/companyProfileService';
import { AppProvider } from '../context/AppContext';
import { RechnungPage } from './RechnungPage';
import { createTestVorgangWithExecutedQuantity } from '../test/fixtures';
import { hydrateVorgangStore } from '../services/vorgangService';
import {
  loadInvoiceDraftRecordByLocator,
  resetInvoiceDraftDurabilityDatabaseForTests,
} from '../services/invoice/invoiceDraftDurabilityService';
import { defaultInvoiceDraftDurabilityAdapter } from '../services/invoice/useInvoiceDraftDurabilitySession';
import * as coordinator from '../services/invoice/invoiceFinalizationCoordinator';
import * as scopeService from '../services/storage/storageScopeService';
import * as workspacePayload from '../services/workspace/workspaceSyncPayloadService';
import type { CompanyProfile, InvoiceDraft } from '../types/models';

/**
 * COMPANY-PROFILE-DRAFT-DRIFT-01E2 — was wird **wirklich** finalisiert?
 *
 * Der Nachweis aus 01E zeigte nur, dass die Finalisierung einmal angestossen
 * wurde. Das genügt nicht: Der Coordinator bekommt gar keinen Entwurf
 * übergeben, sondern ausschliesslich Identität und `expectedRevision` — den
 * Entwurf liest er selbst aus dem dauerhaften Speicher.
 *
 * Also muss **beides** stimmen: der gespeicherte Stand **und** die erwartete
 * Revision. Diese Suite liest deshalb im Augenblick des Coordinator-Aufrufs
 * den echten Datensatz aus IndexedDB und vergleicht ihn mit dem, was übergeben
 * wurde.
 */

const WORKSPACE = 'ws-drift-truth';
const VORGANG = 'vg-drift-truth';

type Mount = { container: HTMLDivElement; root: Root };

const PROFILE_A: CompanyProfile = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Alpha Betrieb GmbH',
  legalForm: 'GmbH',
  street: 'Alphaweg 1',
  zip: '11111',
  city: 'Alphastadt',
  taxNumber: '11/111/11111',
  vatId: 'DE111111111',
  bankName: 'Alpha Bank',
  iban: 'DE11 1111 1111 1111 1111 11',
  bic: 'ALPHADEFFXXX',
  defaultPaymentDays: 14,
};

const PROFILE_B: CompanyProfile = {
  ...PROFILE_A,
  companyName: 'Beta Betrieb GmbH & Co. KG',
  legalForm: 'GmbH & Co. KG',
  street: 'Betaweg 2',
  zip: '22222',
  city: 'Betastadt',
  taxNumber: '22/222/22222',
  vatId: 'DE222222222',
  bankName: 'Beta Bank',
  iban: 'DE22 2222 2222 2222 2222 22',
  bic: 'BETADEFFXXX',
  /* Diese drei dürfen die Übernahme **nicht** mitziehen. */
  defaultPaymentDays: 30,
  phone: '0000 999999',
  invoiceFooterNotes: 'Beta-Fußnote',
};

/** Was im Augenblick des Coordinator-Aufrufs tatsächlich gespeichert war. */
interface Beobachtung {
  expectedRevision: number;
  persistedRevision: number | null;
  persistedDraft: InvoiceDraft | null;
}

let beobachtungen: Beobachtung[] = [];

async function settle(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

async function waitFor(check: () => boolean, rounds = 80): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

async function renderPage(): Promise<Mount> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[`/vorgaenge/${VORGANG}/rechnung?type=abschlag`]}>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <Routes>
            <Route path="/vorgaenge/:id/rechnung" element={<RechnungPage />} />
            <Route
              path="/vorgaenge/:id/rechnungen/:invoiceId"
              element={<div data-testid="invoice-detail" />}
            />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
    await Promise.resolve();
  });
  const mount = { container, root };
  await waitFor(() => container.querySelector('[data-testid="rechnung-page"]') !== null);
  return mount;
}

function q<T extends HTMLElement>(mount: Mount, testId: string): T | null {
  return mount.container.querySelector<T>(`[data-testid="${testId}"]`);
}

async function click(mount: Mount, testId: string): Promise<void> {
  const el = q<HTMLButtonElement>(mount, testId);
  expect(el, `${testId} fehlt`).not.toBeNull();
  await act(async () => {
    el!.click();
    await Promise.resolve();
  });
  await settle();
}

async function fillServicePeriod(mount: Mount): Promise<void> {
  const setValue = (element: HTMLInputElement, value: string): void => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const from = q<HTMLInputElement>(mount, 'invoice-service-period-from');
  const to = q<HTMLInputElement>(mount, 'invoice-service-period-to');
  if (!from || !to) return;
  await act(async () => {
    setValue(from, '2026-08-01');
    await Promise.resolve();
  });
  await act(async () => {
    setValue(to, '2026-08-20');
    await Promise.resolve();
  });
  await settle();
  if (q(mount, 'invoice-confirm-service-period')) {
    await click(mount, 'invoice-confirm-service-period');
  }
}

async function gotoPreview(mount: Mount): Promise<void> {
  if (q(mount, 'invoice-apply-all-positions')) await click(mount, 'invoice-apply-all-positions');
  await fillServicePeriod(mount);
  if (q(mount, 'invoice-continue-preview')) await click(mount, 'invoice-continue-preview');
}

function unmount(mount: Mount): void {
  act(() => mount.root.unmount());
  mount.container.remove();
}

beforeEach(async () => {
  vi.restoreAllMocks();
  localStorage.clear();
  beobachtungen = [];
  await resetInvoiceDraftDurabilityDatabaseForTests();
  hydrateVorgangStore([createTestVorgangWithExecutedQuantity({ id: VORGANG, invoices: [] })]);
  scopeService.setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE });
  hydrateCompanyProfileStore({ ...PROFILE_A });
  vi.spyOn(workspacePayload, 'resolveCloudWorkspaceId').mockReturnValue(WORKSPACE);

  /*
   * Der Kern dieser Suite: Statt nur zu zählen, liest der Doppelgänger im
   * Augenblick des Aufrufs den echten Datensatz aus dem dauerhaften Speicher.
   */
  vi.spyOn(coordinator, 'startInvoiceDraftFinalization').mockImplementation(
    async (input: Parameters<typeof coordinator.startInvoiceDraftFinalization>[0]) => {
      const loaded = await loadInvoiceDraftRecordByLocator({
        sourceScopeKey: input.identity.sourceScopeKey,
        workspaceId: input.identity.workspaceId,
        vorgangId: input.identity.vorgangId,
        invoiceType: input.identity.invoiceType,
      });
      beobachtungen.push({
        expectedRevision: input.expectedRevision,
        persistedRevision: loaded.ok ? loaded.record.revision : null,
        persistedDraft: loaded.ok ? loaded.draft : null,
      });
      return {
        ok: false,
        reason: 'offline_or_unconfigured',
        recovery: 'retry_allowed',
        cloudState: 'not_committed',
      } as never;
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('01E2 — welcher Snapshot wird tatsächlich finalisiert?', () => {
  it('I1/I3/I4/I6: „Übernehmen" finalisiert Stand B — und nur die kritischen Felder', async () => {
    const mount = await renderPage();
    await gotoPreview(mount);

    const vorher = beobachtungen.length;
    hydrateCompanyProfileStore({ ...PROFILE_B });
    await click(mount, 'invoice-approve');
    expect(q(mount, 'invoice-company-drift-confirm'), 'Rückfrage fehlt').not.toBeNull();
    await click(mount, 'invoice-company-drift-apply');
    await settle();

    /* I6 — genau ein Finalisierungsvorgang. */
    expect(beobachtungen.length - vorher).toBe(1);
    const gesehen = beobachtungen.at(-1)!;
    const draft = gesehen.persistedDraft;
    expect(draft, 'kein dauerhaft gespeicherter Entwurf zur Finalisierung').not.toBeNull();

    /* Die erwartete Revision muss zum gespeicherten Stand passen. */
    expect(
      gesehen.expectedRevision,
      `expectedRevision ${gesehen.expectedRevision} passt nicht zum gespeicherten Stand ${gesehen.persistedRevision}`,
    ).toBe(gesehen.persistedRevision);

    /* I1 — die kritischen Felder tragen B. */
    expect(draft!.companySnapshot.companyName).toBe(PROFILE_B.companyName);
    expect(draft!.companySnapshot.legalForm).toBe(PROFILE_B.legalForm);
    expect(draft!.companySnapshot.street).toBe(PROFILE_B.street);
    expect(draft!.companySnapshot.zip).toBe(PROFILE_B.zip);
    expect(draft!.companySnapshot.city).toBe(PROFILE_B.city);
    expect(draft!.companySnapshot.taxNumber).toBe(PROFILE_B.taxNumber);
    expect(draft!.companySnapshot.vatId).toBe(PROFILE_B.vatId);
    expect(draft!.companySnapshot.iban).toBe(PROFILE_B.iban);
    expect(draft!.companySnapshot.bankName).toBe(PROFILE_B.bankName);
    expect(draft!.companySnapshot.bic).toBe(PROFILE_B.bic);

    /* I3 — alles andere bleibt bei A. */
    expect(draft!.companySnapshot.defaultPaymentDays).toBe(PROFILE_A.defaultPaymentDays);
    expect(draft!.companySnapshot.phone).toBe(PROFILE_A.phone);
    expect(draft!.companySnapshot.invoiceFooterNotes).toBe(PROFILE_A.invoiceFooterNotes);

    /* I4 und die Rechnungsentscheidungen des Entwurfs. */
    expect(draft!.brandingSnapshot).toEqual({ version: 1 });
    expect(draft!.servicePeriodFrom).toBe('2026-08-01');
    expect(draft!.servicePeriodTo).toBe('2026-08-20');
    expect(draft!.servicePeriodConfirmed).toBe(true);
    expect(draft!.positions.length).toBeGreaterThan(0);
    expect(draft!.positions.some((p) => p.quantity > 0)).toBe(true);
    unmount(mount);
  }, 40_000);

  it('I2/I7: „Behalten" finalisiert weiterhin Stand A', async () => {
    const mount = await renderPage();
    await gotoPreview(mount);

    hydrateCompanyProfileStore({ ...PROFILE_B });
    await click(mount, 'invoice-approve');
    await click(mount, 'invoice-company-drift-keep');
    await settle();

    expect(beobachtungen.length).toBe(1);
    const gesehen = beobachtungen[0]!;
    expect(gesehen.expectedRevision).toBe(gesehen.persistedRevision);
    const snapshot = gesehen.persistedDraft!.companySnapshot;
    expect(snapshot.companyName).toBe(PROFILE_A.companyName);
    expect(snapshot.iban).toBe(PROFILE_A.iban);
    expect(snapshot.taxNumber).toBe(PROFILE_A.taxNumber);
    expect(snapshot.vatId).toBe(PROFILE_A.vatId);
    expect(snapshot.companyName).not.toBe(PROFILE_B.companyName);
    unmount(mount);
  }, 40_000);

  it('I8: Drift und Übermenge ergeben zusammen genau einen Finalisierungsvorgang', async () => {
    const mount = await renderPage();
    await gotoPreview(mount);

    hydrateCompanyProfileStore({ ...PROFILE_B });
    await click(mount, 'invoice-approve');
    expect(beobachtungen.length, 'vor der Firmendatenfrage darf nichts laufen').toBe(0);
    await click(mount, 'invoice-company-drift-keep');

    if (q(mount, 'invoice-approve-anyway')) {
      expect(beobachtungen.length, 'vor der Übermengenfrage darf nichts laufen').toBe(0);
      await click(mount, 'invoice-approve-anyway');
    }
    expect(beobachtungen.length).toBe(1);
    unmount(mount);
  }, 40_000);
});

describe('01E2 — I5: Persistenzfehler beim Übernehmen', () => {
  it('ein gescheiterter Speicherlauf verhindert die Finalisierung', async () => {
    const mount = await renderPage();
    await gotoPreview(mount);

    /*
     * Ab jetzt scheitert jeder Speicherlauf — der Apply-Pfad läuft hinein.
     *
     * Gesetzt wird am **Adapter-Objekt**, nicht am Modulexport: Die Sitzung
     * hält seit ihrer Erzeugung eine direkte Funktionsreferenz, ein Spion auf
     * dem Export erreichte sie nicht.
     */
    vi.spyOn(defaultInvoiceDraftDurabilityAdapter, 'save').mockResolvedValue({
      ok: false,
      reason: 'storage_failed',
    } as never);

    hydrateCompanyProfileStore({ ...PROFILE_B });
    await click(mount, 'invoice-approve');
    await click(mount, 'invoice-company-drift-apply');
    await settle(40);

    expect(beobachtungen.length, 'trotz Speicherfehler finalisiert').toBe(0);
    expect(q(mount, 'invoice-detail'), 'trotz Speicherfehler navigiert').toBeNull();
    unmount(mount);
  }, 40_000);
});

describe('01E2 — I10: eine erneute Profiländerung wird erneut erkannt', () => {
  it('nach „Behalten" gegen B wird C wieder gemeldet', async () => {
    const mount = await renderPage();
    await gotoPreview(mount);

    hydrateCompanyProfileStore({ ...PROFILE_B });
    await click(mount, 'invoice-approve');
    await click(mount, 'invoice-company-drift-keep');
    expect(beobachtungen.length).toBe(1);

    /* Ein neuer Stand C — die Bestätigung von eben gilt dafür nicht. */
    hydrateCompanyProfileStore({ ...PROFILE_B, companyName: 'Gamma Betrieb GmbH' });
    await click(mount, 'invoice-approve');

    expect(q(mount, 'invoice-company-drift-confirm'), 'C wurde nicht erneut erkannt').not.toBeNull();
    expect(q(mount, 'invoice-company-drift-fields')?.textContent).toContain('Firmenname');
    unmount(mount);
  }, 40_000);
});
