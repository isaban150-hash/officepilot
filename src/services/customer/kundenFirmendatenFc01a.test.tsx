/**
 * FINANZ-CORE-01A — Kunden- und Firmendaten (K-Block): KUN-04, KUN-08, KUN-09, KUN-11, KUN-12,
 * BUH-13, EIN-03, EIN-08.
 *
 *  K4a  Vollvergleich erkennt im Stamm gelöschte optionale Felder; Übernahme ersetzt vollständig
 *  K4b  Vorgang: Abweichung trotz gleicher Stammschlüssel; Übernahme entfernt das Feld
 *  K8a  Abweichungsfelder und Kennzeichen der Rückfrage
 *  K8b  Rückfragekarte: bisher neben aktuell, nur abweichende Felder
 *  K9a  Anlegen prüft E-Mail, USt-IdNr., Ländercode, Leitweg-ID und vereinheitlicht
 *  K9b  Ändern prüft, was es setzt; Leeren entfernt
 *  K9c  Kundenentscheidung im Eingang prüft dasselbe
 *  K9d  Rechnungsprüfung warnt vor fehlerhaften Empfängerangaben
 *  K11  Namensvettern trotz doppelter Leerzeichen erkannt (Altbestand ohne Anlagedatum)
 *  K12a Archiv: Aussteller aus dem Beleg, nicht aus der Einrichtung
 *  K12b Rechnungskopf: Empfänger des Belegs, nicht der heutige Auftragskunde
 *  K12c Kundenakte zeigt USt-IdNr., Land und Leitweg-ID
 *  B13  Storno einer Ausgabe kurz nach Mitternacht: Geschäftstag
 *  B13b Rücknahme einer Mitarbeiterzahlung kurz nach Mitternacht: Geschäftstag
 *  E3a  Der App-Kontext folgt dem Firmenprofil im Store
 *  E3b  Firmendaten: eine fremde IBAN-Änderung geht beim Speichern einer Telefonnummer nicht verloren
 *  E3c  auch ohne Nachführung (Store still geändert): gespeichert wird nur das geänderte Feld
 *  E3d  dasselbe auf den Rechnungseinstellungen und E3e auf der Kommunikationsseite
 *  E8   Rechnungseinstellungen nennen fehlende Firmendaten und verlinken sie
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InvoiceCustomerDriftCard } from '../../components/invoice/InvoiceCustomerDriftCard';
import { AppProvider, useApp } from '../../context/AppContext';
import { AuthProvider } from '../../context/AuthContext';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { t, type TranslationKey } from '../../i18n';
import * as supabaseLib from '../../lib/supabase';
import { InvoiceDetailPage } from '../../pages/InvoiceDetailPage';
import { KundenDetailPage } from '../../pages/KundenDetailPage';
import { KundenPage } from '../../pages/KundenPage';
import { CompanySettingsPage } from '../../pages/settings/CompanySettingsPage';
import { InvoiceSettingsPage } from '../../pages/settings/InvoiceSettingsPage';
import { CommunicationSettingsPage } from '../../pages/settings/CommunicationSettingsPage';
import { loginAsDefaultAdmin, resetAuthForTests } from '../../test/authFixtures';
import { createOrderPosition, createTestVorgang, testSetup } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import { alsInhaber } from '../../test/workspaceRoleTestUtils';
import { isValidIban } from '../../utils/iban';
import { getCompanyProfile, hydrateCompanyProfileStore } from '../companyProfileService';
import {
  billingFromCustomer,
  createCustomer,
  updateCustomer,
  validateCustomerDecisionForCreate,
} from '../customerService';
import { hydrateCustomerStore } from '../customerStoreService';
import { buildOutgoingInvoiceDocumentInput } from '../invoiceArchiveService';
import {
  buildInvoiceDraftForType,
  replaceInvoiceDraftCustomerBilling,
  validateInvoiceDraftForApproval,
} from '../invoiceService';
import { persistAll } from '../persistenceService';
import { buildMitarbeiterZahlungen, resolveExpenseStornoDatum } from '../steuerberater/monatsmappeModelService';
import { setActiveStorageScope } from '../storage/storageScopeService';
import { resetUiSessionLiveState } from '../uiSession/uiSessionLiveState';
import { clearUiSessionSnapshot } from '../uiSession/uiSessionStore';
import {
  getVorgangById,
  getVorgangCustomerMasterPreview,
  hydrateVorgangStore,
  updateVorgangCustomerFromMaster,
} from '../vorgangService';
import { customerBillingDrift, customerDriftFingerprint, sameCustomerBilling } from './customerBillingCopy';
import type { Expense } from '../../types/expense';
import type { CompanyProfile, Customer, CustomerBilling, InvoiceDraft, VorgangInvoice } from '../../types/models';

const BASIS: CustomerBilling = {
  name: 'Kunde K GmbH',
  contactPerson: 'Frau K',
  street: 'Weg 1',
  zip: '10115',
  city: 'Berlin',
  email: 'kunde@example.invalid',
  phone: '',
};

function kunde(input: Partial<Customer> & { name: string }): Customer {
  const result = createCustomer({ ...BASIS, ...input }, { allowDuplicate: true });
  if (!result.success) throw new Error(result.errorKey);
  return result.customer;
}

beforeEach(() => {
  resetTestStores();
  localStorage.clear();
  alsInhaber();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

/* ================================================================== */
/* KUN-04                                                              */
/* ================================================================== */

