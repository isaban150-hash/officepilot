import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { KundenDetailPage, KundenLegacyLinkResolver } from './pages/KundenDetailPage';
import { KundenPage } from './pages/KundenPage';
import { createTestVorgang } from './test/fixtures';
import { hydrateDocumentStore } from './services/documentService';
import { hydrateCompanyProfileStore, getCompanyProfile } from './services/companyProfileService';
import { hydrateCustomerStore } from './services/customerStoreService';
import { createCustomer } from './services/customerService';
import { buildLegacyKundenKey } from './services/kundenOverviewService';
import { buildKundenDetailPath } from './services/kundenWorkspaceService';
import { hydrateVorgangStore } from './services/vorgangService';
import { setTaskStoreForTests } from './services/taskStore';
import type { CompanyDocument, Customer } from './types/models';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };
const SAME_NAME = 'Handwerk Partner GmbH';

/** Mirrors the production route table for the customer area (App.tsx). */
function KundenRoutes() {
  return (
    <Routes>
      <Route path="/kunden" element={<KundenPage />} />
      <Route path="/kunden/customer/:customerId" element={<KundenDetailPage kind="customer" />} />
      <Route path="/kunden/legacy/:legacyKey" element={<KundenDetailPage kind="legacy" />} />
      <Route path="/kunden/orphan/:customerId" element={<KundenDetailPage kind="orphan" />} />
      <Route path="/kunden/:name" element={<KundenLegacyLinkResolver />} />
    </Routes>
  );
}

function renderAt(path: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <AppProvider initialSetup={completeSetup}>
        <KundenRoutes />
      </AppProvider>
    </MemoryRouter>,
  );
}

function mountAt(path: string): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <AppProvider initialSetup={completeSetup}>
          <KundenRoutes />
        </AppProvider>
      </MemoryRouter>,
    );
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function createSameNameCustomer(street: string, zip: string, city: string): Customer {
  const result = createCustomer({
    name: SAME_NAME,
    contactPerson: 'Frau Weber',
    street,
    zip,
    city,
    email: 'weber@partner.de',
    phone: '089-123456',
  });
  expect(result.success).toBe(true);
  if (!result.success) throw new Error('fixture');
  return result.customer;
}

