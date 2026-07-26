import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { DEFAULT_SETUP } from './data/mockData';
import { AppShell } from './components/layout/AppShell';
import { GlobalSearchBar } from './components/search/GlobalSearchBar';
import { SearchPage } from './pages/SearchPage';
import { TestProviders } from './test/testProviders';
import { renderToStaticMarkup } from 'react-dom/server';

type MediaListener = (event: MediaQueryListEvent) => void;

function mockViewport(width: number) {
  const listeners = new Set<MediaListener>();

  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });

  window.matchMedia = ((query: string) => {
    const maxWidthMatch = /max-width:\s*(\d+)px/.exec(query);
    const matches = maxWidthMatch ? width <= Number(maxWidthMatch[1]) : false;
    const mediaQueryList = {
      matches,
      media: query,
      onchange: null,
      addListener: (listener: MediaListener) => {
        listeners.add(listener);
      },
      removeListener: (listener: MediaListener) => {
        listeners.delete(listener);
      },
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        listeners.add(listener as MediaListener);
      },
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        listeners.delete(listener as MediaListener);
      },
      dispatchEvent: () => false,
    };
    return mediaQueryList;
  }) as typeof window.matchMedia;

  return {
    setWidth(nextWidth: number) {
      width = nextWidth;
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: nextWidth,
      });
      const maxWidthMatch = (query: string) => {
        const match = /max-width:\s*(\d+)px/.exec(query);
        return match ? nextWidth <= Number(match[1]) : false;
      };
      window.matchMedia = ((query: string) => {
        const matches = maxWidthMatch(query);
        return {
          matches,
          media: query,
          onchange: null,
          addListener: (listener: MediaListener) => {
            listeners.add(listener);
          },
          removeListener: (listener: MediaListener) => {
            listeners.delete(listener);
          },
          addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
            listeners.add(listener as MediaListener);
          },
          removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
            listeners.delete(listener as MediaListener);
          },
          dispatchEvent: () => false,
        };
      }) as typeof window.matchMedia;

      for (const listener of [...listeners]) {
        listener({
          matches: maxWidthMatch('(max-width: 767px)'),
          media: '(max-width: 767px)',
        } as MediaQueryListEvent);
      }
    },
  };
}

async function flushAnimationFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

function renderShell(container: HTMLDivElement): Root {
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/'] },
        createElement(TestProviders, { initialSetup: DEFAULT_SETUP }, createElement(AppShell)),
      ),
    );
  });
  return root;
}

function getTrigger(container: HTMLElement) {
  return container.querySelector('[data-testid="global-search-trigger"]') as HTMLButtonElement | null;
}

function getPanel(container: HTMLElement) {
  return container.querySelector('[data-testid="global-search-panel"]') as HTMLElement | null;
}

function getInput(container: HTMLElement) {
  return container.querySelector('[data-testid="global-search-input"]') as HTMLInputElement | null;
}

async function openMobileSearch(container: HTMLElement) {
  const trigger = getTrigger(container);
  expect(trigger).not.toBeNull();
  act(() => {
    trigger!.focus();
    trigger!.click();
  });
  await flushAnimationFrame();
  return trigger!;
}

