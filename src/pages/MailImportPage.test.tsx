import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { MailImportPage } from './MailImportPage';
import { MehrPage } from './MehrPage';

describe('MailImportPage', () => {
  it('Importformular rendert', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <MailImportPage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="mail-import-page"');
    expect(html).toContain('data-testid="mail-import-form"');
    expect(html).toContain('data-testid="mail-import-from"');
    expect(html).toContain('data-testid="mail-import-subject"');
    expect(html).toContain('data-testid="mail-import-body"');
    expect(html).toContain('data-testid="mail-import-submit"');
    expect(html).toContain('E-Mail übernehmen');
  });
});

describe('MehrPage mail import link', () => {
  it('zeigt Link zu E-Mails importieren', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <MehrPage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('E-Mails importieren');
    expect(html).toContain('/mail-import');
  });
});
