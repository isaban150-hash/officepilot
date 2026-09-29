/**
 * E-MAIL-HALBZEIT-FIX 07B–07D — gezielte Tests für die Befunde der
 * unabhängigen Browserabnahme: A1 (Angebotstitel), A2 (sichtbare Marke),
 * B1 (Anhang öffnen/herunterladen), B3 (Datumsformat), B4 (ein Sende-CTA),
 * B5 (gleichnamige Kunden). B2/B3-Panel und B6 stehen bei ihren Bausteinen
 * (documentDeliveryUi01b2v2, emailCommunication07c).
 *
 * Neutrale Beispieldaten; kein Netz, kein Provider.
 */
import fs from 'node:fs';
import path from 'node:path';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../context/AppContext';
import { AuthProvider } from '../../context/AuthContext';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { loginAsDefaultAdmin, resetAuthForTests } from '../../test/authFixtures';
import { resetTestStores } from '../../test/resetStores';
import * as supabaseLib from '../../lib/supabase';
import * as persistence from '../../services/persistenceService';
import { t } from '../../i18n';
import { hydrateCompanyProfileStore } from '../../services/companyProfileService';
import { hydrateWorkspaceStore } from '../../services/workspace/workspaceStore';
import { hydrateOffers } from '../../services/offer/offerService';
import { hydrateBusinessLetters } from '../../services/businessLetterService';
import { hydrateCustomerStore } from '../../services/customerStoreService';
import { setActiveStorageScope } from '../../services/storage/storageScopeService';
import { resolveDeliveryDocumentFacts } from '../../services/delivery/deliveryDocumentFacts';
import { composeDocumentDeliveryDraft, composeInvoiceDeliveryDraft } from '../../services/delivery/documentDeliveryDefaults';
import { downloadEmailAttachment, parseEmailMessageRow } from '../../services/email/emailMessageCloudService';
import { buildCustomerOptionLabels } from '../../services/customer/customerOptionLabels';
import { formatDisplayDateTime } from '../../utils/displayFormat';
import { KommunikationEmailDetailPage } from '../../pages/KommunikationEmailDetailPage';
import type { CompanySetup, Customer, VorgangInvoice } from '../../types/models';
import type { Offer } from '../../types/offer';
import type { BusinessLetter } from '../../types/businessLetter';

const WS = '00000000-0000-4000-8000-0000000007f1';
const setup: CompanySetup = { ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'standard_19' };
const PROFILE = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Beispiel Haustechnik',
  legalForm: 'GmbH',
  street: 'Bahnhofstraße 12',
  zip: '32105',
  city: 'Bad Salzuflen',
  phone: '05222 000000',
  email: 'info@beispiel.invalid',
  iban: 'DE89370400440532013000',
  taxNumber: '1',
};
const SRC = path.resolve(__dirname, '..', '..');