describe('KUN-04 — Übernahme aus dem Kundenstamm vollständig', () => {
  it('K4a: Vollvergleich erkennt gelöschte optionale Felder; Übernahme ersetzt vollständig', () => {
    const master: CustomerBilling = { ...BASIS };
    const entwurf: CustomerBilling = { ...BASIS, vatId: 'DE123456789', leitwegId: '04011000-12345-67' };
    expect(sameCustomerBilling(master, entwurf)).toBe(false);
    // Abwesenheit und leerer Text sind gleich.
    expect(sameCustomerBilling(master, { ...BASIS, vatId: '' })).toBe(true);

    const ersetzt = replaceInvoiceDraftCustomerBilling({ customerBilling: entwurf } as InvoiceDraft, master);
    expect(ersetzt.customerBilling).toEqual(master);
    expect(ersetzt.customerBilling.vatId).toBeUndefined();
    expect(ersetzt.customerBilling.leitwegId).toBeUndefined();
  });

  it('K4b: Vorgang — Abweichung trotz gleicher Stammschlüssel; Übernahme entfernt das Feld', () => {
    const stamm = kunde({ name: 'Kunde K4' });
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-k4',
        customerId: stamm.id,
        customer: stamm.name,
        customerBilling: { ...billingFromCustomer(stamm), vatId: 'DE999999999' },
      }),
    ]);
    expect(getVorgangCustomerMasterPreview('v-k4')?.differs).toBe(true);
    const ergebnis = updateVorgangCustomerFromMaster('v-k4');
    expect(ergebnis.success && ergebnis.changed).toBe(true);
    expect(getVorgangById('v-k4')?.customerBilling?.vatId).toBeUndefined();
  });
});

/* ================================================================== */
/* KUN-08                                                              */
/* ================================================================== */

