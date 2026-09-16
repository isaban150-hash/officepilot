/**
 * UIUX-FOUNDATION-01C — AppShell & Navigation.
 *
 *  A  navConfig: eine Quelle — Desktop 6 Hauptbereiche, Mobile exakt 5, Sekundärzone abgeleitet
 *  B  Sidebar: Haupt-/Sekundärzone, aktiver Zustand (Klasse + aria-current), Testids stabil
 *  C  BottomNav: 5 Ziele, Rechnungen statt Assistent, aria-current
 *  D  Mehr: gruppierte Zeilen, keine Karten, Admin-Ziel nur mit Rolle, jede Route existiert in App.tsx
 *  E  Header: Assistent + Zahnrad als Werkzeuge, kein „Mehr“ im Benutzermenü
 *  F  Finanzen-Hub: nur Navigation zu bestehenden Routen, keine Kennzahlen
 *  G  Deep Links: Parameter (vtab, step, fromOverview) bleiben in NavLink-Ziele unberührt
 *  H  i18n: neue Schlüssel in de/tr/bg ohne stillen Rückfall
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { AppProvider } from '../../context/AppContext';
import { AuthProvider } from '../../context/AuthContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { t } from '../../i18n';
import { loginAsDefaultAdmin, seedDefaultAdminUser } from '../../test/authFixtures';
import { AppShell } from './AppShell';
import { BottomNav } from './BottomNav';
import { SidebarNav } from './SidebarNav';
import { UserMenu } from './UserMenu';
import { MehrPage } from '../../pages/MehrPage';
import { FinanzenPage } from '../../pages/FinanzenPage';
import {
  DESKTOP_NAV_ITEMS,
  DESKTOP_SECONDARY_NAV_ITEMS,
  FINANZEN_HUB_GROUPS,
  MOBILE_BOTTOM_NAV_ITEMS,
  PRIMARY_NAV,
  SECONDARY_NAV_GROUPS,
  resolveMehrGroups,
} from './navConfig';
import fs from 'node:fs';
import path from 'node:path';

const APP_SOURCE = fs.readFileSync(path.resolve(__dirname, '../../App.tsx'), 'utf8');
const ROUTE_PATHS = Array.from(APP_SOURCE.matchAll(/<Route path="([^"]+)"/g)).map((m) => m[1]!);

function routeExists(to: string): boolean {
  return ROUTE_PATHS.some((route) => route === to || (route.includes(':') && new RegExp('^' + route.replace(/:[^/]+/g, '[^/]+') + '$').test(to)));
}

function withProviders(node: React.ReactNode, entries: string[] = ['/']) {
  return (
    <MemoryRouter initialEntries={entries}>
      <AuthProvider>
        <AppProvider initialSetup={DEFAULT_SETUP}>{node}</AppProvider>
      </AuthProvider>
    </MemoryRouter>
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('UIUX-FOUNDATION-01C — navConfig (A)', () => {
  it('Desktop 6 Hauptbereiche, Mobile exakt 5, beides aus PRIMARY_NAV abgeleitet', () => {
    expect(DESKTOP_NAV_ITEMS.map((i) => i.to)).toEqual(['/', '/ablage', '/vorgaenge', '/rechnungen/offen', '/finanzen', '/dokumente']);
    expect(MOBILE_BOTTOM_NAV_ITEMS.map((i) => i.to)).toEqual(['/', '/ablage', '/vorgaenge', '/rechnungen/offen', '/mehr']);
    expect(MOBILE_BOTTOM_NAV_ITEMS).toHaveLength(5);
    for (const item of MOBILE_BOTTOM_NAV_ITEMS.slice(0, 4)) expect(PRIMARY_NAV).toContain(item);
    expect(DESKTOP_NAV_ITEMS.some((i) => i.to === '/einstellungen')).toBe(false);
    expect(MOBILE_BOTTOM_NAV_ITEMS.some((i) => i.to === '/einstellungen' || i.to === '/assistent')).toBe(false);
  });

  it('Sekundärzone kommt aus den Mehr-Gruppen; jede konfigurierte Route existiert in App.tsx', () => {
    expect(DESKTOP_SECONDARY_NAV_ITEMS.map((i) => i.to)).toEqual(['/kunden', '/aufgaben', '/kommunikation', '/wissen']);
    const all = [...PRIMARY_NAV, ...SECONDARY_NAV_GROUPS.flatMap((g) => g.items), ...FINANZEN_HUB_GROUPS.flatMap((g) => g.items)];
    /* Einstellungen und Assistent haben genau einen Ort: Zahnrad/UserMenu bzw. Header-Werkzeug. */
    for (const item of all) expect(['/einstellungen', '/assistent']).not.toContain(item.to);
    for (const item of all) expect(routeExists(item.to), item.to).toBe(true);
  });

  it('Admin-Ziel nur mit bestehender Rolle', () => {
    const member = resolveMehrGroups({ isAdmin: false }).flatMap((g) => g.items.map((i) => i.to));
    const admin = resolveMehrGroups({ isAdmin: true }).flatMap((g) => g.items.map((i) => i.to));
    expect(member).not.toContain('/admin/users');
    expect(admin).toContain('/admin/users');
    expect(resolveMehrGroups({ isAdmin: false }).map((g) => g.id)).toEqual(['work', 'finance', 'officepilot', 'system']);
  });
});

