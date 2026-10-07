/**
 * CLOUD-SYNC S3 (WEISS-Recheck) — Bearbeiten hält Wissen, Wert und
 * abgeleiteten Schlüssel zusammen.
 *
 * Befund: Wissen „ALPHA" angelegt, über „Bearbeiten" das Feld „Wissen" auf
 * „BETA" geändert, gespeichert — der Wissenstext war BETA, der Wert blieb
 * ALPHA, auch nach dem Neuladen. Ursache war die Vorbelegung des Formulars:
 * Was beim Anlegen aus dem Text abgeleitet wurde (Schlüssel) bzw. aus ihm
 * übernommen wurde (Wert), erschien beim Bearbeiten als eigene Angabe.
 *
 * Geprüft wird der ganze Weg: Formular, Speicher, Neuladen, Sendeauftrag,
 * Cloud-Payload, Versand, Abzug auf einem zweiten Gerät, Deaktivieren,
 * Löschen, Duplikatprüfung und die Verbraucher (Kommunikationskontext,
 * Brain-Snapshot, KI-Prompt).
 *
 * Neutrale Beispieldaten.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgePanel } from './KnowledgePanel';
import { TestProviders } from '../../test/testProviders';
import { DEFAULT_SETUP } from '../../data/mockData';
import type { KnowledgeFact } from '../../types/knowledge';
import type { SyncMeta, SyncOutboxEntry } from '../../types/sync';
import {
  addKnowledgeFact,
  deriveKnowledgeKey,
  getKnowledgeFacts,
  getKnowledgeSnapshot,
  hydrateKnowledgeFacts,
  resetKnowledgeFacts,
  searchKnowledgeFacts,
} from '../../services/knowledgeService';
import {
  buildKnowledgeFactCloudPushPayload,
  stripKnowledgeFactForCloud,
  type WorkspaceKnowledgeFactRow,
} from '../../services/knowledge/knowledgeFactCloudService';
import { buildCommunicationContext } from '../../services/communicationContextService';
import { buildBrainSnapshot } from '../../services/brain/brainSnapshotService';
import { buildBrainPrompt } from '../../services/brain/brainPromptBuilder';
import {
  applyStateToStores,
  buildPersistedStateSnapshot,
  loadPersistedState,
  persistAll,
} from '../../services/persistenceService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from '../../services/sync/syncOutboxService';
import { resetSyncChangeTrackerForTests } from '../../services/sync/syncChangeTrackerService';
import { createSyncClient, resetSyncClientForTests } from '../../services/sync/syncClientService';
import { SupabaseSyncAdapter } from '../../services/sync/supabaseSyncAdapter';
import * as workspaceCloudService from '../../services/workspace/workspaceCloudService';
import { mergeRemoteWorkspacePullIntoState } from '../../services/workspace/workspaceProvisioningService';
import * as supabaseLib from '../../lib/supabase';

const WORKSPACE = 'ws-knowledge-s3-orange';
const DEVICE = 'device-knowledge-s3-orange';
const UPDATED_AT = '2026-10-06T12:00:00.000Z';
const ALPHA = 'ALPHA Testwissen zur Abnahme';
const BETA = 'BETA Testwissen zur Abnahme';

let root: Root | null = null;
let host: HTMLDivElement;

function syncMeta(version: number, overrides: Partial<SyncMeta> = {}): SyncMeta {
  return { updatedAt: UPDATED_AT, version, deleted: false, deviceId: DEVICE, workspaceId: WORKSPACE, ...overrides };
}

/** Ein Eintrag, wie ihn das Formular aus einem Wissenstext anlegt. */
function abgeleitet(text: string, overrides: Partial<KnowledgeFact> = {}): KnowledgeFact {
  return {
    id: 'knowledge-orange-1',
    scope: 'company',
    category: 'other',
    key: deriveKnowledgeKey(text),
    value: text,
    displayText: text,
    sourceType: 'user',
    confirmedAt: '2026-10-06T11:00:00.000Z',
    createdAt: '2026-10-06T11:00:00.000Z',
    active: true,
    ...overrides,
  };
}

function zeile(fact: KnowledgeFact, rowVersion: number, deleted = false): WorkspaceKnowledgeFactRow {
  return {
    workspace_id: WORKSPACE,
    client_fact_id: fact.id,
    scope: fact.scope,
    scope_id: fact.scopeId ?? null,
    category: fact.category,
    active: deleted ? false : fact.active,
    payload: stripKnowledgeFactForCloud(fact) as unknown as Record<string, unknown>,
    row_version: rowVersion,
    deleted,
    deleted_at: deleted ? UPDATED_AT : null,
    updated_at: UPDATED_AT,
  };
}

