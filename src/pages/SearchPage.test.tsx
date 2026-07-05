import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { SearchPage } from './SearchPage';

describe('SearchPage', () => {
  it('rendert die globale Suchseite', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/suche?q=Finanzamt']}>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <SearchPage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="search-page"');
    expect(html).toContain('data-testid="global-search-input"');
    expect(html).toContain('OfficePilot durchsuchen');
  });
});