describe('UIUX-FOUNDATION-01C — Sidebar (B)', () => {
  it('rendert Haupt- und Sekundärzone, aktiven Zustand mit aria-current und stabile Testids', () => {
    const html = renderToStaticMarkup(withProviders(<SidebarNav />, ['/vorgaenge/abc?vtab=order']));
    expect(html).toContain('data-testid="sidebar-nav-primary"');
    expect(html).toContain('data-testid="sidebar-nav-secondary"');
    expect(html).toContain('data-testid="sidebar-nav-link-home"');
    expect(html).toContain('data-testid="sidebar-nav-link-ablage"');
    expect(html).toContain('data-testid="sidebar-nav-link-finanzen"');
    expect(html).toContain('Weitere Bereiche');
    const active = html.match(/<a[^>]*sidebar-nav__item--active[^>]*>/g) ?? [];
    expect(active).toHaveLength(1);
    expect(active[0]).toContain('aria-current="page"');
    expect(active[0]).toContain('href="/vorgaenge"');
    expect(html).not.toContain('href="/steuerberater"');
    expect(html).not.toContain('href="/einstellungen"');
    expect(html).not.toContain('href="/assistent"');
  });
});

describe('UIUX-FOUNDATION-01C — BottomNav (C)', () => {
  it('fünf Ziele mit Icon + Text, Rechnungen an vierter Stelle, aktiver Zustand auf Eingang', () => {
    const html = renderToStaticMarkup(withProviders(<BottomNav />, ['/ablage/123']));
    const links = html.match(/<a [^>]*bottom-nav__item[^>]*>/g) ?? [];
    expect(links).toHaveLength(5);
    expect(links[3]).toContain('href="/rechnungen/offen"');
    expect(html).toContain('>Rechnungen</span>');
    expect(html).not.toContain('>OfficePilot</span>');
    const active = links.filter((l) => l.includes('bottom-nav__item--active'));
    expect(active).toHaveLength(1);
    expect(active[0]).toContain('aria-current="page"');
    expect(active[0]).toContain('href="/ablage"');
    expect((html.match(/data-icon=/g) ?? []).length).toBe(5);
  });
});

describe('UIUX-FOUNDATION-01C — Mehr (D)', () => {
  it('gruppierte Zeilenliste statt Karten; Member ohne Admin-Zeile', () => {
    const html = renderToStaticMarkup(withProviders(<MehrPage />));
    expect(html).toContain('data-testid="mehr-page"');
    expect(html).toContain('data-testid="mehr-group-work"');
    expect(html).toContain('data-testid="mehr-group-system"');
    expect(html).toContain('data-testid="mehr-link-finanzen"');
    expect(html).toContain('data-testid="mehr-link-dokumente"');
    /* 01D: Zeilen kommen aus dem kanonischen RowList-Pattern. */
    expect(html).toContain('row-list__item row-list__item--interactive nav-group__row');
    expect(html).not.toContain('mehr-link-card');
    expect(html).not.toContain('class="card');
    expect(html).not.toContain('href="/admin/users"');
    expect(html).not.toContain('href="/einstellungen"');
    expect(html).not.toContain('href="/assistent"');
    expect(html.indexOf('href="/kunden"')).toBeLessThan(html.indexOf('href="/synchronisation"'));
  });
});

