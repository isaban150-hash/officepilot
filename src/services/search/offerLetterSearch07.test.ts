/**
 * GLOBALE-SUCHE-V1 — Angebote und Briefe als eigene Treffer.
 *
 *  A  Angebote: Titel, Kunde, Nummer, Baustelle, Entwurf, Navigation
 *  B  Briefe: Betreff, Empfänger, Entwurf, Navigation
 *  C  Aktive und gelöschte Entitäten
 *  D  Dedupe Variante 2 — ein fachlicher Treffer, Archiv bleibt vollständig
 *  E  Ranking
 *  F  Bestehende Suche unverändert
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { searchOffice } from '../officeSearchService';
import { searchDocuments, hydrateDocumentStore } from '../documentService';
import { setOfferStoreForTests } from '../offer/offerService';
import { setBusinessLetterStoreForTests } from '../businessLetterService';
import { resetTestStores } from '../../test/resetStores';
import type { CompanyDocument } from '../../types/models';
import type { Offer } from '../../types/offer';
import type { BusinessLetter } from '../../types/businessLetter';
import type { SearchResult } from '../../types/officeSearch';

const TODAY = '2026-10-03';

function offer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: 'off-1',
    workspaceId: 'ws-1',
    offerNumber: 'AN-2026-0042',
    status: 'freigegeben',
    customer: {
      name: 'Meier Hochbau GmbH',
      contactPerson: '',
      street: 'Weg 1',
      zip: '33602',
      city: 'Bielefeld',
      email: '',
      phone: '',
    },
    title: 'Badsanierung Obergeschoss',
    baustelle: 'Lindenallee 7',
    positions: [],
    offerDate: '2026-09-01',
    validUntil: '2026-10-31',
    taxStatus: 'standard_19',
    createdAt: '2026-09-01T08:00:00.000Z',
    ...overrides,
  } as Offer;
}

function letter(overrides: Partial<BusinessLetter> = {}): BusinessLetter {
  return {
    id: 'let-1',
    workspaceId: 'ws-1',
    subject: 'Terminbestätigung Rohbauabnahme',
    body: 'Sehr geehrte Damen und Herren, hiermit bestätigen wir den Termin.',
    letterDate: '2026-09-20',
    recipient: {
      name: 'Schulz Bauträger AG',
      street: 'Hauptstrasse 3',
      zip: '33604',
      city: 'Bielefeld',
    },
    status: 'finalized',
    createdAt: '2026-09-20T08:00:00.000Z',
    ...overrides,
  } as BusinessLetter;
}

function document(overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  return {
    id: 'doc-1',
    title: 'Irgendein Beleg',
    category: 'sonstiges',
    issuer: 'Musterbetrieb',
    recognizedText: '',
    issueDate: '2026-09-01',
    validUntil: null,
    digitalFolder: { id: 'd', name: 'Ablage', path: '/Ablage' },
    paperFolder: { folderId: 'f1', register: 'A', label: 'Ordner A' },
    tags: [],
    linkedCompany: '',
    linkedVorgang: null,
    archived: false,
    createdAt: '2026-09-01T08:00:00.000Z',
    ...overrides,
  } as CompanyDocument;
}

/** Das Archivdokument, wie `offerArchiveService` es anlegt. */
function offerArchive(target: Offer, overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  return document({
    id: `doc-${target.id}`,
    title: `${target.offerNumber} – Angebot`,
    classifiedKind: 'angebot',
    linkedOfferId: target.id,
    linkedCompany: target.customer.name,
    recognizedText: [
      `Angebot ${target.offerNumber ?? ''}`.trim(),
      target.title,
      target.customer.name,
      target.baustelle,
      '12 m² Fliesenarbeiten Feinsteinzeug',
    ].join('\n'),
    ...overrides,
  } as Partial<CompanyDocument>);
}

/** Das Archivdokument, wie `businessLetterArchiveService` es anlegt. */
function letterArchive(target: BusinessLetter, overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  return document({
    id: `doc-${target.id}`,
    title: target.subject,
    linkedLetterId: target.id,
    recognizedText: `${target.subject}\n\n${target.body}`,
    ...overrides,
  } as Partial<CompanyDocument>);
}

function find(query: string, type?: string): SearchResult[] {
  const results = searchOffice({ query, todayIso: TODAY });
  return type ? results.filter((item) => item.type === type) : results;
}

beforeEach(() => {
  localStorage.clear();
  resetTestStores();
  setOfferStoreForTests([]);
  setBusinessLetterStoreForTests([]);
  hydrateDocumentStore([]);
});