describe('KUN-08 — Rückfrage zu geänderten Kundendaten', () => {
  it('K8a: Abweichungsfelder und Kennzeichen', () => {
    const entwurf: CustomerBilling = { ...BASIS };
    const master: CustomerBilling = { ...BASIS, street: 'Neue Straße 9', vatId: 'DE123456789' };
    expect(customerBillingDrift(entwurf, master)).toEqual(['street', 'vatId']);
    expect(customerBillingDrift(entwurf, { ...BASIS })).toEqual([]);
    // Die Zusage gilt nur für genau dieses Paar.
    const zusage = customerDriftFingerprint(entwurf, master);
    expect(customerDriftFingerprint(entwurf, { ...master, street: 'Andere Straße' })).not.toBe(zusage);
    expect(customerDriftFingerprint(entwurf, { ...master })).toBe(zusage);
  });

  it('K8b: die Karte zeigt bisher neben aktuell, nur für abweichende Felder', () => {
    const html = renderToStaticMarkup(
      createElement(InvoiceCustomerDriftCard, {
        fields: ['street', 'vatId'],
        draftBilling: { ...BASIS },
        masterBilling: { ...BASIS, street: 'Neue Straße 9', vatId: 'DE123456789' },
        translate: (key: TranslationKey) => t(key),
        onKeep: () => {},
        onApply: () => {},
      }),
    );
    expect(html).toContain('data-testid="invoice-customer-drift-confirm"');
    expect(html).toContain('Weg 1');
    expect(html).toContain('Neue Straße 9');
    expect(html).toContain(t('invoice.companyDrift.empty' as TranslationKey));
    expect(html).toContain('DE123456789');
    expect(html).not.toContain('data-field="city"');
    expect(html).toContain('data-testid="invoice-customer-drift-keep"');
    expect(html).toContain('data-testid="invoice-customer-drift-apply"');
  });
});

/* ================================================================== */
/* KUN-09                                                              */
/* ================================================================== */

describe('KUN-09 — Formatprüfung der Kundenangaben', () => {
  it('K9a: Anlegen prüft und vereinheitlicht', () => {
    const ok = kunde({
      name: 'Format GmbH',
      email: ' info@format.invalid ',
      vatId: 'de 123 456 789',
      countryCode: 'deutschland',
      leitwegId: '04011000-1234512345-06',
    });
    expect(ok.email).toBe('info@format.invalid');
    expect(ok.vatId).toBe('DE123456789');
    expect(ok.countryCode).toBe('DE');
    expect(ok.leitwegId).toBe('04011000-1234512345-06');

    expect(kunde({ name: 'Österreich GmbH', vatId: 'ATU12345678', countryCode: 'at' }).countryCode).toBe('AT');
    expect(kunde({ name: 'Schweiz AG', vatId: 'CHE-123.456.789 MWST' }).vatId).toBe('CHE123456789MWST');
    expect(kunde({ name: 'Paris SARL', vatId: 'FR12345678901', countryCode: 'FR' }).countryCode).toBe('FR');

    const faelle: Array<[keyof Customer, string, string]> = [
      ['email', 'info@format', 'customer.validation.email'],
      ['vatId', 'DE12345', 'customer.validation.vatId'],
      ['vatId', 'DE-TEST-A', 'customer.validation.vatId'],
      ['countryCode', 'GER', 'customer.validation.countryCode'],
      ['leitwegId', 'TEST-LEITWEG', 'customer.validation.leitwegId'],
    ];
    for (const [feld, wert, schluessel] of faelle) {
      const r = createCustomer({ ...BASIS, name: `Fehler ${feld} ${wert}`, [feld]: wert }, { allowDuplicate: true });
      expect(r.success ? 'angelegt' : r.errorKey, `${feld}=${wert}`).toBe(schluessel);
    }
    // Die Texte sind übersetzt, kein roher Schlüssel.
    expect(t('customer.validation.vatId' as TranslationKey)).toContain('DE123456789');
  });

  it('K9b: Ändern prüft, was es setzt; Leeren entfernt', () => {
    const stamm = kunde({ name: 'Ändern GmbH', vatId: 'DE123456789' });
    const falsch = updateCustomer(stamm.id, { vatId: 'XX' });
    expect(falsch.success ? 'gespeichert' : falsch.errorKey).toBe('customer.validation.vatId');
    const telefon = updateCustomer(stamm.id, { phone: '030 1' });
    expect(telefon.success).toBe(true);
    const normal = updateCustomer(stamm.id, { vatId: 'de 987 654 321', countryCode: 'Schweiz' });
    expect(normal.success && normal.customer.vatId).toBe('DE987654321');
    expect(normal.success && normal.customer.countryCode).toBe('CH');
    const leer = updateCustomer(stamm.id, { vatId: '' });
    expect(leer.success && leer.customer.vatId).toBeUndefined();
  });

  it('K9c: die Kundenentscheidung im Eingang prüft dasselbe', () => {
    const r = validateCustomerDecisionForCreate({ kind: 'new', input: { name: 'Neu aus Eingang', email: 'kaputt' } });
    expect(r.ok ? 'ok' : r.errorKey).toBe('customer.validation.email');
    expect(validateCustomerDecisionForCreate({ kind: 'new', input: { name: 'Neu aus Eingang', email: 'ok@example.invalid' } }).ok).toBe(true);
  });

  it('K9d: die Rechnungsprüfung warnt vor fehlerhaften Empfängerangaben', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-k9',
        materialSource: 'betrieb',
        orderPositions: [createOrderPosition({ id: 'op-1', plannedQuantity: 1, executedQuantity: 1, unit: 'Stück', unitPrice: 100, category: 'arbeit' })],
      }),
    ]);
    const base = buildInvoiceDraftForType('v-k9', testSetup, 'rechnung')!;
    const codes = (billing: Partial<CustomerBilling>) =>
      validateInvoiceDraftForApproval(
        { ...base, customerBilling: { ...base.customerBilling, ...billing } },
        getCompanyProfile(),
        getVorgangById('v-k9'),
      ).warnings.map((w) => w.code);
    const fehlerhaft = codes({ email: 'x@y', vatId: 'DE12', countryCode: 'XYZ', leitwegId: 'L-1' });
    expect(fehlerhaft).toEqual(
      expect.arrayContaining(['customer_email_format', 'customer_vat_id_format', 'customer_country_format', 'customer_leitweg_format']),
    );
    const sauber = codes({ email: 'kunde@example.invalid', vatId: 'DE123456789', countryCode: 'DE', leitwegId: '04011000-12345-67' });
    expect(sauber.filter((code) => code.startsWith('customer_'))).toEqual([]);
  });
});

