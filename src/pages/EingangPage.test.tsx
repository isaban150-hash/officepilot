import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { MOCK_INBOX_ITEMS } from '../data/inboxMockData';
import { EingangPage } from './EingangPage';
import { hydrateInboxStore } from '../services/inboxService';
import * as pendingEngineService from '../services/pendingEngineService';

describe('EingangPage pending scan', () => {
  beforeEach(() => {
    hydrateInboxStore(MOCK_INBOX_ITEMS.map((item) => ({ ...item })));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('führt beim initialen Laden nur einen Pending-Scan aus', () => {
    const scanSpy = vi.spyOn(pendingEngineService, 'scanPendingItems');

    renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <EingangPage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(scanSpy).toHaveBeenCalledTimes(1);
  });
});
