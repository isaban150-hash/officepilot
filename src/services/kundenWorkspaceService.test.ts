import { beforeEach, describe, expect, it } from 'vitest';
import { createTestVorgang } from '../test/fixtures';
import { hydrateCustomerStore } from './customerStoreService';
import { createCustomer, updateCustomer } from './customerService';
import { hydrateCompanyProfileStore, getCompanyProfile } from './companyProfileService';
import { hydrateDocumentStore } from './documentService';
import { buildLegacyKundenKey, getKundenOverview } from './kundenOverviewService';
import {
  buildKundenDetailPath,
  getKundenWorkspace,
  normalizeKundenName,
  resolveKundenLinkTargets,
} from './kundenWorkspaceService';
import { setTaskStoreForTests } from './taskStore';
import { normalizeTask } from './taskNormalize';
import { getVorgangById, hydrateVorgangStore } from './vorgangService';
import type { CompanyDocument, CustomerBilling, Vorgang } from '../types/models';

const SAME_NAME = 'NordWest Dachbau GmbH';

const EMPTY_BILLING: CustomerBilling = {
  name: '',
  contactPerson: '',
  street: '',
  zip: '',
  city: '',
  email: '',
  phone: '',
};

describe('kundenWorkspaceService', () => {
  beforeEach(() => {
    hydrateVorgangStore([]);
    hydrateDocumentStore([]);
    hydrateCustomerStore([]);
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

    const workspace = getKundenWorkspace('legacy', buildLegacyKundenKey('Müller Bau GmbH'));
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

    const workspace = getKundenWorkspace('legacy', buildLegacyKundenKey('Schmidt AG'));
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

    const workspace = getKundenWorkspace('legacy', buildLegacyKundenKey('Test Kunde'));
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

    const workspace = getKundenWorkspace('legacy', buildLegacyKundenKey('Rechnungs Kunde'), '2026-07-06');
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

    const workspace = getKundenWorkspace('legacy', buildLegacyKundenKey('Dok Kunde'));
    expect(workspace!.documents.some((d) => d.title === 'Werkvertrag.pdf')).toBe(true);
    expect(workspace!.documents.some((d) => d.title === 'Angebot Küche')).toBe(true);
    expect(workspace!.tasks.some((t) => t.title === 'Rechnung vorbereiten')).toBe(true);
    expect(workspace!.tasks.some((t) => t.title === 'Vertrag prüfen')).toBe(true);
  });

  it('normalisiert Namen und baut Detail-Pfad je Identitätsart', () => {
    expect(normalizeKundenName('  Müller  Bau  ')).toBe('Müller Bau');
    expect(buildKundenDetailPath({ kind: 'customer', key: 'cust-1' })).toBe(
      '/kunden/customer/cust-1',
    );
    expect(buildKundenDetailPath({ kind: 'orphan', key: 'cust-weg' })).toBe(
      '/kunden/orphan/cust-weg',
    );
    expect(buildKundenDetailPath({ kind: 'legacy', key: buildLegacyKundenKey('Müller Bau GmbH') })).toBe(
      `/kunden/legacy/${encodeURIComponent('müller bau gmbh')}`,
    );
  });

  it('liefert null für unbekannte Kunden', () => {
    expect(getKundenWorkspace('legacy', buildLegacyKundenKey('Gibt es nicht'))).toBeNull();
  });

  it('Legacy-Schlüssel kollidieren nicht bei +, Leerzeichen, Punkt, Bindestrich und %', () => {
    const names = ['A+B Bau', 'A B Bau', 'Bau-Service GmbH', 'Bau.Service GmbH', '100% Bau'];
    const keys = names.map(buildLegacyKundenKey);
    expect(new Set(keys).size).toBe(names.length);
    for (const [index, key] of keys.entries()) {
      // Hin und zurück verlustfrei — kein Slug.
      expect(decodeURIComponent(encodeURIComponent(key))).toBe(key);
      expect(key).toBe(names[index]!.toLowerCase());
    }
  });

  it('trennt zwei gleichnamige Customer vollständig', () => {
    hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: 'Eigene Firma GmbH' });
    const a = createCustomer({
      name: SAME_NAME,
      street: 'Hafenstraße 12',
      zip: '45356',
      city: 'Essen',
    });
    const b = createCustomer({
      name: SAME_NAME,
      street: 'Ruhrallee 5',
      zip: '44787',
      city: 'Bochum',
    });
    const c = createCustomer({ name: 'Ohne Vorgang GmbH', street: 'Weg 1', zip: '10115', city: 'Berlin' });
    expect(a.success && b.success && c.success).toBe(true);
    if (!a.success || !b.success || !c.success) return;

    const vorgangA = createTestVorgang({
      id: 'v-a',
      title: 'Vorgang A',
      customer: SAME_NAME,
      customerId: a.customer.id,
      customerBilling: { ...EMPTY_BILLING, name: SAME_NAME },
    });
    const vorgangB = createTestVorgang({
      id: 'v-b',
      title: 'Vorgang B',
      customer: SAME_NAME,
      customerId: b.customer.id,
      customerBilling: { ...EMPTY_BILLING, name: SAME_NAME },
    });
    const legacy = createTestVorgang({
      id: 'v-legacy',
      title: 'Alt-Vorgang',
      customer: SAME_NAME,
    });
    const unknown = createTestVorgang({
      id: 'v-unknown',
      title: 'Unbekannt',
      customer: '',
      customerExplicitlyUnknown: true,
    });
    const orphan = createTestVorgang({
      id: 'v-orphan',
      title: 'Waise',
      customer: SAME_NAME,
      customerId: 'cust-nicht-im-store',
    });
    hydrateVorgangStore([vorgangA, vorgangB, legacy, unknown, orphan]);

    const overview = getKundenOverview();
    const rows = overview.filter((entry) => entry.name === SAME_NAME);
    // Zwei ID-Customer, ein Legacy, ein Orphan — vier getrennte Zeilen.
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.kind === 'customer')).toHaveLength(2);
    expect(rows.filter((r) => r.kind === 'legacy')).toHaveLength(1);
    expect(rows.filter((r) => r.kind === 'orphan')).toHaveLength(1);

    const rowA = rows.find((r) => r.key === a.customer.id)!;
    const rowB = rows.find((r) => r.key === b.customer.id)!;
    expect(rowA.addressLine).toBe('Hafenstraße 12, 45356 Essen');
    expect(rowB.addressLine).toBe('Ruhrallee 5, 44787 Bochum');
    expect(rowA.orderCount).toBe(1);
    expect(rowB.orderCount).toBe(1);

    // Unknown erzeugt keine Zeile.
    expect(overview.some((entry) => entry.name === '')).toBe(false);
    expect(overview.some((entry) => entry.key === 'v-unknown')).toBe(false);

    // Customer ohne Vorgang ist sichtbar und hat einen gültigen Arbeitsbereich.
    const rowC = overview.find((entry) => entry.key === c.customer.id)!;
    expect(rowC.orderCount).toBe(0);
    expect(rowC.openInvoiceCount).toBe(0);
    const workspaceC = getKundenWorkspace('customer', c.customer.id);
    expect(workspaceC).not.toBeNull();
    expect(workspaceC!.openVorgaenge).toHaveLength(0);
    expect(workspaceC!.contact.addressLine).toBe('Weg 1, 10115 Berlin');

    // Je Customer nur der eigene Vorgang.
    const workspaceA = getKundenWorkspace('customer', a.customer.id)!;
    const workspaceB = getKundenWorkspace('customer', b.customer.id)!;
    expect(workspaceA.openVorgaenge.map((v) => v.id)).toEqual(['v-a']);
    expect(workspaceB.openVorgaenge.map((v) => v.id)).toEqual(['v-b']);

    // Legacy und Orphan getrennt.
    const workspaceLegacy = getKundenWorkspace('legacy', buildLegacyKundenKey(SAME_NAME))!;
    expect(workspaceLegacy.openVorgaenge.map((v) => v.id)).toEqual(['v-legacy']);
    const workspaceOrphan = getKundenWorkspace('orphan', 'cust-nicht-im-store')!;
    expect(workspaceOrphan.openVorgaenge.map((v) => v.id)).toEqual(['v-orphan']);

    // Umbenennung wirkt auf die Anzeige, nicht auf die Snapshots.
    const billingBefore = { ...vorgangA.customerBilling! };
    const renamed = updateCustomer(a.customer.id, { name: 'NordWest Dachbau Nord GmbH' });
    expect(renamed.success).toBe(true);
    const afterRename = getKundenOverview().find((entry) => entry.key === a.customer.id)!;
    expect(afterRename.name).toBe('NordWest Dachbau Nord GmbH');
    expect(getKundenWorkspace('customer', a.customer.id)!.contact.name).toBe(
      'NordWest Dachbau Nord GmbH',
    );
    const storedA = hydrateAndRead('v-a');
    expect(storedA.customer).toBe(SAME_NAME);
    expect(storedA.customerBilling).toEqual(billingBefore);
  });

  it('ordnet Dokumente nur über sichere Vorgangsreferenzen zu', () => {
    hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: 'Eigene Firma GmbH' });
    const a = createCustomer({ name: SAME_NAME, street: 'Hafenstraße 12', zip: '45356', city: 'Essen' });
    const b = createCustomer({ name: SAME_NAME, street: 'Ruhrallee 5', zip: '44787', city: 'Bochum' });
    expect(a.success && b.success).toBe(true);
    if (!a.success || !b.success) return;

    hydrateVorgangStore([
      createTestVorgang({ id: 'v-a', customer: SAME_NAME, customerId: a.customer.id }),
      createTestVorgang({ id: 'v-b', customer: SAME_NAME, customerId: b.customer.id }),
      createTestVorgang({ id: 'v-legacy', customer: SAME_NAME }),
    ]);

    const safeDoc: CompanyDocument = {
      id: 'doc-safe',
      title: 'Vertrag A',
      category: 'vertrag',
      issuer: SAME_NAME,
      recognizedText: '',
      digitalFolder: { id: 'dig-1', name: 'Verträge', path: '/Vertraege/' },
      paperFolder: { folderId: 'p1', register: 'A', label: 'Ordner 1' },
      tags: [],
      linkedCompany: '',
      linkedVorgang: { vorgangId: 'v-a', vorgangTitle: 'Vorgang A' },
      archived: false,
      createdAt: '2026-05-04T09:00:00.000Z',
    } as CompanyDocument;
    const nameOnlyDoc: CompanyDocument = {
      ...safeDoc,
      id: 'doc-name-only',
      title: 'Nur Name',
      linkedCompany: SAME_NAME,
      linkedVorgang: null,
    };
    hydrateDocumentStore([safeDoc, nameOnlyDoc]);

    const idsFor = (kind: 'customer' | 'legacy', key: string) =>
      (getKundenWorkspace(kind, key)?.documents ?? []).map((doc) => doc.id);

    // Sicheres Dokument nur beim richtigen Customer.
    expect(idsFor('customer', a.customer.id)).toContain('doc-safe');
    expect(idsFor('customer', b.customer.id)).not.toContain('doc-safe');
    // Namensdokument bei keinem ID-Customer.
    expect(idsFor('customer', a.customer.id)).not.toContain('doc-name-only');
    expect(idsFor('customer', b.customer.id)).not.toContain('doc-name-only');
    // Aber im Legacy-Arbeitsbereich.
    expect(idsFor('legacy', buildLegacyKundenKey(SAME_NAME))).toContain('doc-name-only');
  });

  it('löst alte Kundenlinks auf und wählt bei Mehrdeutigkeit nicht automatisch', () => {
    hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: 'Eigene Firma GmbH' });
    const a = createCustomer({ name: SAME_NAME, street: 'Hafenstraße 12', zip: '45356', city: 'Essen' });
    expect(a.success).toBe(true);
    if (!a.success) return;
    hydrateVorgangStore([
      createTestVorgang({ id: 'v-a', customer: SAME_NAME, customerId: a.customer.id }),
    ]);

    // Genau ein Ziel.
    const single = resolveKundenLinkTargets(SAME_NAME);
    expect(single).toHaveLength(1);
    expect(single[0]!.route).toBe(`/kunden/customer/${a.customer.id}`);

    // Customer plus gleichnamiger Legacy-Vorgang → mehrdeutig.
    hydrateVorgangStore([
      createTestVorgang({ id: 'v-a', customer: SAME_NAME, customerId: a.customer.id }),
      createTestVorgang({ id: 'v-legacy', customer: SAME_NAME }),
    ]);
    const ambiguous = resolveKundenLinkTargets(SAME_NAME);
    expect(ambiguous).toHaveLength(2);
    expect(ambiguous.map((t) => t.kind).sort()).toEqual(['customer', 'legacy']);

    // Kein Ziel.
    expect(resolveKundenLinkTargets('Gibt es nicht')).toHaveLength(0);
  });

  it('berücksichtigt einen reinen Dokument-Legacy-Arbeitsbereich', () => {
    hydrateVorgangStore([]);
    const doc: CompanyDocument = {
      id: 'doc-only',
      title: 'Altdokument',
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
    } as CompanyDocument;
    hydrateDocumentStore([doc]);

    const targets = resolveKundenLinkTargets(SAME_NAME);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.kind).toBe('legacy');
    const workspace = getKundenWorkspace('legacy', SAME_NAME);
    expect(workspace).not.toBeNull();
    expect(workspace!.documents.map((d) => d.id)).toContain('doc-only');

    // Über den echten Routenschlüssel: Originalschreibweise aus linkedCompany.
    const routeKey = buildLegacyKundenKey(SAME_NAME);
    expect(routeKey).toBe(SAME_NAME.toLowerCase());
    const viaRoute = getKundenWorkspace('legacy', routeKey);
    expect(viaRoute).not.toBeNull();
    expect(viaRoute!.documents.map((d) => d.id)).toContain('doc-only');
    expect(viaRoute!.contact.name).toBe(SAME_NAME);
    expect(viaRoute!.name).toBe(SAME_NAME);
    expect(viaRoute!.contact.name).not.toBe(routeKey);
  });

  it('zeigt bei reinem Pfadtreffer ohne sichere Schreibweise keinen Routenschlüssel als Namen', () => {
    hydrateVorgangStore([]);
    const lowerKey = buildLegacyKundenKey(SAME_NAME);
    const doc: CompanyDocument = {
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
    } as CompanyDocument;
    hydrateDocumentStore([doc]);

    // Positive Vorbedingung: der Arbeitsbereich existiert überhaupt.
    const workspace = getKundenWorkspace('legacy', lowerKey);
    expect(workspace).not.toBeNull();
    expect(workspace!.documents.map((d) => d.id)).toContain('doc-path');
    // Kein kleingeschriebener Schlüssel als Name — die UI zeigt dann einen neutralen Titel.
    expect(workspace!.contact.name).toBe('');
    expect(workspace!.name).toBe('');

    // Trägt der Pfad eine echte Schreibweise, wird genau diese übernommen.
    hydrateDocumentStore([
      { ...doc, digitalFolder: { id: 'dig-2', name: 'Kunden', path: `/Kunden/${SAME_NAME}/2026/` } },
    ]);
    const recovered = getKundenWorkspace('legacy', lowerKey);
    expect(recovered).not.toBeNull();
    expect(recovered!.contact.name).toBe(SAME_NAME);
  });

  it('trennt Customer- und Orphan-Arbeitsbereich derselben ID', () => {
    hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: 'Eigene Firma GmbH' });
    const a = createCustomer({ name: SAME_NAME, street: 'Hafenstraße 12', zip: '45356', city: 'Essen' });
    expect(a.success).toBe(true);
    if (!a.success) return;
    hydrateVorgangStore([
      createTestVorgang({ id: 'v-a', customer: SAME_NAME, customerId: a.customer.id }),
      createTestVorgang({
        id: 'v-orphan',
        customer: SAME_NAME,
        customerId: 'cust-nicht-im-store',
      }),
    ]);

    // Positive Vorbedingung: der echte Customer-Arbeitsbereich existiert.
    const customerWorkspace = getKundenWorkspace('customer', a.customer.id);
    expect(customerWorkspace).not.toBeNull();
    expect(customerWorkspace!.openVorgaenge.map((v) => v.id)).toEqual(['v-a']);

    // Dieselbe ID als Waise ergibt keinen zweiten Arbeitsbereich.
    expect(getKundenWorkspace('orphan', a.customer.id)).toBeNull();

    // Eine echte Waise bleibt erreichbar.
    const orphanWorkspace = getKundenWorkspace('orphan', 'cust-nicht-im-store');
    expect(orphanWorkspace).not.toBeNull();
    expect(orphanWorkspace!.openVorgaenge.map((v) => v.id)).toEqual(['v-orphan']);
    // Keine Namensersatzverknüpfung: der Customer-Vorgang bleibt draußen.
    expect(orphanWorkspace!.openVorgaenge.map((v) => v.id)).not.toContain('v-a');
  });
});

function hydrateAndRead(vorgangId: string): Vorgang {
  // Liest den gespeicherten Vorgang über den produktiven Store-Leser.
  const vorgang = getVorgangById(vorgangId);
  expect(vorgang).toBeDefined();
  return vorgang!;
}
