/**
 * BRIEFE-01D — nur das, was die sichtbare Abnahme nicht beweisen konnte.
 *
 * Die Oberfläche hat bereits gezeigt: PDF entsteht, ist lesbar, lädt herunter,
 * und mehrfaches Öffnen erzeugt keinen zweiten Archiveintrag. Zwei Zusagen
 * liessen sich dort nicht prüfen, weil der Testarbeitsbereich kein Firmenlogo
 * führt und weil man einem fertigen Brief von aussen nicht ansieht, woher seine
 * Absenderdaten stammen:
 *
 *   1. das Logo wird eingebettet, wenn eines hinterlegt ist,
 *   2. ein fertiggestellter Brief druckt nach einer Änderung am Firmenprofil
 *      unverändert weiter.
 *
 * Dazu die Idempotenz der Ablage als festgeschriebener Vertrag.
 *
 * Neutrale Beispieldaten.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { BusinessLetter } from '../../types/businessLetter';
import type { CompanyProfile } from '../../types/models';
import {
  buildBusinessLetterPdfFilename,
  generateBusinessLetterPdf,
} from './businessLetterPdfService';
import { ensureBusinessLetterArchived } from './businessLetterArchiveService';
import {
  addBusinessLetter,
  finalizeBusinessLetter,
  getBusinessLetterById,
  resetBusinessLetters,
} from '../businessLetterService';
import { getAllDocuments, resetDocuments } from '../documentService';
import { hydrateCompanyProfileStore, resetCompanyProfile } from '../companyProfileService';
import { createCompanyProfileFromSetup } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';

const WORKSPACE = 'ws-letter-01d';

/* Ein winziges, gültiges PNG — ein Pixel. */
const PNG_EIN_PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function profil(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    ...createCompanyProfileFromSetup(DEFAULT_SETUP),
    companyName: 'Beispiel Haustechnik GmbH',
    street: 'Musterstrasse 5',
    zip: '33602',
    city: 'Bielefeld',
    ...overrides,
  };
}

function legeAn(): BusinessLetter {
  const ergebnis = addBusinessLetter(WORKSPACE, {
    subject: 'Terminbestaetigung',
    body: 'Die Arbeiten beginnen am Montag.\n\nMit freundlichen Gruessen',
    letterDate: '2026-09-19',
    recipient: {
      name: 'Herr Mueller',
      company: 'Musterbau GmbH',
      street: 'Musterweg 1',
      zip: '33602',
      city: 'Bielefeld',
    },
  });
  if (!ergebnis.success) throw new Error('Brief konnte nicht angelegt werden');
  return ergebnis.letter;
}

function stelleFertig(id: string): BusinessLetter {
  const ergebnis = finalizeBusinessLetter(id);
  if (!ergebnis.success) throw new Error('Brief konnte nicht fertiggestellt werden');
  return ergebnis.letter;
}

beforeEach(() => {
  resetBusinessLetters();
  resetDocuments();
  resetCompanyProfile();
  hydrateCompanyProfileStore(profil());
});

