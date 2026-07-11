import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../../context/AppContext';
import { AuthProvider } from '../../context/AuthContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { BottomNav } from './BottomNav';
import { AppShell } from './AppShell';

describe('Navigation layout UX-03', () => {
  it('Mobile-Navigation enthält die neuen Labels', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <BottomNav />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('Heute');
    expect(html).toContain('Aufträge');
    expect(html).toContain('Scan');
    expect(html).toContain('Ablage');
    expect(html).toContain('Mehr');
    expect(html).not.toContain('Smart Inbox');
    expect(html).not.toContain('Eingang');
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
    expect(shellHtml).not.toContain('app-shell__settings');
  });
});
