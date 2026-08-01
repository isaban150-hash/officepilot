import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { KundenDetailPage } from './pages/KundenDetailPage';
import { KundenPage } from './pages/KundenPage';
import { createTestVorgang } from './test/fixtures';
import { hydrateDocumentStore } from './services/documentService';
import { buildKundenDetailPath } from './services/kundenWorkspaceService';
import { hydrateVorgangStore } from './services/vorgangService';
import { setTaskStoreForTests } from './services/taskStore';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };

describe('CUSTOMER-WORKSPACE-01A', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-kunde-1',
        customer: 'Handwerk Partner GmbH',
        baustelle: 'Hauptstraße 12',
        title: 'Badumbau',
        status: 'in_bearbeitung',
        customerBilling: {
          name: 'Handwerk Partner GmbH',
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
        customer: 'Handwerk Partner GmbH',
        baustelle: 'Nebenstraße 1',
        title: 'Altbau',
        status: 'abgeschlossen',
      }),
    ]);
    hydrateDocumentStore([]);
    setTaskStoreForTests([]);
  });

  it('Kundenliste öffnet Kundenakte', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={completeSetup}>
          <KundenPage />
        </AppProvider>
      </MemoryRouter>,
    );

    const href = buildKundenDetailPath('Handwerk Partner GmbH');
    expect(html).toContain(`href="${href}"`);
    expect(html).not.toContain('href="/vorgaenge"');
  });

  it('Kundenakte rendert Kontakt, Baustellen, Vorgänge, Rechnungen, Dokumente, Aufgaben', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[buildKundenDetailPath('Handwerk Partner GmbH')]}>
        <AppProvider initialSetup={completeSetup}>
          <Routes>
            <Route path="/kunden/:name" element={<KundenDetailPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );

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
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[buildKundenDetailPath('Handwerk Partner GmbH')]}>
        <AppProvider initialSetup={completeSetup}>
          <Routes>
            <Route path="/kunden/:name" element={<KundenDetailPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html.toLowerCase()).not.toContain('kunde bearbeiten');
    expect(html.toLowerCase()).not.toContain('kunde löschen');
    expect(html.toLowerCase()).not.toContain('kunde anlegen');
    expect(html).not.toContain('data-testid="kunden-edit"');
    expect(html).not.toContain('data-testid="kunden-delete"');
  });

  it('Route /kunden/:name ist erreichbar', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <MemoryRouter initialEntries={[buildKundenDetailPath('Handwerk Partner GmbH')]}>
          <AppProvider initialSetup={completeSetup}>
            <Routes>
              <Route path="/kunden/:name" element={<KundenDetailPage />} />
            </Routes>
          </AppProvider>
        </MemoryRouter>,
      );
    });
    expect(container.querySelector('[data-testid="kunden-detail-page"]')).not.toBeNull();
    act(() => root.unmount());
    container.remove();
  });
});