beforeEach(() => {
  resetTestStores();
  localStorage.clear();
  hydrateCompanyProfileStore({ ...PROFILE });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------------ */
/* A1 — Angebotstitel                                                        */
/* ------------------------------------------------------------------------ */

describe('HALBZEIT-FIX A1 — Angebots-Mail: fachlicher Titel, Nummer nicht doppelt', () => {
  const ARCHIVE_TITLE = 'AN-2026-0001 – Angebot';
  const OFFER_TITLE = 'Badsanierung Musterstraße 5';

  function offerDocument() {
    hydrateOffers([{ id: 'offer-1', offerNumber: 'AN-2026-0001', title: OFFER_TITLE, customerId: 'c-1', status: 'angenommen' } as unknown as Offer]);
    return { linkedOfferId: 'offer-1', linkedLetterId: null, linkedVorgang: null, title: ARCHIVE_TITLE };
  }

  it('1: documentTitle = fachlicher Angebotstitel (nicht Archivtitel)', () => {
    const facts = resolveDeliveryDocumentFacts(offerDocument());
    expect(facts).toMatchObject({ documentNumber: 'AN-2026-0001', documentTitle: OFFER_TITLE });
  });

  it('2: Nummer steht im Text genau einmal, der Titel ebenfalls', () => {
    const document = offerDocument();
    const facts = resolveDeliveryDocumentFacts(document);
    const draft = composeDocumentDeliveryDraft(
      { kind: 'offer', title: facts.documentTitle ?? document.title, documentNumber: facts.documentNumber, customerName: facts.customerName, profile: PROFILE },
      'de',
    );
    expect(draft.bodyText.split('AN-2026-0001')).toHaveLength(2);
    expect(draft.bodyText).toContain(`„${OFFER_TITLE}“`);
    expect(draft.bodyText).not.toContain(ARCHIVE_TITLE);
    expect(draft.subject).toBe('Angebot AN-2026-0001 - Beispiel Haustechnik GmbH');
  });

  it('3: Rechnungsvorlage unverändert', () => {
    const invoice = { id: 'inv-1', number: 'RE-2026-0013', customerSnapshot: { name: 'Kunde' }, companySnapshot: { companyName: 'Beispiel Haustechnik', legalForm: 'GmbH' } } as unknown as VorgangInvoice;
    const draft = composeInvoiceDeliveryDraft(invoice, 'de', { profile: PROFILE });
    expect(draft.subject).toBe('Rechnung RE-2026-0013 - Beispiel Haustechnik GmbH');
    expect(draft.bodyText.startsWith('Guten Tag,\n\nanbei erhalten Sie unsere Rechnung RE-2026-0013.')).toBe(true);
  });

  it('4: Geschäftsbrief unverändert — Titel bleibt der Dokumenttitel', () => {
    hydrateBusinessLetters([{ id: 'letter-1', workspaceId: WS, subject: 'Terminbestätigung', body: 'Text', customerId: 'c-1', status: 'finalized', recipient: {} } as unknown as BusinessLetter]);
    const facts = resolveDeliveryDocumentFacts({ linkedLetterId: 'letter-1', linkedOfferId: null, linkedVorgang: null });
    expect(facts.documentTitle).toBeUndefined();
    const draft = composeDocumentDeliveryDraft({ kind: 'letter', title: 'Terminbestätigung', profile: PROFILE }, 'de');
    expect(draft.subject).toBe('Terminbestätigung - Beispiel Haustechnik GmbH');
    expect(draft.bodyText).toContain('anbei erhalten Sie unser Schreiben „Terminbestätigung“.');
  });
});

/* ------------------------------------------------------------------------ */
/* A2 — sichtbare Marke                                                      */
/* ------------------------------------------------------------------------ */

describe('HALBZEIT-FIX A2 — sichtbare Marke OfficeTakt', () => {
  it('5a: die gefundenen Stellen zeigen OfficeTakt (de/tr/bg)', () => {
    expect(t('settings.communication.identity.fromValue', 'de')).toBe('Versanddienst von OfficeTakt (nicht änderbar)');
    expect(t('settings.communication.sender.hint', 'de')).toContain('Versanddienst von OfficeTakt');
    expect(t('detail.officePilotDid', 'de')).toBe('Was OfficeTakt erledigt hat');
    expect(t('auth.login.subtitle', 'de')).toContain('OfficeTakt');
    expect(t('settings.communication.identity.fromValue', 'tr')).toContain('OfficeTakt');
    expect(t('settings.communication.identity.fromValue', 'bg')).toContain('OfficeTakt');
  });

  it('5b: kein sichtbarer OfficePilot-Text mehr in Übersetzungen und Oberflächen-Code', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (['testWorld', 'test'].includes(entry.name)) continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\./.test(entry.name)) continue;
        // Bewusste Ausnahme: Wiedererkennungsschlüssel für gespeicherte Alttexte.
        if (entry.name === 'resolveStoredText.ts') continue;
        let inBlock = false;
        fs.readFileSync(full, 'utf8').split(/\r?\n/).forEach((line, index) => {
          const trimmed = line.trim();
          const isComment = inBlock || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || /^\{\/\*.*\*\/\}$/.test(trimmed);
          if (trimmed.startsWith('/*') && !trimmed.includes('*/')) inBlock = true;
          else if (inBlock && trimmed.includes('*/')) inBlock = false;
          if (isComment || /console\.|LOG_PREFIX|\[OfficePilot[\]:]/.test(line)) return;
          if (/\bOfficePilot\b/.test(line)) offenders.push(`${path.relative(SRC, full)}:${index + 1}`);
        });
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
    expect(fs.readFileSync(path.resolve(SRC, '..', 'index.html'), 'utf8')).toContain('<title>OfficeTakt</title>');
  }, 120_000);
});

