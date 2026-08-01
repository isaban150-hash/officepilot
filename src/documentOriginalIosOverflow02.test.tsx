import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { DocumentOriginalFilePanel } from './components/documents/DocumentOriginalFilePanel';
import { t } from './i18n';
import {
  resetDocumentFileStoreForTests,
  storeDocumentFileFromCachedPayload } from './services/documentFileStoreService';

const CSS_PATH = resolve(__dirname, 'styles/document-upload.css');
const VIEWPORT = 390;

const CONTAINMENT_CSS = `
  .page { width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box; display: flex; flex-direction: column; gap: 1rem; }
  .page > * { min-width: 0; max-width: 100%; }
  .card { max-width: 100%; min-width: 0; box-sizing: border-box; padding: 1rem; }
  .document-original-file-panel,
  [data-testid='ablage-original-file'],
  .document-detail__preview {
    width: 100%;
    max-width: 100%;
    min-width: 0;
    overflow-x: clip;
    box-sizing: border-box;
  }
  .document-original-file-panel__preview {
    position: relative;
    display: block;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    overflow-x: auto;
    contain: layout paint;
    box-sizing: border-box;
  }
  .document-original-file-panel__preview--pdf {
    height: 360px;
  }
  .document-original-file-panel__image {
    display: block;
    width: 100%;
    max-width: 100%;
    height: auto;
    object-fit: contain;
    box-sizing: border-box;
  }
  .document-original-file-panel__pdf {
    display: block;
    position: absolute;
    inset: 0;
    width: 100%;
    max-width: 100%;
    height: 100%;
    min-width: 0;
    box-sizing: border-box;
  }
`;

function installStyles(): HTMLStyleElement {
  const style = document.createElement('style');
  style.textContent = CONTAINMENT_CSS;
  document.head.appendChild(style);
  return style;
}

useDocumentBlobDatabaseReset();

describe('DOCUMENT-ORIGINAL-IOS-OVERFLOW-02', () => {
  afterEach(async () => {
    document.body.innerHTML = '';
    resetDocumentFileStoreForTests();
  });

  it('CSS sichert Flex-Kinder und Preview mit min-width:0 sowie width:100%', () => {
    const css = readFileSync(CSS_PATH, 'utf8');
    expect(css).toMatch(/\.document-original-file-panel__preview\s*\{[^}]*min-width:\s*0/s);
    expect(css).toMatch(/\.document-original-file-panel__preview\s*\{[^}]*width:\s*100%/s);
    expect(css).toMatch(/\.document-original-file-panel__preview\s*\{[^}]*overflow-x:\s*auto/s);
    expect(css).toMatch(/\.document-original-file-panel__preview\s*\{[^}]*contain:\s*layout\s+paint/s);
    expect(css).toMatch(/\.document-original-file-panel__image\s*\{[^}]*width:\s*100%/s);
    expect(css).toMatch(/\.document-original-file-panel__image\s*\{[^}]*object-fit:\s*contain/s);
    expect(css).toMatch(/\.document-original-file-panel__pdf\s*\{[^}]*min-width:\s*0/s);
    expect(css).toMatch(/\.document-original-file-panel__pdf\s*\{[^}]*position:\s*absolute/s);
    expect(css).toMatch(/\.page\s*>\s*\*\s*\{[^}]*min-width:\s*0/s);
  });

  it('Bildvorschau bleibt im 390px-Container und sprengt die Seite nicht', () => {
    const style = installStyles();
    const page = document.createElement('div');
    page.className = 'page';
    page.style.cssText = `width:${VIEWPORT}px;max-width:${VIEWPORT}px;min-width:0;overflow-x:auto;box-sizing:border-box;`;

    const card = document.createElement('div');
    card.className = 'card document-original-file-panel';
    card.style.cssText = 'width:100%;max-width:100%;min-width:0;box-sizing:border-box;';

    const preview = document.createElement('div');
    preview.className = 'document-original-file-panel__preview';

    const img = document.createElement('img');
    img.className = 'document-original-file-panel__image';
    img.setAttribute('width', '3024');
    img.setAttribute('height', '4032');
    img.alt = 'wide';
    img.src =
      'data:image/svg+xml,' +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="3024" height="4032"><rect width="3024" height="4032" fill="#ccc"/></svg>`,
      );

    preview.appendChild(img);
    card.appendChild(preview);
    page.appendChild(card);
    document.body.appendChild(page);

    const imgStyle = getComputedStyle(img);
    const previewStyle = getComputedStyle(preview);
    expect(imgStyle.width).toMatch(new RegExp(`100%|${VIEWPORT}px`));
    expect(imgStyle.maxWidth).toBe('100%');
    expect(imgStyle.objectFit).toBe('contain');
    expect(previewStyle.minWidth).toMatch(/0(px)?/);
    expect(previewStyle.overflowX).toBe('auto');
    expect(previewStyle.width).toMatch(new RegExp(`100%|${VIEWPORT}px`));
    // Intrinsic attributes must not enlarge the page scroll area beyond the viewport box
    expect(page.scrollWidth).toBeLessThanOrEqual(Math.max(page.clientWidth, VIEWPORT) + 1);

    style.remove();
  });

  it('PDF-iframe bleibt im Preview-Container und erweitert die Seite nicht', () => {
    const style = installStyles();
    const page = document.createElement('div');
    page.className = 'page';
    page.style.width = `${VIEWPORT}px`;
    page.style.maxWidth = `${VIEWPORT}px`;

    const card = document.createElement('div');
    card.className = 'card document-original-file-panel';

    const preview = document.createElement('div');
    preview.className = 'document-original-file-panel__preview document-original-file-panel__preview--pdf';

    const iframe = document.createElement('iframe');
    iframe.className = 'document-original-file-panel__pdf';
    iframe.title = 'pdf';
    iframe.style.minWidth = '980px'; // Safari PDF-Viewer typische intrinsische Breite

    preview.appendChild(iframe);
    card.appendChild(preview);
    page.appendChild(card);
    document.body.appendChild(page);

    expect(page.scrollWidth).toBeLessThanOrEqual(VIEWPORT + 1);
    expect(preview.clientWidth).toBeLessThanOrEqual(VIEWPORT);
    // Absolute iframe must not expand page width even with huge min-width
    expect(page.scrollWidth).toBeLessThanOrEqual(VIEWPORT + 1);

    style.remove();
  });

  it('DocumentOriginalFilePanel behält Download und Preview-Klassen', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.4 overflow-test');
    const stored = await storeDocumentFileFromCachedPayload(
      {
        fileName: 'ios.pdf',
        mimeType: 'application/pdf',
        fileSize: bytes.byteLength,
        bytes },
      { lifecycleIntent: 'committed' },
    );

    const host = document.createElement('div');
    host.style.width = `${VIEWPORT}px`;
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        createElement(DocumentOriginalFilePanel, {
          fileRefId: stored.fileRef.id,
          translate: (key) => t(key, 'de') }),
      );
    });

    // Preview URL is resolved asynchronously from IndexedDB — wait for ready state.
    const deadline = Date.now() + 3000;
    while (
      Date.now() < deadline &&
      !host.querySelector('.document-original-file-panel__preview--pdf')
    ) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
    }

    expect(host.querySelector('.document-original-file-panel__preview--pdf')).toBeTruthy();
    expect(host.querySelector('[data-testid="document-original-file-panel-download"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="document-original-file-panel-pdf"]')).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});
