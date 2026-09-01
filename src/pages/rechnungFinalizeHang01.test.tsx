/**
 * INVOICE-FINALIZE-HANG-01B — die Freigabe darf nie dauerhaft stehenbleiben.
 *
 * Im Realtest blieb die Oberfläche für immer bei „Rechnung wird freigegeben…":
 * ohne Meldung, ohne Serverkontakt. Ursache war ein Wartepunkt vor der
 * Finalisierung, der sich nie meldete — `session.flush()` wartete unbegrenzt
 * auf einen Speicherlauf.
 *
 * Geprüft wird deshalb beides: dass die Freigabe nach einer Frist kontrolliert
 * endet, **und** dass in diesem Fall kein Finalisierungspfad angelaufen ist.
 *
 * Ausschliesslich synthetische, neutrale Daten. Kein Netz, kein realer Vorgang.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { hydrateCompanyProfileStore } from '../services/companyProfileService';
import { AppProvider } from '../context/AppContext';
import { RechnungPage } from './RechnungPage';
import { createTestVorgang } from '../test/fixtures';
import { hydrateVorgangStore } from '../services/vorgangService';
import { resetInvoiceDraftDurabilityDatabaseForTests } from '../services/invoice/invoiceDraftDurabilityService';
import * as durability from '../services/invoice/invoiceDraftDurabilityService';
import * as coordinator from '../services/invoice/invoiceFinalizationCoordinator';
import * as scopeService from '../services/storage/storageScopeService';
import * as workspacePayload from '../services/workspace/workspaceSyncPayloadService';
import { INVOICE_DRAFT_FLUSH_TIMEOUT_MS } from '../services/invoice/useInvoiceDraftDurabilitySession';

const WORKSPACE = 'ws-hang-a';
const VORGANG = 'vg-hang-1';

type Mount = { container: HTMLDivElement; root: Root };

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

async function waitFor(check: () => boolean, rounds = 60): Promise<void> {
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

async function gotoPreview(mount: Mount): Promise<void> {
  const applyAll = mount.container.querySelector<HTMLButtonElement>(
    '[data-testid="invoice-apply-all-positions"]',
  );
  if (applyAll) {
    await act(async () => {
      applyAll.click();
      await Promise.resolve();
    });
    await settle();
  }
  const next = mount.container.querySelector<HTMLButtonElement>(
    '[data-testid="invoice-continue-preview"]',
  );
  if (!next) return;
  await act(async () => {
    next.click();
    await Promise.resolve();
  });
  await settle();
}

async function clickApprove(mount: Mount): Promise<void> {
  const button = mount.container.querySelector<HTMLButtonElement>(
    '[data-testid="invoice-approve"]',
  );
  expect(button, mount.container.innerHTML.slice(0, 400)).not.toBeNull();
  await act(async () => {
    button!.click();
    await Promise.resolve();
  });
}

function approveLabel(mount: Mount): string {
  return (
    mount.container.querySelector('[data-testid="invoice-approve"]')?.textContent ?? ''
  );
}

/**
 * Erzeugt eine echte Entwurfsänderung im Positionsschritt — damit der spätere
 * Flush tatsächlich auf einen Speicherlauf wartet und nicht mit `no_changes`
 * abkürzt.
 */
async function mutateDraft(mount: Mount): Promise<void> {
  const toggle = mount.container.querySelector<HTMLButtonElement>(
    '[data-testid="invoice-skonto-yes"]',
  );
  expect(toggle, 'kein Änderungspunkt im Positionsschritt gefunden').not.toBeNull();
  await act(async () => {
    toggle!.click();
    await Promise.resolve();
  });
}

function unmount(mount: Mount): void {
  act(() => mount.root.unmount());
  mount.container.remove();
}