function pullMit(rows: WorkspaceKnowledgeFactRow[]) {
  return {
    workspace: null,
    members: [],
    settings: null,
    setupPayload: null,
    setupRowVersion: 0,
    setupUpdatedAt: null,
    companyProfilePayload: null,
    companyProfileRowVersion: 0,
    companyProfileUpdatedAt: null,
    vorgaenge: [],
    customers: [],
    knowledgeFacts: rows,
  } as unknown as Parameters<typeof mergeRemoteWorkspacePullIntoState>[1];
}

function wissensAuftraege(): SyncOutboxEntry[] {
  return getSyncOutboxSnapshot().filter(
    (entry) => entry.entityType === 'knowledge_fact' && entry.status !== 'completed',
  );
}

function mount(): void {
  if (root) act(() => root!.unmount());
  root = createRoot(host);
  act(() => {
    root!.render(
      createElement(
        MemoryRouter,
        null,
        createElement(TestProviders, { initialSetup: DEFAULT_SETUP }, createElement(KnowledgePanel)),
      ),
    );
  });
}

function q<T extends HTMLElement>(selector: string): T {
  return host.querySelector(selector) as T;
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function click(el: HTMLElement): void {
  act(() => el.click());
}

function karten(): HTMLElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>('[data-testid="knowledge-item"]'));
}

function knopf(karte: HTMLElement, beschriftung: string): HTMLButtonElement {
  const button = Array.from(karte.querySelectorAll('button')).find((b) => b.textContent?.trim() === beschriftung);
  if (!button) throw new Error(`Knopf fehlt: ${beschriftung}`);
  return button as HTMLButtonElement;
}

/** Der echte Produktweg: „Neu anlegen", nur der Wissenstext, „Speichern". */
function anlegen(text: string): void {
  click(q('[data-testid="knowledge-create"]'));
  setValue(q('[data-testid="knowledge-text"]'), text);
  click(q('[data-testid="knowledge-save"]'));
}

/** Der echte Produktweg: „Bearbeiten", nur das Feld „Wissen" ändern, „Speichern". */
function bearbeiten(von: string, nach: string): void {
  const karte = karten().find((el) => el.textContent?.includes(von));
  if (!karte) throw new Error(`Karte fehlt: ${von}`);
  click(knopf(karte, 'Bearbeiten'));
  setValue(q('[data-testid="knowledge-text"]'), nach);
  click(q('[data-testid="knowledge-save"]'));
}

function formular() {
  const text = q<HTMLTextAreaElement>('[data-testid="knowledge-text"]');
  const key = q<HTMLInputElement>('[data-testid="knowledge-key"]');
  const value = q<HTMLInputElement>('[data-testid="knowledge-value"]');
  return {
    text: text.value,
    key: key.value,
    keyPlatzhalter: key.placeholder,
    value: value.value,
    valuePlatzhalter: value.placeholder,
  };
}

beforeEach(() => {
  localStorage.clear();
  resetKnowledgeFacts();
  resetSyncOutboxForTests([]);
  resetSyncChangeTrackerForTests();
  resetSyncClientForTests({ ...createSyncClient(), deviceId: DEVICE, workspaceId: WORKSPACE, serverWorkspaceId: WORKSPACE });
  host = document.createElement('div');
  document.body.appendChild(host);
  mount();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host.remove();
  resetKnowledgeFacts();
  vi.restoreAllMocks();
});

