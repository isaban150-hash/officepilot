/**
 * P1MA WEISS — Dokumentdetail einer eindeutig zugeordneten Mitarbeiterquittung.
 *
 * Erzeugte Quittung und unterschriebener Nachweis zeigen keinen
 * „Wahrscheinlichen Auftrag" und keine „Das konnte OfficeTakt nicht sicher
 * erkennen"-Zeilen. Die erzeugte Quittung trägt keine Deutungskarte mit
 * „Original abheften". Ein gewöhnliches Dokument mit demselben Text behält die
 * allgemeine Deutung (Gegenprobe).
 *
 * Die allgemeinen Analyseangaben („Dokumentangaben") sind hier für jedes
 * Dokument vorhanden (gestellt): Eine Mitarbeiterquittung zeigt sie nicht,
 * das gewöhnliche Dokument schon.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../context/AppContext';
import { AuthProvider } from '../context/AuthContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { DokumentDetailPage } from './DokumentDetailPage';
import { loginAsDefaultAdmin } from '../test/authFixtures';
import * as supabaseLib from '../lib/supabase';
import { hydrateWorkspaceStore } from '../services/workspace/workspaceStore';
import { resetSyncClientForTests } from '../services/sync/syncClientService';
import { hydrateDocumentStore } from '../services/documentService';
import { hydrateEmployeePaymentStore, hydrateEmployeeStore } from '../services/employee/employeeStore';
import { hydrateVorgangStore, resetVorgaenge } from '../services/vorgangService';
import { resetMemoryStore } from '../services/officePilotMemoryStore';
import type { CompanyDocument, CompanySetup, Vorgang } from '../types/models';
import type { Employee, EmployeePayment } from '../types/employee';

vi.mock('../services/documentArchiveTruthDisplayService', () => ({
  buildDocumentArchiveTruthDisplayView: () => ({
    facts: [
      { labelValue: 'Bestätigungserfordernis: Vorgang zuordnen oder neuen Vorgang bewusst anlegen.', provenance: 'analysis' },
      { labelValue: 'Zusammenfassung: Dokumentart oder betriebliche Bedeutung ist unsicher — manuelle Prüfung erforderlich.', provenance: 'analysis' },
    ],
    conflictLines: [],
  }),
}));

const setup: CompanySetup = { ...DEFAULT_SETUP, setupComplete: true, language: 'de' };
const WORKSPACE_ID = '00000000-0000-4000-8000-00000000e1e2';

const TEXT = [
  'Beispielbetrieb GmbH',
  'Auszahlungsquittung',
  'Referenz MZ-20261008-R8A1JP1G',
  'Auszahlungsdatum 08.10.2026',
  'Mitarbeiter/in Erika Beispiel',
  'Art der Zahlung Auslagenerstattung',
  'Zahlungsweg Bar',
  'Ausgezahlter Betrag 350,00 €',
  'Verwendungszweck Auslagen September Gewerbepark Senne',
  'Ich bestätige, den oben genannten Betrag in bar erhalten zu haben.',
].join('\n');

/** Erkannter Text eines hochgeladenen Nachweises: Vorspann der Eingangsanalyse, PDF-Text doppelt. */
const NACHWEIS_PDF = [...TEXT.split('\n'), 'Beispielstadt, 08.10.2026', 'Unterschrift Empfänger/in'].join('\n');
const NACHWEIS_TEXT = [
  'Dokumentart: quittung',
  'Betrag: 350,00 €',
  'Lieferant: Beispielbetrieb GmbH',
  `_extractedText: ${NACHWEIS_PDF}`,
  `_vertragstext: ${NACHWEIS_PDF}`,
  'Betreff: Unterschriebene Auszahlungsquittung MZ-20261008-R8A1JP1G – Erika Beispiel',
  `_pageTexts: ${JSON.stringify([{ pageNumber: 1, text: NACHWEIS_PDF }])}`,
].join('\n');

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

async function render(entry: string, element: ReactNode): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[entry]}>
        <AuthProvider>
          <AppProvider initialSetup={setup}>
            <Routes>
              <Route path="/dokumente/:id" element={element} />
            </Routes>
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

function q(id: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${id}"]`);
}

/** „Muss ich etwas tun?" im Verständnisblock. */
function verstaendnisHandlung(): string {
  const zeilen = [
    ...document.body.querySelectorAll('[data-testid="document-understanding-card"] .document-understanding-meta__line'),
  ];
  return zeilen.find((zeile) => zeile.textContent?.includes('Muss ich etwas tun'))?.textContent ?? '';
}

