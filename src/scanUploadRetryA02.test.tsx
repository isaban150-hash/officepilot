/**
 * P1-KORREKTURBLOCK A-02 — Dateiauswahl nach einem Erfassungsfehler.
 *
 * Befund (WEISS, SCHWARZ-Rundgang S2–S5): Nach „Kein lesbarer Text“ öffneten „Andere Datei auswählen“, „Erneut
 * versuchen“ und „Neues Foto aufnehmen“ die Dateiauswahl über das Eingabefeld der Fehleransicht. Im selben Handler
 * wurde der Fehler zurückgesetzt; die Ausgangsansicht hängte das Feld an anderer Stelle neu ein. Die gewählte Datei
 * landete am ausgehängten Feld und ging still verloren — die Seite stand wieder am Erfassungsanfang.
 *
 * Geprüft wird an beiden Erfassungsseiten (Scan und Upload): Das geklickte Feld ist beim Wählen noch im Dokument, die
 * neue Datei wird verarbeitet und erzeugt genau eine Vorschau; Abbrechen lässt die Fehleransicht stehen; wiederholte
 * Fehler verlieren die nächste Auswahl nicht; ohne Entscheidung wird nichts abgelegt.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { DEFAULT_SETUP } from './data/mockData';
import { ScanPage } from './pages/ScanPage';
import { DocumentUploadPage } from './pages/DocumentUploadPage';
import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';
import { resetDocumentFileStoreForTests } from './services/documentFileStoreService';
import { getDocumentStoreSnapshot, hydrateDocumentStore } from './services/documentService';
import { getInboxStoreSnapshot, hydrateInboxStore } from './services/inboxService';
import { hydrateVorgangStore } from './services/vorgangService';
import { hydrateCustomerStore } from './services/customerStoreService';
import { setOcrImageRecognizerForTests } from './services/tesseractOcrService';
import { setImageOcrExtractorForTests } from './services/ocrDocumentService';
import {
  listUploadDraftRecordsForActiveScope,
  resetUploadDraftStoreForTests,
} from './services/storage/uploadDraftIndexedDbService';
import { clearUiSessionSnapshot } from './services/uiSession/uiSessionStore';
import { resetUiSessionLiveState } from './services/uiSession/uiSessionLiveState';
import { resetStorageScopeForTests } from './services/storage/storageScopeService';
import { loginAsDefaultAdmin, resetAuthForTests } from './test/authFixtures';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };

useDocumentBlobDatabaseReset();

/** „leer…“ hat keinen lesbaren Text (→ „Kein lesbarer Text“), alles andere schon. */
function fileOf(marker: string): File {
  return new File([new TextEncoder().encode(marker)], `${marker}.jpg`, { type: 'image/jpeg' });
}

interface Mount {
  container: HTMLDivElement;
  root: Root;
}

function render(path: '/scan' | '/dokumente/upload'): Mount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <AppProvider initialSetup={completeSetup}>
            <div className="app-shell__main">
              <Routes>
                <Route path="/scan" element={<ScanPage />} />
                <Route path="/dokumente/upload" element={<DocumentUploadPage />} />
                <Route path="/ablage/:id" element={<div data-testid="inbox-detail" />} />
                <Route path="/dokumente/:id" element={<div data-testid="document-detail" />} />
              </Routes>
            </div>
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

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return;
    await settle(1);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

const q = (root: ParentNode, id: string) => root.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const errorVisible = (m: Mount) => q(m.container, 'document-upload-error-panel') !== null;
const previewCount = (m: Mount) => m.container.querySelectorAll('[data-testid="ocr-preview-panel"]').length;

/** Eine Datei an genau dieses Feld geben — so, wie der Browser es nach der Auswahl tut. */
async function choose(input: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}

/** Klicks auf Dateifelder mitschneiden (jsdom öffnet keinen Dialog). */
function recordFileInputClicks(): HTMLInputElement[] {
  const clicked: HTMLInputElement[] = [];
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
    if (this.type === 'file') clicked.push(this);
  });
  return clicked;
}

/** Die Fehleransicht über das jeweilige Startfeld herbeiführen. */
async function produceError(m: Mount, startInputId: string): Promise<void> {
  await choose(q(m.container, startInputId) as HTMLInputElement, fileOf('leer-1'));
  await waitFor(() => errorVisible(m), 'Fehleransicht');
}

const PAGES = [
  { name: 'Scan', path: '/scan' as const, startInput: 'scan-gallery-input' },
  { name: 'Upload', path: '/dokumente/upload' as const, startInput: 'document-upload-input' },
];