describe('A — Angebote', () => {
  it('A1: Angebotsentwurf über den Titel gefunden', () => {
    setOfferStoreForTests([offer({ status: 'entwurf', offerNumber: undefined })]);
    const hits = find('Badsanierung', 'offer');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.title).toBe('Badsanierung Obergeschoss');
  });

  it('A2: Angebotsentwurf über den Kundennamen gefunden', () => {
    setOfferStoreForTests([offer({ status: 'entwurf' })]);
    expect(find('Meier Hochbau', 'offer')).toHaveLength(1);
  });

  it('A3: Angebot über die Angebotsnummer gefunden', () => {
    setOfferStoreForTests([offer()]);
    const hits = find('AN-2026-0042', 'offer');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.title).toBe('AN-2026-0042 · Badsanierung Obergeschoss');
  });

  it('A4: Angebot über die Baustelle gefunden', () => {
    setOfferStoreForTests([offer()]);
    expect(find('Lindenallee', 'offer')).toHaveLength(1);
  });

  it('A5: Navigation führt direkt zum Angebot, nicht ins Archiv', () => {
    setOfferStoreForTests([offer()]);
    expect(find('Badsanierung', 'offer')[0]!.route).toBe('/angebote/off-1');
  });

  it('A6: der Entwurf ist als Entwurf erkennbar', () => {
    setOfferStoreForTests([offer({ status: 'entwurf' })]);
    expect(find('Badsanierung', 'offer')[0]!.statusLabel).toBe('Entwurf');
  });

  it('A7: ein freigegebenes Angebot trägt kein Entwurfsetikett', () => {
    setOfferStoreForTests([offer({ status: 'freigegeben' })]);
    expect(find('Badsanierung', 'offer')[0]!.statusLabel).toBeUndefined();
  });

  it('A8: Unterzeile nennt Kunde und Baustelle, keine Kennung', () => {
    setOfferStoreForTests([offer()]);
    const hit = find('Badsanierung', 'offer')[0]!;
    expect(hit.subtitle).toBe('Meier Hochbau GmbH – Lindenallee 7');
    expect(hit.subtitle).not.toContain('off-1');
    expect(hit.title).not.toContain('off-1');
  });

  it('A9: Positionstexte sind nicht im nativen Haystack', () => {
    setOfferStoreForTests([offer()]);
    expect(find('Feinsteinzeug', 'offer')).toHaveLength(0);
  });
});

describe('B — Briefe', () => {
  it('B1: Briefentwurf über den Betreff gefunden', () => {
    setBusinessLetterStoreForTests([letter({ status: 'draft' })]);
    const hits = find('Rohbauabnahme', 'letter');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.title).toBe('Terminbestätigung Rohbauabnahme');
  });

  it('B2: Briefentwurf über den Empfänger gefunden', () => {
    setBusinessLetterStoreForTests([letter({ status: 'draft' })]);
    expect(find('Schulz Bauträger', 'letter')).toHaveLength(1);
  });

  it('B3: Navigation führt direkt zum Schreiben', () => {
    setBusinessLetterStoreForTests([letter()]);
    expect(find('Rohbauabnahme', 'letter')[0]!.route).toBe('/schreiben/let-1');
  });

  it('B4: der Entwurf ist als Entwurf erkennbar', () => {
    setBusinessLetterStoreForTests([letter({ status: 'draft' })]);
    expect(find('Rohbauabnahme', 'letter')[0]!.statusLabel).toBe('Entwurf');
  });

  it('B5: ein fertiggestellter Brief trägt kein Etikett', () => {
    setBusinessLetterStoreForTests([letter({ status: 'finalized' })]);
    expect(find('Rohbauabnahme', 'letter')[0]!.statusLabel).toBeUndefined();
  });

  it('B6: der Fliesstext ist nicht im nativen Haystack', () => {
    setBusinessLetterStoreForTests([letter()]);
    expect(find('Sehr geehrte', 'letter')).toHaveLength(0);
  });

  /*
   * Sichtbare Abnahme — Befund aus der echten App: Ein Brief an eine
   * Organisation mit eigener Kontaktperson war ueber den Organisationsnamen
   * nicht zu finden, obwohl die Schreiben-Seite genau diesen anzeigt.
   */
  it('B7: der Brief wird ueber die Organisation des Empfaengers gefunden', () => {
    setBusinessLetterStoreForTests([
      letter({
        recipient: {
          name: 'Sachbearbeitung Bau',
          company: 'Bauamt Teststadt',
          street: 'Rathausplatz 1',
          zip: '33602',
          city: 'Teststadt',
        },
      } as never),
    ]);
    expect(find('Bauamt Teststadt', 'letter')).toHaveLength(1);
    /* Die Kontaktperson findet ihn weiterhin. */
    expect(find('Sachbearbeitung Bau', 'letter')).toHaveLength(1);
  });

  it('B8: angezeigt wird die Organisation, wie auf der Schreiben-Seite', () => {
    setBusinessLetterStoreForTests([
      letter({
        recipient: {
          name: 'Sachbearbeitung Bau',
          company: 'Bauamt Teststadt',
          street: 'Rathausplatz 1',
          zip: '33602',
          city: 'Teststadt',
        },
      } as never),
    ]);
    expect(find('Rohbauabnahme', 'letter')[0]!.subtitle).toBe('Bauamt Teststadt');
  });

  it('B9: ohne Organisation bleibt die Person die Anzeige', () => {
    setBusinessLetterStoreForTests([letter()]);
    expect(find('Rohbauabnahme', 'letter')[0]!.subtitle).toBe('Schulz Bauträger AG');
  });

  it('B10: die Stadt allein ist kein Treffer', () => {
    setBusinessLetterStoreForTests([
      letter({
        recipient: {
          name: 'Sachbearbeitung Bau',
          company: 'Bauamt Teststadt',
          street: 'Rathausplatz 1',
          zip: '33602',
          city: 'Hintertupfingen',
        },
      } as never),
    ]);
    expect(find('Hintertupfingen', 'letter')).toHaveLength(0);
  });
});