describe('S3-ORANGE — Bearbeiten ALPHA → BETA über das Formular', () => {
  it('O1 — ALPHA anlegen: Wissen und Wert sind der Text, der Schlüssel ist aus ihm abgeleitet', () => {
    anlegen(ALPHA);

    const facts = getKnowledgeFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ displayText: ALPHA, value: ALPHA, key: deriveKnowledgeKey(ALPHA) });
  });

  it('O2 — Bearbeiten zeigt abgeleitete Angaben leer wie beim Anlegen, den Text vorbelegt', () => {
    anlegen(ALPHA);
    click(knopf(karten()[0]!, 'Bearbeiten'));

    expect(formular()).toEqual({
      text: ALPHA,
      key: '',
      keyPlatzhalter: deriveKnowledgeKey(ALPHA),
      value: '',
      valuePlatzhalter: ALPHA,
    });
  });

  it('O3 — ALPHA → BETA: Wissen, Wert und Schlüssel folgen; eine Karte; erneutes Bearbeiten ist konsistent', () => {
    anlegen(ALPHA);
    const id = getKnowledgeFacts()[0]!.id;

    bearbeiten(ALPHA, BETA);

    const facts = getKnowledgeFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ id, displayText: BETA, value: BETA, key: deriveKnowledgeKey(BETA) });
    // Die Karte zeigt nur noch die neue Fassung — Titel und Zeile „Schlüssel: Wert".
    expect(karten()).toHaveLength(1);
    expect(karten()[0]!.textContent).toContain(BETA);
    expect(karten()[0]!.textContent).toContain(`${deriveKnowledgeKey(BETA)}: ${BETA}`);
    expect(karten()[0]!.textContent).not.toContain('ALPHA');
    expect(karten()[0]!.textContent?.toLowerCase()).not.toContain('alpha');

    click(knopf(karten()[0]!, 'Bearbeiten'));
    expect(formular()).toEqual({
      text: BETA,
      key: '',
      keyPlatzhalter: deriveKnowledgeKey(BETA),
      value: '',
      valuePlatzhalter: BETA,
    });
    // Die Suche findet die alte Fassung nicht mehr.
    expect(searchKnowledgeFacts({ query: 'ALPHA' })).toEqual([]);
  });

  it('O4 — eine eigene Angabe bleibt beim Bearbeiten stehen (Wert und Schlüssel)', () => {
    expect(
      addKnowledgeFact({
        scope: 'company',
        category: 'pricing_history',
        key: 'anfahrt_pauschale',
        value: '55 €',
        displayText: 'Anfahrt pauschal 55 €',
        sourceType: 'user',
      }).success,
    ).toBe(true);
    mount();

    click(knopf(karten()[0]!, 'Bearbeiten'));
    expect(formular()).toMatchObject({ key: 'anfahrt_pauschale', value: '55 €' });
    setValue(q('[data-testid="knowledge-text"]'), 'Anfahrt pauschal 60 €');
    click(q('[data-testid="knowledge-save"]'));

    expect(getKnowledgeFacts()[0]).toMatchObject({
      displayText: 'Anfahrt pauschal 60 €',
      key: 'anfahrt_pauschale',
      value: '55 €',
    });
  });

  it('O5 — nach dem Neuladen bleibt die Fassung konsistent BETA', () => {
    anlegen(ALPHA);
    bearbeiten(ALPHA, BETA);
    const id = getKnowledgeFacts()[0]!.id;

    resetKnowledgeFacts();
    applyStateToStores(loadPersistedState()!);

    const facts = getKnowledgeFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ id, displayText: BETA, value: BETA, key: deriveKnowledgeKey(BETA) });
  });

  it('O6 — Doppelprüfung folgt dem neuen Text: ALPHA ist wieder frei, ein zweites BETA nicht', () => {
    anlegen(ALPHA);
    bearbeiten(ALPHA, BETA);

    anlegen(BETA);
    expect(getKnowledgeFacts()).toHaveLength(1);
    expect(host.textContent).toContain('Dieses Wissen existiert bereits');

    click(Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Abbrechen') as HTMLButtonElement);
    anlegen(ALPHA);
    expect(getKnowledgeFacts().map((fact) => fact.displayText).sort()).toEqual([ALPHA, BETA].sort());
  });
});

