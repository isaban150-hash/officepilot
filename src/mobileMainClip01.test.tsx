import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { HeutePage } from './pages/HeutePage';
import { EingangPage } from './pages/EingangPage';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { createMockInboxItemFromUpload } from './services/inboxUploadFactory';
import { hydrateInboxStore } from './services/inboxService';
import { processUploadedDocument } from './services/intakeWorkflowService';
import { resetTestStores } from './test/resetStores';

const INDEX_CSS = resolve(__dirname, 'index.css');
const SHELL_CSS = resolve(__dirname, 'styles/shell.css');
const UPLOAD_CSS = resolve(__dirname, 'styles/document-upload.css');

function mockViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
  window.matchMedia = ((query: string) => {
    const maxWidthMatch = /max-width:\s*(\d+)px/.exec(query);
    const matches = maxWidthMatch ? width <= Number(maxWidthMatch[1]) : false;
    return {
      matches,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    };
  }) as typeof window.matchMedia;
}

function extractAppShellMainRules(css: string): string[] {
  const rules: string[] = [];
  const re = /\.app-shell__main\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css)) !== null) {
    rules.push(match[1]);
  }
  return rules;
}

describe('FIX-MOBILE-MAIN-CLIP-01', () => {
  beforeEach(() => {
    mockViewport(390);
  });

  afterEach(() => {
    mockViewport(1024);
    resetTestStores();
  });

  it('app-shell__main nutzt kein overflow-x: clip mehr', () => {
    for (const path of [INDEX_CSS, SHELL_CSS, UPLOAD_CSS]) {
      const css = readFileSync(path, 'utf8');
      for (const body of extractAppShellMainRules(css)) {
        expect(body, path).not.toMatch(/overflow-x:\s*clip/);
      }
    }

    const indexMain = extractAppShellMainRules(readFileSync(INDEX_CSS, 'utf8')).join('\n');
    expect(indexMain).toMatch(/overflow-x:\s*hidden/);
    expect(indexMain).toMatch(/overflow-y:\s*auto/);
    expect(indexMain).toMatch(/min-height:\s*0/);

    const shellMain = extractAppShellMainRules(readFileSync(SHELL_CSS, 'utf8')).join('\n');
    expect(shellMain).toMatch(/overflow-x:\s*hidden/);
    expect(shellMain).toMatch(/overflow-y:\s*auto/);
  });

  it('Dokumentvorschau behält Overflow-Containment mit clip', () => {
    const css = readFileSync(UPLOAD_CSS, 'utf8');
    expect(css).toMatch(
      /\.document-original-file-panel[\s\S]*?overflow-x:\s*clip/,
    );
    expect(css).toMatch(/\.document-original-file-panel__preview\s*\{[^}]*overflow-x:\s*auto/s);
    expect(css).not.toMatch(/\.app-shell__main\s*\{[^}]*overflow-x:\s*clip/s);
  });

  it('Mobile Viewport: Schreibtisch, Eingang und Detail rendern Inhalt', () => {
    const heute = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <HeutePage />
        </AppProvider>
      </MemoryRouter>,
    );
    expect(heute).toContain('data-testid="heute-page"');
    expect(heute).toContain('data-testid="mobile-first-home"');
    expect(heute).toContain('data-testid="desk-priorities"');

    const item = createMockInboxItemFromUpload({
      sourceFileName: 'clip-fix.pdf',
      recognizedText: 'Eingangsrechnung RE-11 Lieferant Bau AG 90,00 EUR',
      kind: 'materialrechnung',
    });
    hydrateInboxStore([item]);
    processUploadedDocument(item.id);

    const ablage = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <EingangPage />
        </AppProvider>
      </MemoryRouter>,
    );
    expect(ablage).toContain('data-testid="ablage-page"');
    expect(ablage).toContain('data-testid="eingang-list"');

    const detail = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/ablage/${item.id}`]}>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <Routes>
            <Route path="/ablage/:id" element={<EingangDetailPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
    expect(detail).toContain('data-testid="ablage-detail-page"');
    expect(detail).toContain('data-testid="document-assistant-panel"');
    expect(detail).toContain('data-testid="document-review-experience"');
  });
});