/* ================================================================== */
/* KUN-11 / KUN-12                                                     */
/* ================================================================== */

function mount(element: ReactNode): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return { container, root };
}

describe('KUN-11/KUN-12 — Anzeige', () => {
  it('K11: Namensvettern trotz doppelter Leerzeichen erkannt (Altbestand ohne Anlagedatum)', () => {
    const alt = (id: string, name: string): Customer => ({
      id,
      name,
      contactPerson: '',
      street: '',
      zip: '',
      city: '',
      email: '',
      phone: '',
      createdAt: '',
      updatedAt: '',
    });
    hydrateCustomerStore([alt('cust-a', 'Hans Schulz'), alt('cust-b', 'Hans  Schulz')]);
    const { container, root } = mount(
      <MemoryRouter initialEntries={['/kunden']}>
        <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 }}>
          <Routes>
            <Route path="/kunden" element={<KundenPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
    const hinweise = [...container.querySelectorAll('[data-testid="kunde-identity-hint"]')].map((el) => el.textContent);
    expect(hinweise).toHaveLength(2);
    act(() => root.unmount());
  });

  it('K12a: Archiv — Aussteller aus dem Beleg, nicht aus der Einrichtung', () => {
    const invoice = { id: 'inv-k12', number: '2026-0120', type: 'rechnung', status: 'vorbereitet', amount: 119, subtotal: 100, taxStatus: 'standard_19', date: '2026-09-01', issueDate: '2026-09-01', positions: [], customerSnapshot: { ...BASIS }, companySnapshot: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Alter Betrieb' } } as unknown as VorgangInvoice;
    const input = buildOutgoingInvoiceDocumentInput(invoice, null, 'Neuer Betrieb');
    expect(input.issuer).toBe('Alter Betrieb');
    expect(input.linkedCompany).toBe('Alter Betrieb');
    const ohneSnapshot = buildOutgoingInvoiceDocumentInput({ ...invoice, companySnapshot: undefined } as VorgangInvoice, null, 'Neuer Betrieb');
    expect(ohneSnapshot.issuer).toBe('Neuer Betrieb');
  });

  it('K12b: Rechnungskopf — Empfänger des Belegs, nicht der heutige Auftragskunde', () => {
    const invoice = {
      id: 'inv-k12b',
      number: '2026-0121',
      type: 'rechnung',
      positions: [{ id: 'l1', orderPositionId: 'op-1', description: 'Arbeit', quantity: 1, unit: 'Stück', unitPrice: 100, lineTotal: 100 }],
      subtotal: 100,
      taxStatus: 'standard_19',
      amount: 119,
      status: 'vorbereitet',
      date: '2026-09-01',
      createdAt: '2026-09-01T08:00:00.000Z',
      issueDate: '2026-09-01',
      servicePeriodFrom: '2026-08-01',
      servicePeriodTo: '2026-08-31',
      servicePeriodConfirmed: true,
      paymentDueDate: '2026-09-15',
      customerSnapshot: { ...BASIS, name: 'Alter Name GmbH' },
      companySnapshot: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Betrieb', street: 'Weg 2', zip: '1', city: 'X', taxNumber: '1/2/3' },
      legalNotices: [],
      previousAbschlagDeductions: [],
      payments: [],
    } as unknown as VorgangInvoice;
    hydrateVorgangStore([createTestVorgang({ id: 'v-k12', customer: 'Neuer Name GmbH', invoices: [invoice] })]);
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/vorgaenge/v-k12/rechnungen/inv-k12b']}>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <Routes>
            <Route path="/vorgaenge/:id/rechnungen/:invoiceId" element={<InvoiceDetailPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
    expect(html).toContain('2026-0121 · Alter Name GmbH');
    expect(html).not.toContain('2026-0121 · Neuer Name GmbH');
  });

  it('K12c: die Kundenakte zeigt USt-IdNr., Land und Leitweg-ID', () => {
    const stamm = kunde({ name: 'Akte GmbH', vatId: 'DE123456789', countryCode: 'AT', leitwegId: '04011000-12345-67' });
    const { container, root } = mount(
      <MemoryRouter initialEntries={[`/kunden/customer/${stamm.id}`]}>
        <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 }}>
          <Routes>
            <Route path="/kunden/customer/:customerId" element={<KundenDetailPage kind="customer" />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
    const kontakt = container.querySelector('[data-testid="kunden-contact"]')?.textContent ?? '';
    expect(kontakt).toContain('DE123456789');
    expect(kontakt).toContain('AT');
    expect(kontakt).toContain('04011000-12345-67');
    act(() => root.unmount());
  });
});

/* ================================================================== */
/* BUH-13                                                              */
/* ================================================================== */

describe('BUH-13 — Geschäftstag statt UTC-Tag', () => {
  it('B13: Storno einer Ausgabe um 0:30 Uhr am Monatsersten gehört in den neuen Monat', () => {
    // 22:30 UTC am 30.09. ist 0:30 Uhr am 01.10. in Berlin (Sommerzeit).
    expect(resolveExpenseStornoDatum({ cancelledAt: '2026-09-30T22:30:00.000Z' } as Expense)).toBe('2026-10-01');
    expect(resolveExpenseStornoDatum({ cancelledAt: '2026-09-30' } as Expense)).toBe('2026-09-30');
    expect(resolveExpenseStornoDatum({} as Expense)).toBeNull();
  });

  it('B13b: Rücknahme einer Mitarbeiterzahlung um 0:30 Uhr am Monatsersten zählt im neuen Monat', () => {
    const zahlung = {
      id: 'ep-b13',
      receiptReference: 'MZ-2026-0001',
      paymentDate: '2026-09-10',
      employeeName: 'A. Beispiel',
      kind: 'advance',
      paymentMethod: 'cash',
      amount: 100,
      reversedAt: '2026-09-30T22:30:00.000Z',
      reversalReason: 'Doppelt erfasst',
    } as never;
    const eingabe = { monthKey: '2026-09', invoices: [], expenses: [], documents: [], inboxItems: [], fileRefs: [], employeePayments: [zahlung] };
    const september = buildMitarbeiterZahlungen(eingabe, '2026-09').zeilen;
    expect(september[0]).toMatchObject({ art: 'zahlung', status: 'aktiv', spaeterStorniertAm: '2026-10-01' });
    const oktober = buildMitarbeiterZahlungen({ ...eingabe, monthKey: '2026-10' }, '2026-10').zeilen;
    expect(oktober.map((zeile) => [zeile.art, zeile.datum])).toEqual([['storno', '2026-10-01']]);
  });
});

/* ================================================================== */
/* EIN-03 / EIN-08                                                     */
/* ================================================================== */

const SAVED: CompanyProfile = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Bestand GmbH',
  legalForm: 'GmbH',
  street: 'Werkstraße 2',
  zip: '54321',
  city: 'Betriebsstadt',
  country: 'Deutschland',
  contactPerson: 'A. Beispiel',
  email: 'info@example.invalid',
  taxNumber: '143/123/45678',
  bankName: 'Musterbank',
  iban: 'DE89370400440532013000',
  bic: 'MUSTDEFF',
  defaultPaymentDays: 14,
  defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen.',
};
const FREMDE_IBAN = 'DE02120300000000202051';

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

async function renderSettings(route: string, element: ReactNode): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>
          <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true }}>
            <Routes>
              <Route path={route} element={element} />
              <Route path="/einstellungen/firma" element={<div data-testid="company-settings-stub" />} />
            </Routes>
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
  await settle();
  return { container, root };
}