describe('BRIEFE-01D — das Dokument', () => {
  it('erzeugt für ein fertiggestelltes Schreiben ein echtes PDF', async () => {
    const fertig = stelleFertig(legeAn().id);
    const ergebnis = await generateBusinessLetterPdf(fertig);

    expect(ergebnis.ok).toBe(true);
    if (!ergebnis.ok) return;
    const kopf = String.fromCharCode(...ergebnis.bytes.slice(0, 5));
    expect(kopf).toBe('%PDF-');
    expect(ergebnis.bytes.byteLength).toBeGreaterThan(1000);
  });

  it('druckt für einen Entwurf nichts', async () => {
    const entwurf = legeAn();
    const ergebnis = await generateBusinessLetterPdf(entwurf);

    expect(ergebnis.ok).toBe(false);
    if (ergebnis.ok) return;
    expect(ergebnis.reason).toBe('not_finalized');
  });

  it('bettet das Logo ein, wenn das eingefrorene Profil eines führt', async () => {
    /*
     * Der Beweis läuft über die Grösse: Dasselbe Schreiben einmal mit und
     * einmal ohne Logo. Wird das Bild eingebettet, wächst die Datei; wird es
     * stillschweigend verworfen, bliebe sie gleich gross.
     */
    hydrateCompanyProfileStore(profil({ logoDataUrl: PNG_EIN_PIXEL }));
    const mitLogo = stelleFertig(legeAn().id);
    const a = await generateBusinessLetterPdf(mitLogo);

    resetBusinessLetters();
    resetCompanyProfile();
    hydrateCompanyProfileStore(profil());
    const ohneLogo = stelleFertig(legeAn().id);
    const b = await generateBusinessLetterPdf(ohneLogo);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.bytes.byteLength).toBeGreaterThan(b.bytes.byteLength);
  });

  it('bleibt nach einer späteren Änderung am Firmenprofil unverändert', async () => {
    const fertig = stelleFertig(legeAn().id);
    const vorher = await generateBusinessLetterPdf(fertig);

    /* Der Betrieb zieht um und benennt sich neu. */
    hydrateCompanyProfileStore(
      profil({ companyName: 'Ganz Anders GmbH', street: 'Neue Gasse 9', city: 'Herford', zip: '32052' }),
    );
    const nachher = await generateBusinessLetterPdf(getBusinessLetterById(fertig.id)!);

    expect(vorher.ok).toBe(true);
    expect(nachher.ok).toBe(true);
    if (!vorher.ok || !nachher.ok) return;
    /*
     * Verglichen wird die Länge und nicht Byte für Byte: pdf-lib schreibt bei
     * jedem Lauf eine eigene Dokumentkennung. Ein anderer Absender wäre ein
     * anderer Text und damit eine andere Länge.
     */
    expect(nachher.bytes.byteLength).toBe(vorher.bytes.byteLength);
  });

  it('baut einen Dateinamen aus Datum, Betreff und kurzer Briefkennung', () => {
    const brief = stelleFertig(legeAn().id);
    const name = buildBusinessLetterPdfFilename(brief);

    expect(name.startsWith('2026-09-19_Terminbestaetigung_')).toBe(true);
    expect(name.endsWith('.pdf')).toBe(true);
    /* Stabil: derselbe Brief ergibt morgen denselben Namen. */
    expect(buildBusinessLetterPdfFilename(brief)).toBe(name);
  });

  it('macht aus Umlauten und Sonderzeichen einen brauchbaren Dateinamen', () => {
    const brief = stelleFertig(legeAn().id);
    const name = buildBusinessLetterPdfFilename({
      ...brief,
      subject: 'Kündigung / Straße & Möbel',
    });

    expect(name).toContain('Kuendigung');
    expect(name).toContain('Strasse');
    expect(/[/\\:*?"<>|]/.test(name)).toBe(false);
  });
});

describe('BRIEFE-01D — die Ablage', () => {
  it('legt ein fertiggestelltes Schreiben genau einmal ab', () => {
    const fertig = stelleFertig(legeAn().id);

    const erst = ensureBusinessLetterArchived(fertig);
    expect(erst.ok).toBe(true);
    if (!erst.ok) return;
    expect(erst.created).toBe(true);

    /* Zweiter, dritter und vierter Aufruf — mit dem inzwischen verknüpften Brief. */
    const verknuepft = getBusinessLetterById(fertig.id)!;
    for (let i = 0; i < 3; i += 1) {
      const weiter = ensureBusinessLetterArchived(verknuepft);
      expect(weiter.ok).toBe(true);
      if (!weiter.ok) return;
      expect(weiter.created).toBe(false);
      expect(weiter.document.id).toBe(erst.document.id);
    }

    expect(getAllDocuments().filter((d) => d.linkedLetterId === fertig.id)).toHaveLength(1);
  });

  it('findet die vorhandene Ablage auch wieder, wenn der Rückverweis am Brief fehlt', () => {
    const fertig = stelleFertig(legeAn().id);
    const erst = ensureBusinessLetterArchived(fertig);
    expect(erst.ok).toBe(true);
    if (!erst.ok) return;

    /* Ein Brief ohne `documentId` — etwa von einem Gerät, das sie noch nicht kennt. */
    const zweit = ensureBusinessLetterArchived({ ...fertig, documentId: undefined });
    expect(zweit.ok).toBe(true);
    if (!zweit.ok) return;
    expect(zweit.created).toBe(false);
    expect(zweit.document.id).toBe(erst.document.id);
    expect(getAllDocuments().filter((d) => d.linkedLetterId === fertig.id)).toHaveLength(1);
  });

  it('legt einen Entwurf nicht ab', () => {
    const entwurf = legeAn();
    const ergebnis = ensureBusinessLetterArchived(entwurf);

    expect(ergebnis.ok).toBe(false);
    if (ergebnis.ok) return;
    expect(ergebnis.reason).toBe('not_finalized');
    /* Der Bestand trägt Beispieldokumente; entscheidend ist, dass keines zu diesem Brief gehört. */
    expect(getAllDocuments().filter((d) => d.linkedLetterId === entwurf.id)).toHaveLength(0);
    expect(getAllDocuments().some((d) => d.category === 'geschaeftsschreiben')).toBe(false);
  });

  it('verknüpft beide Richtungen und trägt die Kategorie Geschäftsschreiben', () => {
    const fertig = stelleFertig(legeAn().id);
    const ergebnis = ensureBusinessLetterArchived(fertig);

    expect(ergebnis.ok).toBe(true);
    if (!ergebnis.ok) return;
    expect(ergebnis.document.category).toBe('geschaeftsschreiben');
    expect(ergebnis.document.linkedLetterId).toBe(fertig.id);
    expect(getBusinessLetterById(fertig.id)?.documentId).toBe(ergebnis.document.id);
  });

  it('lässt den eingefrorenen Briefinhalt beim Verknüpfen unangetastet', () => {
    const fertig = stelleFertig(legeAn().id);
    ensureBusinessLetterArchived(fertig);

    const danach = getBusinessLetterById(fertig.id)!;
    expect(danach.subject).toBe(fertig.subject);
    expect(danach.body).toBe(fertig.body);
    expect(danach.letterDate).toBe(fertig.letterDate);
    expect(danach.recipient).toEqual(fertig.recipient);
    expect(danach.companySnapshot).toEqual(fertig.companySnapshot);
    expect(danach.status).toBe('finalized');
  });
});
