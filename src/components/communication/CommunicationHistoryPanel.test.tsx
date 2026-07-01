import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { DEFAULT_SETUP } from '../../data/mockData';
import { AppProvider } from '../../context/AppContext';
import { CommunicationHistoryPanel } from './CommunicationHistoryPanel';
import { addCommunicationEvent, getEventsForContext } from '../../services/communicationHistoryService';
import { resetCommunicationHistoryStore } from '../../services/communicationHistoryStore';
import { COMMUNICATION_EXCERPT_MAX_LENGTH } from '../../types/communicationHistory';

const setupComplete = { ...DEFAULT_SETUP, setupComplete: true };

type Mount = { container: HTMLDivElement; root: Root };

function renderPanel(
  contextRef: { type: 'vorgang'; id: string } | { type: 'none' },
  refreshKey = 0,
): Mount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter>
        <AppProvider initialSetup={setupComplete}>
          <CommunicationHistoryPanel contextRef={contextRef} refreshKey={refreshKey} />
        </AppProvider>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

describe('CommunicationHistoryPanel', () => {
  let mounted: Mount | undefined;

  beforeEach(() => {
    resetCommunicationHistoryStore();
  });

  afterEach(() => {
    if (mounted) {
      act(() => {
        mounted!.root.unmount();
      });
      mounted.container.remove();
      mounted = undefined;
    }
  });

  it('renders empty state', () => {
    mounted = renderPanel({ type: 'none' });
    expect(mounted.container.querySelector('[data-testid="communication-history"]')).not.toBeNull();
    expect(mounted.container.textContent).toContain('Noch keine Einträge');
  });

  it('renders events with time, type, channel and context', () => {
    const created = addCommunicationEvent({
      type: 'draft_created',
      intent: 'payment_reminder',
      channel: 'email',
      contextRef: { type: 'vorgang', id: 'v-panel-1' },
      status: 'complete',
      userInputExcerpt: 'Zahlung erinnern',
      resultExcerpt: 'Zahlungserinnerung für Rechnung',
      disclaimerShown: true,
    });
    expect(created).not.toBeNull();
    expect(getEventsForContext({ type: 'vorgang', id: 'v-panel-1' })).toHaveLength(1);

    mounted = renderPanel({ type: 'vorgang', id: 'v-panel-1' });
    const items = mounted.container.querySelectorAll('[data-testid="communication-history-item"]');
    expect(items.length).toBe(1);
    expect(mounted.container.querySelector('[data-testid="communication-history-type"]')?.textContent).toContain(
      'Entwurf erstellt',
    );
    expect(mounted.container.querySelector('[data-testid="communication-history-channel"]')?.textContent).toContain(
      'E-Mail',
    );
    expect(mounted.container.querySelector('[data-testid="communication-history-context"]')?.textContent).toContain(
      'v-panel-1',
    );
  });

  it('shows only context-filtered events', () => {
    addCommunicationEvent({
      type: 'draft_created',
      contextRef: { type: 'vorgang', id: 'v-a' },
      status: 'complete',
      disclaimerShown: false,
    });
    addCommunicationEvent({
      type: 'draft_copied',
      contextRef: { type: 'inbox', id: 'inbox-a' },
      status: 'complete',
      disclaimerShown: false,
    });

    mounted = renderPanel({ type: 'vorgang', id: 'v-a' });
    expect(mounted.container.querySelectorAll('[data-testid="communication-history-item"]').length).toBe(1);
  });

  it('displays excerpts only, not full draft bodies', () => {
    const longBody = 'B'.repeat(500);
    addCommunicationEvent({
      type: 'draft_created',
      contextRef: { type: 'vorgang', id: 'v-long' },
      status: 'complete',
      disclaimerShown: false,
      resultExcerpt: longBody,
    });

    mounted = renderPanel({ type: 'vorgang', id: 'v-long' });
    const summary = mounted.container.querySelector('[data-testid="communication-history-item"] .card__title')?.textContent ?? '';
    expect(summary.length).toBeGreaterThan(0);
    expect(summary.length).toBeLessThanOrEqual(COMMUNICATION_EXCERPT_MAX_LENGTH);
    expect(summary).not.toContain('B'.repeat(200));
  });
});