describe('P1 A-02 — erneute Dateiauswahl nach einem Erfassungsfehler', { timeout: 30_000 }, () => {
  let mounted: Mount | undefined;

  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    resetStorageScopeForTests();
    resetUiSessionLiveState();
    clearUiSessionSnapshot();
    resetDocumentFileStoreForTests();
    hydrateInboxStore([]);
    hydrateDocumentStore([]);
    hydrateVorgangStore([]);
    hydrateCustomerStore([]);
    await resetUploadDraftStoreForTests();
    resetAuthForTests();
    await loginAsDefaultAdmin();
    setImageOcrExtractorForTests(async (file) =>
      /leer/.test((file as File).name ?? '') ? { text: '', confidence: 0 } : { text: 'Rechnung 4711 Baustoffe Nord 119,00 EUR', confidence: 88 },
    );
  });

  afterEach(() => {
    if (mounted) {
      act(() => mounted!.root.unmount());
      mounted.container.remove();
      mounted = undefined;
    }
    setImageOcrExtractorForTests(null);
    setOcrImageRecognizerForTests(null);
    vi.restoreAllMocks();
    resetUiSessionLiveState();
    clearUiSessionSnapshot();
  });

  for (const page of PAGES) {
    for (const [knopf, label] of [['document-error-select-file', 'Andere Datei auswählen'], ['document-error-retry', 'Erneut versuchen']] as const) {
      it(`${page.name}: „${label}“ nach „Kein lesbarer Text“ — die neue Datei wird verarbeitet, genau eine Vorschau`, async () => {
        mounted = render(page.path);
        await settle();
        await produceError(mounted, page.startInput);
        const clicked = recordFileInputClicks();
        await act(async () => {
          (q(mounted!.container, knopf) as HTMLButtonElement).click();
        });
        await settle(2);
        expect(clicked, 'kein Dateifeld geöffnet').toHaveLength(1);
        // Kernbefund: Das Feld, an dem der Browser die Auswahl abliefert, muss noch im Dokument hängen.
        expect(clicked[0].isConnected, 'Dateifeld wurde beim Öffnen ausgehängt').toBe(true);
        await choose(clicked[0], fileOf('beleg-ok'));
        await waitFor(() => previewCount(mounted!) > 0, 'Vorschau nach erneuter Auswahl');
        expect(previewCount(mounted)).toBe(1);
        expect(errorVisible(mounted)).toBe(false);
        // Keine Ablage ohne Entscheidung.
        expect(getInboxStoreSnapshot()).toHaveLength(0);
        expect(getDocumentStoreSnapshot()).toHaveLength(0);
      });
    }

    it(`${page.name}: Dateiauswahl abbrechen — die Fehleransicht bleibt, die nächste Auswahl wirkt`, async () => {
      mounted = render(page.path);
      await settle();
      await produceError(mounted, page.startInput);
      const clicked = recordFileInputClicks();
      await act(async () => {
        (q(mounted!.container, 'document-error-select-file') as HTMLButtonElement).click();
      });
      await settle(2);
      // Abbrechen: der Browser liefert nichts — die Fehleransicht mit ihren Wegen bleibt stehen.
      expect(errorVisible(mounted)).toBe(true);
      await act(async () => {
        (q(mounted!.container, 'document-error-select-file') as HTMLButtonElement).click();
      });
      await settle(2);
      const letzter = clicked[clicked.length - 1];
      expect(letzter.isConnected).toBe(true);
      await choose(letzter, fileOf('beleg-nach-abbruch'));
      await waitFor(() => previewCount(mounted!) > 0, 'Vorschau nach Abbruch und neuer Auswahl');
      expect(previewCount(mounted)).toBe(1);
    });

    it(`${page.name}: wiederholte Fehler verlieren die nächste Auswahl nicht; am Ende genau eine Vorschau und ein Entwurf`, async () => {
      mounted = render(page.path);
      await settle();
      await produceError(mounted, page.startInput);
      const clicked = recordFileInputClicks();
      for (const marker of ['leer-2', 'leer-3']) {
        await act(async () => {
          (q(mounted!.container, 'document-error-retry') as HTMLButtonElement).click();
        });
        await settle(2);
        const feld = clicked[clicked.length - 1];
        expect(feld.isConnected).toBe(true);
        await choose(feld, fileOf(marker));
        await waitFor(() => errorVisible(mounted!), `Fehler nach ${marker}`);
      }
      await act(async () => {
        (q(mounted!.container, 'document-error-select-file') as HTMLButtonElement).click();
      });
      await settle(2);
      await choose(clicked[clicked.length - 1], fileOf('beleg-endlich'));
      await waitFor(() => previewCount(mounted!) > 0, 'Vorschau nach wiederholten Fehlern');
      expect(previewCount(mounted)).toBe(1);
      await waitFor(() => true, 'Entwurf gesichert');
      const drafts = await listUploadDraftRecordsForActiveScope();
      expect(drafts, 'genau ein Entwurf für die eine Vorschau').toHaveLength(1);
      expect(getInboxStoreSnapshot()).toHaveLength(0);
    });
  }

  it('Scan: „Neues Foto aufnehmen“ nach dem Fehler öffnet das Kamerafeld, das Foto wird verarbeitet', async () => {
    mounted = render('/scan');
    await settle();
    await produceError(mounted, 'scan-gallery-input');
    const clicked = recordFileInputClicks();
    await act(async () => {
      (q(mounted!.container, 'document-error-new-photo') as HTMLButtonElement).click();
    });
    await settle(2);
    expect(clicked).toHaveLength(1);
    expect(clicked[0].getAttribute('data-testid')).toBe('scan-camera-input');
    expect(clicked[0].isConnected).toBe(true);
    await choose(clicked[0], fileOf('foto-ok'));
    await waitFor(() => previewCount(mounted!) > 0, 'Vorschau nach neuem Foto');
    expect(previewCount(mounted)).toBe(1);
  });
});
