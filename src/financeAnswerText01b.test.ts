/**
 * P0/P1-INTEGRITAET 01B / P4 — Finanzantworten des Assistenten zeigen Text,
 * keine Übersetzungsschlüssel.
 *
 * Hinweise und Empfehlungen der Finanzanalyse tragen `messageKey` + `params`.
 * Vorher landete der Schlüssel roh in den Antwortzeilen
 * („⚠ financeIntelligence.risk.invoiceOverdue"). Geprüft wird die sichtbare
 * Antwort: kein Schlüssel, keine offenen Platzhalter, Parameter eingesetzt.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { hydrateInboxStore } from './services/inboxService';
import { hydrateVorgangStore } from './services/vorgangService';
import { hydrateCommunicationHistory } from './services/communicationHistoryService';
import { resetDunningDocumentations } from './services/dunningDocumentationService';
import { processOfficePilotQuestion } from './services/brain/brainOrchestrator';
import { analyzeGlobalFinance } from './services/brain/financeIntelligenceService';
import { tryResolveFinanceQuestion } from './services/brain/financeKnowledgeResolver';
import {
  recordInvoiceContext,
  recordVorgangContext,
  resetCompanySessionForTests,
} from './services/brain/companySessionService';
import { createMaterialInboxItem, createTestVorgang } from './test/fixtures';
import type { InboxItem, VorgangInvoice } from './types/models';

const RAW_KEY = /\b(financeIntelligence|workflowIntelligence)\.[A-Za-z0-9_.]+/;
const OPEN_PLACEHOLDER = /\{[a-zA-Z]+\}/;

const profile = {
  companyName: 'Beispiel Handwerk GmbH',
  legalForm: 'GmbH',
  street: 'Musterweg 1',
  zip: '10115',
  city: 'Berlin',
  country: 'Deutschland',
  contactPerson: 'Erika Beispiel',
  phone: '030',
  email: 'info@beispiel.invalid',
  website: '',
  taxNumber: '27/000/00000',
  vatId: 'DE000000000',
  bankName: 'Beispielbank',
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
  defaultPaymentDays: 14,
  defaultPaymentTerms: '14 Tage',
  defaultSkonto: '',
  invoiceFooterNotes: '',
};

function rechnung(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-p4',
    number: 'RE-2026-401',
    type: 'abschlag',
    abschlagNumber: 1,
    positions: [
      { id: 'l1', orderPositionId: 'op1', description: 'Leistung', quantity: 5, unit: 'Stunden', unitPrice: 65, lineTotal: 325 },
    ],
    subtotal: 325,
    taxStatus: 'standard_19',
    amount: 386.75,
    status: 'versendet',
    date: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    issueDate: '2026-06-01',
    paymentDueDate: '2020-01-01',
    customerSnapshot: { name: 'Beispiel Kunde', contactPerson: '', street: '', zip: '', city: '', email: '', phone: '' },
    payments: [],
    ...overrides,
  };
}

/** Der sichtbare Hinweis unter der Antwort — ebenfalls Text, kein Schlüssel. */
function expectCleanNote(note: string | undefined): void {
  if (note === undefined) return;
  expect(note, `Rohschlüssel im Hinweis „${note}"`).not.toMatch(RAW_KEY);
  expect(note).not.toMatch(OPEN_PLACEHOLDER);
}

function expectCleanBullets(bullets: readonly string[] | undefined): void {
  expect(bullets && bullets.length > 0, 'keine Antwortzeilen').toBe(true);
  for (const bullet of bullets ?? []) {
    expect(bullet, `Rohschlüssel in „${bullet}"`).not.toMatch(RAW_KEY);
    expect(bullet, `offener Platzhalter in „${bullet}"`).not.toMatch(OPEN_PLACEHOLDER);
  }
}

