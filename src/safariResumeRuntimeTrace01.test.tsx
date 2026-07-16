import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { DEFAULT_SETUP } from './data/mockData';
import { AppShell } from './components/layout/AppShell';
import {
  isSafariResumeDebugEnabled,
  SafariResumeDebugOverlay,
} from './components/system/SafariResumeDebugOverlay';
import { HeutePage } from './pages/HeutePage';
import { resetTestStores } from './test/resetStores';

function dispatchVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => state === 'hidden',
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('MOBILE-SAFARI-RESUME-RUNTIME-TRACE-01', () => {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    host?.remove();
    host = null;
    root = null;
    resetTestStores();
  });

  it('isSafariResumeDebugEnabled nur bei debugSafariResume=1', () => {
    expect(isSafariResumeDebugEnabled('')).toBe(false);
    expect(isSafariResumeDebugEnabled('foo=1')).toBe(false);
    expect(isSafariResumeDebugEnabled('debugSafariResume=0')).toBe(false);
    expect(isSafariResumeDebugEnabled('debugSafariResume=1')).toBe(true);
    expect(isSafariResumeDebugEnabled('x=1&debugSafariResume=1')).toBe(true);
  });

  it('Overlay erscheint nur mit ?debugSafariResume=1', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root!.render(
        createElement(
          MemoryRouter,
          { initialEntries: ['/'] },
          createElement(
            AuthProvider,
            null,
            createElement(
              AppProvider,
              { initialSetup: DEFAULT_SETUP },
              createElement(AppShell),
            ),
          ),
        ),
      );
    });

    expect(host.querySelector('[data-testid="safari-resume-debug-overlay"]')).toBeNull();

    await act(async () => {
      root!.unmount();
    });
    host.remove();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root!.render(
        createElement(
          MemoryRouter,
          { initialEntries: ['/?debugSafariResume=1'] },
          createElement(
            AuthProvider,
            null,
            createElement(
              AppProvider,
              { initialSetup: DEFAULT_SETUP },
              createElement(AppShell),
            ),
          ),
        ),
      );
    });

    expect(host.querySelector('[data-testid="safari-resume-debug-overlay"]')).not.toBeNull();
  });

  it('visibilitychange aktualisiert lastEvent und Messwerte', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root!.render(
        createElement(
          MemoryRouter,
          { initialEntries: ['/?debugSafariResume=1'] },
          createElement(
            AuthProvider,
            null,
            createElement(
              AppProvider,
              { initialSetup: DEFAULT_SETUP },
              createElement(
                Routes,
                null,
                createElement(Route, {
                  path: '/',
                  element: createElement(
                    'div',
                    { className: 'app-shell' },
                    createElement('div', { className: 'app-shell__body' },
                      createElement('main', { className: 'app-shell__main' },
                        createElement(HeutePage),
                      ),
                    ),
                    createElement(SafariResumeDebugOverlay),
                  ),
                }),
              ),
            ),
          ),
        ),
      );
    });

    const overlay = host.querySelector('[data-testid="safari-resume-debug-overlay"]');
    expect(overlay).not.toBeNull();
    expect(host.querySelector('[data-testid="safari-resume-debug-path"]')?.textContent).toBe('/');
    expect(host.querySelector('[data-testid="safari-resume-debug-heute-page"]')?.textContent).toBe(
      'true',
    );
    expect(
      host.querySelector('[data-testid="safari-resume-debug-main.clientHeight"]'),
    ).not.toBeNull();

    await act(async () => {
      dispatchVisibility('hidden');
    });
    expect(host.querySelector('[data-testid="safari-resume-debug-lastEvent"]')?.textContent).toBe(
      'visibilitychange:hidden',
    );

    await act(async () => {
      dispatchVisibility('visible');
    });
    expect(host.querySelector('[data-testid="safari-resume-debug-lastEvent"]')?.textContent).toBe(
      'visibilitychange:visible',
    );
    expect(host.querySelector('[data-testid="safari-resume-debug-visibility"]')?.textContent).toBe(
      'visible',
    );
    expect(host.querySelector('[data-testid="heute-page"]')).not.toBeNull();
  });

  it('AppShell ohne Debug-Parameter bleibt ohne ggf. störendes Overlay', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    function Probe() {
      const [ready] = useState(true);
      return ready
        ? createElement(
            MemoryRouter,
            { initialEntries: ['/'] },
            createElement(
              AuthProvider,
              null,
              createElement(AppProvider, { initialSetup: DEFAULT_SETUP }, createElement(AppShell)),
            ),
          )
        : null;
    }

    await act(async () => {
      root!.render(createElement(Probe));
    });

    expect(host.querySelector('[data-testid="app-shell"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="safari-resume-debug-overlay"]')).toBeNull();
    expect(host.querySelector('.app-shell__main')).not.toBeNull();
  });
});
