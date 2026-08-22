/**
 * SCAN-OCR-EVIDENCE-01B3 — der echte Scan-Vorschauweg zeigt den Belegstatus.
 *
 * Kein Test übergibt visibleFacts direkt an den View-Builder: alles läuft über
 * Bild-OCR-Stub → Layout → Fakten → Zuordnungen → Pending Scan → gerenderte Seite.
 * Kein Netzwerk, kein echtes Tesseract, kein Gemini.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { DEFAULT_SETUP } from './data/mockData';
import { ScanPage } from './pages/ScanPage';
import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import { getCustomerStoreSnapshot, hydrateCustomerStore } from './services/customerStoreService';
import { getDocumentStoreSnapshot, hydrateDocumentStore } from './services/documentService';
import { getInboxStoreSnapshot, hydrateInboxStore } from './services/inboxService';
import { getVorgangStoreSnapshot, hydrateVorgangStore } from './services/vorgangService';
import { resetDocumentFileStoreForTests } from './services/documentFileStoreService';
import { resetUploadDraftStoreForTests } from './services/storage/uploadDraftIndexedDbService';
import { setImageOcrExtractorForTests } from './services/ocrDocumentService';
import { setOcrImageRecognizerForTests } from './services/tesseractOcrService';
import * as aiRequestRunner from './services/ai/aiRequestRunner';
import { resetStorageScopeForTests } from './services/storage/storageScopeService';
import { loginAsDefaultAdmin, resetAuthForTests } from './test/authFixtures';
import {
  DOCUMENT_LAYOUT_VERSION,
  type DocumentLayoutPage,
  type DocumentLayoutToken,
} from './types/documentLayout';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };
const OWN_COMPANY = 'Cirmak Haustechnik GmbH';
const CUSTOMER = 'NordWest Dachbau GmbH';

useDocumentBlobDatabaseReset();

type RowSpec = {
  label: string;
  value?: string;
  confidence?: number;
  /** Zwei getrennte Wertgruppen → mehrdeutig. */
  ambiguousValues?: [string, string];
};

/** Baut eine Layoutseite aus Zeilenangaben — wie eine fotografierte Tabelle. */
function layoutFor(rows: RowSpec[], truncated = false): DocumentLayoutPage {
  const tokens: DocumentLayoutToken[] = [];
  const push = (text: string, x: number, y: number, confidence: number, block: string) => {
    tokens.push({
      id: `p1-t${tokens.length}`,
      text,
      x0: x,
      y0: y,
      x1: x + text.length * 0.012,
      y1: y + 0.02,
      confidence,
      blockId: block,
      lineId: `${block}-l${Math.round(y * 1000)}`,
    });
  };

  rows.forEach((row, index) => {
    const y = 0.2 + index * 0.06;
    push(`${row.label}:`, 0.08, y, 93, 'b0');
    if (row.ambiguousValues) {
      push(row.ambiguousValues[0], 0.3, y, 93, 'b1');
      push(row.ambiguousValues[1], 0.6, y, 93, 'b1');
      return;
    }
    if (!row.value) return;
    row.value.split(' ').forEach((word, wordIndex) => {
      push(word, 0.45 + wordIndex * 0.1, y, row.confidence ?? 93, 'b1');
    });
  });

  return {
    version: DOCUMENT_LAYOUT_VERSION,
    pageNumber: 1,
    width: 1200,
    height: 1700,
    truncated,
    tokens,
  };
}

function stubScanOcr(layout: DocumentLayoutPage, text: string): void {
  // Der textbasierte Stub hätte Vorrang und lieferte kein Layout.
  setImageOcrExtractorForTests(null);
  setOcrImageRecognizerForTests(async () => ({ text, confidence: 90, layout }));
}

type Mount = { container: HTMLDivElement; root: Root };

function renderScan(): Mount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={['/scan']}>
        <AuthProvider>
          <AppProvider initialSetup={completeSetup}>
            <Routes>
              <Route path="/scan" element={<ScanPage />} />
              <Route path="/ablage/:id" element={<div data-testid="inbox-detail" />} />
            </Routes>
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function waitFor(predicate: () => boolean, label = 'condition'): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (predicate()) return;
    await settle(1);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

