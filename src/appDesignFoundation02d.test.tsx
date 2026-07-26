import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { t } from './i18n';
import { AusgabeNeuPage } from './pages/AusgabeNeuPage';
import { DokumentNeuPage } from './pages/DokumentNeuPage';
import { OffeneAusgabenPage } from './pages/OffeneAusgabenPage';
import { OffeneRechnungenPage } from './pages/OffeneRechnungenPage';

type Mount = { container: HTMLDivElement; root: Root };

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}</div>;
}

function mountAt(path: string, page: ReactNode): Mount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <Routes>
            <Route
              path={path}
              element={
                <>
                  {page}
                  <LocationProbe />
                </>
              }
            />
            <Route path="/dokumente" element={<LocationProbe />} />
            <Route path="/ausgaben" element={<LocationProbe />} />
            <Route path="/vorgaenge" element={<LocationProbe />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

function getHeader(container: HTMLElement): HTMLElement {
  const header = container.querySelector('header.page-header');
  expect(header).not.toBeNull();
  return header as HTMLElement;
}

function getHeaderBack(container: HTMLElement): HTMLButtonElement {
  const back = getHeader(container).querySelector(
    'button.page-header__back',
  ) as HTMLButtonElement | null;
  expect(back).not.toBeNull();
  return back!;
}

describe('APP-DESIGN-FOUNDATION-02D PageHeader back navigation', () => {
  let mounted: Mount | undefined;

  afterEach(() => {
    if (mounted) {
      act(() => {
        mounted!.root.unmount();
      });
      mounted.container.remove();
      mounted = undefined;
    }
  });

  it('DokumentNeuPage: Header-Back nach /dokumente, kein externer back-link', () => {
    mounted = mountAt('/dokumente/neu', <DokumentNeuPage />);
    const header = getHeader(mounted.container);
    const back = getHeaderBack(mounted.container);

    expect(header.textContent).toContain(t('document.addTitle', 'de'));
    expect(header.textContent).toContain(t('document.addSubtitle', 'de'));
    expect(back.textContent).toContain(t('common.back', 'de'));
    expect(mounted.container.querySelectorAll('.back-link')).toHaveLength(0);
    expect(mounted.container.querySelectorAll('button.page-header__back')).toHaveLength(1);

    act(() => {
      back.click();
    });
    expect(mounted.container.querySelector('[data-testid="location-probe"]')?.textContent).toBe(
      '/dokumente',
    );
  });

  it('AusgabeNeuPage: Header-Back nach /ausgaben, kein externer back-link', () => {
    mounted = mountAt('/ausgaben/neu', <AusgabeNeuPage />);
    const header = getHeader(mounted.container);
    const back = getHeaderBack(mounted.container);

    expect(header.textContent).toContain(t('expense.addTitle', 'de'));
    expect(header.textContent).toContain(t('expense.addSubtitle', 'de'));
    expect(back.textContent).toContain(t('common.back', 'de'));
    expect(mounted.container.querySelectorAll('.back-link')).toHaveLength(0);

    act(() => {
      back.click();
    });
    expect(mounted.container.querySelector('[data-testid="location-probe"]')?.textContent).toBe(
      '/ausgaben',
    );
  });

  it('OffeneAusgabenPage: Header-Back nach /ausgaben, kein externer back-link', () => {
    mounted = mountAt('/ausgaben/offen', <OffeneAusgabenPage />);
    const header = getHeader(mounted.container);
    const back = getHeaderBack(mounted.container);

    expect(header.textContent).toContain(t('expenseOverview.title', 'de'));
    expect(header.textContent).toContain(t('expenseOverview.subtitle', 'de'));
    expect(back.textContent).toContain(t('common.back', 'de'));
    expect(mounted.container.querySelectorAll('.back-link')).toHaveLength(0);

    act(() => {
      back.click();
    });
    expect(mounted.container.querySelector('[data-testid="location-probe"]')?.textContent).toBe(
      '/ausgaben',
    );
  });

  it('OffeneRechnungenPage: Header-Back nach /vorgaenge; Footer-Link bleibt', () => {
    mounted = mountAt('/rechnungen/offen', <OffeneRechnungenPage />);
    const header = getHeader(mounted.container);
    const back = getHeaderBack(mounted.container);

    expect(header.textContent).toContain(t('overview.title', 'de'));
    expect(header.textContent).toContain(t('overview.subtitle', 'de'));
    expect(back.textContent).toContain(t('common.back', 'de'));
    expect(mounted.container.querySelectorAll('.back-link')).toHaveLength(0);
    expect(mounted.container.querySelectorAll('button.page-header__back')).toHaveLength(1);

    const footerLink = mounted.container.querySelector(
      'a[href="/vorgaenge"]',
    ) as HTMLAnchorElement | null;
    expect(footerLink).not.toBeNull();
    expect(footerLink!.textContent).toContain(t('overview.backToVorgaenge', 'de'));

    act(() => {
      back.click();
    });
    expect(mounted.container.querySelector('[data-testid="location-probe"]')?.textContent).toBe(
      '/vorgaenge',
    );
  });
});
