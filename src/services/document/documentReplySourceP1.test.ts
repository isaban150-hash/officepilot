/**
 * P1 EINGANGSSCHREIBEN Phase 1 — Kunde/Vorgang und die Vorbelegung der Antwortwege.
 *
 *  E  Vorgangsstatus linked → Kunde (Anschrift, E-Mail, Kennung), wenn das Schreiben vom Kunden kommt;
 *     schreibt ein Dritter (Bauamt) zum Vorgang, geht die Antwort an diesen Absender
 *  F  Vorgangsstatus created → derselbe Kunde (vorher fiel die Brücke hier auf den Absender zurück)
 *  H  Lösen und neu zuordnen über den Produktweg: die Brücke folgt; das archivierte
 *     Schreiben respektiert den S4-Unlink (gelöster Bezug kommt nicht zurück)
 *  I  Briefvorbelegung: Quelle, Vorgang, Kunde, Empfänger, Betreff „Ihr Schreiben vom …"
 *  P  ohne belastbare Adresse kein E-Mail-Weg, kein erfundener Empfänger;
 *     Mail-Anhang → Antwort auf die ursprüngliche Mail
 *  —  Fragefeld: der Entwurf trägt die Quelle (replyTo) und den bestätigten Vorgang
 *  —  Befund der App-Abnahme: die Erkennung hielt den gekürzten eigenen Namen
 *     („Haustechnik GmbH") für den Absender; die eigene Firma wird nie Empfänger
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { BusinessInterpretationResult } from '../../types/businessInterpretation';
import type { CompanyDocument, Customer, InboxItem, Vorgang } from '../../types/models';
import { createAuftragInboxItem } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import { hydrateInboxStore, getInboxItemById } from '../inboxService';
import { hydrateDocumentStore } from '../documentService';
import { hydrateDocumentWorkResultStore } from '../documentWorkResultStoreService';
import { hydrateCustomerStore } from '../customerStoreService';
import { getCompanyProfile, hydrateCompanyProfileStore } from '../companyProfileService';
import { emptyDocumentSemanticCore, type DocumentSemanticCore } from '../../types/documentSemanticCore';
import {
  hydrateVorgangStore,
  linkInboxToExistingVorgang,
  unlinkInboxItemFromVorgang,
} from '../vorgangService';
import {
  buildLetterPrefill,
  buildReplyDraft,
  resolveReplyRecipient,
  resolveReplyRecipientForDocument,
} from './documentReplyBridgeService';
import {
  buildReplyEmailHref,
  buildReplyEmailPrefill,
  buildReplyLetterPrefill,
  buildReplySubject,
  resolveDocumentReplySource,
} from './documentReplySourceService';

const KUNDE: Customer = {
  id: 'c-p1',
  name: 'Bauherr Muster GmbH',
  contactPerson: 'Frau Muster',
  street: 'Musterweg 1',
  zip: '33602',
  city: 'Bielefeld',
  email: 'post@bauherr-muster.invalid',
  createdAt: '2026-09-01T00:00:00.000Z',
} as Customer;

function vorgang(id: string, customerId?: string): Vorgang {
  return {
    id,
    title: `Vorgang ${id}`,
    customer: 'Bauherr Muster GmbH',
    ...(customerId ? { customerId } : {}),
    baustelle: '',
    status: 'aktiv',
    documents: [],
    tasks: [],
    photos: [],
    createdAt: '2026-09-01',
    updatedAt: '2026-09-01',
  } as unknown as Vorgang;
}

function schreiben(id: string, overrides: Partial<InboxItem> = {}): InboxItem {
  return createAuftragInboxItem({
    id,
    title: 'Stellungnahme Bauvorhaben',
    documentType: 'brief',
    classifiedKind: 'brief',
    sender: 'Bauamt Musterstadt',
    recognizedData: { Datum: '05.10.2026' },
    deadline: null,
    ...overrides,
  });
}

function mitBetreff(inboxItemId: string, betreff = 'Ihr Bauantrag Nr. 4711') {
  return {
    schemaVersion: 1 as const,
    inboxItemId,
    analyzedAt: '2026-10-07T09:00:00.000Z',
    analysisVersion: 'p1-test',
    sourceFingerprint: `fp-${inboxItemId}`,
    businessInterpretation: {
      operational: { primaryCase: 'communication_information', meanings: [], nextStep: '', confirmRequirement: '', certainty: 'detected' },
      semantic: { deadlines: [], subject: { value: betreff } },
    } as unknown as BusinessInterpretationResult,
    specialistRefs: {
      hasContractIntelligence: false,
      hasContractOrderProposal: false,
      hasClassification: true,
      hasDocumentUnderstanding: true,
      companyRelevant: true,
    },
    overlay: [],
  };
}

beforeEach(() => {
  resetTestStores();
  hydrateCustomerStore([KUNDE]);
  hydrateVorgangStore([vorgang('v-p1', 'c-p1'), vorgang('v-ohne')]);
});

describe('P1 — Kunde aus dem Vorgang', () => {
  it('E — linked: Kunde mit Anschrift, E-Mail und Kennung', () => {
    const item = schreiben('in-e', { sender: KUNDE.name, vorgangId: 'v-p1', vorgangLinkStatus: 'linked' });
    hydrateInboxStore([item]);
    const empfaenger = resolveReplyRecipient(item, undefined);
    expect(empfaenger.source).toBe('confirmed_customer');
    expect(empfaenger.customerId).toBe('c-p1');
    expect(empfaenger.street).toBe('Musterweg 1');
    expect(empfaenger.email).toBe('post@bauherr-muster.invalid');
  });

  it('F — created: derselbe bestätigte Kunde', () => {
    const item = schreiben('in-f', { sender: KUNDE.name, vorgangId: 'v-p1', vorgangLinkStatus: 'created' });
    hydrateInboxStore([item]);
    const empfaenger = resolveReplyRecipient(item, undefined);
    expect(empfaenger.source).toBe('confirmed_customer');
    expect(empfaenger.customerId).toBe('c-p1');
    expect(resolveDocumentReplySource({ type: 'inbox', id: 'in-f' })?.vorgangId).toBe('v-p1');
  });

  it('ohne bestätigten Bezug: nur der belegte Absender, keine erfundene Anschrift', () => {
    const item = schreiben('in-none', { vorgangId: 'v-p1', vorgangLinkStatus: 'none' });
    hydrateInboxStore([item]);
    const empfaenger = resolveReplyRecipient(item, undefined);
    expect(empfaenger).toEqual({ name: 'Bauamt Musterstadt', organization: 'Bauamt Musterstadt', source: 'document' });
  });

  it('H — Zuordnen, Lösen und neu Zuordnen über den Produktweg: die Brücke folgt jedem Schritt', () => {
    hydrateInboxStore([schreiben('in-h', { sender: KUNDE.name })]);

    const verknuepft = linkInboxToExistingVorgang(getInboxItemById('in-h')!, 'v-p1', {
      reason: 'user_confirmed',
      confirmedAt: '2026-10-07T10:00:00.000Z',
    } as never);
    expect(verknuepft).not.toBeNull();
    expect(resolveReplyRecipient(getInboxItemById('in-h')!, undefined).customerId).toBe('c-p1');

    expect(unlinkInboxItemFromVorgang('in-h').success).toBe(true);
    expect(resolveReplyRecipient(getInboxItemById('in-h')!, undefined).source).toBe('document');
    expect(resolveDocumentReplySource({ type: 'inbox', id: 'in-h' })?.vorgangId).toBeUndefined();

    expect(linkInboxToExistingVorgang(getInboxItemById('in-h')!, 'v-p1', { reason: 'user_confirmed', confirmedAt: '2026-10-07T11:00:00.000Z' } as never)).not.toBeNull();
    expect(resolveReplyRecipient(getInboxItemById('in-h')!, undefined).customerId).toBe('c-p1');
  });

  it('H — archiviertes Schreiben: nach dem Lösen (S4-Marker) kein Kunde mehr aus dem alten Vorgang', () => {
    const vorlage = createAuftragInboxItem();
    const dokument = {
      id: 'doc-h',
      title: 'Schreiben archiviert',
      category: 'sonstiges',
      issuer: 'Bauherr Muster GmbH',
      recognizedText: '',
      issueDate: '2026-10-05',
      validUntil: null,
      digitalFolder: vorlage.digitalFolder,
      paperFolder: vorlage.paperFiling,
      tags: [],
      linkedCompany: 'Eigene Firma',
      linkedVorgang: null,
      vorgangLinkReleasedAt: '2026-10-07T10:00:00.000Z',
      archived: true,
      createdAt: '2026-10-06T10:00:00.000Z',
    } as unknown as CompanyDocument;
    hydrateDocumentStore([dokument]);
    expect(resolveReplyRecipientForDocument(dokument)).toEqual({
      name: 'Bauherr Muster GmbH',
      organization: 'Bauherr Muster GmbH',
      source: 'document',
    });

    const verknuepft = { ...dokument, linkedVorgang: { vorgangId: 'v-p1', vorgangTitle: 'Vorgang v-p1' }, vorgangLinkReleasedAt: null } as unknown as CompanyDocument;
    expect(resolveReplyRecipientForDocument(verknuepft).customerId).toBe('c-p1');
  });
});

describe('P1 — Vorbelegung der vorhandenen Schreibwege', () => {
  it('I — Brief: Quelle, Vorgang, Kunde, Empfänger und Betreff „Ihr Schreiben vom …"', () => {
    hydrateInboxStore([schreiben('in-i', { sender: KUNDE.name, vorgangId: 'v-p1', vorgangLinkStatus: 'linked' })]);
    hydrateDocumentWorkResultStore([mitBetreff('in-i')]);
    const quelle = resolveDocumentReplySource({ type: 'inbox', id: 'in-i' })!;
    const vorbelegung = buildReplyLetterPrefill(quelle);
    expect(vorbelegung.replyTo).toEqual({ type: 'inbox', id: 'in-i' });
    expect(vorbelegung.vorgangId).toBe('v-p1');
    expect(vorbelegung.customerId).toBe('c-p1');
    expect(vorbelegung.recipient).toMatchObject({ name: 'Frau Muster', company: 'Bauherr Muster GmbH', street: 'Musterweg 1', zip: '33602', city: 'Bielefeld' });
    expect(vorbelegung.subject).toBe('Ihr Schreiben vom 05.10.2026 – Ihr Bauantrag Nr. 4711');
    expect(vorbelegung.body).toBe('');
  });

  it('Betreff ohne belegtes Datum und mit sehr langem Bezug bleibt kurz und ehrlich', () => {
    expect(buildReplySubject({ title: 'Anhörung' })).toBe('Ihr Schreiben – Anhörung');
    const lang = buildReplySubject({ title: 'x'.repeat(300), letterDate: '2026-10-05' });
    expect(lang.startsWith('Ihr Schreiben vom 05.10.2026 – ')).toBe(true);
    expect(lang.length).toBeLessThan(140);
  });

  it('P — ohne bestätigte Adresse: kein E-Mail-Weg und kein erfundener Empfänger', () => {
    hydrateInboxStore([schreiben('in-p')]);
    const quelle = resolveDocumentReplySource({ type: 'inbox', id: 'in-p' })!;
    expect(quelle.email).toBeNull();
    expect(buildReplyEmailHref(quelle)).toBeNull();
    expect(buildReplyEmailPrefill(quelle).to).toBe('');
    expect(buildReplyLetterPrefill(quelle).customerId).toBeUndefined();
    expect(buildReplyLetterPrefill(quelle).recipient).toEqual({ name: 'Bauamt Musterstadt', company: 'Bauamt Musterstadt', street: undefined, zip: undefined, city: undefined });
  });

  it('M/P — bestätigter Kunde mit Adresse: E-Mail-Weg mit Quelle; Mail-Anhang: Antwort auf die ursprüngliche Mail', () => {
    hydrateInboxStore([
      schreiben('in-mail-kunde', { sender: KUNDE.name, vorgangId: 'v-p1', vorgangLinkStatus: 'linked' }),
      schreiben('in-mail-anhang', {
        emailOrigin: { messageId: 'msg-123', attachmentId: 'att-1', position: 0, sha256: 'x', importedAt: '2026-10-07T08:00:00.000Z' },
      }),
    ]);
    const kunde = resolveDocumentReplySource({ type: 'inbox', id: 'in-mail-kunde' })!;
    expect(kunde.email).toEqual({ kind: 'customer', address: 'post@bauherr-muster.invalid' });
    expect(buildReplyEmailHref(kunde)).toBe('/kommunikation/email/neu?quelle=inbox%3Ain-mail-kunde');
    expect(buildReplyEmailPrefill(kunde)).toMatchObject({ to: 'post@bauherr-muster.invalid', customerId: 'c-p1', vorgangId: 'v-p1' });

    const anhang = resolveDocumentReplySource({ type: 'inbox', id: 'in-mail-anhang' })!;
    expect(anhang.email).toEqual({ kind: 'inbound_reply', messageId: 'msg-123' });
    expect(buildReplyEmailHref(anhang)).toBe('/kommunikation/email/neu?antwortAuf=msg-123&quelle=inbox%3Ain-mail-anhang');
  });

  it('Fragefeld: der Entwurf trägt die Quelle und den bestätigten Vorgang (auch bei created)', () => {
    const item = schreiben('in-frage', { sender: KUNDE.name, vorgangId: 'v-p1', vorgangLinkStatus: 'created' });
    hydrateInboxStore([item]);
    const ergebnis = buildReplyDraft({ text: 'Schreib denen, dass wir am 25.10. kommen', item, companyProfile: null });
    expect(ergebnis).not.toBeNull();
    expect(ergebnis!.sourceRef).toEqual({ type: 'inbox', id: 'in-frage' });
    expect(ergebnis!.confirmedVorgangId).toBe('v-p1');
    const vorbelegung = buildLetterPrefill(ergebnis!);
    expect(vorbelegung.replyTo).toEqual({ type: 'inbox', id: 'in-frage' });
    expect(vorbelegung.customerId).toBe('c-p1');
  });
});

describe('P1 — der Kunde des Vorgangs nur, wenn das Schreiben von ihm kommt (Befund der App-Abnahme)', () => {
  it('ein Dritter schreibt zum Vorgang des Kunden: Antwort an den Absender, Vorgang bleibt Bezug, kein Kunde, kein E-Mail-Weg', () => {
    hydrateInboxStore([schreiben('in-dritt', { vorgangId: 'v-p1', vorgangLinkStatus: 'linked' })]);
    const quelle = resolveDocumentReplySource({ type: 'inbox', id: 'in-dritt' })!;
    expect(quelle.recipient).toEqual({ name: 'Bauamt Musterstadt', organization: 'Bauamt Musterstadt', source: 'document' });
    expect(quelle.vorgangId).toBe('v-p1');
    expect(quelle.email).toBeNull();
    const vorbelegung = buildReplyLetterPrefill(quelle);
    expect(vorbelegung.vorgangId).toBe('v-p1');
    expect(vorbelegung.customerId).toBeUndefined();
    expect(vorbelegung.recipient?.company).toBe('Bauamt Musterstadt');
  });

  it('der Ansprechpartner des Kunden schreibt: Antwort an den Kunden', () => {
    const item = schreiben('in-ap', { sender: 'Frau Muster', vorgangId: 'v-p1', vorgangLinkStatus: 'linked' });
    expect(resolveReplyRecipient(item, undefined).customerId).toBe('c-p1');
  });

  it('kein Absender belegt: Antwort an den Kunden des bestätigten Vorgangs', () => {
    const item = schreiben('in-leer', { sender: '', vorgangId: 'v-p1', vorgangLinkStatus: 'linked' });
    expect(resolveReplyRecipient(item, undefined).source).toBe('confirmed_customer');
  });

  it('ein Behördenschreiben kommt nie vom Kunden — auch ohne belegten Absender', () => {
    const item = schreiben('in-amt', { classifiedKind: 'bauamt', sender: '', vorgangId: 'v-p1', vorgangLinkStatus: 'linked' });
    expect(resolveReplyRecipient(item, undefined)).toEqual({ name: '', source: 'unknown' });
  });

  it('archiviertes Schreiben eines Dritten mit Vorgang: Antwort an den Aussteller', () => {
    const dokument = { id: 'doc-dritt', issuer: 'Bauamt Musterstadt', linkedVorgang: { vorgangId: 'v-p1', vorgangTitle: 'Vorgang v-p1' } } as unknown as CompanyDocument;
    expect(resolveReplyRecipientForDocument(dokument)).toEqual({ name: 'Bauamt Musterstadt', organization: 'Bauamt Musterstadt', source: 'document' });
  });
});

describe('P1 — die eigene Firma ist nie Antwortempfänger (Befund der App-Abnahme)', () => {
  beforeEach(() => {
    hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: 'Çırmak Haustechnik GmbH' });
  });

  it('gekürzter eigener Name als erkannter Absender: Empfänger offen, kein Brief an sich selbst', () => {
    const item = schreiben('in-eigen', { sender: 'Haustechnik GmbH' });
    hydrateInboxStore([item]);
    expect(resolveReplyRecipient(item, undefined)).toEqual({ name: '', source: 'unknown' });
    const quelle = resolveDocumentReplySource({ type: 'inbox', id: 'in-eigen' })!;
    expect(quelle.email).toBeNull();
    expect(buildReplyLetterPrefill(quelle).recipient).toEqual({ name: '', company: undefined, street: undefined, zip: undefined, city: undefined });
  });

  it('eigener Name in anderer Schreibweise oder Rechtsform: ebenfalls offen', () => {
    for (const sender of ['Cirmak Haustechnik GmbH', 'ÇIRMAK HAUSTECHNIK', 'Çırmak Haustechnik GmbH & Co. KG']) {
      expect(resolveReplyRecipient(schreiben('in-x', { sender }), undefined).source).toBe('unknown');
    }
  });

  it('ein fremder Betrieb mit ähnlichem Namen bleibt Absender', () => {
    expect(resolveReplyRecipient(schreiben('in-fremd', { sender: 'Haustechnik Müller GmbH' }), undefined)).toEqual({
      name: 'Haustechnik Müller GmbH',
      organization: 'Haustechnik Müller GmbH',
      source: 'document',
    });
  });

  it('woran die eigene Firma erkannt wurde (Empfängerprüfung), wird nie Empfänger', () => {
    const kern = {
      ...emptyDocumentSemanticCore(),
      recipientCheck: { addressedToOwnCompany: 'yes', matchedOn: ['Çırmak Haustechnik GmbH', 'Industriestraße 5'], certainty: 'confirmed_by_existing_state' },
    } as DocumentSemanticCore;
    expect(resolveReplyRecipient(schreiben('in-ohne', { sender: '' }), kern)).toEqual({ name: '', source: 'unknown' });
  });

  it('archiviertes Schreiben mit der eigenen Firma als Aussteller: Empfänger offen', () => {
    const dokument = { id: 'doc-eigen', issuer: 'Haustechnik GmbH', linkedVorgang: null } as unknown as CompanyDocument;
    expect(resolveReplyRecipientForDocument(dokument)).toEqual({ name: '', source: 'unknown' });
  });

  it('Fragefeld: die eigene Firma reist weder als Empfänger noch als „Absender" in den Entwurf', () => {
    const item = schreiben('in-frage-eigen', { sender: 'Haustechnik GmbH' });
    hydrateInboxStore([item]);
    const ergebnis = buildReplyDraft({ text: 'Schreib denen, dass wir am 25.10. kommen', item, companyProfile: null });
    expect(ergebnis).not.toBeNull();
    expect(ergebnis!.recipient.source).toBe('unknown');
    expect(JSON.stringify(ergebnis!.draft)).not.toContain('Haustechnik');
  });
});
