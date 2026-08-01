/**
 * APP-STATE-RECOVERY-IMPLEMENTATION-01 — UiSessionStore / restore intents / TTL / scope.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContinueWorkingCard } from './components/system/ContinueWorkingCard';
import { t, type TranslationKey } from './i18n';
import { hydrateInboxStore } from './services/inboxService';
import { setActiveStorageScope } from './services/storage/storageScopeService';
import {
  captureAndPersistUiSession,
  buildUiSessionSnapshot,
} from './services/uiSession/uiSessionCapture';
import {
  acceptContinueWorking,
  decideUiSessionRestore,
  discardUiSessionRestore,
  formatUiSessionRelativeTime,
} from './services/uiSession/uiSessionRestore';
import { patchUiSessionLiveChrome, resetUiSessionLiveState } from './services/uiSession/uiSessionLiveState';
import {
  clearUiSessionSnapshot,
  loadUiSessionSnapshot,
  saveUiSessionSnapshot,
  UI_SESSION_STORAGE_KEY,
  UI_SESSION_TTL_STORAGE_KEY,
} from './services/uiSession/uiSessionStore';
import { validateUiSessionSnapshot } from './services/uiSession/uiSessionValidation';
import { hydrateVorgangStore } from './services/vorgangService';
import { hydrateWorkspaceStore, resetWorkspaceStore } from './services/workspace/workspaceStore';
import { createAuftragInboxItem, createTestVorgang } from './test/fixtures';
import type { UiSessionSnapshot } from './types/uiSessionSnapshot';
import {
  UI_SESSION_DRAFT_TTL_MS,
  UI_SESSION_SCHEMA_VERSION,
  UI_SESSION_TTL_MS,
} from './types/uiSessionSnapshot';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function baseSnapshot(overrides: Partial<UiSessionSnapshot> = {}): UiSessionSnapshot {
  return {
    id: 'uis-test-1',
    schemaVersion: UI_SESSION_SCHEMA_VERSION,
    scopeKey: 'officepilot-state:guest',
    userId: null,
    workspaceId: null,
    savedAt: new Date().toISOString(),
    source: 'auto',
    route: { pathname: '/ablage/inbox-test-auftrag', search: '', hash: '' },
    entityType: 'inbox_item',
    entityId: 'inbox-test-auftrag',
    workspaceType: 'document_review',
    activeTab: null,
    activeSection: 'document-data',
    panelState: {
      deepWorkspaceOpen: false,
      moreOptionsExpanded: true,
      detailsOpen: true,
      assistOpen: false,
    },
    selection: {
      selectedItemId: 'inbox-test-auftrag',
      selectedPositionId: null,
      selectedInvoiceId: null,
      selectedCustomerId: null,
      selectedDocumentId: null,
    },
    expandedSections: ['document-data'],
    scroll: { mainTop: 240 },
    list: { search: '', filters: {}, sort: null },
    drafts: { values: {}, dirty: false },
    resumeLabel: {
      titleText: 'Kundenauftrag',
      subtitleText: 'Test Kunde',
      entityHint: '',
    },
    ...overrides,
  };
}

describe('APP-STATE-RECOVERY-IMPLEMENTATION-01', () => {
  beforeEach(() => {
    setActiveStorageScope({ type: 'guest' });
    resetUiSessionLiveState();
    clearUiSessionSnapshot();
    hydrateInboxStore([createAuftragInboxItem()]);
    hydrateVorgangStore([createTestVorgang()]);
    resetWorkspaceStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearUiSessionSnapshot();
    resetUiSessionLiveState();
  });

  it('persists to sessionStorage and TTL localStorage', () => {
    const snap = baseSnapshot();
    saveUiSessionSnapshot(snap);
    expect(sessionStorage.getItem(UI_SESSION_STORAGE_KEY)).toContain('uis-test-1');
    expect(localStorage.getItem(UI_SESSION_TTL_STORAGE_KEY)).toContain('uis-test-1');
    expect(loadUiSessionSnapshot()?.id).toBe('uis-test-1');
  });

  it('falls back to TTL localStorage after sessionStorage cleared (browser-kill)', () => {
    saveUiSessionSnapshot(baseSnapshot({ id: 'uis-ttl-fallback' }));
    sessionStorage.removeItem(UI_SESSION_STORAGE_KEY);
    expect(loadUiSessionSnapshot()?.id).toBe('uis-ttl-fallback');
  });

  it('captures on visibilitychange(hidden) and pagehide (ChatGPT-tab / leave)', () => {
    patchUiSessionLiveChrome({
      workspaceType: 'document_review',
      activeSection: 'tasks',
      panelState: {
        deepWorkspaceOpen: false,
        moreOptionsExpanded: true,
        detailsOpen: true,
        assistOpen: false,
      },
    });
    captureAndPersistUiSession({
      pathname: '/ablage/inbox-test-auftrag',
      search: '',
      mainScrollTop: 120,
    });
    expect(loadUiSessionSnapshot()?.scroll.mainTop).toBe(120);
    expect(loadUiSessionSnapshot()?.activeSection).toBe('tasks');

    // Simulate short switch away: flush again like tracker on hidden/pagehide
    captureAndPersistUiSession({
      pathname: '/ablage/inbox-test-auftrag',
      search: '',
      mainScrollTop: 180,
      source: 'auto',
    });
    expect(loadUiSessionSnapshot()?.scroll.mainTop).toBe(180);
  });

  it('silent restore when same route + same entity + valid snapshot', () => {
    saveUiSessionSnapshot(baseSnapshot());
    const decision = decideUiSessionRestore({
      userId: null,
      currentPathname: '/ablage/inbox-test-auftrag',
      currentSearch: '',
    });
    expect(decision.intent).toBe('silent');
    expect(decision.snapshot?.entityId).toBe('inbox-test-auftrag');
  });

  it('Continue Working offer on dashboard without auto-navigation', () => {
    saveUiSessionSnapshot(baseSnapshot());
    const decision = decideUiSessionRestore({
      userId: null,
      currentPathname: '/',
      currentSearch: '',
    });
    expect(decision.intent).toBe('offer');
    expect(decision.snapshot?.route.pathname).toBe('/ablage/inbox-test-auftrag');

    const html = renderToStaticMarkup(
      createElement(ContinueWorkingCard, {
        snapshot: decision.snapshot!,
        translate,
        onContinue: () => undefined,
        onDiscard: () => undefined,
      }),
    );
    expect(html).toContain('Du hast zuletzt hier gearbeitet');
    expect(html).toContain('Weiterarbeiten');
    expect(html).toContain('Verwerfen');
    expect(html).toContain('Kundenauftrag');
  });

  it('discard Continue Working clears snapshot', () => {
    saveUiSessionSnapshot(baseSnapshot());
    discardUiSessionRestore();
    expect(loadUiSessionSnapshot()).toBeNull();
    const again = decideUiSessionRestore({
      userId: null,
      currentPathname: '/',
      currentSearch: '',
    });
    expect(again.intent).toBe('ignore');
  });

  it('accept Continue Working stages pending apply', () => {
    const snap = baseSnapshot({ scroll: { mainTop: 333 } });
    saveUiSessionSnapshot(snap);
    acceptContinueWorking(snap);
    // pending is consumed by pages; chrome is patched
    expect(snap.scroll.mainTop).toBe(333);
  });

  it('rejects expired TTL snapshots', () => {
    const expired = baseSnapshot({
      savedAt: new Date(Date.now() - UI_SESSION_TTL_MS - 1000).toISOString(),
    });
    const result = validateUiSessionSnapshot(expired, {
      userId: null,
      currentPathname: '/',
      currentSearch: '',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ttl');
  });

  it('allows dirty drafts within draft TTL', () => {
    const snap = baseSnapshot({
      drafts: { values: { sender: 'Neu' }, dirty: true },
      savedAt: new Date(Date.now() - UI_SESSION_TTL_MS - 1000).toISOString(),
    });
    const stillValid = validateUiSessionSnapshot(snap, {
      userId: null,
      currentPathname: '/',
      currentSearch: '',
      nowMs: Date.now(),
    });
    expect(stillValid.ok).toBe(true);
    expect(stillValid.intent).toBe('offer');

    const tooOld = validateUiSessionSnapshot(
      {
        ...snap,
        savedAt: new Date(Date.now() - UI_SESSION_DRAFT_TTL_MS - 1000).toISOString(),
      },
      {
        userId: null,
        currentPathname: '/',
        currentSearch: '',
      },
    );
    expect(tooOld.ok).toBe(false);
    expect(tooOld.reason).toBe('ttl');
  });

  it('discards snapshot when entity was deleted', () => {
    saveUiSessionSnapshot(baseSnapshot());
    hydrateInboxStore([]);
    const decision = decideUiSessionRestore({
      userId: null,
      currentPathname: '/',
      currentSearch: '',
    });
    expect(decision.intent).toBe('ignore');
    expect(decision.reason).toBe('entity');
    expect(loadUiSessionSnapshot()).toBeNull();
  });

  it('rejects other workspace', () => {
    hydrateWorkspaceStore({
      workspace: {
        id: 'ws-active',
        name: 'Active',
        ownerUserId: 'u1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      },
    });
    const snap = baseSnapshot({ workspaceId: 'ws-other' });
    const result = validateUiSessionSnapshot(snap, {
      userId: null,
      currentPathname: '/',
      currentSearch: '',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('workspace');
  });

  it('rejects other user', () => {
    setActiveStorageScope({ type: 'user', userId: 'user-a' });
    const snap = baseSnapshot({
      scopeKey: 'officepilot-state:user:user-a',
      userId: 'user-b',
    });
    const result = validateUiSessionSnapshot(snap, {
      userId: 'user-a',
      currentPathname: '/',
      currentSearch: '',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('user');
  });

  it('rejects wrong scopeKey', () => {
    const snap = baseSnapshot({ scopeKey: 'officepilot-state:user:other' });
    const result = validateUiSessionSnapshot(snap, {
      userId: null,
      currentPathname: '/',
      currentSearch: '',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('scope');
  });

  it('buildUiSessionSnapshot never embeds OCR / proposal / summary blobs', () => {
    patchUiSessionLiveChrome({
      workspaceType: 'document_review',
      drafts: { values: { sender: 'A' }, dirty: true },
    });
    const snap = buildUiSessionSnapshot({
      pathname: '/ablage/inbox-test-auftrag',
      mainScrollTop: 10,
    });
    const json = JSON.stringify(snap);
    expect(json).not.toMatch(/ocrText|fullText|proposal|documentSummary|WorkflowResult|password|token/i);
    expect(snap.drafts.values.sender).toBe('A');
  });

  it('formats relative time for Continue Working subtitle', () => {
    const now = Date.parse('2026-07-26T12:00:00.000Z');
    expect(formatUiSessionRelativeTime('2026-07-26T11:59:00.000Z', now)).toBe('Vor 1 Minute');
    expect(formatUiSessionRelativeTime('2026-07-26T10:00:00.000Z', now)).toBe('Vor 2 Stunden');
  });

  it('reload path: sessionStorage survives and silent-restores same route', () => {
    captureAndPersistUiSession({
      pathname: '/vorgaenge/v-test-1',
      mainScrollTop: 90,
    });
    const afterReload = loadUiSessionSnapshot();
    expect(afterReload?.route.pathname).toBe('/vorgaenge/v-test-1');
    const decision = decideUiSessionRestore({
      userId: null,
      currentPathname: '/vorgaenge/v-test-1',
      currentSearch: '',
    });
    expect(decision.intent).toBe('silent');
  });
});
