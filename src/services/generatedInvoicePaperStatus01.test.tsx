/**
 * OFFICEPILOT-GENERATED-INVOICE-PAPER-STATUS-01 — kein Papier ohne Papier.
 *
 * Eine von OfficePilot selbst erzeugte Ausgangsrechnung hat kein physisches
 * Original. Trotzdem zeigte die Dokumentenliste „Papier offen" — weil
 * `DocumentPaperListStatus` nur `filed | pending` kannte und alles ohne
 * Ablagenachweis auf `pending` fiel.
 *
 * Detailseite und Lifecycle behandeln diesen Fall bereits richtig (Sprint 02F,
 * über `isGeneratedOutgoingInvoiceDocument`). Nur die Liste wurde damals nicht
 * mitgezogen. Sie bekommt jetzt dieselbe Regel — nicht eine zweite.
 *
 * Neutrale Beispieldaten.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { DEFAULT_SETUP } from '../data/mockData';
import { AppProvider } from '../context/AppContext';
import { DokumentePage } from '../pages/DokumentePage';
import { resolveDocumentPaperListStatus } from './documentAreaCatalog';
import {
  hydrateDocumentStore,
  isGeneratedOutgoingInvoiceDocument,
} from './documentService';
import { hydrateMemory } from './officePilotMemoryService';
import { resetTestStores } from '../test/resetStores';
import type { CompanyDocument } from '../types/models';

const setupComplete = { ...DEFAULT_SETUP, setupComplete: true };

/** Ein von OfficePilot erzeugtes Ausgangsrechnungs-Dokument. */
function generatedInvoiceDocument(overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  return {
    id: 'doc-generated-1',
    title: '2026-0099 – Rechnung',
    category: 'ausgangsrechnung',
    classifiedKind: 'ausgangsrechnung',
    issuer: 'Muster GmbH',
    recognizedText: 'Rechnungsnummer: 2026-0099',
    issueDate: '2026-08-27',
    validUntil: null,
    digitalFolder: {
      id: 'dig-inv-1',
      name: 'Ausgangsrechnungen',
      path: '/Vorgänge/Beispiel/Ausgangsrechnungen/',
    },
    // Der Ablageort bleibt am Dokument — nur die Handlungspflicht entfällt.
    paperFolder: { folderId: 'folder-3', register: 'A', label: 'Rechnungen' },
    tags: ['Ausgangsrechnung', '2026-0099'],
    linkedCompany: 'Muster GmbH',
    linkedVorgang: null,
    linkedInvoiceId: 'inv-generated-1',
    archived: true,
    createdAt: '2026-08-27T10:00:00.000Z',
    imagePreview: '🧾',
    ...overrides,
  };
}

/** Ein hochgeladenes Fremddokument mit echtem Papieroriginal. */
function uploadedPaperDocument(overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  return {
    id: 'doc-uploaded-1',
    title: 'Behördenschreiben',
    category: 'behoerde',
    classifiedKind: 'behoerdenschreiben',
    issuer: 'Finanzamt Beispielstadt',
    recognizedText: 'Bescheid',
    issueDate: '2026-08-10',
    validUntil: null,
    digitalFolder: { id: 'dig-beh', name: 'Behörden', path: '/Behörden/' },
    paperFolder: { folderId: 'paper-behoerden', register: 'Finanzamt', label: 'Behörden' },
    tags: [],
    linkedCompany: '',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-08-10T10:00:00.000Z',
    fileRefId: 'file-ref-1',
    ...overrides,
  } as CompanyDocument;
}

interface PageMount {
  container: HTMLDivElement;
  root: Root;
}

function renderDocumentList(element: ReactElement): PageMount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={['/dokumente']}>
        <AppProvider initialSetup={setupComplete}>
          <Routes>
            <Route path="/dokumente" element={element} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

