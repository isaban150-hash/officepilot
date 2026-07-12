import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { MOCK_INBOX_ITEMS } from './data/inboxMockData';
import { HeutePage } from './pages/HeutePage';
import { hydrateInboxStore } from './services/inboxService';
import { hydrateVorgangStore } from './services/vorgangService';
import { hydrateTaskStore } from './services/taskStore';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { resetHomeHintDismissals } from './services/homeHintDismissalService';
import {
  buildDeskGreeting,
  buildDeskPriorities,
  buildDeskRecommendation,
  buildDeskSuccesses,
  getDayPhase,
} from './services/deskIntelligenceService';
import { createTestVorgang } from './test/fixtures';
import { t } from './i18n';

describe('AI-DESK-01', () => {
  beforeEach(() => {
    resetHomeHintDismissals();
    hydrateInboxStore(MOCK_INBOX_ITEMS.map((item) => ({ ...item })));
    hydrateVorgangStore([
      createTestVorgang({ id: 'v-desk-1', title: 'Badumbau Müller', customer: 'Müller GmbH' }),
    ]);
    hydrateTaskStore([]);
    hydrateCompanyProfileStore({ contactPerson: 'Max Mustermann', companyName: 'Test GmbH' });
  });

  afterEach(() => {
    resetHomeHintDismissals();
  });

  it('Begrüßung morgens mit Name', () => {
    const greeting = buildDeskGreeting('Max', new Date('2026-07-06T08:00:00'));
    expect(greeting.messageKey).toBe('desk.greeting.morning');
    expect(greeting.firstName).toBe('Max');
  });

  it('Begrüßung mittags ohne Name', () => {
    const greeting = buildDeskGreeting(undefined, new Date('2026-07-06T13:00:00'));
    expect(greeting.messageKey).toBe('desk.greeting.midday');
    expect(greeting.firstName).toBeUndefined();
  });

  it('Begrüßung abends', () => {
    const greeting = buildDeskGreeting('Anna', new Date('2026-07-06T19:00:00'));
    expect(greeting.messageKey).toBe('desk.greeting.evening');
  });

  it('maximal 3 Prioritäten', () => {
    const priorities = buildDeskPriorities(new Date('2026-07-06T09:00:00'));
    expect(priorities.length).toBeLessThanOrEqual(3);
  });

  it('maximal 4 Erfolge', () => {
    const today = '2026-07-06T12:00:00';
    hydrateInboxStore([
      {
        ...MOCK_INBOX_ITEMS[0],
        id: 'inbox-d1',
        status: 'abgelegt',
        modifiedAt: '2026-07-06T10:00:00.000Z',
      },
      {
        ...MOCK_INBOX_ITEMS[0],
        id: 'inbox-d2',
        status: 'geprueft',
        modifiedAt: '2026-07-06T11:00:00.000Z',
      },
      {
        ...MOCK_INBOX_ITEMS[0],
        id: 'inbox-d3',
        status: 'abgelegt',
        modifiedAt: '2026-07-06T12:00:00.000Z',
      },
      {
        ...MOCK_INBOX_ITEMS[0],
        id: 'inbox-d4',
        vorgangLinkStatus: 'linked',
        modifiedAt: '2026-07-06T13:00:00.000Z',
      },
      {
        ...MOCK_INBOX_ITEMS[0],
        id: 'inbox-d5',
        vorgangLinkStatus: 'linked',
        modifiedAt: '2026-07-06T14:00:00.000Z',
      },
    ]);
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-desk-1',
        sync: { updatedAt: '2026-07-06T09:00:00.000Z', version: 1, clientId: 'c1' },
        invoices: [
          {
            id: 'inv-1',
            number: 'R-1',
            type: 'schlussrechnung',
            positions: [],
            subtotal: 100,
            taxStatus: 'standard_19',
            amount: 119,
            status: 'vorbereitet',
            date: '2026-07-06',
            createdAt: '2026-07-06T08:00:00.000Z',
          },
        ],
      }),
    ]);
    hydrateTaskStore([
      {
        id: 'task-1',
        title: 'Erledigt',
        description: 'Test',
        status: 'done',
        completedAt: '2026-07-06T15:00:00.000Z',
        createdAt: '2026-07-05T10:00:00.000Z',
        category: 'allgemein',
        priority: 'normal',
        sourceType: 'manual',
        taskKind: 'manual',
        dedupeKey: 'manual:task-1',
        autoCreated: false,
        type: 'allgemein',
      },
    ]);

    const successes = buildDeskSuccesses(today);
    expect(successes.length).toBeLessThanOrEqual(4);
    expect(successes.every((entry) => entry.count > 0)).toBe(true);
  });

  it('keine erfundenen Erfolge ohne Tagesdaten', () => {
    hydrateInboxStore(MOCK_INBOX_ITEMS.map((item) => ({ ...item, modifiedAt: '2026-01-01T10:00:00.000Z' })));
    const successes = buildDeskSuccesses(new Date('2026-07-06T12:00:00'));
    expect(successes).toHaveLength(0);
  });

  it('Tageskontext Morgen priorisiert neue Dokumente', () => {
    expect(getDayPhase(new Date('2026-07-06T08:00:00'))).toBe('morning');
    const morning = buildDeskPriorities(new Date('2026-07-06T08:00:00'));
    expect(morning.length).toBeLessThanOrEqual(3);
  });

  it('Tageskontext Mittag', () => {
    expect(getDayPhase(new Date('2026-07-06T14:00:00'))).toBe('midday');
    const midday = buildDeskPriorities(new Date('2026-07-06T14:00:00'));
    expect(midday.length).toBeLessThanOrEqual(3);
  });

  it('Tageskontext Abend', () => {
    expect(getDayPhase(new Date('2026-07-06T20:00:00'))).toBe('evening');
    const evening = buildDeskPriorities(new Date('2026-07-06T20:00:00'));
    expect(evening.length).toBeLessThanOrEqual(3);
  });

  it('Empfehlung nur aus vorhandenen Daten oder null', () => {
    const recommendation = buildDeskRecommendation(new Date('2026-07-06T12:00:00'));
    if (recommendation) {
      expect(recommendation.messageKey).toBeTruthy();
      expect(recommendation.messageKey).not.toMatch(/^desk\.fake/);
    }
  });

  it('Startseite rendert Schreibtisch-Sektionen', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <HeutePage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="desk-greeting-header"');
    expect(html).toContain('data-testid="desk-priorities"');
    expect(html).toContain('data-testid="mobile-first-home"');
    expect(html).toContain('data-testid="home-card-add-document"');
    expect(html).toContain('Heute kümmere ich mich um Folgendes:');
  });

  it('Desktop: 5 Hauptkarten bleiben erhalten', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={{ ...DEFAULT_SETUP, companyName: 'Test' }}>
          <HeutePage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="home-card-orders"');
    expect(html).toContain('data-testid="home-card-officepilot"');
    expect(html).toContain('data-testid="home-card-steuerberater"');
    expect(html).toContain('data-testid="home-card-more"');
  });

  it('DE/TR Desk-Texte', () => {
    expect(t('desk.greeting.morning', 'de')).toBe('Guten Morgen');
    expect(t('desk.noPriorities', 'de')).toContain('keine wichtigen Aufgaben');
    expect(t('desk.recommendationTitle', 'tr')).toBe('OfficePilot öneriyor');
  });
});
