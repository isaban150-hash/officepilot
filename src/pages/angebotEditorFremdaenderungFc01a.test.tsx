/**
 * FINANZ-CORE-01A (ANG-02) — der Angebotseditor überschreibt eine neuere
 * Fassung des gespeicherten Entwurfs nicht mehr still.
 *
 *  A1  neuere Fassung, hier nichts Ungespeichertes: wird geladen
 *  A2  neuere Fassung bei ungespeicherten Eingaben: Hinweis, Speichern gesperrt,
 *      die neuere Fassung bleibt; „Neue Fassung laden" übernimmt sie
 *  A3  „Meine Eingaben behalten" erlaubt danach das bewusste Speichern
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { t } from '../i18n';
import { getOfferById, setOfferStoreForTests } from '../services/offer/offerService';
import { persistAll } from '../services/persistenceService';
import { alsInhaber } from '../test/workspaceRoleTestUtils';
import type { Offer } from '../types/offer';
import { AngebotEditorPage } from './AngebotEditorPage';

const OFFER_ID = 'off-fc01a-ang02';

let container: HTMLDivElement;
let root: Root | null = null;

function angebot(title: string): Offer {
  return {
    id: OFFER_ID,
    workspaceId: '',
    status: 'entwurf',
    customer: { name: 'Muster Bau GmbH', contactPerson: '', street: 'Weg 6', zip: '33602', city: 'Bielefeld', email: '', phone: '' },
    title,
    baustelle: 'Weg 6, Bielefeld',
    positions: [{ id: 'offer-pos-1', description: 'Montage', quantity: 2, unit: 'Stunden', unitPrice: 100 }],
    taxStatus: 'standard_19',
    offerDate: '2026-10-11',
    validUntil: '2026-11-10',
    introText: '',
    closingText: '',
    paymentTermsText: '14 Tage netto',
    createdAt: '2026-10-11T08:00:00.000Z',
  };
}

/** Wie ein Abzug: der Speicher bekommt die neuere Fassung, der Editor erfährt es über den Speicherimpuls. */
function abzug(title: string): void {
  act(() => {
    setOfferStoreForTests([angebot(title)]);
    persistAll();
  });
}

function editor(): void {
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/angebote/${OFFER_ID}/bearbeiten`] },
        createElement(
          AppProvider,
          { initialSetup: DEFAULT_SETUP },
          createElement(
            Routes,
            null,
            createElement(Route, { path: '/angebote/:offerId/bearbeiten', element: createElement(AngebotEditorPage) }),
            createElement(Route, { path: '/angebote/:offerId', element: createElement('div', { 'data-testid': 'route-offer-detail' }) }),
          ),
        ),
      ),
    );
  });
}

const el = (id: string) => container.querySelector(`[data-testid="${id}"]`);
function muss(id: string): HTMLElement {
  const found = el(id);
  if (!found) throw new Error(`nicht gefunden: ${id}`);
  return found as HTMLElement;
}
const wert = (id: string) => (muss(id) as HTMLInputElement).value;
function tippe(id: string, value: string): void {
  const input = muss(id) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function klick(id: string): Promise<void> {
  await act(async () => {
    muss(id).click();
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  alsInhaber();
  setOfferStoreForTests([angebot('Erste Fassung')]);
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
});

describe('ANG-02 — Fremdänderung am Angebotsentwurf', () => {
  it('A1: neuere Fassung ohne ungespeicherte Eingaben wird geladen', () => {
    editor();
    expect(wert('offer-title')).toBe('Erste Fassung');
    abzug('Zweite Fassung');
    expect(wert('offer-title')).toBe('Zweite Fassung');
    expect(el('offer-editor-remote-changed')).toBeNull();
  });

  it('A2: bei ungespeicherten Eingaben Hinweis und Speichersperre; nichts wird still überschrieben', async () => {
    editor();
    tippe('offer-title', 'Meine Eingabe');
    abzug('Zweite Fassung');
    expect(el('offer-editor-remote-changed')).not.toBeNull();
    expect(wert('offer-title')).toBe('Meine Eingabe');

    await klick('offer-save');
    expect(muss('offer-editor-error').textContent).toBe(t('orderDraftCloud.remoteChanged.saveBlocked', 'de'));
    expect(getOfferById(OFFER_ID)?.title).toBe('Zweite Fassung');
    expect(el('route-offer-detail')).toBeNull();

    await klick('offer-editor-remote-load');
    expect(wert('offer-title')).toBe('Zweite Fassung');
    expect(el('offer-editor-remote-changed')).toBeNull();
    // Mit der Entscheidung verschwindet auch der Hinweis „erst entscheiden".
    expect(el('offer-editor-error')).toBeNull();
  });

  it('A3: „Meine Eingaben behalten" erlaubt das bewusste Speichern', async () => {
    editor();
    tippe('offer-title', 'Meine Eingabe');
    abzug('Zweite Fassung');
    await klick('offer-editor-remote-keep');
    expect(el('offer-editor-remote-changed')).toBeNull();

    await klick('offer-save');
    expect(getOfferById(OFFER_ID)?.title).toBe('Meine Eingabe');
    expect(el('route-offer-detail')).not.toBeNull();
  });
});