describe('C — aktive und gelöschte Entitäten', () => {
  it('C1: ein sync-gelöschtes Angebot erzeugt keinen nativen Treffer', () => {
    setOfferStoreForTests([
      offer({ sync: { version: 2, updatedAt: TODAY, deleted: true } as never }),
    ]);
    expect(find('Badsanierung', 'offer')).toHaveLength(0);
  });

  it('C2: ein sync-gelöschter Brief erzeugt keinen nativen Treffer', () => {
    setBusinessLetterStoreForTests([
      letter({ sync: { version: 2, updatedAt: TODAY, deleted: true } as never }),
    ]);
    expect(find('Rohbauabnahme', 'letter')).toHaveLength(0);
  });

  it('C3: storniertes und ersetztes Angebot bleiben suchbar', () => {
    setOfferStoreForTests([
      offer({ id: 'off-s', status: 'storniert' }),
      offer({ id: 'off-e', status: 'ersetzt' }),
    ]);
    expect(find('Badsanierung', 'offer')).toHaveLength(2);
  });
});

describe('D — Dedupe Variante 2', () => {
  it('D1: Angebot und verknüpftes Archivdokument treffen beide — nur der native Treffer bleibt', () => {
    const a = offer();
    setOfferStoreForTests([a]);
    hydrateDocumentStore([offerArchive(a)]);

    const hits = find('Badsanierung');
    expect(hits.filter((h) => h.type === 'offer')).toHaveLength(1);
    expect(hits.filter((h) => h.route === '/dokumente/doc-off-1')).toHaveLength(0);
  });

  it('D2: Brief und verknüpftes Archivdokument — nur der native Treffer bleibt', () => {
    const b = letter();
    setBusinessLetterStoreForTests([b]);
    hydrateDocumentStore([letterArchive(b)]);

    const hits = find('Rohbauabnahme');
    expect(hits.filter((h) => h.type === 'letter')).toHaveLength(1);
    expect(hits.filter((h) => h.route === '/dokumente/doc-let-1')).toHaveLength(0);
  });

  it('D3: trifft nur der Archiv-Volltext, bleibt das Dokument sichtbar', () => {
    const a = offer();
    setOfferStoreForTests([a]);
    hydrateDocumentStore([offerArchive(a)]);

    // „Feinsteinzeug" steht nur im recognizedText, nicht im nativen Haystack.
    const hits = find('Feinsteinzeug');
    expect(hits.filter((h) => h.type === 'offer')).toHaveLength(0);
    expect(hits.filter((h) => h.route === '/dokumente/doc-off-1')).toHaveLength(1);
  });

  it('D4: ein Dokument ohne Verknüpfung bleibt immer sichtbar', () => {
    const a = offer();
    setOfferStoreForTests([a]);
    hydrateDocumentStore([
      offerArchive(a, { id: 'doc-alt', linkedOfferId: undefined }),
    ]);

    const hits = find('Badsanierung');
    expect(hits.filter((h) => h.type === 'offer')).toHaveLength(1);
    expect(hits.filter((h) => h.route === '/dokumente/doc-alt')).toHaveLength(1);
  });

  it('D5: verknüpftes Dokument ohne aktive native Entität bleibt sichtbar', () => {
    const a = offer();
    // Kein Angebot im Bestand — das Dokument ist die einzige Spur.
    setOfferStoreForTests([]);
    hydrateDocumentStore([offerArchive(a)]);

    const hits = find('Badsanierung');
    expect(hits.filter((h) => h.type === 'offer')).toHaveLength(0);
    expect(hits.filter((h) => h.route === '/dokumente/doc-off-1')).toHaveLength(1);
  });

  it('D6: dasselbe für ein gelöschtes Angebot', () => {
    const a = offer({ sync: { version: 2, updatedAt: TODAY, deleted: true } as never });
    setOfferStoreForTests([a]);
    hydrateDocumentStore([offerArchive(a)]);

    const hits = find('Badsanierung');
    expect(hits.filter((h) => h.type === 'offer')).toHaveLength(0);
    expect(hits.filter((h) => h.route === '/dokumente/doc-off-1')).toHaveLength(1);
  });

  it('D7: das Dokumentarchiv selbst bleibt vollständig', () => {
    const a = offer();
    const b = letter();
    setOfferStoreForTests([a]);
    setBusinessLetterStoreForTests([b]);
    hydrateDocumentStore([offerArchive(a), letterArchive(b)]);

    // searchDocuments ist der Dienst der Archivansicht — unverändert.
    expect(searchDocuments('Badsanierung', 'all')).toHaveLength(1);
    expect(searchDocuments('Rohbauabnahme', 'all')).toHaveLength(1);
    expect(searchDocuments('', 'all')).toHaveLength(2);
  });

  it('D8: ohne native Treffer wird nichts unterdrückt', () => {
    const a = offer();
    setOfferStoreForTests([]);
    setBusinessLetterStoreForTests([]);
    hydrateDocumentStore([offerArchive(a), document({ id: 'doc-frei', title: 'Badsanierung Notiz' })]);

    expect(find('Badsanierung').filter((h) => h.type === 'document')).toHaveLength(2);
  });
});

