import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { t } from './i18n';
import { DokumentePage } from './pages/DokumentePage';
import {
  documentMatchesArea,
  resolveDocumentAreas,
  resolveDocumentPaperListStatus,
} from './services/documentAreaCatalog';
import {
  addDocument,
  getDocumentById,
  hydrateDocumentStore,
  searchDocuments,
} from './services/documentService';
import {
  markDocumentPhysicallyFiled,
  resetMemory,
} from './services/officePilotMemoryService';
import { hydrateVorgangStore } from './services/vorgangService';
import { createTestVorgang } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import { parseDocumentAreaFilter } from './types/documentArea';
import type { ClassifiedDocumentKind, CompanyDocument } from './types/models';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function baseDoc(overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  return {
    id: 'doc-area-1',
    title: 'Testdokument',
    category: 'sonstiges',
    issuer: 'Test',
    recognizedText: '',
    issueDate: null,
    validUntil: null,
    digitalFolder: { id: 'dig', name: 'Test', path: '/Firma/Dokumente/' },
    paperFolder: { folderId: 'folder-1', register: 'A', label: 'Test' },
    tags: [],
    linkedCompany: 'Test GmbH',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('DOCUMENT-AREA-FILTERS-01', () => {
  beforeEach(() => {
    resetMemory();
    hydrateDocumentStore([]);
    hydrateVorgangStore([]);
  });

  afterEach(() => {
    resetTestStores();
  });

  it('Kind-Gruppen liefern erwartete Bereiche', () => {
    const cases: Array<[ClassifiedDocumentKind, string[]]> = [
      ['eingangsrechnung', ['rechnungen']],
      ['ausgangsrechnung', ['rechnungen']],
      ['gutschrift', ['rechnungen']],
      ['quittung', ['belege']],
      ['tankbeleg', ['belege']],
      ['angebot', ['angebote']],
      ['auftrag', ['auftraege']],
      ['lieferschein', ['auftraege']],
      ['abnahmeprotokoll', ['auftraege']],
      ['werkvertrag', ['vertraege']],
      ['leasingvertrag', ['vertraege']],
      ['finanzamt', ['behoerden']],
      ['bg_bau', ['behoerden']],
      ['aok', ['behoerden']],
      ['lohnabrechnung', ['mitarbeiter']],
      ['arbeitsvertrag', ['mitarbeiter']],
      ['betriebshaftpflicht', ['versicherungen']],
      ['baustellenfoto', ['baustellen']],
      ['brief', ['allgemein']],
      ['sonstiges', ['allgemein']],
    ];

    for (const [kind, expected] of cases) {
      const areas = resolveDocumentAreas(baseDoc({ classifiedKind: kind }));
      expect(areas, kind).toEqual(expected);
    }
  });

  it('Eingangsrechnung mit linkedVorgang erscheint in Rechnungen und Aufträge', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-area-1', customer: 'Müller Bau', baustelle: '' })]);
    const areas = resolveDocumentAreas(
      baseDoc({
        classifiedKind: 'eingangsrechnung',
        linkedVorgang: { vorgangId: 'v-area-1', vorgangTitle: 'Testvorgang' },
      }),
    );
    expect(areas).toContain('rechnungen');
    expect(areas).toContain('auftraege');
    expect(areas).toContain('kunden');
  });

  it('Kundenverknüpfung ergänzt Kunden, Baustelle ergänzt Baustellen', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-site',
        customer: 'Kunde AG',
        baustelle: 'Hauptstr. 1',
      }),
    ]);
    const areas = resolveDocumentAreas(
      baseDoc({
        classifiedKind: 'brief',
        linkedVorgang: { vorgangId: 'v-site', vorgangTitle: 'Sanierung' },
      }),
    );
    expect(areas).toContain('allgemein');
    expect(areas).toContain('auftraege');
    expect(areas).toContain('kunden');
    expect(areas).toContain('baustellen');
  });

  it('unsicheres Foto bleibt allgemein', () => {
    const areas = resolveDocumentAreas(
      baseDoc({
        classifiedKind: 'foto',
        digitalFolder: { id: 'd', name: 'Eingang', path: '/Eingang/Sonstiges/2026/' },
      }),
    );
    expect(areas).toEqual(['allgemein']);
  });

  it('Pfad-Fallback ohne classifiedKind', () => {
    const areas = resolveDocumentAreas(
      baseDoc({
        classifiedKind: undefined,
        digitalFolder: {
          id: 'd',
          name: 'Eingangsrechnungen',
          path: '/Steuerberater/2026/07/Eingangsrechnungen/',
        },
      }),
    );
    expect(areas).toContain('rechnungen');
  });

  it('unbekanntes Dokument erscheint in allgemein', () => {
    expect(resolveDocumentAreas(baseDoc({ classifiedKind: undefined }))).toEqual(['allgemein']);
  });

  it('Bereichsfilter und Suche funktionieren gemeinsam', () => {
    addDocument({
      title: 'Holzmann Rechnung',
      category: 'steuer',
      issuer: 'Holz AG',
      classifiedKind: 'eingangsrechnung',
      digitalFolder: { id: 'd1', name: 'ER', path: '/Steuerberater/2026/07/Eingangsrechnungen/' },
    });
    addDocument({
      title: 'Allianz Police',
      category: 'versicherung',
      issuer: 'Allianz',
      classifiedKind: 'betriebshaftpflicht',
      digitalFolder: { id: 'd2', name: 'V', path: '/Versicherungen/2026/' },
    });

    expect(searchDocuments('', { area: 'rechnungen' }).map((d) => d.title)).toEqual([
      'Holzmann Rechnung',
    ]);
    expect(searchDocuments('Allianz', { area: 'rechnungen' })).toHaveLength(0);
    expect(searchDocuments('Allianz', { area: 'versicherungen' })).toHaveLength(1);
    expect(searchDocuments('', { area: 'alle' }).length).toBeGreaterThanOrEqual(2);
  });

  it('ungültiger URL-Area-Wert fällt auf alle zurück', () => {
    expect(parseDocumentAreaFilter('rechnungen')).toBe('rechnungen');
    expect(parseDocumentAreaFilter('keine-ahnung')).toBe('alle');
    expect(parseDocumentAreaFilter(null)).toBe('alle');
  });

  it('Dokument behält fileRefId über Bereiche hinweg und erzeugt keinen zweiten Datensatz', () => {
    const created = addDocument({
      title: 'Geteilte Datei',
      category: 'steuer',
      classifiedKind: 'eingangsrechnung',
      fileRefId: 'file-ref-shared-area',
      digitalFolder: { id: 'd', name: 'ER', path: '/Steuerberater/2026/07/Eingangsrechnungen/' },
      linkedVorgang: { vorgangId: 'missing-v', vorgangTitle: 'Auftrag X' },
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    const inRechnungen = searchDocuments('', { area: 'rechnungen' }).find(
      (d) => d.id === created.document.id,
    );
    const inAuftraege = searchDocuments('', { area: 'auftraege' }).find(
      (d) => d.id === created.document.id,
    );
    expect(inRechnungen?.fileRefId).toBe('file-ref-shared-area');
    expect(inAuftraege?.fileRefId).toBe('file-ref-shared-area');
    expect(inRechnungen?.id).toBe(inAuftraege?.id);
    expect(getDocumentById(created.document.id)?.fileRefId).toBe('file-ref-shared-area');
  });

  it('Papierstatus ist sichtbar und beeinflusst Filter nicht', () => {
    const created = addDocument({
      title: 'Papier Dok',
      category: 'behoerde',
      classifiedKind: 'finanzamt',
      digitalFolder: { id: 'd', name: 'FA', path: '/Behörden/Finanzamt/2026/' },
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(resolveDocumentPaperListStatus(created.document.id)).toBe('pending');
    const before = searchDocuments('', { area: 'behoerden' }).map((d) => d.id);
    expect(before).toContain(created.document.id);

    markDocumentPhysicallyFiled(created.document.id);
    expect(resolveDocumentPaperListStatus(created.document.id)).toBe('filed');
    expect(searchDocuments('', { area: 'behoerden' }).map((d) => d.id)).toEqual(before);
  });

  it('DokumentePage zeigt Bereichs-Chips und Papierstatus ohne Seitenoverflow-Klassenkonflikt', () => {
    addDocument({
      title: 'Chip Dok',
      category: 'steuer',
      classifiedKind: 'eingangsrechnung',
    });
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/dokumente?area=rechnungen']}>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <Routes>
            <Route path="/dokumente" element={<DokumentePage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
    expect(html).toContain('data-testid="document-area-chips"');
    expect(html).toContain('data-testid="document-area-chip-rechnungen"');
    expect(html).toContain('document-area-chips');
    expect(html).toContain(t('document.area.paper.pending', 'de'));
  });

  it('CSS für Chip-Leiste begrenzt Overflow auf den Chip-Container', () => {
    const css = readFileSync(resolve(__dirname, 'index.css'), 'utf8');
    expect(css).toMatch(/\.document-area-chips\s*\{[^}]*overflow-x:\s*auto/s);
    expect(css).toMatch(/\.document-area-chips\s*\{[^}]*max-width:\s*100%/s);
    expect(css).toMatch(/\.document-area-chips\s*\{[^}]*min-width:\s*0/s);
  });

  it('DE/TR/BG Labels vorhanden', () => {
    for (const lang of ['de', 'tr', 'bg'] as const) {
      expect(t('document.area.rechnungen', lang).length).toBeGreaterThan(0);
      expect(t('document.area.paper.filed', lang).length).toBeGreaterThan(0);
      expect(t('document.area.empty', lang).length).toBeGreaterThan(0);
    }
    expect(t('document.area.rechnungen', 'tr')).not.toBe(t('document.area.rechnungen', 'de'));
    expect(t('document.area.rechnungen', 'bg')).not.toBe(t('document.area.rechnungen', 'de'));
  });
});
