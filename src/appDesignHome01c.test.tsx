import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { MOCK_INBOX_ITEMS } from './data/inboxMockData';
import { DeskPriorities } from './components/home/DeskPriorities';
import { buildDeskPriorities } from './services/deskIntelligenceService';
import * as deskIntelligenceService from './services/deskIntelligenceService';
import { hydrateInboxStore } from './services/inboxService';
import { hydrateVorgangStore } from './services/vorgangService';
import { hydrateTaskStore } from './services/taskStore';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import {
  resetHomeHintDismissals,
  snoozeHomeHint,
  dismissHomeHint,
} from './services/homeHintDismissalService';
import * as homeHintDismissalService from './services/homeHintDismissalService';
import { createTestVorgang } from './test/fixtures';
import { t } from './i18n';
import type { HomeHint } from './services/homeHintService';

function seedDeskData() {
  resetHomeHintDismissals();
  hydrateInboxStore(MOCK_INBOX_ITEMS.map((item) => ({ ...item })));
  hydrateVorgangStore([
    createTestVorgang({ id: 'v-desk-1', title: 'Badumbau Müller', customer: 'Müller GmbH' }),
  ]);
  hydrateTaskStore([]);
  hydrateCompanyProfileStore({ contactPerson: 'Max Mustermann', companyName: 'Test GmbH' });
}

function byTestId(root: ParentNode, testId: string): HTMLElement | null {
  return (
    Array.from(root.querySelectorAll<HTMLElement>('[data-testid]')).find(
      (el) => el.getAttribute('data-testid') === testId,
    ) ?? null
  );
}

function requirePriorities(minCount = 1): HomeHint[] {
  const priorities = buildDeskPriorities().slice(0, 3);
  expect(priorities.length).toBeGreaterThanOrEqual(minCount);
  return priorities;
}

function clearDeskData() {
  resetHomeHintDismissals();
  hydrateInboxStore([]);
  hydrateVorgangStore([]);
  hydrateTaskStore([]);
}

function renderStatic() {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AppProvider initialSetup={DEFAULT_SETUP}>
        <DeskPriorities />
      </AppProvider>
    </MemoryRouter>,
  );
}

