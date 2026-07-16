import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { HeutePage } from './pages/HeutePage';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { createMockInboxItemFromUpload } from './services/inboxUploadFactory';
import { hydrateInboxStore } from './services/inboxService';
import { processUploadedDocument } from './services/intakeWorkflowService';
import { resetTestStores } from './test/resetStores';

const INDEX_CSS = resolve(__dirname, 'index.css');
const SHELL_CSS = resolve(__dirname, 'styles/shell.css');
const UPLOAD_CSS = resolve(__dirname, 'styles/document-upload.css');

function extractRuleBodies(css: string, selector: string): string[] {
  const rules: string[] = [];
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(css)) !== null) {
    rules.push(match[1]);
  }
  return rules;
}

function mockViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
}

function dispatchVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => state === 'hidden',
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('FIX-SAFARI-RESUME-DVH-01', () => {
  beforeEach(() => {
    mockViewport(390);
  });

  afterEach(() => {
    mockViewport(1024);
    resetTestStores();
    document.body.innerHTML = '';
  });

  it('app-shell hat keine feste height: 100dvh, aber min-height Fallback', () => {
    const css = readFileSync(INDEX_CSS, 'utf8');
    const shellBodies = extractRuleBodies(css, '.app-shell');
    expect(shellBodies.length).toBeGreaterThan(0);
    const primary = shellBodies[0];
    expect(primary).not.toMatch(/(?:^|[^-])height:\s*100dvh/);
    expect(primary).toMatch(/min-height:\s*100vh/);
    expect(primary).toMatch(/min-height:\s*100dvh/);
  });

  it('app-shell__main behält overflow-x: hidden ohne clip', () => {
    for (const path of [INDEX_CSS, SHELL_CSS, UPLOAD_CSS]) {
      const css = readFileSync(path, 'utf8');
      for (const body of extractRuleBodies(css, '.app-shell__main')) {
        expect(body, path).not.toMatch(/overflow-x:\s*clip/);
      }
    }
    const indexMain = extractRuleBodies(readFileSync(INDEX_CSS, 'utf8'), '.app-shell__main').join('\n');
    expect(indexMain).toMatch(/overflow-x:\s*hidden/);
    expect(indexMain).toMatch(/overflow-y:\s*auto/);
  });

  it('Dokumentvorschau behält preview containment', () => {
    const css = readFileSync(UPLOAD_CSS, 'utf8');
    expect(css).toMatch(/\.document-original-file-panel[\s\S]*?overflow-x:\s*clip/);
    expect(css).not.toMatch(/\.app-shell__main\s*\{[^}]*overflow-x:\s*clip/s);
  });

  it('visibilitychange hidden→visible löscht keinen Page-DOM', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const main = document.createElement('main');
    main.className = 'app-shell__main';
    host.appendChild(main);

    const item = createMockInboxItemFromUpload({
      sourceFileName: 'resume.pdf',
      recognizedText: 'Eingangsrechnung RE-22 Lieferant Holz AG 110,00 EUR',
      kind: 'materialrechnung',
    });
    hydrateInboxStore([item]);
    processUploadedDocument(item.id);

    const mount = (entry: string, element: ReturnType<typeof createElement>) => {
      const root = createRoot(main);
      act(() => {
        root.render(
          createElement(
            MemoryRouter,
            { initialEntries: [entry] },
            createElement(AppProvider, { initialSetup: DEFAULT_SETUP }, element),
          ),
        );
      });
      return root;
    };

    let root = mount('/', createElement(HeutePage));
    expect(main.querySelector('[data-testid="heute-page"]')).not.toBeNull();
    expect(main.querySelector('[data-testid="mobile-first-home"]')).not.toBeNull();
    const heuteMarkup = main.innerHTML;
    expect(heuteMarkup.length).toBeGreaterThan(100);

    act(() => {
      dispatchVisibility('hidden');
      dispatchVisibility('visible');
      window.dispatchEvent(new Event('pageshow'));
    });

    expect(main.querySelector('[data-testid="heute-page"]')).not.toBeNull();
    expect(main.innerHTML).toBe(heuteMarkup);

    act(() => {
      root.unmount();
    });

    root = mount(
      `/ablage/${item.id}`,
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: '/ablage/:id',
          element: createElement(EingangDetailPage),
        }),
      ),
    );

    expect(main.querySelector('[data-testid="ablage-detail-page"]')).not.toBeNull();
    expect(main.querySelector('[data-testid="document-assistant-panel"]')).not.toBeNull();
    const detailMarkup = main.innerHTML;

    act(() => {
      dispatchVisibility('hidden');
      dispatchVisibility('visible');
      window.dispatchEvent(new Event('pageshow'));
    });

    expect(main.querySelector('[data-testid="ablage-detail-page"]')).not.toBeNull();
    expect(main.innerHTML).toBe(detailMarkup);

    act(() => {
      root.unmount();
    });
  });
});