describe('CUSTOMER-WORKSPACE-01A', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateCustomerStore([]);
    hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: 'Eigene Firma GmbH' });
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-kunde-1',
        customer: SAME_NAME,
        baustelle: 'Hauptstraße 12',
        title: 'Badumbau',
        status: 'in_bearbeitung',
        customerBilling: {
          name: SAME_NAME,
          contactPerson: 'Frau Weber',
          street: 'Industrieweg 3',
          zip: '80331',
          city: 'München',
          email: 'weber@partner.de',
          phone: '089-123456',
        },
        documents: [
          {
            id: 'd1',
            name: 'Vertrag Bad.pdf',
            type: 'kundenauftrag',
            date: '2026-03-01',
          },
        ],
        tasks: [
          {
            id: 't1',
            type: 'dokument_pruefen',
            title: 'Abnahme vorbereiten',
            done: false,
          },
        ],
        invoices: [
          {
            id: 'inv-1',
            number: 'R-500',
            type: 'schlussrechnung',
            positions: [],
            subtotal: 1000,
            taxStatus: 'standard_19',
            amount: 1190,
            status: 'versendet',
            date: '2026-06-01',
            createdAt: '2026-06-01T10:00:00.000Z',
            paymentStatus: 'offen',
            payments: [],
          },
        ],
      }),
      createTestVorgang({
        id: 'v-kunde-2',
        customer: SAME_NAME,
        baustelle: 'Nebenstraße 1',
        title: 'Altbau',
        status: 'abgeschlossen',
      }),
    ]);
    hydrateDocumentStore([]);
    setTaskStoreForTests([]);
  });

  const legacyPath = () =>
    buildKundenDetailPath({ kind: 'legacy', key: buildLegacyKundenKey(SAME_NAME) });

  it('Kundenliste öffnet Kundenakte', () => {
    const html = renderAt('/kunden');
    expect(html).toContain(`href="${legacyPath()}"`);
    expect(html).not.toContain('href="/vorgaenge"');
  });

  it('Kundenakte rendert Kontakt, Baustellen, Vorgänge, Rechnungen, Dokumente, Aufgaben', () => {
    const html = renderAt(legacyPath());

    expect(html).toContain('data-testid="kunden-detail-page"');
    expect(html).toContain('data-testid="kunden-contact"');
    expect(html).toContain('Frau Weber');
    expect(html).toContain('089-123456');
    expect(html).toContain('weber@partner.de');
    expect(html).toContain('Industrieweg 3');
    expect(html).toContain('Hauptstraße 12');
    expect(html).toContain('Nebenstraße 1');
    expect(html).toContain('data-testid="kunden-vorgaenge-open"');
    expect(html).toContain('data-testid="kunden-vorgang-v-kunde-1"');
    expect(html).toContain('data-testid="kunden-vorgaenge-closed"');
    expect(html).toContain('data-testid="kunden-vorgang-v-kunde-2"');
    expect(html).toContain('R-500');
    expect(html).toContain('data-testid="kunden-receivables"');
    expect(html).toContain('Vertrag Bad.pdf');
    expect(html).toContain('Abnahme vorbereiten');
  });

  it('bleibt Read-only — keine Bearbeiten-/Löschen-Aktionen', () => {
    const html = renderAt(legacyPath());

    expect(html.toLowerCase()).not.toContain('kunde bearbeiten');
    expect(html.toLowerCase()).not.toContain('kunde löschen');
    expect(html.toLowerCase()).not.toContain('kunde anlegen');
    expect(html).not.toContain('data-testid="kunden-edit"');
    expect(html).not.toContain('data-testid="kunden-delete"');
  });

  it('Legacy-Detailroute ist erreichbar', () => {
    const view = mountAt(legacyPath());
    expect(view.container.querySelector('[data-testid="kunden-detail-page"]')).not.toBeNull();
    view.unmount();
  });

  it('zeigt zwei gleichnamige Kunden als getrennte Zeilen mit eigener Adresse und eigenem Link', () => {
    const a = createSameNameCustomer('Industrieweg 3', '80331', 'München');
    const b = createSameNameCustomer('Seeufer 9', '88131', 'Lindau');
    const c = createSameNameCustomer('Ohnestraße 1', '10115', 'Berlin');
    hydrateVorgangStore([
      createTestVorgang({ id: 'v-a', title: 'Bad A', customer: SAME_NAME, customerId: a.id }),
      createTestVorgang({ id: 'v-b', title: 'Bad B', customer: SAME_NAME, customerId: b.id }),
      createTestVorgang({ id: 'v-legacy', title: 'Alt', customer: SAME_NAME }),
      createTestVorgang({
        id: 'v-orphan',
        title: 'Waise',
        customer: SAME_NAME,
        customerId: 'cust-nicht-im-store',
      }),
      createTestVorgang({ id: 'v-unknown', title: 'Ohne Kunde', customer: '' }),
    ]);

    const view = mountAt('/kunden');
    const { container } = view;

    const rowA = container.querySelector(`[data-testid="kunde-customer-${a.id}"]`);
    const rowB = container.querySelector(`[data-testid="kunde-customer-${b.id}"]`);
    const rowC = container.querySelector(`[data-testid="kunde-customer-${c.id}"]`);
    const rowLegacy = container.querySelector(
      `[data-testid="kunde-legacy-${buildLegacyKundenKey(SAME_NAME)}"]`,
    );
    const rowOrphan = container.querySelector('[data-testid="kunde-orphan-cust-nicht-im-store"]');

    expect(rowA).not.toBeNull();
    expect(rowB).not.toBeNull();
    // Kunde ohne Vorgang bleibt sichtbar.
    expect(rowC).not.toBeNull();
    expect(rowLegacy).not.toBeNull();
    expect(rowOrphan).not.toBeNull();

    // Getrennte Links.
    expect(rowA!.getAttribute('href')).toBe(`/kunden/customer/${a.id}`);
    expect(rowB!.getAttribute('href')).toBe(`/kunden/customer/${b.id}`);
    expect(rowA!.getAttribute('href')).not.toBe(rowB!.getAttribute('href'));

    // Beide aktuellen Adressen sind sichtbar.
    expect(rowA!.querySelector('[data-testid="kunde-address"]')!.textContent).toBe(
      'Industrieweg 3, 80331 München',
    );
    expect(rowB!.querySelector('[data-testid="kunde-address"]')!.textContent).toBe(
      'Seeufer 9, 88131 Lindau',
    );

    // Kennzeichnung von Legacy und Waise.
    expect(rowLegacy!.textContent).toContain('Altbestand');
    expect(rowOrphan!.textContent).toContain('Kundenstamm fehlt');

    // Technische IDs erscheinen nicht als Text.
    expect(container.textContent).not.toContain(a.id);
    expect(container.textContent).not.toContain(b.id);
    expect(container.textContent).not.toContain('cust-nicht-im-store');

    // Unbekannter Vorgang erzeugt keine Zeile.
    expect(container.querySelectorAll('.card-link')).toHaveLength(5);

    view.unmount();
  });

  it('öffnet je Kundenzeile nur den eigenen Vorgang', () => {
    const a = createSameNameCustomer('Industrieweg 3', '80331', 'München');
    const b = createSameNameCustomer('Seeufer 9', '88131', 'Lindau');
    const c = createSameNameCustomer('Ohnestraße 1', '10115', 'Berlin');
    hydrateVorgangStore([
      createTestVorgang({ id: 'v-a', title: 'Bad A', customer: SAME_NAME, customerId: a.id }),
      createTestVorgang({ id: 'v-b', title: 'Bad B', customer: SAME_NAME, customerId: b.id }),
      createTestVorgang({ id: 'v-legacy', title: 'Alt', customer: SAME_NAME }),
      createTestVorgang({
        id: 'v-orphan',
        title: 'Waise',
        customer: SAME_NAME,
        customerId: 'cust-nicht-im-store',
      }),
    ]);

    const htmlA = renderAt(`/kunden/customer/${a.id}`);
    expect(htmlA).toContain('data-testid="kunden-vorgang-v-a"');
    expect(htmlA).not.toContain('data-testid="kunden-vorgang-v-b"');
    expect(htmlA).not.toContain('data-testid="kunden-vorgang-v-legacy"');
    expect(htmlA).not.toContain('data-testid="kunden-vorgang-v-orphan"');

    const htmlB = renderAt(`/kunden/customer/${b.id}`);
    expect(htmlB).toContain('data-testid="kunden-vorgang-v-b"');
    expect(htmlB).not.toContain('data-testid="kunden-vorgang-v-a"');

    const htmlLegacy = renderAt(legacyPath());
    expect(htmlLegacy).toContain('data-testid="kunden-vorgang-v-legacy"');
    expect(htmlLegacy).not.toContain('data-testid="kunden-vorgang-v-a"');

    const htmlOrphan = renderAt('/kunden/orphan/cust-nicht-im-store');
    expect(htmlOrphan).toContain('data-testid="kunden-vorgang-v-orphan"');
    expect(htmlOrphan).not.toContain('data-testid="kunden-vorgang-v-a"');

    // Kunde ohne Vorgang öffnet einen gültigen, leeren Arbeitsbereich.
    const htmlC = renderAt(`/kunden/customer/${c.id}`);
    expect(htmlC).toContain('data-testid="kunden-detail-page"');
    expect(htmlC).not.toContain('data-testid="kunden-detail-empty"');
    expect(htmlC).toContain('Ohnestraße 1, 10115 Berlin');
    expect(htmlC).not.toContain('data-testid="kunden-vorgang-');
  });

  it('leitet alte Kundenlinks nur bei genau einem Ziel weiter', () => {
    // Genau ein Ziel: Legacy-Vorgänge aus dem beforeEach.
    const single = mountAt(`/kunden/${encodeURIComponent(SAME_NAME)}`);
    expect(single.container.querySelector('[data-testid="kunden-detail-page"]')).not.toBeNull();
    expect(single.container.querySelector('[data-testid="kunden-legacy-link"]')).toBeNull();
    single.unmount();
  });

  it('wählt bei gleichnamigen Kunden kein Ziel automatisch aus', () => {
    const a = createSameNameCustomer('Industrieweg 3', '80331', 'München');
    const b = createSameNameCustomer('Seeufer 9', '88131', 'Lindau');
    hydrateVorgangStore([
      createTestVorgang({ id: 'v-a', title: 'Bad A', customer: SAME_NAME, customerId: a.id }),
      createTestVorgang({ id: 'v-b', title: 'Bad B', customer: SAME_NAME, customerId: b.id }),
    ]);

    const view = mountAt(`/kunden/${encodeURIComponent(SAME_NAME)}`);
    const { container } = view;
    expect(container.querySelector('[data-testid="kunden-detail-page"]')).toBeNull();
    expect(container.querySelector('[data-testid="kunden-legacy-link"]')).not.toBeNull();
    const targets = container.querySelectorAll(
      '[data-testid="kunden-legacy-link-targets"] .card-link',
    );
    expect(targets).toHaveLength(2);
    view.unmount();
  });

  it('behandelt Kunde plus gleichnamigen Legacy-Bereich als mehrdeutig', () => {
    const a = createSameNameCustomer('Industrieweg 3', '80331', 'München');
    hydrateVorgangStore([
      createTestVorgang({ id: 'v-a', title: 'Bad A', customer: SAME_NAME, customerId: a.id }),
      createTestVorgang({ id: 'v-legacy', title: 'Alt', customer: SAME_NAME }),
    ]);

    const view = mountAt(`/kunden/${encodeURIComponent(SAME_NAME)}`);
    const { container } = view;
    expect(container.querySelector('[data-testid="kunden-legacy-link"]')).not.toBeNull();
    expect(
      container.querySelector(`[data-testid="kunden-legacy-target-customer-${a.id}"]`),
    ).not.toBeNull();
    expect(
      container.querySelector(
        `[data-testid="kunden-legacy-target-legacy-${buildLegacyKundenKey(SAME_NAME)}"]`,
      ),
    ).not.toBeNull();
    view.unmount();
  });

  it('berücksichtigt einen reinen Dokument-Legacy-Bereich beim alten Link', () => {
    hydrateVorgangStore([]);
    const doc = {
      id: 'doc-only',
      title: 'Altvertrag',
      category: 'vertrag',
      issuer: SAME_NAME,
      recognizedText: '',
      digitalFolder: { id: 'dig-1', name: 'Verträge', path: '/Vertraege/' },
      paperFolder: { folderId: 'p1', register: 'A', label: 'Ordner 1' },
      tags: [],
      linkedCompany: SAME_NAME,
      linkedVorgang: null,
      archived: false,
      createdAt: '2026-05-04T09:00:00.000Z',
    } as unknown as CompanyDocument;
    hydrateDocumentStore([doc]);

    const view = mountAt(`/kunden/${encodeURIComponent(SAME_NAME)}`);
    const { container } = view;
    expect(container.querySelector('[data-testid="kunden-detail-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="kunden-document-doc-only"]')).not.toBeNull();
    // Originalschreibweise aus linkedCompany, nicht der kanonische Routenschlüssel.
    const title = container.querySelector('h1')!;
    expect(title.textContent).toBe(SAME_NAME);
    expect(title.textContent).not.toBe(buildLegacyKundenKey(SAME_NAME));
    view.unmount();
  });

  it('zeigt bei reinem Pfadtreffer ohne sichere Schreibweise den neutralen Legacy-Titel', () => {
    hydrateVorgangStore([]);
    const lowerKey = buildLegacyKundenKey(SAME_NAME);
    const doc = {
      id: 'doc-path',
      title: 'Pfaddokument',
      category: 'vertrag',
      issuer: '',
      recognizedText: '',
      digitalFolder: { id: 'dig-2', name: 'Kunden', path: `/kunden/${lowerKey}/2026/` },
      paperFolder: { folderId: 'p1', register: 'A', label: 'Ordner 1' },
      tags: [],
      linkedCompany: '',
      linkedVorgang: null,
      archived: false,
      createdAt: '2026-05-04T09:00:00.000Z',
    } as unknown as CompanyDocument;
    hydrateDocumentStore([doc]);

    const view = mountAt(`/kunden/legacy/${encodeURIComponent(lowerKey)}`);
    const { container } = view;
    // Positive Vorbedingung: der Arbeitsbereich ist gerendert.
    expect(container.querySelector('[data-testid="kunden-detail-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="kunden-document-doc-path"]')).not.toBeNull();
    expect(container.querySelector('h1')!.textContent).toBe('Altbestand');
    expect(container.textContent).not.toContain(lowerKey);
    view.unmount();
  });

  it('zeigt einen namenlosen echten Orphan verständlich statt technisch', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-orphan-leer',
        title: 'Waisen-Vorgang',
        customer: '',
        customerId: 'cust-verwaist-1',
        customerBilling: {
          name: '',
          contactPerson: '',
          street: '',
          zip: '',
          city: '',
          email: '',
          phone: '',
        },
        invoices: [],
      }),
    ]);

    const list = mountAt('/kunden');
    const row = list.container.querySelector('[data-testid="kunde-orphan-cust-verwaist-1"]');
    expect(row).not.toBeNull();
    expect(row!.querySelector('.card__title')!.textContent).toBe('Kundenstamm fehlt');
    expect(list.container.textContent).not.toContain('cust-verwaist-1');
    list.unmount();

    const detail = mountAt('/kunden/orphan/cust-verwaist-1');
    expect(detail.container.querySelector('[data-testid="kunden-detail-page"]')).not.toBeNull();
    expect(detail.container.querySelector('[data-testid="kunden-vorgang-v-orphan-leer"]')).not.toBeNull();
    expect(detail.container.querySelector('h1')!.textContent).toBe('Kundenstamm fehlt');
    expect(detail.container.querySelector('h1')!.textContent).not.toBe('Altbestand');
    expect(detail.container.textContent).not.toContain('cust-verwaist-1');
    detail.unmount();
  });

  it('nutzt für einen Orphan ohne Vorgangsnamen den eigenen Snapshot-Namen', () => {
    // Gleichnamiger Customer existiert — es darf trotzdem keine Verknüpfung entstehen.
    const a = createSameNameCustomer('Industrieweg 3', '80331', 'München');
    hydrateVorgangStore([
      createTestVorgang({ id: 'v-a', title: 'Bad A', customer: SAME_NAME, customerId: a.id }),
      createTestVorgang({
        id: 'v-orphan-snapshot',
        title: 'Waise mit Snapshot',
        customer: '',
        customerId: 'cust-verwaist-2',
        customerBilling: {
          name: SAME_NAME,
          contactPerson: '',
          street: '',
          zip: '',
          city: '',
          email: '',
          phone: '',
        },
        invoices: [],
      }),
    ]);

    const list = mountAt('/kunden');
    const row = list.container.querySelector('[data-testid="kunde-orphan-cust-verwaist-2"]');
    expect(row).not.toBeNull();
    expect(row!.querySelector('.card__title')!.textContent).toBe(SAME_NAME);
    expect(list.container.textContent).not.toContain('cust-verwaist-2');
    list.unmount();

    // Keine Namensverknüpfung: die Vorgänge bleiben strikt getrennt.
    const detail = mountAt('/kunden/orphan/cust-verwaist-2');
    expect(detail.container.querySelector('[data-testid="kunden-vorgang-v-orphan-snapshot"]')).not.toBeNull();
    expect(detail.container.querySelector('[data-testid="kunden-vorgang-v-a"]')).toBeNull();
    expect(detail.container.querySelector('h1')!.textContent).toBe(SAME_NAME);
    detail.unmount();

    const customerDetail = mountAt(`/kunden/customer/${a.id}`);
    expect(customerDetail.container.querySelector('[data-testid="kunden-vorgang-v-a"]')).not.toBeNull();
    expect(
      customerDetail.container.querySelector('[data-testid="kunden-vorgang-v-orphan-snapshot"]'),
    ).toBeNull();
    customerDetail.unmount();
  });

  it('öffnet unter einer vorhandenen Customer-ID keinen Orphan-Arbeitsbereich', () => {
    const a = createSameNameCustomer('Industrieweg 3', '80331', 'München');
    hydrateVorgangStore([
      createTestVorgang({ id: 'v-a', title: 'Bad A', customer: SAME_NAME, customerId: a.id }),
    ]);

    // Positive Vorbedingung: die normale Customer-Route ist gültig.
    const ok = mountAt(`/kunden/customer/${a.id}`);
    expect(ok.container.querySelector('[data-testid="kunden-detail-page"]')).not.toBeNull();
    expect(ok.container.querySelector('[data-testid="kunden-vorgang-v-a"]')).not.toBeNull();
    // Aktuelle Stammadresse bleibt sichtbar, die ID nicht.
    expect(ok.container.textContent).toContain('Industrieweg 3, 80331 München');
    expect(ok.container.textContent).not.toContain(a.id);
    ok.unmount();

    const orphan = mountAt(`/kunden/orphan/${a.id}`);
    expect(orphan.container.querySelector('[data-testid="kunden-detail-empty"]')).not.toBeNull();
    expect(orphan.container.querySelector('[data-testid="kunden-vorgang-v-a"]')).toBeNull();
    expect(orphan.container.textContent).not.toContain(a.id);
    orphan.unmount();
  });

  it('zeigt bei unbekanntem alten Link den Weg zurück zur Kundenliste', () => {
    const view = mountAt('/kunden/Gibt%20es%20nicht');
    const { container } = view;
    expect(container.querySelector('[data-testid="kunden-legacy-link"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="kunden-legacy-link-targets"]')).toBeNull();
    const back = [...container.querySelectorAll('a')].some(
      (link) => link.getAttribute('href') === '/kunden',
    );
    expect(back).toBe(true);
    view.unmount();
  });
});
