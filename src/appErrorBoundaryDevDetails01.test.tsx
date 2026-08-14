/**
 * CORE-REALTEST-BLOCKER-01B — die 500-Seite zeigt im Entwicklungsmodus die
 * technische Fehlermeldung, damit ein abgefangener Render-Fehler diagnostiziert
 * werden kann. In Produktion bleibt sie generisch.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppErrorBoundary } from './components/system/AppErrorBoundary';

const UNIQUE_MESSAGE = 'CORE-REALTEST-BLOCKER-01B Testfehler 4711';

function Boom(): never {
  throw new Error(UNIQUE_MESSAGE);
}

function Healthy() {
  return <p data-testid="healthy-content">Normaler Inhalt</p>;
}

function mount(children: React.ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<AppErrorBoundary>{children}</AppErrorBoundary>);
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('CORE-REALTEST-BLOCKER-01B — Dev-Fehlerdetails auf der 500-Seite', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // React protokolliert gefangene Fehler zusätzlich selbst; kontrolliert stumm.
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('rendert ohne Fehler den normalen Inhalt und keine 500-Seite', () => {
    const view = mount(<Healthy />);
    expect(view.container.querySelector('[data-testid="healthy-content"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="server-error-page"]')).toBeNull();
    expect(view.container.querySelector('[data-testid="server-error-dev-details"]')).toBeNull();
    view.unmount();
  });

  it('fängt den Fehler, zeigt die 500-Seite und die eindeutige Meldung', () => {
    const view = mount(<Boom />);
    const { container } = view;

    // Positive Vorbedingung: die 500-Seite ist gerendert.
    expect(container.querySelector('[data-testid="server-error-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="server-error-retry"]')).not.toBeNull();
    // Der normale Inhalt ist verschwunden.
    expect(container.querySelector('[data-testid="healthy-content"]')).toBeNull();

    // Dev-Diagnose: eindeutige Meldung und Component-Stack sichtbar.
    const details = container.querySelector('[data-testid="server-error-dev-details"]');
    expect(import.meta.env.DEV).toBe(true);
    expect(details).not.toBeNull();
    expect(details!.textContent).toContain('Technische Details');
    const message = container.querySelector('[data-testid="server-error-dev-message"]');
    expect(message).not.toBeNull();
    expect(message!.textContent).toBe(UNIQUE_MESSAGE);
    expect(container.textContent).toContain(UNIQUE_MESSAGE);

    const componentStack = container.querySelector(
      '[data-testid="server-error-dev-component-stack"]',
    );
    expect(componentStack).not.toBeNull();
    expect(componentStack!.textContent).toContain('Boom');

    // Der Fehler wurde protokolliert; der Spy wird im afterEach wiederhergestellt.
    expect(errorSpy).toHaveBeenCalled();
    view.unmount();
  });
});
