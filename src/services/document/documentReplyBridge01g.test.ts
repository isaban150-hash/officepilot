/**
 * DOKUMENT-ASSISTENT-01G — die Antwortbrücke.
 *
 * Geprüft wird, was 01G neu entscheidet: wann aus einer Eingabe ein Entwurf
 * wird und wann nicht, dass die Angabe des Benutzers unverändert hineingeht
 * und nichts hinzukommt, wer als Empfänger gilt, und dass die Übergabe an den
 * Briefeditor keine unbestätigte Zuordnung mitschleppt.
 *
 * Alle Beispiele sind frei erfunden.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildLetterPrefill,
  buildReplyDraft,
  detectChannelPreference,
  extractCoreMessage,
  hasEmailAddress,
  hasPostalAddress,
  isLetterDraftPrefill,
  isReplyRequest,
  resolveReplyRecipient,
} from './documentReplyBridgeService';
import { resetVorgaenge, hydrateVorgangStore } from '../vorgangService';
import { resetCustomers, hydrateCustomerStore } from '../customerStoreService';
import type { CompanyProfile, Customer, InboxItem, Vorgang } from '../../types/models';
import type { DocumentSemanticCore } from '../../types/documentSemanticCore';
import { emptyDocumentSemanticCore } from '../../types/documentSemanticCore';

const PROFIL = { companyName: 'Beispiel Haustechnik GmbH' } as CompanyProfile;

function kern(teile: Partial<DocumentSemanticCore> = {}): DocumentSemanticCore {
  return {
    ...emptyDocumentSemanticCore(),
    subject: { value: 'Maengelanzeige Gewerbepark Senne', certainty: 'detected' },
    deadlines: [
      { date: '2026-09-22', type: 'response_due', appliesTo: 'Antwort', actionRequired: true, certainty: 'detected' },
    ],
    ...teile,
  };
}

function posten(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'inbox-1',
    title: 'Schreiben',
    documentType: 'sonstiges',
    sender: 'Westfalen Projektbau GmbH',
    priority: 'mittel',
    deadline: null,
    recommendedAction: 'klaeren',
    digitalFolder: { id: 'd', name: 'Eingang', path: '/Eingang/' },
    paperFiling: { folderId: 'f', register: 'A', label: 'Ordner' },
    status: 'neu',
    receivedAt: '2026-09-12T08:00:00.000Z',
    recognizedData: {},
    officePilotSuggestion: '',
    nextTaskLabel: '',
    securityHint: '',
    ...overrides,
  } as InboxItem;
}

function vorgang(): Vorgang {
  return {
    id: 'vg-1',
    title: 'Gewerbepark Senne',
    customer: 'Westfalen Projektbau GmbH',
    customerId: 'cust-1',
    baustelle: 'Senne',
    status: 'in_arbeit',
    materialSource: 'standard',
    orderPositions: [],
    documents: [],
    tasks: [],
    photos: [],
    invoices: [],
  } as unknown as Vorgang;
}

function kunde(): Customer {
  return {
    id: 'cust-1',
    name: 'Westfalen Projektbau GmbH',
    contactPerson: 'Daniel Krüger',
    street: 'Industriestrasse 27',
    zip: '33689',
    city: 'Bielefeld',
    email: 'info@westfalen-projektbau.example',
  } as unknown as Customer;
}

const entwurf = (text: string, item = posten(), core = kern()) =>
  buildReplyDraft({ text, item, core, companyProfile: PROFIL });

beforeEach(() => {
  resetVorgaenge();
  resetCustomers();
});

describe('01G — Antwortabsicht von Frage und Wiedervorlage trennen', () => {
  it('erkennt eine Aufforderung zu schreiben', () => {
    expect(isReplyRequest('Schreib denen, dass wir am 25.09. kommen.')).toBe(true);
    expect(isReplyRequest('Antworte, dass wir die Mängel prüfen.')).toBe(true);
    expect(isReplyRequest('Schreib eine E-Mail und frag nach drei Raten.')).toBe(true);
  });

  it('lässt gewöhnliche Fragen gewöhnliche Fragen sein', () => {
    expect(isReplyRequest('Was muss ich tun?')).toBe(false);
    expect(isReplyRequest('Bis wann muss ich reagieren?')).toBe(false);
    expect(isReplyRequest('Ist das schon bezahlt?')).toBe(false);
  });

  it('greift nicht nach einem Wiedervorlagewunsch', () => {
    expect(isReplyRequest('Erinnere mich zwei Tage vorher.')).toBe(false);
    expect(isReplyRequest('Mach daraus eine Wiedervorlage.')).toBe(false);
  });

  it('merkt sich einen genannten Kanal, wählt ihn aber nicht aus', () => {
    expect(detectChannelPreference('Schreib eine E-Mail.')).toBe('email');
    expect(detectChannelPreference('Mach daraus einen Brief.')).toBe('letter');
    expect(detectChannelPreference('Schreib denen.')).toBe('undecided');
  });
});

describe('01G — die Aussage des Benutzers', () => {
  it('macht aus einem Nebensatz einen vollständigen Satz', () => {
    expect(extractCoreMessage('Schreib denen, dass wir am 25.09. kommen.')).toBe(
      'Wir teilen Ihnen mit, dass wir am 25.09. kommen.',
    );
  });

  it('macht aus einer Nachfrage eine Bitte', () => {
    expect(extractCoreMessage('Schreib eine E-Mail und frag nach drei Raten.')).toBe(
      'Wir bitten um drei Raten.',
    );
  });

  it('übernimmt die Angabe des Benutzers unverändert in den Entwurf', () => {
    const ergebnis = entwurf('Schreib denen, dass wir am 25.09. kommen.');
    expect(ergebnis?.draft.body).toContain('25.09.');
    expect(ergebnis?.draft.basedOnFacts.join(' ')).toContain('25.09.');
  });

  it('fügt keine Zusage hinzu, die der Benutzer nicht gemacht hat', () => {
    const ergebnis = entwurf('Schreib denen, dass wir die Mängel prüfen.');
    const text = ergebnis?.draft.body ?? '';
    expect(text).not.toMatch(/30\.09|22\.09|beseitigen bis|verpflichte/i);
    expect(ergebnis?.draft.notIncluded.join(' ')).toContain('Keine rechtliche Bewertung');
  });

  it('nennt das Schreiben, auf das geantwortet wird', () => {
    const ergebnis = entwurf('Antworte, dass wir uns melden.');
    expect(ergebnis?.draft.subject).toContain('Maengelanzeige');
    expect(ergebnis?.draft.body).toContain('Maengelanzeige');
  });

  it('behauptet bei einer Ratenbitte keinen Rechtsanspruch', () => {
    const text = entwurf('Schreib eine E-Mail und frag nach drei Raten.')?.draft.body ?? '';
    expect(text).toContain('Wir bitten um drei Raten');
    expect(text).not.toMatch(/anspruch|gesetzlich|müssen zustimmen|verpflichtet/i);
  });

  it('erfindet keine Beträge', () => {
    const text = entwurf('Schreib eine E-Mail und frag nach drei Raten.')?.draft.body ?? '';
    expect(text).not.toMatch(/\d+[.,]\d{2}\s*(EUR|€)/);
  });
});

describe('01G — Empfänger', () => {
  it('nimmt den bestätigt zugeordneten Kunden', () => {
    hydrateVorgangStore([vorgang()]);
    hydrateCustomerStore([kunde()]);
    const empfaenger = resolveReplyRecipient(
      posten({ vorgangId: 'vg-1', vorgangLinkStatus: 'linked' }),
      kern(),
    );

    expect(empfaenger.source).toBe('confirmed_customer');
    expect(empfaenger.customerId).toBe('cust-1');
    expect(hasPostalAddress(empfaenger)).toBe(true);
    expect(hasEmailAddress(empfaenger)).toBe(true);
  });

  it('nimmt ohne bestätigte Zuordnung nur den belegten Absender', () => {
    const empfaenger = resolveReplyRecipient(posten(), kern());
    expect(empfaenger.source).toBe('document');
    expect(empfaenger.organization).toBe('Westfalen Projektbau GmbH');
  });

  it('erfindet weder Anschrift noch E-Mail', () => {
    const empfaenger = resolveReplyRecipient(posten(), kern());
    expect(hasPostalAddress(empfaenger)).toBe(false);
    expect(hasEmailAddress(empfaenger)).toBe(false);
    expect(empfaenger.street).toBeUndefined();
    expect(empfaenger.email).toBeUndefined();
  });

  it('macht aus einem unbestätigten Kandidaten keinen Kunden', () => {
    const mitKandidat = kern({
      customerCandidates: [{ id: 'cust-9', name: 'Westfalen Projektbau GmbH', score: 1, reasons: ['Absender.'] }],
    });
    const empfaenger = resolveReplyRecipient(posten(), mitKandidat);
    expect(empfaenger.customerId).toBeUndefined();
    expect(empfaenger.source).not.toBe('confirmed_customer');
  });
});

describe('01G — Übergabe an den Briefeditor', () => {
  it('übergibt Betreff, Text und Empfänger', () => {
    const ergebnis = entwurf('Schreib denen, dass wir am 25.09. kommen.');
    if (!ergebnis) throw new Error('kein Entwurf');
    const prefill = buildLetterPrefill(ergebnis);

    expect(prefill.subject).toContain('Maengelanzeige');
    expect(prefill.body).toContain('25.09.');
    expect(prefill.recipient.company).toBe('Westfalen Projektbau GmbH');
    expect(isLetterDraftPrefill(prefill)).toBe(true);
  });

  it('übergibt keine unbestätigte Kunden- oder Auftragskennung', () => {
    const mitKandidat = kern({
      customerCandidates: [{ id: 'cust-9', name: 'Westfalen Projektbau GmbH', score: 1, reasons: ['Absender.'] }],
      vorgangCandidates: [{ id: 'vg-9', name: 'Gewerbepark Senne', score: 1, reasons: ['Im Text.'] }],
    });
    const ergebnis = buildReplyDraft({
      text: 'Schreib denen, dass wir kommen.',
      item: posten(),
      core: mitKandidat,
      companyProfile: PROFIL,
    });
    if (!ergebnis) throw new Error('kein Entwurf');
    const prefill = buildLetterPrefill(ergebnis);

    expect(prefill.customerId).toBeUndefined();
    expect(prefill.vorgangId).toBeUndefined();
  });

  it('übergibt eine bestätigte Zuordnung sehr wohl', () => {
    hydrateVorgangStore([vorgang()]);
    hydrateCustomerStore([kunde()]);
    const ergebnis = buildReplyDraft({
      text: 'Schreib denen, dass wir kommen.',
      item: posten({ vorgangId: 'vg-1', vorgangLinkStatus: 'linked' }),
      core: kern(),
      companyProfile: PROFIL,
    });
    if (!ergebnis) throw new Error('kein Entwurf');
    const prefill = buildLetterPrefill(ergebnis);

    expect(prefill.customerId).toBe('cust-1');
    expect(prefill.vorgangId).toBe('vg-1');
    expect(prefill.recipient.street).toBe('Industriestrasse 27');
  });

  it('erkennt eine fremde Vorbelegung nicht als gültig an', () => {
    expect(isLetterDraftPrefill(null)).toBe(false);
    expect(isLetterDraftPrefill({ subject: 1, body: 2 })).toBe(false);
  });
});

describe('01G — ohne semantischen Kern', () => {
  it('erzeugt weiterhin einen Entwurf', () => {
    const ergebnis = buildReplyDraft({
      text: 'Schreib denen, dass wir kommen.',
      item: posten(),
      core: undefined,
      companyProfile: PROFIL,
    });
    expect(ergebnis?.draft.body).toContain('Wir teilen Ihnen mit');
  });

  it('liefert ohne Kernaussage gar keinen Entwurf', () => {
    expect(entwurf('Schreib.')).toBeNull();
  });
});
