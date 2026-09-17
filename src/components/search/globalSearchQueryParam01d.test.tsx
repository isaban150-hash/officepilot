import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { DEFAULT_SETUP } from '../../data/mockData';
import { TestProviders } from '../../test/testProviders';
import { GlobalSearchBar } from './GlobalSearchBar';

/**
 * VISUAL-POLISH-01D — `?q=` gehört der Kopfzeilensuche nur auf `/suche`.
 *
 * Der Assistent nutzt denselben Parameter für seine Frage (`/assistent?q=…`).
 * Vorher übernahm die Kopfzeilensuche ihn auf jeder Route, füllte ihr Feld und
 * legte ihre Vorschau über die Assistentenseite.
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
