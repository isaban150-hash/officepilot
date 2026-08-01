import { beforeEach, describe, expect, it } from 'vitest';
import { createTestVorgang } from '../test/fixtures';
import { hydrateDocumentStore } from './documentService';
import {
  buildKundenDetailPath,
  getKundenWorkspace,
  normalizeKundenName,
} from './kundenWorkspaceService';
import { setTaskStoreForTests } from './taskStore';
import { normalizeTask } from './taskNormalize';
import { hydrateVorgangStore } from './vorgangService';
import type { CompanyDocument } from '../types/models';

describe('kundenWorkspaceService', () => {
  beforeEach(() => {
    hydrateVorgangStore([]);
    hydrateDocumentStore([]);
    setTaskStoreForTests([]);
  });

  it('baut Kontaktkopf aus neuesten nicht-leeren Billing-Daten', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-old',
        customer: 'Müller Bau GmbH',
        baustelle: 'Altstraße 1',
        sync: { updatedAt: '2026-01-01T10:00:00.000Z', version: 1, clientId: 'c1' },
        customerBilling: {
          name: 'Müller Bau GmbH',
          contactPerson: 'Alt Kontakt',
          street: 'Altstraße 1',
          zip: '10115',
          city: 'Berlin',
          email: 'alt@example.com',
          phone: '030-111',
        },
      }),
      createTestVorgang({
        id: 'v-new',
        customer: 'Müller Bau GmbH',
        baustelle: 'Neustraße 2',
        sync: { updatedAt: '2026-07-01T10:00:00.000Z', version: 1, clientId: 'c1' },
        customerBilling: {
          name: 'Müller Bau GmbH',
          contactPerson: 'Neu Kontakt',
          street: '',
          zip: '',
          city: '',
          email: 'neu@example.com',
          phone: '',
        },
      }),
    ]);

    const workspace = getKundenWorkspace('Müller Bau GmbH');
    expect(workspace).not.toBeNull();
    expect(workspace!.contact.contactPerson).toBe('Neu Kontakt');
    expect(workspace!.contact.email).toBe('neu@example.com');
    expect(workspace!.contact.phone).toBe('030-111');
    expect(workspace!.contact.street).toBe('Altstraße 1');
    expect(workspace!.contact.addressLine).toContain('Altstraße 1');
  });

  it('führt Baustellen distinct zusammen', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-1',
        customer: 'Schmidt AG',
        baustelle: 'Baustelle A',
        title: 'Auftrag A',
      }),
      createTestVorgang({
        id: 'v-2',
        customer: 'Schmidt AG',
        baustelle: 'Baustelle A',
        title: 'Auftrag A2',
      }),
      createTestVorgang({
        id: 'v-3',
        customer: 'Schmidt AG',
        baustelle: 'Baustelle B',
        title: 'Auftrag B',
      }),
    ]);

    const workspace = getKundenWorkspace('Schmidt AG');
    expect(workspace!.baustellen).toHaveLength(2);
    expect(workspace!.baustellen.map((s) => s.label).sort()).toEqual([
      'Baustelle A',
      'Baustelle B',
    ]);
  });

  it('trennt offene und abgeschlossene Vorgänge', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-open',
        customer: 'Test Kunde',
        status: 'in_bearbeitung',
        title: 'Offen',
      }),
      createTestVorgang({
        id: 'v-closed',
        customer: 'Test Kunde',
        status: 'abgeschlossen',
        title: 'Fertig',
      }),
    ]);

    const workspace = getKundenWorkspace('Test Kunde');
    expect(workspace!.openVorgaenge.map((v) => v.id)).toEqual(['v-open']);
    expect(workspace!.closedVorgaenge.map((v) => v.id)).toEqual(['v-closed']);
  });

  it('liefert Rechnungsübersicht und offene Forderung', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-inv',
        customer: 'Rechnungs Kunde',
        invoices: [
          {
            id: 'inv-open',
            number: 'R-100',
            type: 'schlussrechnung',
            positions: [],
            subtotal: 100,
            taxStatus: 'standard_19',
            amount: 119,
            status: 'versendet',
            date: '2026-06-01',
            createdAt: '2026-06-01T10:00:00.000Z',
            paymentDueDate: '2026-07-01',
            paymentStatus: 'offen',
            payments: [],
            customerSnapshot: {
              name: 'Rechnungs Kunde',
              contactPerson: '',
              street: '',
              zip: '',
              city: '',
              email: '',
              phone: '',
            },
          },
          {
            id: 'inv-paid',
            number: 'R-101',
            type: 'schlussrechnung',
            positions: [],
            subtotal: 200,
            taxStatus: 'standard_19',
            amount: 238,
            status: 'versendet',
            date: '2026-05-01',
            createdAt: '2026-05-01T10:00:00.000Z',
            paymentStatus: 'bezahlt',
            payments: [
              {
                id: 'pay-1',
                amount: 238,
                date: '2026-05-10',
                createdAt: '2026-05-10T10:00:00.000Z',
              },
            ],
          },
        ],
      }),
    ]);

    const workspace = getKundenWorkspace('Rechnungs Kunde', '2026-07-06');
    expect(workspace!.openInvoices).toHaveLength(1);
    expect(workspace!.openInvoices[0]!.number).toBe('R-100');
    expect(workspace!.paidInvoices).toHaveLength(1);
    expect(workspace!.paidInvoices[0]!.number).toBe('R-101');
    expect(workspace!.openReceivableTotal).toBeGreaterThan(0);
  });

  it('aggregiert Dokumente und Aufgaben', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-docs',
        customer: 'Dok Kunde',
        documents: [
          {
            id: 'vd-1',
            name: 'Werkvertrag.pdf',
            type: 'kundenauftrag',
            date: '2026-01-01',
            companyDocumentId: 'cd-1',
          },
        ],
        tasks: [
          {
            id: 'vt-1',
            type: 'dokument_pruefen',
            title: 'Vertrag prüfen',
            done: false,
            dueDate: '2026-07-10',
          },
        ],
      }),
    ]);
    hydrateDocumentStore([
      {
        id: 'cd-2',
        title: 'Angebot Küche',
        category: 'sonstiges',
        issuer: 'Dok Kunde',
        recognizedText: 'Angebot',
        issueDate: '2026-02-01',
        validUntil: null,
        digitalFolder: { id: 'd', name: 'Kunden', path: '/Kunden/Dok Kunde/Angebote/' },
        paperFolder: { folderId: 'f', register: 'A', label: 'x' },
        tags: [],
        linkedCompany: 'Dok Kunde',
        linkedVorgang: { vorgangId: 'v-docs', vorgangTitle: 'Test' },
        archived: true,
        createdAt: '2026-02-01T00:00:00.000Z',
        classifiedKind: 'angebot',
      } satisfies CompanyDocument,
    ]);
    setTaskStoreForTests([
      normalizeTask({
        id: 'gt-1',
        title: 'Rechnung vorbereiten',
        description: '',
        status: 'open',
        priority: 'hoch',
        category: 'rechnungen',
        type: 'rechnung_vorbereiten',
        linkedVorgangId: 'v-docs',
        linkedVorgangTitle: 'Testvorgang',
        done: false,
      }),
    ]);

    const workspace = getKundenWorkspace('Dok Kunde');
    expect(workspace!.documents.some((d) => d.title === 'Werkvertrag.pdf')).toBe(true);
    expect(workspace!.documents.some((d) => d.title === 'Angebot Küche')).toBe(true);
    expect(workspace!.tasks.some((t) => t.title === 'Rechnung vorbereiten')).toBe(true);
    expect(workspace!.tasks.some((t) => t.title === 'Vertrag prüfen')).toBe(true);
  });

  it('normalisiert Namen und baut Detail-Pfad', () => {
    expect(normalizeKundenName('  Müller  Bau  ')).toBe('Müller Bau');
    expect(buildKundenDetailPath('Müller Bau GmbH')).toBe(
      `/kunden/${encodeURIComponent('Müller Bau GmbH')}`,
    );
  });

  it('liefert null für unbekannte Kunden', () => {
    expect(getKundenWorkspace('Gibt es nicht')).toBeNull();
  });
});