describe('UIUX-FOUNDATION-01C — Header & Benutzermenü (E)', () => {
  it('AppShell zeigt Assistent- und Einstellungs-Werkzeug mit aria-label', () => {
    const html = renderToStaticMarkup(withProviders(<AppShell />));
    expect(html).toContain('data-testid="assistant-entry"');
    expect(html).toContain('href="/assistent"');
    expect(html).toContain('aria-label="OfficePilot-Assistent öffnen"');
    expect(html).toContain('data-testid="settings-gear"');
    expect(html).toContain('data-testid="sidebar-nav"');
    expect(html).toContain('data-testid="bottom-nav"');
    expect(html).toContain('data-testid="app-shell-search"');
  });

  it('Benutzermenü: Einstellungen, Admin (Rolle), Abmelden — kein „Mehr“', async () => {
    await seedDefaultAdminUser();
    await loginAsDefaultAdmin();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(withProviders(<UserMenu />));
      await Promise.resolve();
    });
    for (let i = 0; i < 20 && !container.querySelector('[data-testid="user-menu-dropdown-trigger"]'); i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    await act(async () => {
      container!.querySelector<HTMLButtonElement>('[data-testid="user-menu-dropdown-trigger"]')!.click();
    });
    expect(container.querySelector('[data-testid="user-menu-einstellungen"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="user-menu-admin"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="logout-button"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="user-menu-settings"]')).toBeNull();
    expect(container.innerHTML).not.toContain('href="/mehr"');
  });
});

describe('UIUX-FOUNDATION-01C — Finanzen-Hub (F)', () => {
  it('verlinkt nur bestehende Finanzbereiche und zeigt keine Beträge', () => {
    const html = renderToStaticMarkup(withProviders(<FinanzenPage />));
    expect(html).toContain('data-testid="finanzen-page"');
    for (const to of ['/ausgaben', '/ausgaben/offen', '/rechnungen/offen', '/steuerberater']) {
      expect(html).toContain(`href="${to}"`);
    }
    expect(html).not.toMatch(/\d+,\d{2}\s?€/);
    expect(html).not.toContain('money-display');
    expect(FINANZEN_HUB_GROUPS.flatMap((g) => g.items)).toHaveLength(4);
  });
});

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="probe">{location.pathname + location.search}</p>;
}

describe('UIUX-FOUNDATION-01C — Deep Links (G)', () => {
  it('Shell-Navigation verändert Deep-Link-Parameter nicht', () => {
    for (const entry of ['/vorgaenge/v1?vtab=invoices', '/vorgaenge/v1/rechnung?step=preview', '/rechnungen/r1?from=overview', '/ablage/i1', '/einstellungen/kommunikation']) {
      const html = renderToStaticMarkup(
        withProviders(
          <Routes>
            <Route element={<AppShell />}>
              <Route path="*" element={<LocationProbe />} />
            </Route>
          </Routes>,
          [entry],
        ),
      );
      expect(html, entry).toContain(`data-testid="probe">${entry}</p>`);
    }
  });
});

describe('UIUX-FOUNDATION-01C — i18n (H)', () => {
  it('neue Navigationsbegriffe in de/tr/bg ohne stillen Rückfall', () => {
    for (const key of ['nav.rechnungen', 'nav.finanzen', 'nav.secondaryTitle', 'nav.assistant.tool', 'mehr.group.work', 'mehr.group.system', 'finanzen.title', 'finanzen.steuerberater'] as const) {
      expect(t(key, 'de').trim(), key).not.toBe('');
      expect(t(key, 'tr'), key).not.toBe(t(key, 'de'));
      expect(t(key, 'bg'), key).not.toBe(t(key, 'de'));
    }
    expect(t('nav.heute', 'de')).toBe('Heute');
  });
});