/** Das Abzeichen im Seitenkopf (Lebenszyklus). */
function abzeichen(): string {
  return document.body.querySelector('.work-detail-head .badge')?.textContent ?? '';
}

async function zeigeMehr(): Promise<void> {
  const knopf = q('show-more-toggle') as HTMLButtonElement | null;
  if (knopf && knopf.getAttribute('aria-expanded') !== 'true') {
    await act(async () => {
      knopf.click();
    });
    await settle();
  }
}

async function abbauen(): Promise<void> {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
}

function dokument(id: string, title: string, overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  return {
    id,
    title,
    category: 'personal',
    issuer: 'Beispielbetrieb GmbH',
    recognizedText: TEXT,
    issueDate: '2026-10-08',
    validUntil: null,
    digitalFolder: { id: 'zn', name: 'Zahlungsnachweise 2026', path: '/Mitarbeiter/Zahlungsnachweise/2026/' },
    paperFolder: { folderId: 'paper-personal', register: 'Lohn', label: 'Personal' },
    tags: [],
    linkedCompany: '',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-10-08T09:00:00.000Z',
    imagePreview: '📄',
    linkedInvoiceId: null,
    linkedLetterId: null,
    linkedOfferId: null,
    ...overrides,
  } as CompanyDocument;
}

const mitarbeiter: Employee = {
  id: 'emp-1',
  name: 'Erika Beispiel',
  active: true,
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
} as Employee;

const zahlung: EmployeePayment = {
  id: 'pay-1',
  employeeId: 'emp-1',
  employeeName: 'Erika Beispiel',
  kind: 'reimbursement',
  amount: 350,
  paymentDate: '2026-10-08',
  paymentMethod: 'cash',
  receiptReference: 'MZ-20261008-R8A1JP1G',
  receiptDocumentId: 'emp-receipt-pay-1',
  proofDocumentId: 'doc-nachweis-1',
  createdAt: '2026-10-08T09:00:00.000Z',
} as EmployeePayment;