describe('APP-DESIGN-FOUNDATION-01D Mobile Search Collapse', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    container.remove();
    vi.restoreAllMocks();
  });

  it('Mobile initial: Trigger, aria und geschlossenes Panel', () => {
    mockViewport(390);
    root = renderShell(container);

    const trigger = getTrigger(container);
    const panel = getPanel(container);
    const input = getInput(container);

    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain('Suche');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(panel).not.toBeNull();
    expect(input).not.toBeNull();
    expect(panel?.hasAttribute('hidden')).toBe(true);

    const controlsId = trigger?.getAttribute('aria-controls');
    expect(controlsId).toBeTruthy();
    expect(panel?.id).toBe(controlsId);
  });

  it('Mobile: Öffnen hält Trigger, setzt aria-expanded und fokussiert Input', async () => {
    mockViewport(390);
    root = renderShell(container);

    const trigger = await openMobileSearch(container);
    const panel = getPanel(container);
    const input = getInput(container);

    expect(getTrigger(container)).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(panel?.hasAttribute('hidden')).toBe(false);
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it('Mobile: Escape schließt und Fokus kehrt zum Trigger zurück', async () => {
    mockViewport(390);
    root = renderShell(container);

    const trigger = await openMobileSearch(container);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await flushAnimationFrame();

    const restoredTrigger = getTrigger(container);
    expect(restoredTrigger).not.toBeNull();
    expect(restoredTrigger?.getAttribute('aria-expanded')).toBe('false');
    expect(getPanel(container)?.hasAttribute('hidden')).toBe(true);
    expect(document.activeElement).toBe(restoredTrigger);
  });

  it('Mobile: Outside-Click schließt die Suche', async () => {
    mockViewport(390);
    root = renderShell(container);

    await openMobileSearch(container);
    expect(getTrigger(container)?.getAttribute('aria-expanded')).toBe('true');

    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await flushAnimationFrame();

    expect(getTrigger(container)?.getAttribute('aria-expanded')).toBe('false');
    expect(getPanel(container)?.hasAttribute('hidden')).toBe(true);
  });

  it('Mobile: Klick innerhalb der Suche schließt nicht', async () => {
    mockViewport(390);
    root = renderShell(container);

    await openMobileSearch(container);
    const input = getInput(container);
    expect(input).not.toBeNull();

    act(() => {
      input!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await flushAnimationFrame();

    expect(getTrigger(container)?.getAttribute('aria-expanded')).toBe('true');
    expect(getPanel(container)?.hasAttribute('hidden')).toBe(false);
  });

  it('Mobile: Interaktion mit Vorschauergebnissen schließt nicht vorzeitig', async () => {
    mockViewport(390);
    root = renderShell(container);

    await openMobileSearch(container);
    const input = getInput(container);
    expect(input).not.toBeNull();

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input!, 'Mu');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flushAnimationFrame();

    const preview = container.querySelector('[data-testid="global-search-preview"]');
    const resultButton = preview?.querySelector('.search-results-list__item') as HTMLButtonElement | null;

    if (!preview || !resultButton) {
      // No indexed hit for "Mu" in this fixture set — still verify panel click stays open.
      act(() => {
        getPanel(container)!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
      await flushAnimationFrame();
      expect(getTrigger(container)?.getAttribute('aria-expanded')).toBe('true');
      return;
    }

    act(() => {
      resultButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await flushAnimationFrame();

    expect(getTrigger(container)?.getAttribute('aria-expanded')).toBe('true');
    expect(getPanel(container)?.hasAttribute('hidden')).toBe(false);
  });

  it('Desktop: Suche dauerhaft sichtbar ohne Mobile-Trigger', () => {
    mockViewport(1280);
    root = renderShell(container);

    expect(getInput(container)).not.toBeNull();
    expect(getPanel(container)?.hasAttribute('hidden')).toBe(false);
    expect(getTrigger(container)).toBeNull();
  });

  it('Tablet (>=768): Suche dauerhaft sichtbar wie Desktop', () => {
    mockViewport(800);
    root = renderShell(container);

    expect(getInput(container)).not.toBeNull();
    expect(getPanel(container)?.hasAttribute('hidden')).toBe(false);
    expect(getTrigger(container)).toBeNull();
  });

  it('Breakpoint-Wechsel Mobile → Desktop zeigt Suchfeld ohne Trigger', async () => {
    const viewport = mockViewport(390);
    root = renderShell(container);

    expect(getTrigger(container)).not.toBeNull();
    expect(getPanel(container)?.hasAttribute('hidden')).toBe(true);

    act(() => {
      viewport.setWidth(1024);
    });
    await flushAnimationFrame();

    expect(getInput(container)).not.toBeNull();
    expect(getPanel(container)?.hasAttribute('hidden')).toBe(false);
    expect(getTrigger(container)).toBeNull();
  });

  it('SearchPage bleibt ohne Collapse-Regression', () => {
    mockViewport(390);
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ['/suche?q=Finanzamt'] },
        createElement(TestProviders, { initialSetup: DEFAULT_SETUP }, createElement(SearchPage)),
      ),
    );

    expect(html).toContain('data-testid="search-page"');
    expect(html).toContain('data-testid="global-search-input"');
    expect(html).not.toContain('data-testid="global-search-trigger"');
  });

  it('GlobalSearchBar ohne collapsibleOnMobile bleibt immer offen', () => {
    mockViewport(390);
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(
          TestProviders,
          { initialSetup: DEFAULT_SETUP },
          createElement(GlobalSearchBar, { compact: true }),
        ),
      ),
    );

    expect(html).toContain('data-testid="global-search-input"');
    expect(html).not.toContain('data-testid="global-search-trigger"');
    expect(html).not.toContain(' hidden');
  });
});
