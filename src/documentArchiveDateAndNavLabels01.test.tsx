import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { BottomNav } from './components/layout/BottomNav';
import { SidebarNav } from './components/layout/SidebarNav';
import { DESKTOP_NAV_ITEMS, MOBILE_BOTTOM_NAV_ITEMS } from './components/layout/navConfig';
import { DEFAULT_SETUP } from './data/mockData';
import { t } from './i18n';
import { DokumentePage } from './pages/DokumentePage';
import { MehrPage } from './pages/MehrPage';
import { hydrateDocumentStore } from './services/documentService';
import { resetTestStores } from './test/resetStores';
import type { CompanyDocument } from './types/models';
import {
  formatDocumentValidUntil,
  formatSafeDocumentDate,
  parseSafeDocumentDate,
  resolveDocumentCardDate,
} from './utils/documentDateDisplay';

function baseDoc(overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  return {
    id: 'doc-date-1',
    title: 'Testdokument',
    category: 'sonstiges',
    issuer: 'Test AG',
    recognizedText: '',
    issueDate: null,
    validUntil: null,
    digitalFolder: { id: 'dig', name: 'Test', path: '/Firma/Dokumente/' },
    paperFolder: { folderId: 'folder-1', register: 'A', label: 'Test' },
    tags: [],
    linkedCompany: 'Test GmbH',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-01-10T12:00:00.000Z',
    ...overrides,
  };
}

