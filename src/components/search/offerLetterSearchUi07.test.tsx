/**
 * GLOBALE-SUCHE-V1 — Angebote und Briefe in der vorhandenen Suchoberfläche.
 *
 *  U1  Treffer erscheinen mit Symbol, Typbezeichnung und Ziel
 *  U2  Entwurf ist in der vollen Darstellung erkennbar
 *  U3  Entwurf ist auch in der kompakten Darstellung erkennbar
 *  U4  Treffer sind per Tastatur erreichbar und auslösbar
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProvider } from '../../context/AppContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { SearchResultsList } from './GlobalSearchBar';
import { searchOffice } from '../../services/officeSearchService';
import { setOfferStoreForTests } from '../../services/offer/offerService';
import { setBusinessLetterStoreForTests } from '../../services/businessLetterService';
import { hydrateDocumentStore } from '../../services/documentService';
import { resetTestStores } from '../../test/resetStores';
import type { Offer } from '../../types/offer';
import type { BusinessLetter } from '../../types/businessLetter';

const TODAY = '2026-10-03';
let root: Root;
let host: HTMLDivElement;

function offer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: 'off-1',
    workspaceId: 'ws-1',
    offerNumber: 'AN-2026-0042',
    status: 'entwurf',
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
    body: 'Sehr geehrte Damen und Herren',
    letterDate: '2026-09-20',
    recipient: { name: 'Schulz Bauträger AG', street: 'Hauptstrasse 3', zip: '33604', city: 'Bielefeld' },
    status: 'draft',
    createdAt: '2026-09-20T08:00:00.000Z',
    ...overrides,
  } as BusinessLetter;
}

async function mountResults(query: string, compact: boolean): Promise<void> {
  const results = searchOffice({ query, todayIso: TODAY });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true }}>
          <SearchResultsList results={results} compact={compact} />
        </AppProvider>
      </MemoryRouter>,
    );
  });
}

beforeEach(() => {
  localStorage.clear();
  resetTestStores();
  setOfferStoreForTests([]);
  setBusinessLetterStoreForTests([]);
  hydrateDocumentStore([]);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('U1 — Darstellung', () => {
  it('U1.1: der Angebotstreffer zeigt Nummer, Titel, Kunde und Typbezeichnung', async () => {
    setOfferStoreForTests([offer({ status: 'freigegeben' })]);
    await mountResults('Badsanierung', false);

    const text = host.textContent ?? '';
    expect(text).toContain('AN-2026-0042 · Badsanierung Obergeschoss');
    expect(text).toContain('Meier Hochbau GmbH – Lindenallee 7');
    expect(text).toContain('Angebot');
    // Keine technische Kennung in der Anzeige.
    expect(text).not.toContain('off-1');
  });

  it('U1.2: der Brieftreffer zeigt Betreff, Empfänger und Typbezeichnung', async () => {
    setBusinessLetterStoreForTests([letter({ status: 'finalized' })]);
    await mountResults('Rohbauabnahme', false);

    const text = host.textContent ?? '';
    expect(text).toContain('Terminbestätigung Rohbauabnahme');
    expect(text).toContain('Schulz Bauträger AG');
    expect(text).toContain('Schreiben');
    expect(text).not.toContain('let-1');
  });
});

describe('U2/U3 — Entwurfskennzeichnung', () => {
  it('U2.1: in der vollen Darstellung ist der Angebotsentwurf erkennbar', async () => {
    setOfferStoreForTests([offer()]);
    await mountResults('Badsanierung', false);
    expect(host.textContent).toContain('Entwurf');
  });

  it('U2.2: in der vollen Darstellung ist der Briefentwurf erkennbar', async () => {
    setBusinessLetterStoreForTests([letter()]);
    await mountResults('Rohbauabnahme', false);
    expect(host.textContent).toContain('Entwurf');
  });

  it('U3.1: auch in der kompakten Darstellung bleibt der Angebotsentwurf erkennbar', async () => {
    /*
     * Die kompakte Vorschau blendet Schnipsel und Metazeile aus. Wäre „Entwurf"
     * nur dort, wüsste der Nutzer in der Kopfzeilensuche nicht, dass er einen
     * Entwurf vor sich hat.
     */
    setOfferStoreForTests([offer()]);
    await mountResults('Badsanierung', true);
    expect(host.textContent).toContain('Entwurf');
  });

  it('U3.2: dasselbe für den Briefentwurf', async () => {
    setBusinessLetterStoreForTests([letter()]);
    await mountResults('Rohbauabnahme', true);
    expect(host.textContent).toContain('Entwurf');
  });

  it('U3.3: ein fertiges Angebot trägt die Kennzeichnung nicht', async () => {
    setOfferStoreForTests([offer({ status: 'freigegeben' })]);
    await mountResults('Badsanierung', true);
    expect(host.textContent).not.toContain('Entwurf');
  });
});

describe('U4 — Bedienbarkeit', () => {
  it('U4.1: jeder Treffer ist ein fokussierbarer Knopf', async () => {
    setOfferStoreForTests([offer()]);
    setBusinessLetterStoreForTests([letter()]);
    await mountResults('e', false);

    const buttons = host.querySelectorAll<HTMLButtonElement>('button.search-results-list__item');
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    for (const button of buttons) {
      button.focus();
      expect(document.activeElement).toBe(button);
      // Kein tabIndex=-1: die Zeile liegt in der natürlichen Tabfolge.
      expect(button.getAttribute('tabindex')).toBeNull();
    }
  });

  it('U4.2: die Treffer stehen als Liste, nicht als Fliesstext', async () => {
    setOfferStoreForTests([offer()]);
    await mountResults('Badsanierung', false);
    expect(host.querySelectorAll('ul.search-results-list li').length).toBeGreaterThan(0);
  });
});