describe('S3-ORANGE — Cloud, zweites Gerät, Lebenszyklus, Verbraucher', () => {
  /** Wie nach einem bestätigten Versand: ALPHA mit Serverversion 1. */
  function bestaetigtesAlpha(): void {
    hydrateKnowledgeFacts([{ ...abgeleitet(ALPHA), sync: syncMeta(1) }]);
    persistAll(); // Grundlinie des Änderungsverfolgers
    resetSyncOutboxForTests([]);
    mount();
  }

  it('O7 — Sendeauftrag und Cloud-Payload tragen die neue Fassung, mit der bestätigten Version als Erwartung', async () => {
    bestaetigtesAlpha();
    bearbeiten(ALPHA, BETA);

    const auftraege = wissensAuftraege();
    expect(auftraege).toEqual([expect.objectContaining({ entityId: 'knowledge-orange-1', operation: 'update' })]);

    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    const upsert = vi
      .spyOn(workspaceCloudService, 'rpcUpsertWorkspaceSyncEntity')
      .mockResolvedValue({ rowVersion: 2, payload: {}, entityId: null, deduped: false });
    const adapter = new SupabaseSyncAdapter(null);
    vi.spyOn(adapter as unknown as { assertClient: () => unknown }, 'assertClient').mockReturnValue({});

    const result = await adapter.pushChanges({
      deviceId: DEVICE,
      workspaceId: WORKSPACE,
      state: buildPersistedStateSnapshot(),
      outbox: auftraege,
    });

    expect(result.failedOutbox).toEqual([]);
    const [, entityType, payload, rowVersion] = upsert.mock.calls[0]!;
    expect(entityType).toBe('knowledge_fact');
    expect(rowVersion).toBe(1);
    expect((payload as { payload: Record<string, unknown> }).payload).toMatchObject({
      displayText: BETA,
      value: BETA,
      key: deriveKnowledgeKey(BETA),
    });
    expect(JSON.stringify(payload)).not.toContain('ALPHA');
    expect(result.state.knowledgeFacts?.[0]).toMatchObject({ displayText: BETA, value: BETA, sync: expect.objectContaining({ version: 2 }) });
  });

  it('O8 — zweites Gerät: der Abzug liefert genau die BETA-Fassung, ohne Doppel und ohne Rücksendung', () => {
    const beta = abgeleitet(BETA, { updatedAt: UPDATED_AT });
    // Frisches Gerät, nichts lokal.
    const frisch = mergeRemoteWorkspacePullIntoState(buildPersistedStateSnapshot(), pullMit([zeile(beta, 2)]));
    expect(frisch.conflicts).toEqual([]);
    expect(frisch.state.knowledgeFacts).toHaveLength(1);
    expect(frisch.state.knowledgeFacts?.[0]).toMatchObject({ displayText: BETA, value: BETA, key: deriveKnowledgeKey(BETA) });
    expect(wissensAuftraege()).toEqual([]);

    // Gerät mit der alten bestätigten ALPHA-Fassung: die neuere BETA-Fassung ersetzt sie.
    hydrateKnowledgeFacts([{ ...abgeleitet(ALPHA), sync: syncMeta(1) }]);
    const alt = mergeRemoteWorkspacePullIntoState(buildPersistedStateSnapshot(), pullMit([zeile(beta, 2)]));
    expect(alt.conflicts).toEqual([]);
    expect(alt.state.knowledgeFacts).toHaveLength(1);
    expect(alt.state.knowledgeFacts?.[0]).toMatchObject({ displayText: BETA, value: BETA, sync: expect.objectContaining({ version: 2 }) });
  });

  it('O9 — Deaktivieren bleibt, wie es war: nur das Aktiv-Kennzeichen ändert sich', () => {
    bestaetigtesAlpha();
    bearbeiten(ALPHA, BETA);
    resetSyncOutboxForTests([]);

    click(knopf(karten()[0]!, 'Deaktivieren'));

    expect(getKnowledgeFacts()[0]).toMatchObject({
      active: false,
      displayText: BETA,
      value: BETA,
      key: deriveKnowledgeKey(BETA),
      sync: expect.objectContaining({ version: 1, deleted: false }),
    });
    expect(wissensAuftraege()).toEqual([expect.objectContaining({ operation: 'update' })]);
  });

  it('O10 — Löschen bleibt, wie es war: Grabstein mit erhaltener Version, ein Löschauftrag', () => {
    bestaetigtesAlpha();
    bearbeiten(ALPHA, BETA);
    resetSyncOutboxForTests([]);

    click(knopf(karten()[0]!, 'Löschen'));

    expect(getKnowledgeFacts()).toEqual([]);
    expect(karten()).toHaveLength(0);
    const grabstein = getKnowledgeSnapshot().find((fact) => fact.id === 'knowledge-orange-1');
    expect(grabstein?.sync).toMatchObject({ deleted: true, version: 1 });
    expect(grabstein).toMatchObject({ displayText: BETA, value: BETA });
    expect(wissensAuftraege()).toEqual([expect.objectContaining({ operation: 'delete' })]);
    expect(buildKnowledgeFactCloudPushPayload(grabstein!, true)).toMatchObject({ deleted: true });
  });

  it('O11 — Kommunikationskontext, Brain-Snapshot und KI-Prompt erhalten die neue Fassung', () => {
    bestaetigtesAlpha();
    bearbeiten(ALPHA, BETA);

    const kontext = buildCommunicationContext({ type: 'vorgang', id: 'vorgang-ohne-bezug' });
    expect(kontext.facts.filter((fact) => fact.source === 'knowledge')).toEqual([
      { key: 'knowledge:knowledge-orange-1', value: BETA, source: 'knowledge' },
    ]);

    const snapshot = buildBrainSnapshot();
    expect(snapshot.knowledge).toEqual([{ scope: 'company', category: 'other', displayText: BETA }]);

    const prompt = buildBrainPrompt('Was gilt?', snapshot);
    expect(prompt).toContain(`[company] ${BETA}`);
    expect(prompt).not.toContain('ALPHA');
  });
});