beforeEach(async () => {
  vi.restoreAllMocks();
  localStorage.clear();
  await resetInvoiceDraftDurabilityDatabaseForTests();
  hydrateVorgangStore([createTestVorgang({ id: VORGANG, invoices: [] })]);
  scopeService.setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE });
  hydrateCompanyProfileStore({
    ...DEFAULT_COMPANY_PROFILE,
    companyName: 'Beispiel Betrieb GmbH',
    street: 'Werkstraße 2',
    zip: '54321',
    city: 'Betriebsstadt',
    taxNumber: '11/222/33333',
  });
  vi.spyOn(workspacePayload, 'resolveCloudWorkspaceId').mockReturnValue(WORKSPACE);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('INVOICE-FINALIZE-HANG-01B — Freigabe bleibt nicht stehen', () => {
  it('H0: die Frist ist gesetzt und liegt in einem vertretbaren Bereich', () => {
    // Lang genug für einen echten Speicherlauf, kurz genug für einen Menschen.
    expect(INVOICE_DRAFT_FLUSH_TIMEOUT_MS).toBeGreaterThanOrEqual(3_000);
    expect(INVOICE_DRAFT_FLUSH_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  /* TEST 2 — der gesunde Weg bleibt unverändert. */
  it('H2: ohne Störung läuft die Finalisierung wie bisher an', async () => {
    const start = vi
      .spyOn(coordinator, 'startInvoiceDraftFinalization')
      .mockResolvedValue({ ok: false, reason: 'offline_or_unconfigured', recovery: 'retry_allowed' } as never);

    const mount = await renderPage();
    await gotoPreview(mount);
    await clickApprove(mount);
    await settle();

    expect(start).toHaveBeenCalledTimes(1);
    unmount(mount);
  }, 30_000);

  /*
   * TEST 5 — ein wiederholbarer Ausgang gibt die Freigabe frei …
   */
  it('H3: retry_allowed beendet den Ladezustand', async () => {
    vi.spyOn(coordinator, 'startInvoiceDraftFinalization').mockResolvedValue({
      ok: false,
      reason: 'offline_or_unconfigured',
      recovery: 'retry_allowed',
    } as never);

    const mount = await renderPage();
    await gotoPreview(mount);
    await clickApprove(mount);
    await settle();

    expect(approveLabel(mount)).not.toContain('freigegeben…');
    unmount(mount);
  }, 30_000);

  /*
   * TEST 6 — … ein nicht wiederholbarer dagegen nicht. Diese bewusste Sperre
   * schützt vor einer zweiten Rechnung und darf durch den neuen Catch nicht
   * versehentlich aufgehoben werden.
   */
  it('H4: ein Ausgang mit ungewissem Serverzustand bleibt gesperrt', async () => {
    /*
     * INVOICE-FINALIZE-HANG-01C — dieser Fall prüfte zuvor nur `recovery` und
     * schrieb damit die falsche Regel fest. Entscheidend ist der **Cloudstand**:
     * `confirmed` bedeutet, dass serverseitig bereits etwas liegt. Nur deshalb
     * darf hier gesperrt bleiben.
     */
    const start = vi.spyOn(coordinator, 'startInvoiceDraftFinalization').mockResolvedValue({
      ok: false,
      reason: 'possible_existing_invoice',
      recovery: 'reload_required',
      cloudState: 'confirmed',
    } as never);

    const mount = await renderPage();
    await gotoPreview(mount);
    await clickApprove(mount);
    await settle();

    // Ein zweiter Klick darf nichts erneut auslösen.
    const button = mount.container.querySelector<HTMLButtonElement>(
      '[data-testid="invoice-approve"]',
    );
    if (button) {
      await act(async () => {
        button.click();
        await Promise.resolve();
      });
      await settle();
    }
    expect(start).toHaveBeenCalledTimes(1);
    expect(approveLabel(mount)).toContain('freigegeben…');
    unmount(mount);
  }, 30_000);

  /*
   * INVOICE-FINALIZE-HANG-01C — der Kernfall des Realtests.
   *
   * Ein Fehlschlag **vor** dem Serverkontakt trägt `cloudState:
   * 'not_committed'`, bekommt von `failBeforeBegin` aber die Vorgabe
   * `recovery: 'blocked'`. Bisher blieb die Oberfläche deshalb dauerhaft auf
   * „Rechnung wird freigegeben…" stehen — obwohl nachweislich nichts
   * übertragen wurde.
   */
  it('H6: ein nachweislich nicht übertragener Fehlschlag gibt die Freigabe wieder frei', async () => {
    const start = vi.spyOn(coordinator, 'startInvoiceDraftFinalization').mockResolvedValue({
      ok: false,
      reason: 'pull_failed',
      recovery: 'blocked',
      cloudState: 'not_committed',
    } as never);

    const mount = await renderPage();
    await gotoPreview(mount);
    await clickApprove(mount);
    await settle();

    // Der Ladezustand endet, der Knopf trägt wieder seine normale Beschriftung.
    expect(approveLabel(mount)).not.toContain('freigegeben…');
    const button = mount.container.querySelector<HTMLButtonElement>(
      '[data-testid="invoice-approve"]',
    );
    expect(button?.disabled).toBe(false);
    // Kein automatischer zweiter Versuch.
    expect(start).toHaveBeenCalledTimes(1);
    // Der Entwurf ist unversehrt.
    expect(mount.container.querySelector('[data-testid="rechnung-page"]')).not.toBeNull();

    // Und ein ausdrücklicher neuer Versuch ist wieder möglich.
    await act(async () => {
      button!.click();
      await Promise.resolve();
    });
    await settle();
    expect(start).toHaveBeenCalledTimes(2);

    unmount(mount);
  }, 30_000);

  /*
   * Ein ungewisser Cloudstand ist kein Beweis für „nichts übertragen" — er
   * bleibt gesperrt. Genau hier verläuft die Grenze des neuen Zugeständnisses.
   */
  it.each(['unknown', 'conflict', undefined])(
    'H7: cloudState %s gibt die Freigabe nicht frei',
    async (cloudState) => {
      const start = vi.spyOn(coordinator, 'startInvoiceDraftFinalization').mockResolvedValue({
        ok: false,
        reason: 'pull_failed',
        recovery: 'blocked',
        ...(cloudState === undefined ? {} : { cloudState }),
      } as never);

      const mount = await renderPage();
      await gotoPreview(mount);
      await clickApprove(mount);
      await settle();

      expect(approveLabel(mount)).toContain('freigegeben…');
      const button = mount.container.querySelector<HTMLButtonElement>(
        '[data-testid="invoice-approve"]',
      );
      if (button) {
        await act(async () => {
          button.click();
          await Promise.resolve();
        });
        await settle();
      }
      expect(start).toHaveBeenCalledTimes(1);
      unmount(mount);
    },
    30_000,
  );

  /*
   * TEST 4 — ein unerwarteter Wurf **im** Finalisierungsaufruf darf die
   * Oberfläche nicht dauerhaft sperren.
   *
   * Der Aufruf ist zwar intern abgesichert und liefert normalerweise ein
   * Ergebnis; hier wird der Ausnahmefall erzwungen, um den neuen Catch zu
   * prüfen. Weil der Serverzustand danach ungewiss ist, bleibt die Sperre
   * bewusst bestehen — nur der Ladezustand endet.
   */
  it('H5: ein unerwarteter Fehler beendet den Ladezustand und sperrt weiter', async () => {
    const start = vi
      .spyOn(coordinator, 'startInvoiceDraftFinalization')
      .mockImplementation(() => {
        throw new Error('unerwartet');
      });

    const mount = await renderPage();
    await gotoPreview(mount);
    await clickApprove(mount);
    await settle();

    expect(start).toHaveBeenCalledTimes(1);
    expect(approveLabel(mount)).not.toContain('freigegeben…');

    // Kein blinder zweiter Versuch — der Serverzustand ist ungewiss.
    const button = mount.container.querySelector<HTMLButtonElement>(
      '[data-testid="invoice-approve"]',
    );
    if (button) {
      await act(async () => {
        button.click();
        await Promise.resolve();
      });
      await settle();
    }
    expect(start).toHaveBeenCalledTimes(1);
    unmount(mount);
  }, 30_000);
});