describe('OFFICEPILOT-GENERATED-INVOICE-PAPER-STATUS-01', () => {
  let mounted: PageMount | null = null;

  beforeEach(() => {
    resetTestStores();
    // Ohne dies trüge ein Ablagenachweis aus einem Test in den nächsten.
    hydrateMemory({
      documentMemories: [],
      proofMemories: [],
      relations: [],
      paperRegisterEntries: [],
    });
  });

  afterEach(() => {
    if (mounted) {
      const { root, container } = mounted;
      act(() => root.unmount());
      container.remove();
      mounted = null;
    }
    resetTestStores();
  });

  /* ---------------------------------------------------------------------- */
  /* Der Kernfall                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Genau die Auswertung, die auch `DokumentePage` vornimmt: Die maßgebliche
   * Erkennung lebt in `documentService`, der Katalog bildet nur den Status.
   */
  function paperStatusFor(document: CompanyDocument) {
    return resolveDocumentPaperListStatus(document, {
      skipPhysicalFiling: isGeneratedOutgoingInvoiceDocument(document),
    });
  }

  it('A/C: ein erzeugtes Ausgangsrechnungs-Dokument braucht kein Papier', () => {
    const document = generatedInvoiceDocument();
    hydrateDocumentStore([document]);

    // Kein Gedächtniseintrag, kein Papierregister — genau die Ausgangslage.
    expect(paperStatusFor(document)).toBe('not_required');
  });

  it('B: dasselbe gilt für ein aus der Cloud gezogenes Dokument', () => {
    /*
     * Eine gezogene Fassung trägt SyncMeta und keinerlei lokales Gedächtnis.
     * Die Semantik muss allein aus dem Dokument folgen — sonst bräuchte es
     * einen Backfill.
     */
    const fromCloud = generatedInvoiceDocument({
      sync: {
        updatedAt: '2026-08-27T10:00:00.000Z',
        version: 1,
        deleted: false,
        deviceId: 'cloud',
        workspaceId: '00000000-0000-4000-8000-00000000aaaa',
      },
    });
    hydrateDocumentStore([fromCloud]);

    expect(paperStatusFor(fromCloud)).toBe('not_required');
  });

  /* ---------------------------------------------------------------------- */
  /* Alles andere bleibt, wie es war                                         */
  /* ---------------------------------------------------------------------- */

  it('D: ein hochgeladenes Papierdokument ohne Ablage bleibt offen', () => {
    const document = uploadedPaperDocument();
    hydrateDocumentStore([document]);

    expect(paperStatusFor(document)).toBe('pending');
  });

  it('E: ein abgeheftetes Dokument bleibt abgeheftet', () => {
    const document = uploadedPaperDocument();
    hydrateDocumentStore([document]);
    hydrateMemory({
      documentMemories: [
        {
          id: 'mem-1',
          documentId: document.id,
          title: document.title,
          issuer: document.issuer,
          digitalFolder: document.digitalFolder,
          paperFolder: document.paperFolder,
          validUntil: null,
          physicalFiled: true,
        },
      ],
      proofMemories: [],
      relations: [],
      paperRegisterEntries: [],
    });

    expect(paperStatusFor(document)).toBe('filed');
  });

  it('F/G: eine fremde Ausgangsrechnung ohne Rechnungsbezug bleibt papierpflichtig', () => {
    /*
     * Die Kategorie allein darf nicht entscheiden — eine eingescannte fremde
     * Ausgangsrechnung hat sehr wohl ein Original.
     */
    const scanned = uploadedPaperDocument({
      id: 'doc-scan-1',
      category: 'ausgangsrechnung',
      classifiedKind: 'ausgangsrechnung',
      linkedInvoiceId: null,
    });
    hydrateDocumentStore([scanned]);

    expect(isGeneratedOutgoingInvoiceDocument(scanned)).toBe(false);
    expect(paperStatusFor(scanned)).not.toBe('not_required');
    expect(paperStatusFor(scanned)).toBe('pending');
  });

  it('K: die Liste benutzt dieselbe zentrale Erkennung wie Detailseite und Lifecycle', () => {
    const generated = generatedInvoiceDocument();
    const scanned = uploadedPaperDocument({
      category: 'ausgangsrechnung',
      classifiedKind: 'ausgangsrechnung',
      linkedInvoiceId: null,
    });

    // Genau die Funktion, die 02F für Detailseite und Lifecycle eingeführt hat.
    expect(isGeneratedOutgoingInvoiceDocument(generated)).toBe(true);
    expect(isGeneratedOutgoingInvoiceDocument(scanned)).toBe(false);

    expect(paperStatusFor(generated)).toBe('not_required');
    expect(paperStatusFor(scanned)).not.toBe('not_required');
  });

  /* ---------------------------------------------------------------------- */
  /* Was der Nutzer sieht                                                    */
  /* ---------------------------------------------------------------------- */

  it('H: die Liste zeigt für ein erzeugtes Dokument kein „Papier offen"', () => {
    hydrateDocumentStore([generatedInvoiceDocument()]);
    mounted = renderDocumentList(<DokumentePage />);

    // Die Karte ist da — nur der Papierhinweis darf fehlen.
    expect(
      mounted.container.querySelector('[data-testid="document-summary-list-doc-generated-1"]'),
    ).not.toBeNull();
    expect(mounted.container.textContent).not.toContain('Papier offen');
  });

  it('I: ein normales Papierdokument zeigt weiterhin „Papier offen"', () => {
    hydrateDocumentStore([uploadedPaperDocument()]);
    mounted = renderDocumentList(<DokumentePage />);

    expect(
      mounted.container.querySelector('[data-testid="document-summary-list-doc-uploaded-1"]'),
    ).not.toBeNull();
    expect(mounted.container.textContent).toContain('Papier offen');
  });

  it('J: ein abgeheftetes Dokument zeigt weiterhin seinen Ablagestatus', () => {
    const document = uploadedPaperDocument();
    hydrateDocumentStore([document]);
    hydrateMemory({
      documentMemories: [
        {
          id: 'mem-1',
          documentId: document.id,
          title: document.title,
          issuer: document.issuer,
          digitalFolder: document.digitalFolder,
          paperFolder: document.paperFolder,
          validUntil: null,
          physicalFiled: true,
        },
      ],
      proofMemories: [],
      relations: [],
      paperRegisterEntries: [],
    });

    mounted = renderDocumentList(<DokumentePage />);
    expect(mounted.container.textContent).not.toContain('Papier offen');
    expect(mounted.container.textContent).toContain('Papier abgeheftet');
  });

  /* ---------------------------------------------------------------------- */
  /* Architektur                                                             */
  /* ---------------------------------------------------------------------- */

  it('01B: documentAreaCatalog importiert documentService nicht', () => {
    /*
     * `documentService` bezieht `documentMatchesArea` aus dem Katalog. Ein
     * Import in die Gegenrichtung schlösse einen Zyklus — deshalb wertet der
     * Aufrufer die generated-invoice-Erkennung aus und übergibt nur das
     * Ergebnis.
     */
    const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

    const catalog = read('src/services/documentAreaCatalog.ts');
    expect(catalog).not.toContain("from './documentService'");
    expect(catalog).not.toContain('isGeneratedOutgoingInvoiceDocument');

    // Die Gegenrichtung bleibt ausdrücklich erlaubt und unverändert.
    const service = read('src/services/documentService.ts');
    expect(service).toContain("from './documentAreaCatalog'");

    // Und die Seite wertet die zentrale Erkennung selbst aus.
    const page = read('src/pages/DokumentePage.tsx');
    expect(page).toContain('isGeneratedOutgoingInvoiceDocument(doc)');
    expect(page).toContain('skipPhysicalFiling');
  });

  it('H2: beide Dokumentarten nebeneinander bleiben unterscheidbar', () => {
    hydrateDocumentStore([generatedInvoiceDocument(), uploadedPaperDocument()]);
    mounted = renderDocumentList(<DokumentePage />);

    const text = mounted.container.textContent ?? '';
    expect(
      mounted.container.querySelector('[data-testid="document-summary-list-doc-generated-1"]'),
    ).not.toBeNull();
    expect(
      mounted.container.querySelector('[data-testid="document-summary-list-doc-uploaded-1"]'),
    ).not.toBeNull();
    // Genau einmal — für das Fremddokument, nicht für die erzeugte Rechnung.
    expect(text.split('Papier offen').length - 1).toBe(1);
  });
});