/** Eine stornierte Zahlung: Quittung und Nachweis bleiben Prüfspur. */
const stornierteZahlung: EmployeePayment = {
  id: 'pay-2',
  employeeId: 'emp-1',
  employeeName: 'Erika Beispiel',
  kind: 'advance',
  amount: 50,
  paymentDate: '2026-10-07',
  paymentMethod: 'cash',
  receiptReference: 'MZ-20261007-STORNO01',
  receiptDocumentId: 'emp-receipt-pay-2',
  proofDocumentId: 'doc-nachweis-2',
  createdAt: '2026-10-07T09:00:00.000Z',
  reversedAt: '2026-10-08T08:00:00.000Z',
  reversalReason: 'Doppelt erfasst',
} as EmployeePayment;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-08T10:00:00.000Z'));
  resetSyncClientForTests({
    deviceId: 'dev-a',
    workspaceId: 'local-ws-a',
    serverWorkspaceId: WORKSPACE_ID,
    createdAt: '2026-01-01T00:00:00.000Z',
    syncPolicy: 'cloud_ready',
  });
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
  await loginAsDefaultAdmin();
  hydrateWorkspaceStore({
    workspace: { id: WORKSPACE_ID, name: 'Beispielbetrieb', ownerUserId: 'usr-owner', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1 },
    workspaceMembers: [{ workspaceId: WORKSPACE_ID, userId: 'usr-admin', role: 'owner', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  });
  // Papierstand gehört zum einzelnen Fall: kein Abheften aus einem früheren Test.
  resetMemoryStore();
  resetVorgaenge();
  hydrateVorgangStore([
    {
      id: 'vg-1',
      title: 'Gewerbepark Senne',
      customer: 'Westfalen Projektbau GmbH',
      baustelle: 'Senne',
      status: 'in_arbeit',
      materialSource: 'standard',
      orderPositions: [],
      documents: [],
      tasks: [],
      photos: [],
      invoices: [],
    } as unknown as Vorgang,
  ]);
  hydrateDocumentStore([
    dokument('emp-receipt-pay-1', 'Auszahlungsquittung MZ-20261008-R8A1JP1G – Erika Beispiel'),
    dokument('doc-nachweis-1', 'Unterschriebene Auszahlungsquittung MZ-20261008-R8A1JP1G – Erika Beispiel', {
      classifiedKind: 'lohnunterlagen',
      recognizedText: NACHWEIS_TEXT,
    } as Partial<CompanyDocument>),
    dokument('emp-receipt-pay-2', 'Auszahlungsquittung MZ-20261007-STORNO01 – Erika Beispiel'),
    dokument('doc-nachweis-2', 'Unterschriebene Auszahlungsquittung MZ-20261007-STORNO01 – Erika Beispiel', {
      classifiedKind: 'lohnunterlagen',
      recognizedText: NACHWEIS_TEXT,
    } as Partial<CompanyDocument>),
    dokument('doc-normal-1', 'Schreiben mit demselben Text', {
      category: 'sonstiges',
      recognizedText: NACHWEIS_TEXT,
      digitalFolder: { id: 'eg', name: 'Eingang', path: '/Eingang/Sonstiges/2026/' },
    }),
  ]);
  hydrateEmployeeStore([mitarbeiter]);
  hydrateEmployeePaymentStore([zahlung, stornierteZahlung]);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('P1MA WEISS — Dokumentdetail einer Mitarbeiterquittung', () => {
  it('erzeugte Quittung: kein Auftrag, keine Unsicherheit, keine Deutungskarte — dafür die Zahlung', async () => {
    await render('/dokumente/emp-receipt-pay-1', <DokumentDetailPage />);
    const text = document.body.textContent ?? '';
    expect(q('document-employee-payment-receipt')).not.toBeNull();
    expect(q('document-meaning-panel')).not.toBeNull();
    expect(q('document-meaning-vorgang-candidates')).toBeNull();
    expect(q('document-meaning-customer-candidates')).toBeNull();
    expect(text).not.toContain('Wahrscheinlicher Auftrag');
    expect(text).not.toContain('Das konnte OfficeTakt nicht sicher erkennen');
    expect(q('document-understanding-card')).toBeNull();
    // Keine leere Karte „Nächste Schritte": kein Papierhinweis, kein offener Punkt.
    expect(q('document-detail-experience')).toBeNull();
    expect(q('document-archive-truth-facts')).toBeNull();
    expect(text).not.toContain('Vorgang zuordnen');
    expect(q('document-meaning-amounts')).toBeNull();
    expect(q('document-meaning-deadlines')).toBeNull();
    expect(q('document-meaning-accounting')?.textContent).toContain('Mitarbeiterzahlung – bereits erfasst');
    expect(text).toContain('Keine Handlung nötig – die Auszahlung ist unter Mitarbeiterzahlungen erfasst und belegt.');
  });

  it('unterschriebener Nachweis: kein Auftrag und keine Unsicherheit; die Deutungskarte (Original abheften) bleibt', async () => {
    await render('/dokumente/doc-nachweis-1', <DokumentDetailPage />);
    const text = document.body.textContent ?? '';
    expect(q('document-archive-truth-facts')).toBeNull();
    expect(text).not.toContain('Vorgang zuordnen');
    expect(text).not.toContain('Gutschrift zu Ihren Gunsten');
    expect(q('document-meaning-amounts')).toBeNull();
    expect(q('document-meaning-deadlines')).toBeNull();
    expect(q('document-employee-payment-proof')).not.toBeNull();
    expect(q('document-meaning-vorgang-candidates')).toBeNull();
    expect(text).not.toContain('Wahrscheinlicher Auftrag');
    expect(text).not.toContain('Das konnte OfficeTakt nicht sicher erkennen');
    expect(q('document-understanding-card')).not.toBeNull();
    // Der Nachweis ist ein Papieroriginal: die Karte mit dem Ablagehinweis bleibt.
    expect(q('document-detail-experience')).not.toBeNull();
    expect(q('document-meaning-accounting')?.textContent).toContain('Mitarbeiterzahlung – bereits erfasst');

    /* Bis das Original abgeheftet ist, bleibt genau das zu tun — kein „Keine Handlung nötig". */
    expect(q('document-meaning-action')?.textContent).toContain('Ja');
    expect(q('document-meaning-next-step')?.textContent).toContain('Unterschriebenes Original abheften');
    expect(text).not.toContain('Keine Handlung nötig');
    await act(async () => {
      (q('document-filing-mark-filed') as HTMLButtonElement).click();
    });
    await settle();
    expect(q('document-meaning-action')?.textContent).toContain('Nein');
    expect(q('document-meaning-next-step')?.textContent).toContain(
      'Keine Handlung nötig – dieser unterschriebene Nachweis belegt die Auszahlung.',
    );
  });

  it('Gegenprobe: ein gewöhnliches Dokument mit demselben Text behält die allgemeine Deutung', async () => {
    await render('/dokumente/doc-normal-1', <DokumentDetailPage />);
    expect(q('document-employee-payment-receipt')).toBeNull();
    expect(q('document-meaning-vorgang-candidates')?.textContent).toContain('Gewerbepark Senne');
    expect(q('document-understanding-card')).not.toBeNull();
    expect(q('document-detail-experience')).not.toBeNull();
    expect(q('document-archive-truth-facts')).not.toBeNull();
    expect(q('document-meaning-amounts')?.textContent).toContain('Gutschrift zu Ihren Gunsten');
  });
});

describe('P1MA WEISS-FINAL — eine Antwort, keine scheinbare Löschaktion', () => {
  it('Nachweis: oben, im Verständnisblock und im Abzeichen dieselbe Antwort — offen JA, nach dem Abheften NEIN', async () => {
    await render('/dokumente/doc-nachweis-1', <DokumentDetailPage />);
    expect(abzeichen()).toContain('Handlung nötig');
    expect(q('document-meaning-action')?.textContent).toContain('Ja – unterschriebenes Original abheften.');
    expect(verstaendnisHandlung()).toContain('Ja – unterschriebenes Original abheften.');
    expect(verstaendnisHandlung()).not.toContain('Nein');
    expect(q('document-detail-experience')?.textContent).toContain('Bitte Original abheften');
    // Keine leere Überschrift „Nächste Schritte" in der Karte.
    expect(q('document-detail-experience')?.textContent).not.toContain('Nächste Schritte');
    await zeigeMehr();
    expect(q('document-lifecycle-next-step')?.textContent).toBe(q('document-meaning-next-step')?.textContent);

    await act(async () => {
      (q('document-filing-mark-filed') as HTMLButtonElement).click();
    });
    await settle();
    expect(abzeichen()).not.toContain('Handlung nötig');
    expect(q('document-meaning-action')?.textContent).toContain('Nein – der unterschriebene Nachweis belegt die Auszahlung.');
    expect(verstaendnisHandlung()).toContain('Nein – der unterschriebene Nachweis belegt die Auszahlung.');
    expect(verstaendnisHandlung()).not.toContain('Ja');
    // Der Papierhinweis widerspräche jetzt dem „Nein" — die Karte entfällt.
    expect(q('document-detail-experience')).toBeNull();
    expect(document.body.textContent).not.toContain('Bitte Original abheften');
    expect(q('document-lifecycle-next-step')?.textContent).toBe(
      'Keine Handlung nötig – dieser unterschriebene Nachweis belegt die Auszahlung.',
    );
  });

  it('Nachweis einer stornierten Zahlung mit offenem Original: ebenfalls JA — das Original bleibt Prüfspur', async () => {
    await render('/dokumente/doc-nachweis-2', <DokumentDetailPage />);
    expect(abzeichen()).toContain('Handlung nötig');
    expect(q('document-meaning-action')?.textContent).toContain('Ja – unterschriebenes Original abheften.');
    expect(q('document-meaning-next-step')?.textContent).toContain('Die Zahlung ist storniert.');
    expect(verstaendnisHandlung()).toContain('Ja – unterschriebenes Original abheften.');
  });

  it('keine Löschaktion an Quittung und Nachweis — auch bei stornierter Zahlung; stattdessen der Grund', async () => {
    for (const id of ['doc-nachweis-1', 'emp-receipt-pay-1', 'emp-receipt-pay-2', 'doc-nachweis-2']) {
      await render(`/dokumente/${id}`, <DokumentDetailPage />);
      await zeigeMehr();
      expect(q('show-more-content'), id).not.toBeNull();
      expect(q('document-detail-delete-trigger'), id).toBeNull();
      expect(q('document-detail-delete-confirm'), id).toBeNull();
      expect(q('document-detail-delete-protected')?.textContent, id).toContain('Gehört zu einer Mitarbeiterzahlung');
      // „Stand dieses Dokuments" nennt denselben nächsten Schritt wie die Deutung.
      expect(q('document-lifecycle-next-step')?.textContent, id).toBe(q('document-meaning-next-step')?.textContent);
      await abbauen();
    }
  });

  it('Gegenprobe: ein gewöhnliches Dokument behält „Löschen" und die allgemeine Verständnisregel', async () => {
    await render('/dokumente/doc-normal-1', <DokumentDetailPage />);
    await zeigeMehr();
    expect(q('document-detail-delete-trigger')).not.toBeNull();
    expect(q('document-detail-delete-protected')).toBeNull();
    expect(verstaendnisHandlung()).toContain('Nein – vorerst ablegen und bei Bedarf nachlesen.');
    expect(q('document-meaning-action')?.textContent).not.toContain('unterschriebenes Original');
    expect(q('document-lifecycle-next-step')?.textContent).toBe('Original abheften und in OfficeTakt bestätigen.');
  });
});