describe('DOCUMENT-ARCHIVE-DATE-AND-NAV-LABELS-01', () => {
  beforeEach(() => {    hydrateDocumentStore([]);
  });

  afterEach(() => {
    resetTestStores();
  });

  describe('Teil A — Sichere Datumsanzeige', () => {
    it('validUntil „15.07.2026“ erzeugt auf der Karte kein „Invalid Date“', () => {
      hydrateDocumentStore([
        baseDoc({
          id: 'doc-vu',
          title: 'Mit Frist',
          documentDate: '2026-03-01',
          issueDate: null,
          validUntil: '15.07.2026',
        }),
      ]);

      const html = renderToStaticMarkup(
        <MemoryRouter initialEntries={['/dokumente']}>
          <AppProvider initialSetup={DEFAULT_SETUP}>
            <Routes>
              <Route path="/dokumente" element={<DokumentePage />} />
            </Routes>
          </AppProvider>
        </MemoryRouter>,
      );

      expect(html).not.toContain('Invalid Date');
      expect(html).toContain('data-testid="document-card-date-doc-vu"');
      expect(html).toContain('01.03.2026');
      expect(html).toContain('Gültig bis');
      expect(html).toContain('15.07.2026');
    });

    it('documentDate wird bevorzugt vor issueDate und createdAt', () => {
      const result = resolveDocumentCardDate(
        {
          documentDate: '2026-05-20',
          issueDate: '2026-04-01',
          createdAt: '2026-01-01T00:00:00.000Z',
          uploadedAt: '2026-02-01T00:00:00.000Z',
        },
        'de',
        'Datum nicht erkannt',
      );
      expect(result.source).toBe('documentDate');
      expect(result.formatted).toBe('20.05.2026');
    });

    it('issueDate wird als zweiter Fallback verwendet', () => {
      const result = resolveDocumentCardDate(
        {
          documentDate: null,
          issueDate: '2026-04-15',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        'de',
        'Datum nicht erkannt',
      );
      expect(result.source).toBe('issueDate');
      expect(result.formatted).toBe('15.04.2026');
    });

    it('createdAt wird verwendet, wenn kein fachliches Datum existiert', () => {
      const result = resolveDocumentCardDate(
        {
          documentDate: null,
          issueDate: null,
          createdAt: '2026-02-28T12:00:00.000Z',
        },
        'de',
        'Datum nicht erkannt',
      );
      expect(result.source).toBe('createdAt');
      expect(result.isRecognized).toBe(true);
      expect(result.formatted).not.toBe('Invalid Date');
      expect(result.formatted).not.toBe('Datum nicht erkannt');
    });

    it('ungültige Werte führen zu „Datum nicht erkannt“', () => {
      expect(parseSafeDocumentDate('not-a-date')).toBeNull();
      expect(parseSafeDocumentDate('32.13.2026')).toBeNull();
      expect(parseSafeDocumentDate('07/15/2026')).toBeNull();
      expect(formatSafeDocumentDate('bogus', 'de', 'Datum nicht erkannt')).toBe(
        'Datum nicht erkannt',
      );
      expect(
        resolveDocumentCardDate(
          {
            documentDate: 'kaputt',
            issueDate: 'xx',
            createdAt: 'nein',
            uploadedAt: undefined,
          },
          'de',
          'Datum nicht erkannt',
        ).formatted,
      ).toBe('Datum nicht erkannt');
    });

    it('deutsche Datumsausgabe verwendet de-DE', () => {
      expect(formatSafeDocumentDate('2026-07-15', 'de')).toBe('15.07.2026');
      expect(formatSafeDocumentDate('15.07.2026', 'de')).toBe('15.07.2026');
    });

    it('türkische Datumsausgabe verwendet tr-TR', () => {
      const expected = new Date(2026, 6, 15).toLocaleDateString('tr-TR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      });
      expect(formatSafeDocumentDate('2026-07-15', 'tr')).toBe(expected);
      expect(formatSafeDocumentDate('15.07.2026', 'tr')).toBe(expected);
    });

    it('bulgarische Datumsausgabe verwendet bg-BG', () => {
      const expected = new Date(2026, 6, 15).toLocaleDateString('bg-BG', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      });
      expect(formatSafeDocumentDate('2026-07-15', 'bg')).toBe(expected);
      expect(formatSafeDocumentDate('15.07.2026', 'bg')).toBe(expected);
    });

    it('Frist bleibt getrennt vom primären Kartendatum', () => {
      expect(formatDocumentValidUntil('15.07.2026', 'de')).toBe('15.07.2026');
      expect(formatDocumentValidUntil('kaputt', 'de')).toBeNull();
      const primary = resolveDocumentCardDate(
        {
          documentDate: '2026-01-05',
          issueDate: null,
          createdAt: '2026-01-01T12:00:00.000Z',
        },
        'de',
        'Datum nicht erkannt',
      );
      expect(primary.formatted).toBe('05.01.2026');
      expect(primary.source).not.toBe('none');
    });
  });

  describe('Teil B — Navigation klar benennen', () => {
    it('Bottom Navigation zeigt „Eingang“ und führt weiterhin zu /ablage', () => {
      expect(MOBILE_BOTTOM_NAV_ITEMS.find((item) => item.to === '/ablage')?.key).toBe(
        'nav.eingang',
      );
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider initialSetup={DEFAULT_SETUP}>
            <BottomNav />
          </AppProvider>
        </MemoryRouter>,
      );
      expect(html).toContain('Eingang');
      expect(html).toContain('href="/ablage"');
      expect(html).not.toMatch(/>Dokumente<\/span>/);
    });

    it('Desktop Navigation zeigt ebenfalls „Eingang“', () => {
      expect(DESKTOP_NAV_ITEMS.find((item) => item.to === '/ablage')?.key).toBe('nav.eingang');
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider initialSetup={DEFAULT_SETUP}>
            <SidebarNav />
          </AppProvider>
        </MemoryRouter>,
      );
      expect(html).toContain('Eingang');
      expect(html).toContain('href="/ablage"');
    });

    it('Mehr-Seite zeigt „Dokumentenarchiv“ und führt zu /dokumente', () => {
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <AuthProvider>
            <AppProvider initialSetup={DEFAULT_SETUP}>
              <MehrPage />
            </AppProvider>
          </AuthProvider>
        </MemoryRouter>,
      );
      expect(html).toContain('Dokumentenarchiv');
      expect(html).toContain('href="/dokumente"');
      expect(t('mehr.documents', 'de')).toBe('Dokumentenarchiv');
      expect(t('mehr.documents', 'tr')).toBe('Belge arşivi');
      expect(t('mehr.documents', 'bg')).toBe('Архив на документи');
    });

    it('Archivseite trägt den klaren Archivtitel', () => {
      const html = renderToStaticMarkup(
        <MemoryRouter initialEntries={['/dokumente']}>
          <AppProvider initialSetup={DEFAULT_SETUP}>
            <Routes>
              <Route path="/dokumente" element={<DokumentePage />} />
            </Routes>
          </AppProvider>
        </MemoryRouter>,
      );
      expect(html).toContain('Dokumentenarchiv');
      expect(html).toContain('Gespeicherte Firmendokumente finden und verwalten.');
      expect(t('document.title', 'tr')).toBe('Belge arşivi');
      expect(t('document.title', 'bg')).toBe('Архив на документи');
    });

    it('Upload-/Scan-Routen bleiben unverändert benannt in navConfig', () => {
      expect(MOBILE_BOTTOM_NAV_ITEMS.some((item) => item.to === '/dokumente')).toBe(false);
      expect(DESKTOP_NAV_ITEMS.some((item) => item.to === '/dokumente')).toBe(false);
      expect(MOBILE_BOTTOM_NAV_ITEMS.find((item) => item.to === '/ablage')?.to).toBe('/ablage');
    });
  });
});