describe('APP-DESIGN-HOME-01C DeskPriorities actions', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    seedDeskData();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root.unmount();
      });
    }
    container.remove();
    vi.restoreAllMocks();
    resetHomeHintDismissals();
  });

  async function mount(ui: ReactElement) {
    await act(async () => {
      root = createRoot(container);
      root.render(ui);
      await Promise.resolve();
    });
  }

  async function mountDesk() {
    await mount(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <DeskPriorities />
        </AppProvider>
      </MemoryRouter>,
    );
  }

  it('zeigt pro Priorität Text, Erledigt und genau einen neutralen Menütrigger', () => {
    const priorities = requirePriorities(1);
    const html = renderStatic();

    for (const hint of priorities) {
      expect(html).toContain(`data-testid="desk-priority-${hint.id}"`);
      expect(html).toContain(`data-testid="desk-priority-done-${hint.id}"`);
      expect(html).toContain(`data-testid="desk-priority-more-${hint.id}-trigger"`);
      expect(html).toContain(t('hints.action.done', 'de'));
      expect(html).toContain(t('invoice.moreActions', 'de'));
    }

    const doneMatches = html.match(/data-testid="desk-priority-done-/g) ?? [];
    const triggerMatches = html.match(/data-testid="desk-priority-more-[^"]+-trigger"/g) ?? [];
    expect(doneMatches).toHaveLength(priorities.length);
    expect(triggerMatches).toHaveLength(priorities.length);
  });

  it('hält Snooze- und Ausblenden-Aktionen geschlossen nicht sichtbar', () => {
    const priorities = requirePriorities(1);
    const html = renderStatic();

    for (const hint of priorities) {
      expect(html).not.toContain(`data-testid="desk-priority-snooze-tomorrow-${hint.id}"`);
      expect(html).not.toContain(`data-testid="desk-priority-snooze-3days-${hint.id}"`);
      expect(html).not.toContain(`data-testid="desk-priority-snooze-nextweek-${hint.id}"`);
      expect(html).not.toContain(`data-testid="desk-priority-hide-${hint.id}"`);
    }
  });

  it('zeigt nach Öffnen die vier Aktionen in fester Reihenfolge', async () => {
    const hint = requirePriorities(1)[0];
    await mountDesk();

    expect(byTestId(container, `desk-priority-more-${hint.id}-panel`)).toBeNull();

    await act(async () => {
      byTestId(container, `desk-priority-more-${hint.id}-trigger`)?.click();
      await Promise.resolve();
    });

    const panel = byTestId(container, `desk-priority-more-${hint.id}-panel`);
    expect(panel).not.toBeNull();

    const items = Array.from(panel!.querySelectorAll('[role="menuitem"]'));
    expect(items).toHaveLength(4);
    expect(items[0].getAttribute('data-testid')).toBe(`desk-priority-snooze-tomorrow-${hint.id}`);
    expect(items[1].getAttribute('data-testid')).toBe(`desk-priority-snooze-3days-${hint.id}`);
    expect(items[2].getAttribute('data-testid')).toBe(`desk-priority-snooze-nextweek-${hint.id}`);
    expect(items[3].getAttribute('data-testid')).toBe(`desk-priority-hide-${hint.id}`);
    expect(items[0].textContent).toContain(t('hints.action.snoozeTomorrow', 'de'));
    expect(items[1].textContent).toContain(t('hints.action.snooze3Days', 'de'));
    expect(items[2].textContent).toContain(t('hints.action.snoozeNextWeek', 'de'));
    expect(items[3].textContent).toContain(t('hints.action.hide', 'de'));
    expect(items[3].className).toContain('dropdown-menu__item--danger');
  });

  it('ruft Snooze-Handler mit unveränderten Zeiträumen auf', async () => {
    const hint = requirePriorities(1)[0];
    const snoozeSpy = vi
      .spyOn(homeHintDismissalService, 'snoozeHomeHint')
      .mockImplementation(() => undefined);

    for (const duration of ['tomorrow', '3days', 'nextweek'] as const) {
      seedDeskData();
      snoozeSpy.mockClear();
      if (root) {
        await act(async () => {
          root.unmount();
          await Promise.resolve();
        });
      }
      await mountDesk();

      await act(async () => {
        byTestId(container, `desk-priority-more-${hint.id}-trigger`)?.click();
        await Promise.resolve();
      });
      await act(async () => {
        byTestId(container, `desk-priority-snooze-${duration}-${hint.id}`)?.click();
        await Promise.resolve();
      });
      expect(snoozeSpy).toHaveBeenCalledTimes(1);
      expect(snoozeSpy).toHaveBeenCalledWith(hint.id, duration);
    }
  });

  it('ruft Ausblenden über dismissHomeHint mit hidden auf', async () => {
    const hint = requirePriorities(1)[0];
    const dismissSpy = vi.spyOn(homeHintDismissalService, 'dismissHomeHint');

    await mountDesk();

    await act(async () => {
      byTestId(container, `desk-priority-more-${hint.id}-trigger`)?.click();
      await Promise.resolve();
    });
    await act(async () => {
      byTestId(container, `desk-priority-hide-${hint.id}`)?.click();
      await Promise.resolve();
    });

    expect(dismissSpy).toHaveBeenCalledWith(hint.id, 'hidden');
  });

  it('lässt Erledigt direkt sichtbar und unverändert wirksam', async () => {
    const hint = requirePriorities(1)[0];
    const dismissSpy = vi.spyOn(homeHintDismissalService, 'dismissHomeHint');

    await mountDesk();

    const doneButton = byTestId(container, `desk-priority-done-${hint.id}`);
    expect(doneButton).not.toBeNull();
    expect(doneButton!.textContent).toContain(t('hints.action.done', 'de'));

    await act(async () => {
      doneButton!.click();
      await Promise.resolve();
    });

    expect(dismissSpy).toHaveBeenCalledWith(hint.id, 'done');
  });

  it('schließt Menü bei Escape und Outside-Click', async () => {
    const hint = requirePriorities(1)[0];
    await mountDesk();

    await act(async () => {
      byTestId(container, `desk-priority-more-${hint.id}-trigger`)?.click();
      await Promise.resolve();
    });
    expect(byTestId(container, `desk-priority-more-${hint.id}-panel`)).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await Promise.resolve();
    });
    expect(byTestId(container, `desk-priority-more-${hint.id}-panel`)).toBeNull();

    await act(async () => {
      byTestId(container, `desk-priority-more-${hint.id}-trigger`)?.click();
      await Promise.resolve();
    });
    expect(byTestId(container, `desk-priority-more-${hint.id}-panel`)).not.toBeNull();

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await Promise.resolve();
    });
    expect(byTestId(container, `desk-priority-more-${hint.id}-panel`)).toBeNull();
  });

  it('behandelt Innenklick ohne Schließen und ohne Aktion durch Bubbling', async () => {
    const hint = requirePriorities(1)[0];
    const snoozeSpy = vi
      .spyOn(homeHintDismissalService, 'snoozeHomeHint')
      .mockImplementation(() => undefined);

    await mountDesk();

    await act(async () => {
      byTestId(container, `desk-priority-more-${hint.id}-trigger`)?.click();
      await Promise.resolve();
    });

    const panel = byTestId(container, `desk-priority-more-${hint.id}-panel`);
    expect(panel).not.toBeNull();

    await act(async () => {
      panel!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await Promise.resolve();
    });
    expect(byTestId(container, `desk-priority-more-${hint.id}-panel`)).not.toBeNull();
    expect(snoozeSpy).not.toHaveBeenCalled();

    await act(async () => {
      byTestId(container, `desk-priority-snooze-tomorrow-${hint.id}`)?.click();
      await Promise.resolve();
    });

    expect(snoozeSpy).toHaveBeenCalledTimes(1);
    expect(snoozeSpy).toHaveBeenCalledWith(hint.id, 'tomorrow');
    expect(byTestId(container, `desk-priority-more-${hint.id}-panel`)).toBeNull();
  });

  it('steuert bei mehreren Prioritäten nur die zugehörige ID', async () => {
    const snoozeSpy = vi
      .spyOn(homeHintDismissalService, 'snoozeHomeHint')
      .mockImplementation(() => undefined);
    const dismissSpy = vi
      .spyOn(homeHintDismissalService, 'dismissHomeHint')
      .mockImplementation(() => undefined);

    const controlled: HomeHint[] = [
      {
        id: 'desk-hint-a',
        severity: 'critical',
        messageKey: 'desk.priority.newDocuments',
        params: { count: 2 },
        route: '/eingang',
      },
      {
        id: 'desk-hint-b',
        severity: 'warning',
        messageKey: 'desk.priority.deferredDocuments',
        params: { count: 1 },
        route: '/eingang',
      },
    ];
    vi.spyOn(deskIntelligenceService, 'buildDeskPriorities').mockReturnValue(controlled);

    const [first, second] = controlled;
    await mountDesk();

    await act(async () => {
      byTestId(container, `desk-priority-more-${second.id}-trigger`)?.click();
      await Promise.resolve();
    });

    expect(byTestId(container, `desk-priority-more-${first.id}-panel`)).toBeNull();
    expect(byTestId(container, `desk-priority-more-${second.id}-panel`)).not.toBeNull();

    await act(async () => {
      byTestId(container, `desk-priority-snooze-3days-${second.id}`)?.click();
      await Promise.resolve();
    });

    expect(snoozeSpy).toHaveBeenCalledTimes(1);
    expect(snoozeSpy).toHaveBeenCalledWith(second.id, '3days');
    expect(snoozeSpy).not.toHaveBeenCalledWith(first.id, expect.anything());

    await act(async () => {
      byTestId(container, `desk-priority-done-${first.id}`)?.click();
      await Promise.resolve();
    });

    expect(dismissSpy).toHaveBeenCalledWith(first.id, 'done');
    expect(dismissSpy).not.toHaveBeenCalledWith(second.id, 'done');
  });

  it('Empty State behält Text und entfernt grünes Emoji', () => {
    clearDeskData();
    const html = renderStatic();

    expect(html).toContain('data-testid="desk-priorities-empty"');
    expect(html).toContain(t('desk.noPriorities', 'de'));
    expect(html).not.toContain('🟢');
  });

  it('hält Prioritätsreihenfolge, Limit, Links und Routen unverändert', () => {
    const priorities = buildDeskPriorities().slice(0, 3);
    expect(priorities.length).toBeLessThanOrEqual(3);

    const html = renderStatic();
    const positions = priorities.map((hint) => html.indexOf(`data-testid="desk-priority-${hint.id}"`));
    expect(positions.every((pos) => pos >= 0)).toBe(true);
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }

    for (const hint of priorities) {
      if (hint.route) {
        expect(html).toContain(`href="${hint.route}"`);
      }
    }

    expect(html).not.toContain('data-testid="desk-recommendation"');
    expect(html).not.toContain('mobile-home-card');
  });

  it('behält Handler-Signaturen für snoozeHomeHint und dismissHomeHint', () => {
    expect(typeof snoozeHomeHint).toBe('function');
    expect(typeof dismissHomeHint).toBe('function');
  });
});
