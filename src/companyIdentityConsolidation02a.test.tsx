/**
 * OFFICEPILOT-COMPANY-IDENTITY-CONSOLIDATION-02A — eine Wahrheit für den
 * aktuellen Firmennamen.
 *
 * `companyName` steht in `CompanySetup` **und** in `CompanyProfile`. Bei der
 * Hydrierung gewinnt bereits das Profil, und `updateCompanyProfile` schreibt
 * den Namen als Spiegel ins Setup zurück. Trotzdem lasen mehrere normale
 * UI-/Fachpfade weiterhin `setup.companyName` — und ein Cloud-Pull kann das
 * lokale Setup vollständig durch eine fremde, ältere Fassung ersetzen. Danach
 * zeigte die Anwendung einen anderen Firmennamen an, als sie führte.
 *
 * Diese Fälle halten fest, welche Quelle gilt — und ebenso, welche
 * Altbestandsrettung **erhalten** bleiben muss.
 *
 * Neutrale Beispieldaten.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthProvider } from './context/AuthContext';
import { AppProvider } from './context/AppContext';
import { AppShell } from './components/layout/AppShell';
import { DocumentForm } from './components/documents/DocumentForm';
import { DEFAULT_SETUP } from './data/mockData';
import { DEFAULT_COMPANY_PROFILE, createCompanyProfileFromSetup } from './data/companyProfileDefaults';
import {
  getCompanyProfile,
  hydrateCompanyProfileStore,
  syncCompanyProfileFromSetup,
} from './services/companyProfileService';
import { buildCompanySetupCloudPayload } from './services/workspace/workspaceCloudService';
import { buildInvoicePrintModelFromInvoice } from './services/invoicePrintModel';
import { resetTestStores } from './test/resetStores';
import type {
  CompanyDocument,
  CompanyProfile,
  CompanySetup,
  VorgangInvoice,
} from './types/models';

const OLD_NAME = 'Alter Firmenname GmbH';
const NEW_NAME = 'Neuer Firmenname GmbH';

/** Setup mit dem **alten** Namen — der Legacy-Spiegel. */
const divergentSetup: CompanySetup = {
  ...DEFAULT_SETUP,
  setupComplete: true,
  companyName: OLD_NAME,
};

/** Profil mit dem **neuen** Namen — die maßgebliche Identität. */
function divergentProfile(): CompanyProfile {
  return {
    ...DEFAULT_COMPANY_PROFILE,
    companyName: NEW_NAME,
    street: 'Musterallee 5',
    zip: '30000',
    city: 'Musterstadt',
    email: 'kontakt@beispielbetrieb.de',
  };
}

describe('COMPANY-IDENTITY-CONSOLIDATION-02A — aktuelle Identität', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    resetTestStores();
    hydrateCompanyProfileStore(divergentProfile());
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container.remove();
    resetTestStores();
  });

  function mount(node: ReturnType<typeof createElement>): void {
    root = createRoot(container);
    act(() => {
      root!.render(
        createElement(
          MemoryRouter,
          null,
          createElement(
            AuthProvider,
            null,
            createElement(AppProvider, { initialSetup: divergentSetup }, node),
          ),
        ),
      );
    });
  }

  it('A: die Kopfzeile zeigt den Profilnamen, nicht den Setup-Namen', () => {
    mount(createElement(AppShell));

    const company = container.querySelector('.app-shell__company');
    expect(company?.textContent).toBe(NEW_NAME);
    expect(container.textContent).not.toContain(OLD_NAME);
  });

  it('B: das Dokumentformular übernimmt den Profilnamen als eigene Firma', () => {
    /*
     * `linkedCompany` wird nicht als Feld gerendert, sondern nur mitgeführt.
     * Geprüft wird deshalb das tatsächlich gespeicherte Dokument.
     */
    let saved: CompanyDocument | null = null;
    mount(
      createElement(DocumentForm, {
        mode: 'add' as const,
        onSaved: (doc: CompanyDocument) => {
          saved = doc;
        },
        onCancel: () => {},
      }),
    );

    const title = container.querySelector('#doc-title') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(title, 'Beispieldokument');
      title.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      (container.querySelector('form') as HTMLFormElement).requestSubmit();
    });

    expect(saved).not.toBeNull();
    expect(saved!.linkedCompany).toBe(NEW_NAME);
  });
});

describe('COMPANY-IDENTITY-CONSOLIDATION-02A — Altbestand bleibt gerettet', () => {
  beforeEach(() => {
    resetTestStores();
  });

  afterEach(() => {
    resetTestStores();
  });

  it('D: fehlt das Profil, entsteht es weiterhin aus dem Setup', () => {
    const setup: CompanySetup = { ...DEFAULT_SETUP, companyName: 'Firma A' };
    expect(createCompanyProfileFromSetup(setup).companyName).toBe('Firma A');
  });

  it('E: ein leerer Profilname wird weiterhin aus dem Setup gefüllt', () => {
    hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: '' });
    syncCompanyProfileFromSetup('Firma A');
    expect(getCompanyProfile().companyName).toBe('Firma A');
  });

  it('F: ein bereits befülltes Profil wird nie von einem alten Setup-Namen überschrieben', () => {
    hydrateCompanyProfileStore(divergentProfile());
    syncCompanyProfileFromSetup(OLD_NAME);
    expect(getCompanyProfile().companyName).toBe(NEW_NAME);
  });

  it('H: die company_setup-Cloudstruktur bleibt unverändert und führt companyName weiter', () => {
    const payload = buildCompanySetupCloudPayload(divergentSetup) as {
      payload: CompanySetup;
      setup_version: number;
    };
    expect(payload.payload.companyName).toBe(OLD_NAME);
    expect(Object.keys(payload).sort()).toEqual(['payload', 'setup_version']);
    expect(Object.keys(payload.payload).sort()).toEqual(Object.keys(divergentSetup).sort());
  });
});

describe('COMPANY-IDENTITY-CONSOLIDATION-02A — historische Rechnung', () => {
  beforeEach(() => {
    resetTestStores();
  });

  afterEach(() => {
    resetTestStores();
  });

  it('G: eine finalisierte Rechnung folgt ihrem Snapshot, nicht der aktuellen Identität', () => {
    const snapshotName = 'Firmenname zum Rechnungszeitpunkt GmbH';
    const invoice = {
      id: 'inv-identity-1',
      number: '2026-0001',
      type: 'rechnung',
      positions: [],
      subtotal: 1000,
      taxStatus: 'standard_19',
      amount: 1190,
      status: 'versendet',
      date: '2026-05-01',
      createdAt: '2026-05-01T09:00:00.000Z',
      companySnapshot: { ...DEFAULT_COMPANY_PROFILE, companyName: snapshotName },
      customerSnapshot: {
        name: 'Beispiel Projektbau GmbH',
        contactPerson: '',
        street: 'Beispielstraße 2',
        zip: '20000',
        city: 'Beispielstadt',
        email: '',
        phone: '',
      },
    } as VorgangInvoice;

    // Die aktuelle Identität wird nach der Rechnung geändert.
    hydrateCompanyProfileStore(divergentProfile());

    const model = buildInvoicePrintModelFromInvoice(invoice);
    expect(model.company.companyName).toBe(snapshotName);
    expect(model.company.companyName).not.toBe(NEW_NAME);
  });
});
