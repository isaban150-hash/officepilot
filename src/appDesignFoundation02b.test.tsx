import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { t } from './i18n';
import { AusgabenPage } from './pages/AusgabenPage';
import { DokumentePage } from './pages/DokumentePage';

function renderDokumente() {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={['/dokumente']}>
      <AppProvider initialSetup={DEFAULT_SETUP}>
        <DokumentePage />
      </AppProvider>
    </MemoryRouter>,
  );
}

function renderAusgaben() {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={['/ausgaben']}>
      <AppProvider initialSetup={DEFAULT_SETUP}>
        <AusgabenPage />
      </AppProvider>
    </MemoryRouter>,
  );
}

function getHeaderActionsHtml(html: string): string {
  const match = html.match(/<header class="page-header"[^>]*>[\s\S]*?<\/header>/);
  expect(match).not.toBeNull();
  const header = match![0];
  expect(header).toContain('page-header__actions');
  return header;
}

describe('APP-DESIGN-FOUNDATION-02B PageHeader action slots', () => {
  it('DokumentePage: Aktionen liegen im PageHeader, separater Block entfällt', () => {
    const html = renderDokumente();
    const header = getHeaderActionsHtml(html);

    expect(header).toContain(t('document.title', 'de'));
    expect(header).toContain(t('document.subtitle', 'de'));

    const uploadLink = header.match(
      /<a[^>]*href="\/dokumente\/upload"[^>]*>[\s\S]*?<\/a>/,
    );
    const addLink = header.match(/<a[^>]*href="\/dokumente\/neu"[^>]*>[\s\S]*?<\/a>/);
    expect(uploadLink).not.toBeNull();
    expect(addLink).not.toBeNull();
    expect(uploadLink![0]).toContain('document-upload-link');
    expect(uploadLink![0]).toContain('btn--primary');
    expect(uploadLink![0]).toContain(t('document.upload.action', 'de'));
    expect(addLink![0]).toContain('btn--outline');
    expect(addLink![0]).toContain(t('document.add', 'de'));

    const outsideHeader = html.replace(header, '');
    expect(outsideHeader).not.toContain('page-header__actions');
    expect(html).not.toContain('page-header__actions--row');
    expect(html.match(/page-header__actions/g)).toHaveLength(1);
    expect(html.match(/data-testid="document-upload-link"/g)).toHaveLength(1);

    expect(html).toContain('data-testid="document-area-chips"');
    expect(html).toContain('document-search');
  });

  it('AusgabenPage: Aktionen liegen im PageHeader, separater Block entfällt', () => {
    const html = renderAusgaben();
    const header = getHeaderActionsHtml(html);

    expect(header).toContain(t('expense.title', 'de'));
    expect(header).toContain(t('expense.subtitle', 'de'));

    const addLink = header.match(/<a[^>]*href="\/ausgaben\/neu"[^>]*>[\s\S]*?<\/a>/);
    const openLink = header.match(/<a[^>]*href="\/ausgaben\/offen"[^>]*>[\s\S]*?<\/a>/);
    expect(addLink).not.toBeNull();
    expect(openLink).not.toBeNull();
    expect(addLink![0]).toContain('btn--primary');
    expect(addLink![0]).toContain(t('expense.add', 'de'));
    expect(openLink![0]).toContain('btn--outline');
    expect(openLink![0]).toContain(t('expense.openLiabilities', 'de'));

    const outsideHeader = html.replace(header, '');
    expect(outsideHeader).not.toContain('page-header__actions');
    expect(outsideHeader).not.toContain('href="/ausgaben/neu"');
    expect(outsideHeader).not.toContain('href="/ausgaben/offen"');
    expect(html.match(/page-header__actions/g)).toHaveLength(1);

    expect(html).toContain('expense-summary-card');
    expect(html).toContain('document-search');
    expect(html).toContain('document-categories');
  });

  it('keine doppelten Header-Aktionsbuttons auf beiden Seiten', () => {
    const dokumente = renderDokumente();
    expect(dokumente.match(/page-header__actions/g)).toHaveLength(1);
    expect(dokumente.match(/data-testid="document-upload-link"/g)).toHaveLength(1);

    const ausgaben = renderAusgaben();
    expect(ausgaben.match(/page-header__actions/g)).toHaveLength(1);
    expect(ausgaben.match(/href="\/ausgaben\/neu"/g)).toHaveLength(1);
    expect(ausgaben.match(/href="\/ausgaben\/offen"/g)).toHaveLength(1);
  });
});
