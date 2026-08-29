/**
 * OFFICEPILOT-CUSTOMER-NAVIGATION-ENTRY-01 — der Kundenbereich braucht einen
 * sichtbaren Einstieg.
 *
 * `/kunden` existiert samt Detailseiten, war über die Oberfläche aber nicht
 * erreichbar: Der einzige je gebaute Einstieg lag in `HomeDeskTiles`, und die
 * Komponente ist nirgends eingebunden. Der Kommentar in `navConfig` hielt die
 * Absicht fest — „Kunden & Steuerberater via Schreibtisch-Kacheln" — nur wurde
 * sie nie umgesetzt.
 *
 * Der Zugang läuft bewusst über „Mehr" statt über einen sechsten Tab: Die
 * Fünfer-Grenze der Bottom-Navigation ist eine dokumentierte Regel, und
 * dieselbe Seite bedient Mobile und Desktop.
 *
 * Neutrale Beispieldaten.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { MOBILE_BOTTOM_NAV_ITEMS } from './components/layout/navConfig';
import { DEFAULT_SETUP } from './data/mockData';
import { t } from './i18n';
import { MehrPage } from './pages/MehrPage';

function renderMehr(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AuthProvider>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <MehrPage />
        </AppProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('CUSTOMER-NAVIGATION-ENTRY-01', () => {
  it('A: „Mehr" führt zum Kundenbereich', () => {
    const html = renderMehr();
    expect(html).toContain('href="/kunden"');
    expect(html).toContain(t('mehr.customers', 'de'));
  });

  it('B: der Eintrag steht bei den fachlichen Bereichen, nicht bei den Einstellungen', () => {
    /*
     * Die Reihenfolge der Liste ist Teil der Aussage: Kunden gehören zum
     * Tagesgeschäft, nicht zu Firmendaten und Synchronisation.
     */
    const html = renderMehr();
    const customersAt = html.indexOf('href="/kunden"');
    const companyAt = html.indexOf('mehr-link-card');
    expect(customersAt).toBeGreaterThan(-1);
    expect(companyAt).toBeGreaterThan(-1);
    expect(customersAt).toBeLessThan(html.indexOf('href="/synchronisation"'));
  });

  it('C: die Beschriftung liegt in allen drei Sprachen vor', () => {
    for (const lang of ['de', 'tr', 'bg'] as const) {
      expect(t('mehr.customers', lang).trim(), lang).not.toBe('');
      expect(t('mehr.customersDesc', lang).trim(), lang).not.toBe('');
    }
    // Kein stiller Rückfall auf den deutschen Text.
    expect(t('mehr.customers', 'tr')).not.toBe(t('mehr.customers', 'de'));
    expect(t('mehr.customers', 'bg')).not.toBe(t('mehr.customers', 'de'));
  });

  it('D: die Bottom-Navigation bleibt bei fünf Bereichen', () => {
    // Der Zugang darf die dokumentierte Fünfer-Grenze nicht aufweichen.
    expect(MOBILE_BOTTOM_NAV_ITEMS).toHaveLength(5);
    expect(MOBILE_BOTTOM_NAV_ITEMS.map((item) => item.to)).not.toContain('/kunden');
  });
});
