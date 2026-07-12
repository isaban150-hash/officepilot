import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../../context/AppContext';
import { AuthProvider } from '../../context/AuthContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { BottomNav } from './BottomNav';
import { AppShell } from './AppShell';

describe('Navigation layout UX-HOME-01 ABSCHLUSSFIX', () => {
  it('Mobile-Navigation hat maximal 5 Hauptbereiche', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <BottomNav />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('Schreibtisch');
    expect(html).toContain('Dokumente');
    expect(html).toContain('Aufträge');
    expect(html).toContain('OfficePilot');
    expect(html).toContain('Mehr');
    expect(html).not.toContain('Steuerberater');
    expect(html).not.toContain('Kunden');
    expect(html).not.toContain('Heute');
    expect(html).not.toContain('Scan');
    expect(html).not.toContain('Ablage');
  });

  it('Desktop-Layout nutzt Sidebar und breitere Arbeitsfläche', () => {
    const shellHtml = renderToStaticMarkup(
      <MemoryRouter>
        <AuthProvider>
          <AppProvider initialSetup={DEFAULT_SETUP}>
            <AppShell />
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(shellHtml).toContain('data-testid="sidebar-nav"');
    expect(shellHtml).toContain('data-testid="bottom-nav"');
    expect(shellHtml).toContain('app-shell__body');
    expect(shellHtml).toContain('app-shell__top-right');
    expect(shellHtml).not.toContain('Demo zurücksetzen');
  });
});