/* ------------------------------------------------------------------------ */
/* B1 — Anhang öffnen/herunterladen                                          */
/* ------------------------------------------------------------------------ */

describe('HALBZEIT-FIX B1 — Anhang der freien E-Mail', () => {
  const PATH = `${WS}/${'a'.repeat(64)}.pdf`;

  it('9/10: nur über den angemeldeten Storage-Zugriff des privaten Buckets; MIME bleibt', async () => {
    const download = vi.fn(async () => ({ data: new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]), error: null }));
    const from = vi.fn(() => ({ download }));
    const result = await downloadEmailAttachment({ storagePath: PATH, mimeType: 'application/pdf' }, { storage: { from } } as never);
    expect(from).toHaveBeenCalledWith('email-attachments');
    expect(download).toHaveBeenCalledWith(PATH);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blob.type).toBe('application/pdf');
      expect(result.blob.size).toBe(4);
    }
  });

  it('11: fehlende Datei / fremder Pfad / kein Zugriff → klare Fehlerart, kein Rohtext', async () => {
    const missing = { storage: { from: () => ({ download: async () => ({ data: null, error: { statusCode: '404', message: 'Object not found' } }) }) } } as never;
    expect(await downloadEmailAttachment({ storagePath: PATH, mimeType: 'application/pdf' }, missing)).toEqual({ ok: false, error: 'missing' });
    const forbidden = { storage: { from: () => ({ download: async () => ({ data: null, error: { statusCode: '403', message: 'new row violates row-level security' } }) }) } } as never;
    expect(await downloadEmailAttachment({ storagePath: PATH, mimeType: 'application/pdf' }, forbidden)).toEqual({ ok: false, error: 'forbidden' });
    const from = vi.fn();
    expect(await downloadEmailAttachment({ storagePath: '../fremd/datei.pdf', mimeType: 'application/pdf' }, { storage: { from } } as never)).toEqual({ ok: false, error: 'missing' });
    expect(from).not.toHaveBeenCalled();
  });

  describe('Detailseite', () => {
    let root: Root;
    let host: HTMLDivElement;
    const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
    async function settle() { for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
    async function mount(node: ReactNode) {
      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => {
        root.render(<MemoryRouter initialEntries={['/kommunikation/email/m-1']}><AuthProvider><AppProvider initialSetup={setup}><Routes><Route path="/kommunikation/email/:id" element={node} /></Routes></AppProvider></AuthProvider></MemoryRouter>);
      });
      await settle();
    }
    const message = parseEmailMessageRow({
      id: 'm-1', workspace_id: WS, client_message_id: 'em-1', to_recipients: ['kunde@example.invalid'], cc_recipients: [], bcc_recipients: [],
      subject: 'Testmail', body_text: 'Text', sender_name: 'Beispiel', reply_to_email: 'info@beispiel.invalid', provider: 'brevo',
      provider_message_id: 'p', status: 'provider_accepted', created_at: '2026-09-27T00:16:00.000Z', provider_accepted_at: '2026-09-27T00:16:02.000Z',
      attempt_number: 1, row_version: 3,
      attachments: [
        { position: 1, filename: 'OfficeTakt-07D-Test.pdf', mime_type: 'application/pdf', size_bytes: 679, sha256: 'a'.repeat(64), storage_path: PATH },
        { position: 2, filename: 'Tabelle.xlsx', mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size_bytes: 100, sha256: 'b'.repeat(64), storage_path: `${WS}/${'b'.repeat(64)}.xlsx` },
      ],
    })!;

    beforeEach(async () => {
      resetAuthForTests();
      setActiveStorageScope({ type: 'workspace', workspaceId: WS });
      vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
      vi.spyOn(persistence, 'buildPersistedStateSnapshot').mockReturnValue({ syncClient: { serverWorkspaceId: WS } } as never);
      hydrateWorkspaceStore({
        workspace: { id: WS, name: 'Betrieb', ownerUserId: 'usr-admin', createdAt: 'x', updatedAt: 'x', version: 1 },
        workspaceMembers: [{ workspaceId: WS, userId: 'usr-admin', role: 'owner', status: 'active', createdAt: 'x', updatedAt: 'x' }],
      });
      await loginAsDefaultAdmin();
    });
    afterEach(async () => {
      await act(async () => root?.unmount());
      document.body.innerHTML = '';
    });

    it('9/10: Herunterladen lädt authentifiziert und speichert unter dem gespeicherten Namen; Öffnen nur für anzeigbare Typen', async () => {
      const blobUrl = 'blob:http://localhost/abc';
      const createObjectURL = vi.fn(() => blobUrl);
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
      const clicked: Array<{ href: string; download: string }> = [];
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push({ href: this.href, download: this.download });
      });
      const downloadAttachment = vi.fn(async (input: { storagePath: string; mimeType: string }) => ({ ok: true as const, blob: new Blob(['x'], { type: input.mimeType }) }));
      await mount(<KommunikationEmailDetailPage loadChain={async () => ({ ok: true, messages: [message] })} downloadAttachment={downloadAttachment} />);
      const rows = Array.from(host.querySelectorAll('[data-testid="kommunikation-email-detail-attachment-row"]'));
      expect(rows).toHaveLength(2);
      // PDF: Öffnen + Herunterladen; XLSX: nur Herunterladen.
      expect(rows[0].querySelector('[data-testid="kommunikation-email-detail-attachment-open"]')).not.toBeNull();
      expect(rows[1].querySelector('[data-testid="kommunikation-email-detail-attachment-open"]')).toBeNull();
      await act(async () => { (rows[0].querySelector('[data-testid="kommunikation-email-detail-attachment-download"]') as HTMLElement).click(); });
      await settle();
      expect(downloadAttachment).toHaveBeenCalledWith({ storagePath: PATH, mimeType: 'application/pdf' });
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect((createObjectURL.mock.calls[0] as unknown as [Blob])[0].type).toBe('application/pdf');
      expect(clicked).toEqual([{ href: blobUrl, download: 'OfficeTakt-07D-Test.pdf' }]);
      expect(q('kommunikation-email-detail-attachment-error')).toBeNull();
    });

    it('11: Datei nicht mehr vorhanden → verständliche Meldung am Anhang', async () => {
      const downloadAttachment = vi.fn(async () => ({ ok: false as const, error: 'missing' as const }));
      await mount(<KommunikationEmailDetailPage loadChain={async () => ({ ok: true, messages: [message] })} downloadAttachment={downloadAttachment} />);
      await act(async () => { (host.querySelector('[data-testid="kommunikation-email-detail-attachment-download"]') as HTMLElement).click(); });
      await settle();
      expect(q('kommunikation-email-detail-attachment-error')?.textContent).toBe('Der Anhang „OfficeTakt-07D-Test.pdf" ist nicht mehr verfügbar.');
    });
  });
});