describe('E — Ranking', () => {
  it('E1: die exakte Angebotsnummer steht ganz oben', () => {
    const a = offer();
    setOfferStoreForTests([a]);
    hydrateDocumentStore([offerArchive(a), document({ id: 'doc-x', title: 'Notiz AN-2026-0042' })]);

    const hits = find('AN-2026-0042');
    expect(hits[0]!.type).toBe('offer');
    expect(hits[0]!.route).toBe('/angebote/off-1');
  });

  it('E2: der exakte Briefbetreff steht vor einem schwächeren Dokumenttreffer', () => {
    const b = letter();
    setBusinessLetterStoreForTests([b]);
    hydrateDocumentStore([
      document({ id: 'doc-y', title: 'Notiz', recognizedText: 'Terminbestätigung Rohbauabnahme war Thema' }),
    ]);

    const hits = find('Terminbestätigung Rohbauabnahme');
    expect(hits[0]!.type).toBe('letter');
  });

  it('E3: der Angebotstitel findet das Angebot auch ohne Nummernvorsprung', () => {
    const a = offer();
    setOfferStoreForTests([a]);
    hydrateDocumentStore([
      document({ id: 'doc-t', title: 'Notiz', recognizedText: 'Badsanierung Obergeschoss erwaehnt' }),
    ]);
    const hits = find('Badsanierung Obergeschoss');
    expect(hits[0]!.type).toBe('offer');
  });
});

describe('F — bestehende Suche unverändert', () => {
  it('F1: ein gewöhnliches Dokument bleibt auffindbar', () => {
    hydrateDocumentStore([document({ id: 'doc-z', title: 'Handwerkskammer Bescheid' })]);
    expect(find('Handwerkskammer', 'document')).toHaveLength(1);
  });

  it('F2: Rechnungsarchivdokumente werden nicht angefasst', () => {
    // Ein Rechnungsbeleg trägt weder linkedOfferId noch linkedLetterId.
    hydrateDocumentStore([
      document({
        id: 'doc-re',
        title: 'Ausgangsrechnung 2026-0001',
        category: 'ausgangsrechnung',
        linkedInvoiceId: 'inv-1',
      }),
    ]);
    setOfferStoreForTests([offer()]);
    /*
     * Geprueft wird die Archivzeile selbst ueber ihre Route. Die Trefferzahl
     * zu zaehlen waere hier irrefuehrend: `collectPaperResults` liefert fuer
     * passende Papierordner ebenfalls `type: 'document'` (Route
     * `/papierarchiv`) — vorhandenes Verhalten, von diesem Block unberuehrt.
     */
    const hits = find('Ausgangsrechnung');
    expect(hits.filter((h) => h.route === '/dokumente/doc-re')).toHaveLength(1);
  });

  it('F3: ohne Angebote und Briefe liefert die Suche unverändert nur die alten Typen', () => {
    hydrateDocumentStore([document({ id: 'doc-q', title: 'Prüfbericht' })]);
    const hits = find('Prüfbericht');
    expect(hits.every((h) => h.type !== 'offer' && h.type !== 'letter')).toBe(true);
  });
});