async function tippe(container: HTMLElement, testId: string, value: string): Promise<void> {
  const el = container.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement | HTMLTextAreaElement;
  expect(el, testId).not.toBeNull();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function absenden(container: HTMLElement, selector: string): Promise<void> {
  const form = container.querySelector(selector) as HTMLFormElement;
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
}

describe('EIN-03/EIN-08 — Einstellungen über dem aktuellen Firmenprofil', () => {
  beforeEach(async () => {
    resetAuthForTests();
    setActiveStorageScope({ type: 'guest' });
    resetUiSessionLiveState();
    clearUiSessionSnapshot();
    hydrateCompanyProfileStore(SAVED);
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
    await loginAsDefaultAdmin();
  });

  afterEach(() => {
    clearUiSessionSnapshot();
    resetUiSessionLiveState();
  });

  it('E3a: der App-Kontext folgt dem Firmenprofil im Store', async () => {
    function Sonde() {
      const { companyProfile } = useApp();
      return <span data-testid="sonde">{companyProfile.iban}</span>;
    }
    const { container, root } = await renderSettings('/sonde', <Sonde />);
    expect(container.querySelector('[data-testid="sonde"]')?.textContent).toBe(SAVED.iban);
    // Ein Abzug aus der Cloud legt den neuen Stand in den Store und speichert lokal.
    await act(async () => {
      hydrateCompanyProfileStore({ ...SAVED, iban: FREMDE_IBAN });
      persistAll();
    });
    expect(container.querySelector('[data-testid="sonde"]')?.textContent).toBe(FREMDE_IBAN);
    act(() => root.unmount());
  });

  it('E3b: eine fremde IBAN-Änderung geht beim Speichern einer Telefonnummer nicht verloren', async () => {
    expect(isValidIban(FREMDE_IBAN)).toBe(true);
    const { container, root } = await renderSettings('/einstellungen/firma', <CompanySettingsPage />);
    await tippe(container, 'settings-company-phone', '+49 5222 1');
    // Währenddessen ändert ein anderes Gerät die IBAN (Abzug aus der Cloud).
    await act(async () => {
      hydrateCompanyProfileStore({ ...SAVED, iban: FREMDE_IBAN });
      persistAll();
    });
    await settle();
    // Das unberührte Feld zeigt den neuen Stand.
    // EINRICHTUNG-01 (AP6; F-03) — angezeigt in Vierergruppen; gespeichert bleibt die elektronische Form.
    expect((container.querySelector('[data-testid="settings-company-iban"]') as HTMLInputElement).value.replace(/\s+/g, '')).toBe(FREMDE_IBAN);
    await absenden(container, 'form.settings-form');
    const profil = getCompanyProfile();
    expect(profil.phone).toBe('+49 5222 1');
    expect(profil.iban).toBe(FREMDE_IBAN);
    act(() => root.unmount());
  });

  it('E3c: auch ohne Nachführung (Store still geändert) wird nur das geänderte Feld gespeichert', async () => {
    const { container, root } = await renderSettings('/einstellungen/firma', <CompanySettingsPage />);
    await tippe(container, 'settings-company-phone', '+49 5222 2');
    // Ein Stand im Store, von dem die Seite nichts erfährt (keine lokale Speicherung gemeldet).
    hydrateCompanyProfileStore({ ...SAVED, iban: FREMDE_IBAN });
    await absenden(container, 'form.settings-form');
    const profil = getCompanyProfile();
    expect(profil.phone).toBe('+49 5222 2');
    expect(profil.iban).toBe(FREMDE_IBAN);
    act(() => root.unmount());
  });

  it('E3d: Rechnungseinstellungen schreiben nur das geänderte Feld', async () => {
    const { container, root } = await renderSettings('/einstellungen/rechnungen', <InvoiceSettingsPage />);
    await tippe(container, 'settings-invoices-defaultIntroText', 'Neuer Einleitungstext');
    hydrateCompanyProfileStore({ ...SAVED, defaultPaymentDays: 30, defaultPaymentTerms: 'Zahlbar innerhalb von 30 Tagen.' });
    await absenden(container, 'form.settings-invoices');
    const profil = getCompanyProfile();
    expect(profil.defaultIntroText).toBe('Neuer Einleitungstext');
    expect(profil.defaultPaymentDays).toBe(30);
    act(() => root.unmount());
  });

  it('E3e: Kommunikationseinstellungen schreiben nur das geänderte Feld', async () => {
    hydrateCompanyProfileStore({ ...SAVED, emailSignature: 'Alte Signatur' });
    const { container, root } = await renderSettings('/einstellungen/kommunikation', <CommunicationSettingsPage />);
    await tippe(container, 'settings-communication-senderDisplayName', 'Bestand Büro');
    hydrateCompanyProfileStore({ ...SAVED, emailSignature: 'Neue Signatur von Gerät B' });
    await absenden(container, 'form.settings-communication');
    const profil = getCompanyProfile();
    expect(profil.senderDisplayName).toBe('Bestand Büro');
    expect(profil.emailSignature).toBe('Neue Signatur von Gerät B');
    act(() => root.unmount());
  });

  it('E8: die Rechnungseinstellungen nennen fehlende Firmendaten und verlinken sie', async () => {
    hydrateCompanyProfileStore({ ...SAVED, companyName: '' });
    const { container, root } = await renderSettings('/einstellungen/rechnungen', <InvoiceSettingsPage />);
    await tippe(container, 'settings-invoices-defaultIntroText', 'Neuer Einleitungstext');
    await absenden(container, 'form.settings-invoices');
    const hinweis = container.querySelector('[data-testid="settings-invoices-company-errors"]');
    expect(hinweis, 'Hinweis fehlt').not.toBeNull();
    expect(hinweis?.querySelectorAll('li').length).toBeGreaterThan(0);
    expect(container.querySelector('[data-testid="settings-invoices-company-link"]')?.getAttribute('href')).toBe('/einstellungen/firma');
    // Nichts gespeichert.
    expect(getCompanyProfile().defaultIntroText ?? '').not.toBe('Neuer Einleitungstext');
    act(() => root.unmount());
  });
});