/* ------------------------------------------------------------------------ */
/* B3 / B4 / B5                                                              */
/* ------------------------------------------------------------------------ */

describe('HALBZEIT-FIX B3 — Datumsformat im E-Mail-Bereich', () => {
  it('13: zweistellig, Minutengenauigkeit, ohne Sekunden', () => {
    const value = formatDisplayDateTime(new Date(2026, 8, 26, 20, 13, 49));
    expect(value).toBe('26.09.2026, 20:13');
    expect(formatDisplayDateTime(undefined)).toBe('—');
  });
});

describe('HALBZEIT-FIX B4 — Angebot: nur ein Sende-CTA', () => {
  it('14: die Abschnittsüberschrift ist keine zweite „Per E-Mail senden“-Aktion', () => {
    for (const lang of ['de', 'tr', 'bg'] as const) {
      expect(t('offer.detail.send', lang)).not.toBe(t('delivery.document.action.send', lang));
    }
    expect(t('offer.detail.send', 'de')).toBe('E-Mail-Versand');
  });
});

describe('HALBZEIT-FIX B5 — gleichnamige Kunden unterscheidbar', () => {
  const base = { street: '', zip: '', city: '', email: '', createdAt: '2026-09-01T10:00:00.000Z' };
  const customer = (id: string, name: string, extra: Partial<Customer> = {}) => ({ ...base, id, name, ...extra }) as Customer;

  it('15: eindeutige Namen unverändert; gleiche Namen mit erster fachlicher Unterscheidung; UUID nur als letzter Rückfall', () => {
    const labels = buildCustomerOptionLabels([
      customer('c-1', 'Einzel GmbH'),
      customer('c-2', 'RheinWest Industriebau GmbH', { city: 'Delbrück' }),
      customer('c-3', 'RheinWest Industriebau GmbH', { city: 'Delbrueck' }),
      customer('c-4', 'Westfalen Projektbau GmbH', { city: 'Bielefeld', street: 'Industriestraße 27', email: 'a@example.invalid' }),
      customer('c-5', 'Westfalen Projektbau GmbH', { city: 'Bielefeld', street: 'Industriestraße 27', email: 'b@example.invalid' }),
      customer('c-6', 'M5 Testbau GmbH', { city: 'Bielefeld', createdAt: '2026-09-12T10:00:00.000Z' }),
      customer('c-7', 'M5 Testbau GmbH', { city: 'Bielefeld', createdAt: '2026-09-13T10:00:00.000Z' }),
      customer('cust-uuid-111-aaaaaa', 'Zwilling GmbH', { city: 'Lemgo' }),
      customer('cust-uuid-222-bbbbbb', 'Zwilling GmbH', { city: 'Lemgo' }),
    ]);
    expect(labels.get('c-1')).toBe('Einzel GmbH');
    expect(labels.get('c-2')).toBe('RheinWest Industriebau GmbH · Delbrück');
    expect(labels.get('c-3')).toBe('RheinWest Industriebau GmbH · Delbrueck');
    expect(labels.get('c-4')).toBe('Westfalen Projektbau GmbH · a@example.invalid');
    expect(labels.get('c-6')).toBe('M5 Testbau GmbH · angelegt 12.09.2026');
    expect(labels.get('c-7')).toBe('M5 Testbau GmbH · angelegt 13.09.2026');
    expect(labels.get('cust-uuid-111-aaaaaa')).toBe('Zwilling GmbH · Kennung …aaaaaa');
    expect(new Set(labels.values()).size).toBe(labels.size);
  });

  it('15b: die Auswahl verändert keine Kundendaten', () => {
    const list = [customer('c-a', 'Gleich GmbH', { city: 'A' }), customer('c-b', 'Gleich GmbH', { city: 'B' })];
    hydrateCustomerStore(list);
    const snapshot = JSON.stringify(list);
    buildCustomerOptionLabels(list);
    expect(JSON.stringify(list)).toBe(snapshot);
  });
});