/** Datei über das echte Galerie-Input übergeben und Vorschau abwarten. */
async function scanFile(mount: Mount, marker = 'FOTO'): Promise<void> {
  const input = mount.container.querySelector(
    '[data-testid="scan-gallery-input"]',
  ) as HTMLInputElement;
  expect(input).not.toBeNull();
  const file = new File([new TextEncoder().encode(marker)], `${marker}.jpg`, {
    type: 'image/jpeg',
  });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
  await waitFor(
    () => mount.container.querySelector('[data-testid="ocr-preview-panel"]') !== null,
    'preview rendered',
  );
  await settle(2);
}

function previewText(mount: Mount): string {
  const panel = mount.container.querySelector('[data-testid="ocr-preview-panel"]');
  return (panel?.textContent ?? '').replace(/\s+/g, ' ');
}

function expectNoDomainObjects(): void {
  expect(getInboxStoreSnapshot()).toHaveLength(0);
  expect(getDocumentStoreSnapshot()).toHaveLength(0);
  expect(getVorgangStoreSnapshot()).toHaveLength(0);
  expect(getCustomerStoreSnapshot()).toHaveLength(0);
}

describe('SCAN-OCR-EVIDENCE-01B3 Belegstatus in der echten Scan-Vorschau', () => {
  let mounted: Mount | undefined;

  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    resetStorageScopeForTests();
    resetDocumentFileStoreForTests();
    hydrateInboxStore([]);
    hydrateDocumentStore([]);
    hydrateVorgangStore([]);
    hydrateCustomerStore([]);
    hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: OWN_COMPANY });
    await resetUploadDraftStoreForTests();
    resetAuthForTests();
    await loginAsDefaultAdmin();
    vi.spyOn(aiRequestRunner, 'isAiProviderConfigured').mockReturnValue(false);
  });

  afterEach(() => {
    if (mounted) {
      act(() => mounted!.root.unmount());
      mounted.container.remove();
      mounted = undefined;
    }
    setImageOcrExtractorForTests(null);
    setOcrImageRecognizerForTests(null);
    hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE });
    vi.restoreAllMocks();
    resetDocumentFileStoreForTests();
    localStorage.clear();
  });

  it('A — sicher erkannte Parteien erscheinen mit Wert und Ihr Betrieb', async () => {
    stubScanOcr(
      layoutFor([
        { label: 'Auftraggeber', value: CUSTOMER },
        { label: 'Auftragnehmer', value: OWN_COMPANY },
      ]),
      'Werkvertrag (Bauleistung nach VOB/B)',
    );

    mounted = renderScan();
    await settle();
    await scanFile(mounted);

    const text = previewText(mounted);
    expect(text).toContain(CUSTOMER);
    expect(text).toContain(OWN_COMPANY);
    // „Ihr Betrieb" genau einmal — beim eigenen Betrieb.
    expect(text.match(/Ihr Betrieb/g) ?? []).toHaveLength(1);
    const ownRow = [...mounted.container.querySelectorAll('article')].find((node) =>
      (node.textContent ?? '').includes('Ihr Betrieb'),
    );
    expect(ownRow?.textContent).toContain(OWN_COMPANY);
    expect(ownRow?.textContent).not.toContain(CUSTOMER);
    expectNoDomainObjects();
  });

  it('B — unleserlicher Auftragnehmer zeigt „Nicht sicher erkannt" ohne Namen', async () => {
    stubScanOcr(
      layoutFor([
        { label: 'Auftraggeber', value: CUSTOMER },
        { label: 'Auftragnehmer', value: 'C1rm4k H4ustechn1k', confidence: 18 },
      ]),
      'Werkvertrag (Bauleistung nach VOB/B)',
    );

    mounted = renderScan();
    await settle();
    await scanFile(mounted);

    const text = previewText(mounted);
    expect(text).toContain('Auftragnehmer');
    expect(text).toContain('Nicht sicher erkannt');
    expect(text).not.toContain('C1rm4k');
    // Keine erfundene Partei, keine Own-Company-Markierung.
    expect(text).not.toContain('Ihr Betrieb');
    expectNoDomainObjects();
  });

  it('C — sichtbares Label ohne Wert zeigt „Kein Wert erkannt"', async () => {
    stubScanOcr(
      layoutFor([
        { label: 'Auftraggeber', value: CUSTOMER },
        { label: 'Auftragnehmer' },
      ]),
      'Werkvertrag (Bauleistung nach VOB/B)',
    );

    mounted = renderScan();
    await settle();
    await scanFile(mounted);

    const text = previewText(mounted);
    expect(text).toContain('Auftragnehmer');
    expect(text).toContain('Kein Wert erkannt');
    expect(text).not.toContain('Nur teilweise prüfbar');
  });

  it('D — gekapptes Layout zeigt „Nur teilweise prüfbar", nicht „Kein Wert erkannt"', async () => {
    stubScanOcr(
      layoutFor(
        [{ label: 'Auftraggeber', value: CUSTOMER }, { label: 'Auftragnehmer' }],
        true,
      ),
      'Werkvertrag (Bauleistung nach VOB/B)',
    );

    mounted = renderScan();
    await settle();
    await scanFile(mounted);

    const text = previewText(mounted);
    expect(text).toContain('Nur teilweise prüfbar');
    expect(text).not.toContain('Kein Wert erkannt');
  });

  it('E — mehrdeutiger Wert zeigt den Prüfhinweis', async () => {
    stubScanOcr(
      layoutFor([
        { label: 'Auftraggeber', value: CUSTOMER },
        { label: 'Auftragnehmer', ambiguousValues: ['Alpha', 'Beta'] },
      ]),
      'Werkvertrag (Bauleistung nach VOB/B)',
    );

    mounted = renderScan();
    await settle();
    await scanFile(mounted);

    const text = previewText(mounted);
    expect(text).toContain('Mehrdeutige Angabe');
    expect(text).not.toContain('Ihr Betrieb');
  });

  it('F — KI-Vorschlag ist sichtbar, füllt aber keine Partei', async () => {
    stubScanOcr(
      layoutFor([
        { label: 'Auftraggeber', value: CUSTOMER },
        { label: 'Vertragspartner', value: OWN_COMPANY },
      ]),
      'Werkvertrag (Bauleistung nach VOB/B)',
    );
    vi.spyOn(aiRequestRunner, 'isAiProviderConfigured').mockReturnValue(true);
    vi.spyOn(aiRequestRunner, 'runAiRequest').mockResolvedValue({
      success: true,
      source: 'ai',
      // Das Modell ordnet „Vertragspartner" dem Auftragnehmer zu.
      text: '{"assignments":[{"factId":"f1-1","fieldKey":"auftragnehmer"}]}',
    });

    mounted = renderScan();
    await settle();
    await scanFile(mounted);

    const text = previewText(mounted);
    expect(text).toContain('KI-Vorschlag');
    // Der belegte Text ist sichtbar, aber nicht als bestätigte Partei.
    expect(text).toContain(OWN_COMPANY);
    expect(text).not.toContain('Ihr Betrieb');
    expectNoDomainObjects();
  });

  it('G — allgemeiner Rechnungsfall: unleserliche Rechnungsnummer', async () => {
    stubScanOcr(
      layoutFor([
        { label: 'Rechnungsnummer', value: 'RE-2026-0042', confidence: 15 },
        { label: 'Rechnungsdatum', value: '04.05.2026' },
        { label: 'Auftraggeber', value: CUSTOMER },
      ]),
      'Rechnung Werkvertrag (Bauleistung nach VOB/B)',
    );

    mounted = renderScan();
    await settle();
    await scanFile(mounted);

    // Der Statushinweis erscheint auch außerhalb der Vertragsparteien.
    const text = previewText(mounted);
    expect(text).toContain('Nicht sicher erkannt');
    expect(text).not.toContain('RE-2026-0042');
    expectNoDomainObjects();
  });
});
