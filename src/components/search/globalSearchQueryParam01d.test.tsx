import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { DEFAULT_SETUP } from '../../data/mockData';
import { TestProviders } from '../../test/testProviders';
import { createTestVorgang } from '../../test/fixtures';
import { hydrateVorgangStore } from '../../services/vorgangService';
import { AppShell } from '../layout/AppShell';
import { GlobalSearchBar, SearchPage } from './GlobalSearchBar';

/**
 * VISUAL-POLISH-01D — `?q=` gehört der Kopfzeilensuche nur auf `/suche`.
 *
 * Der Assistent nutzt denselben Parameter für seine Frage (`/assistent?q=…`).
 * Vorher übernahm die Kopfzeilensuche ihn auf jeder Route, füllte ihr Feld und
 * legte ihre Vorschau über die Assistentenseite.
 *
 * PRODUCT-ACCEPTANCE-FIX-01B (F-04) — die Vorschau ist eine Eingabehilfe: sie
 * öffnet beim Tippen, schließt mit Enter/Auswahl/Routenwechsel; auf `/suche`
 * gibt es genau einen Suchzustand (Seitensuche + Trefferliste, keine
 * Kopfzeilensuche, keine zweite Vorschau).
 */
function renderBar(route: string) {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [route] },
      createElement(
        TestProviders,
        { initialSetup: DEFAULT_SETUP },
        createElement(GlobalSearchBar, { compact: true }),
      ),
    ),
  );
}

function LocationProbe() {
  const location = useLocation();
  return createElement('span', { 'data-testid': 'location-probe' }, location.pathname + location.search);
}

let root: Root | null = null;
let container: HTMLElement | null = null;

function mountShell(route: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(
        MemoryRouter,
        { initialEntries: [route] },
        createElement(
          TestProviders,
          { initialSetup: DEFAULT_SETUP },
          createElement(
            Routes,
            null,
            createElement(
              Route,
              { element: createElement(AppShell) },
              createElement(Route, { path: '/', element: createElement(LocationProbe) }),
              createElement(Route, { path: '/dokumente', element: createElement(LocationProbe) }),
              createElement(Route, { path: '/suche', element: createElement(SearchPage) }),
            ),
          ),
        ),
      ),
    );
  });
  return container;
}

function q(id: string) {
  return container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

describe('VISUAL-POLISH-01D — Kopfzeilensuche und ?q=', () => {
  it('/assistent?q=… füllt die Suche nicht und öffnet keine Vorschau', () => {
    const html = renderBar('/assistent?q=' + encodeURIComponent('Was soll ich heute erledigen?'));
    expect(html).toContain('data-testid="global-search-input"');
    expect(html).toContain('value=""');
    expect(html).not.toContain('Was soll ich heute erledigen?');
    expect(html).not.toContain('data-testid="global-search-preview"');
  });

  it('/suche?q=… übernimmt die Frage weiterhin in die Suchleiste', () => {
    const html = renderBar('/suche?q=Finanzamt');
    expect(html).toContain('value="Finanzamt"');
  });

  it('normale Kopfzeilensuche ohne Parameter bleibt leer und ohne Vorschau', () => {
    const html = renderBar('/dokumente');
    expect(html).toContain('data-testid="global-search-input"');
    expect(html).toContain('value=""');
    expect(html).not.toContain('data-testid="global-search-preview"');
  });
});

describe('PRODUCT-ACCEPTANCE-FIX-01B (F-04) — ein Suchzustand', () => {
  it('Tippen öffnet die Vorschau, Enter führt zu /suche?q= und schließt sie; die Suchseite hat keine Kopfzeilensuche und keine zweite Vorschau', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-search-1', title: 'Badumbau', customer: 'Müller Bau GmbH' })]);
    mountShell('/dokumente');

    const headerInput = q('global-search-input') as HTMLInputElement;
    expect(headerInput).not.toBeNull();
    typeInto(headerInput, 'Müller');
    expect(q('global-search-preview'), 'Vorschau beim Tippen').not.toBeNull();

    act(() => {
      headerInput.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(q('search-page'), 'Suchseite erreicht').not.toBeNull();
    expect(q('search-page-results')?.textContent ?? '').toContain('Müller');
    expect(q('app-shell-search'), 'Kopfzeilensuche auf /suche').toBeNull();
    expect(q('global-search-preview'), 'keine Vorschau über der Ergebnisseite').toBeNull();
    const pageInput = q('search-page-bar')!.querySelector('[data-testid="global-search-input"]') as HTMLInputElement;
    expect(pageInput.value).toBe('Müller');
    expect(container!.querySelectorAll('[data-testid="global-search-input"]')).toHaveLength(1);
  });

  it('Seitensuche auf /suche zeigt beim Tippen keine zweite Vorschau', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-search-2', title: 'Badumbau', customer: 'Müller Bau GmbH' })]);
    mountShell('/suche?q=Bad');
    const pageInput = q('global-search-input') as HTMLInputElement;
    typeInto(pageInput, 'Müll');
    expect(q('global-search-preview')).toBeNull();
    expect(q('search-page-results')).not.toBeNull();
  });

  it('außerhalb von /suche: Vorschau öffnet beim Tippen und schließt beim Routenwechsel', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-search-3', title: 'Badumbau', customer: 'Müller Bau GmbH' })]);
    mountShell('/');
    const headerInput = q('global-search-input') as HTMLInputElement;
    typeInto(headerInput, 'Müller');
    expect(q('global-search-preview')).not.toBeNull();
    const link = container!.querySelector('[data-testid="sidebar-nav"] a[href="/dokumente"]') as HTMLAnchorElement;
    act(() => {
      link.click();
    });
    expect(q('location-probe')?.textContent).toBe('/dokumente');
    expect(q('global-search-preview'), 'Vorschau nach Routenwechsel').toBeNull();
  });
});
