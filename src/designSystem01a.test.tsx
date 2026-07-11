import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from './components/ui/Button';
import { Input } from './components/ui/Input';
import { Badge } from './components/ui/Card';
import { Skeleton, SkeletonStack } from './components/ui/Skeleton';
import { PageHeader } from './components/ui/PageHeader';
import { DropdownMenu } from './components/ui/DropdownMenu';
import { FileTypeIcon } from './components/ui/FileTypeIcon';
import { UserMenu } from './components/layout/UserMenu';
import { AppShell } from './components/layout/AppShell';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { DEFAULT_SETUP } from './data/mockData';
import { HeutePage } from './pages/HeutePage';
import { DocumentUploadPage } from './pages/DocumentUploadPage';
import { LoginPage } from './pages/LoginPage';
import { VorgaengePage } from './pages/VorgaengePage';
import { loginAsDefaultAdmin, seedDefaultAdminUser } from './test/authFixtures';

describe('DESIGN-SYSTEM-01A components', () => {
  it('renders button variants and loading state', () => {
    const html = renderToStaticMarkup(
      <>
        <Button variant="primary">Primary</Button>
        <Button variant="on-dark">On Dark</Button>
        <Button variant="on-dark-outline">On Dark Outline</Button>
        <Button variant="danger" loading>
          Loading
        </Button>
      </>,
    );

    expect(html).toContain('btn--primary');
    expect(html).toContain('btn--on-dark');
    expect(html).toContain('btn--on-dark-outline');
    expect(html).toContain('btn--loading');
    expect(html).toContain('aria-busy="true"');
  });

  it('renders input helper and error states', () => {
    const html = renderToStaticMarkup(
      <Input label="E-Mail" helperText="Hinweis" error="Pflichtfeld" data-testid="email-input" />,
    );

    expect(html).toContain('form-field__label');
    expect(html).toContain('E-Mail');
    expect(html).toContain('form-field__error');
    expect(html).toContain('Pflichtfeld');
    expect(html).toContain('input--error');
  });

  it('renders badge variants and skeletons', () => {
    const html = renderToStaticMarkup(
      <>
        <Badge tone="info">Info</Badge>
        <Badge tone="danger">Danger</Badge>
        <Skeleton variant="card" />
        <SkeletonStack count={2} variant="list-row" />
      </>,
    );

    expect(html).toContain('badge--info');
    expect(html).toContain('badge--danger');
    expect(html).toContain('skeleton--card');
    expect(html).toContain('skeleton-stack');
  });

  it('renders page header with actions', () => {
    const html = renderToStaticMarkup(
      <PageHeader
        title="Vorgänge"
        subtitle="Übersicht"
        primaryAction={<button type="button">Neu</button>}
        secondaryAction={<button type="button">Filter</button>}
      />,
    );

    expect(html).toContain('page-header__title');
    expect(html).toContain('Vorgänge');
    expect(html).toContain('page-header__actions');
  });

  it('file type icon replaces emoji preview label', () => {
    const html = renderToStaticMarkup(<FileTypeIcon mimeType="application/pdf" fileName="test.pdf" />);
    expect(html).toContain('file-type-icon');
    expect(html).toContain('PDF');
    expect(html).not.toContain('📄');
  });
});

describe('DESIGN-SYSTEM-01A dropdown menu', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    if (root) {
      act(() => root.unmount());
    }
    container?.remove();
  });

  async function mount(ui: ReactElement) {
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(ui);
      await Promise.resolve();
    });
  }

  it('opens, closes on outside click and ESC', async () => {
    await mount(
      <MemoryRouter>
        <DropdownMenu
          testId="test-dropdown"
          trigger={<span>Menü</span>}
          items={[
            { id: 'one', label: 'Eintrag 1', onSelect: vi.fn() },
            { id: 'two', label: 'Eintrag 2', href: '/mehr' },
          ]}
        />
      </MemoryRouter>,
    );

    expect(container.querySelector('[data-testid="test-dropdown-panel"]')).toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="test-dropdown-trigger"]')?.click();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="test-dropdown-panel"]')).not.toBeNull();

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="test-dropdown-panel"]')).toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="test-dropdown-trigger"]')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="test-dropdown-panel"]')).toBeNull();
  });
});

describe('DESIGN-SYSTEM-01A app shell and reference pages', () => {
  it('user menu contains expected actions when authenticated', async () => {
    await seedDefaultAdminUser();
    await loginAsDefaultAdmin();

    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root;

    await act(async () => {
      root = createRoot(container);
      root.render(
        <MemoryRouter>
          <AuthProvider>
            <AppProvider initialSetup={DEFAULT_SETUP}>
              <UserMenu />
            </AppProvider>
          </AuthProvider>
        </MemoryRouter>,
      );
      await Promise.resolve();
    });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (container.querySelector('[data-testid="user-menu"]')) break;
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(container.querySelector('[data-testid="user-menu"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="user-menu-dropdown-trigger"]')).not.toBeNull();
    expect(container.innerHTML).not.toContain('app-shell__settings');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('app shell keeps sidebar and bottom navigation markup', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AuthProvider>
          <AppProvider initialSetup={DEFAULT_SETUP}>
            <AppShell />
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="sidebar-nav"');
    expect(html).toContain('data-testid="bottom-nav"');
    expect(html).toContain('app-shell__top-right');
  });

  it('reference pages render after design system update', () => {
    expect(
      renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider initialSetup={DEFAULT_SETUP}>
            <HeutePage />
          </AppProvider>
        </MemoryRouter>,
      ),
    ).toContain('data-testid="heute-page"');

    expect(
      renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider initialSetup={DEFAULT_SETUP}>
            <DocumentUploadPage />
          </AppProvider>
        </MemoryRouter>,
      ),
    ).toContain('data-testid="document-upload-page"');

    expect(
      renderToStaticMarkup(
        <MemoryRouter>
          <AuthProvider>
            <LoginPage />
          </AuthProvider>
        </MemoryRouter>,
      ),
    ).toContain('data-testid="login-page"');

    expect(
      renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider initialSetup={DEFAULT_SETUP}>
            <VorgaengePage />
          </AppProvider>
        </MemoryRouter>,
      ),
    ).toContain('page-header__title');
  });
});