beforeEach(() => {
  localStorage.clear();
  resetCompanySessionForTests();
  hydrateCompanyProfileStore(profile);
  hydrateCommunicationHistory([]);
  resetDunningDocumentations();
  hydrateVorgangStore([
    createTestVorgang({
      id: 'v-p4',
      title: 'Bad Beispiel',
      invoices: [
        rechnung(),
        rechnung({
          id: 'inv-p4-teil',
          number: 'RE-2026-402',
          payments: [{ id: 'pay-p4', date: '2026-06-10', amount: 100, method: 'ueberweisung' } as never],
        }),
      ],
    }),
  ]);
  hydrateInboxStore([
    { ...createMaterialInboxItem(), id: 'inbox-p4', classifiedKind: 'eingangsrechnung' } as InboxItem,
  ]);
});

describe('P4 — keine financeIntelligence-Rohschlüssel in sichtbaren Antworten', () => {
  it('Gesamtstand: Hinweise, Empfehlung und DATEV-Zeile sind übersetzt, {count} eingesetzt', () => {
    const analysis = analyzeGlobalFinance();
    expect(analysis.risks.length + analysis.recommendations.length).toBeGreaterThan(0);
    expect(analysis.datevRelevantCount).toBe(1);

    const result = tryResolveFinanceQuestion('Wie ist der Finanzstand?');
    const bullets = result?.assistantAnswer?.bullets;
    expectCleanBullets(bullets);
    // Mit Hinweisen gibt es immer einen Prüfhinweis — als Text.
    expect(result?.uncertaintyNote).toBeTruthy();
    expectCleanNote(result?.uncertaintyNote);
    // Die DATEV-Zeile trägt die Anzahl, nicht den Platzhalter.
    expect(bullets?.some((line) => /Buchhaltung/.test(line) && /\b1\b/.test(line))).toBe(true);
    // Mindestens eine Hinweis- oder Empfehlungszeile ist echter Text.
    expect(bullets?.some((line) => /^[⚠→] \S/.test(line))).toBe(true);
  });

  it('überfällige Rechnung: Parameter (Nummer) stehen im Text', () => {
    recordInvoiceContext('v-p4', 'inv-p4');
    const bullets = tryResolveFinanceQuestion('Welche Rechnungen sind überfällig?')?.assistantAnswer?.bullets;
    expectCleanBullets(bullets);
    expect(bullets?.some((line) => line.startsWith('⚠') && line.includes('RE-2026-401'))).toBe(true);
  });

  it('Vorgang mit Teilzahlung: Zahlungsstand ohne Schlüssel', () => {
    recordVorgangContext('v-p4');
    expectCleanBullets(tryResolveFinanceQuestion('Ist die Rechnung bezahlt?')?.assistantAnswer?.bullets);
  });

  it('Steuerfragen: Erklärzeilen übersetzt', () => {
    recordInvoiceContext('v-p4', 'inv-p4');
    for (const question of ['Was bedeutet Reverse Charge §13b?', 'Was bedeutet Kleinunternehmerregelung?']) {
      const result = tryResolveFinanceQuestion(question);
      expectCleanBullets(result?.assistantAnswer?.bullets);
      expectCleanNote(result?.uncertaintyNote);
    }
  });

  it('über den Orchestrator (der Weg in die Oberfläche) ebenso', async () => {
    recordInvoiceContext('v-p4', 'inv-p4');
    const result = await processOfficePilotQuestion('Welche Rechnungen sind überfällig?', { mode: 'rules' });
    expect(result.financeUsed).toContain('finance_intelligence');
    expectCleanBullets(result.assistantAnswer?.bullets);
    expectCleanNote(result.uncertaintyNote);
    // DATEV- und Skonto-Fragen setzen eigene Hinweise.
    for (const question of ['Welche Buchhaltungsbelege gibt es?', 'Gibt es Skonto?']) {
      expectCleanNote((await processOfficePilotQuestion(question, { mode: 'rules' })).uncertaintyNote);
    }
  });
});
