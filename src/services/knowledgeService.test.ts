import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { createTestVorgang } from '../test/fixtures';
import { buildCommunicationContext } from './communicationContextService';
import { loadPersistedState, persistAll } from './persistenceService';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { hydrateVorgangStore } from './vorgangService';
import {
  addKnowledgeFact,
  deleteKnowledgeFact,
  getKnowledgeFacts,
  getKnowledgeFactsForCommunicationContext,
  getKnowledgeFactsForScope,
  hydrateKnowledgeFacts,
  resetKnowledgeFacts,
  searchKnowledgeFacts,
  updateKnowledgeFact,
} from './knowledgeService';
import { resetKnowledgeStore } from './knowledgeStore';

function createFactInput(overrides: Partial<Parameters<typeof addKnowledgeFact>[0]> = {}) {
  return {
    scope: 'company' as const,
    category: 'communication_preference' as const,
    key: 'preferred_channel',
    value: 'whatsapp',
    displayText: 'Kunde bevorzugt WhatsApp',
    sourceType: 'user' as const,
    ...overrides,
  };
}

describe('knowledgeService', () => {
  beforeEach(() => {
    resetKnowledgeStore();
    localStorage.clear();
  });

  it('creates knowledge facts on user confirmation', () => {
    const result = addKnowledgeFact(createFactInput());
    expect(result.success).toBe(true);
    expect(getKnowledgeFacts()).toHaveLength(1);
    expect(getKnowledgeFacts()[0].confirmedAt).toBeTruthy();
    expect(getKnowledgeFacts()[0].sourceType).toBe('user');
  });

  it('updates and deletes knowledge facts', () => {
    const created = addKnowledgeFact(createFactInput());
    expect(created.success).toBe(true);
    if (!created.success) return;

    const updated = updateKnowledgeFact(created.fact.id, {
      displayText: 'Kunde bevorzugt E-Mail',
      value: 'email',
    });
    expect(updated.success).toBe(true);
    expect(getKnowledgeFacts()[0].displayText).toBe('Kunde bevorzugt E-Mail');

    const removed = deleteKnowledgeFact(created.fact.id);
    expect(removed.success).toBe(true);
    expect(getKnowledgeFacts()).toHaveLength(0);
  });

  it('persists knowledge facts', () => {
    addKnowledgeFact(createFactInput({ key: 'persist_key' }));
    persistAll({ ...DEFAULT_SETUP, setupComplete: true });

    resetKnowledgeStore();
    const loaded = loadPersistedState();
    expect(loaded?.knowledgeFacts).toHaveLength(1);
    hydrateKnowledgeFacts(loaded!.knowledgeFacts ?? []);
    expect(getKnowledgeFacts()[0].key).toBe('persist_key');
  });

  it('searches knowledge facts by query', () => {
    addKnowledgeFact(createFactInput({ key: 'alpha', displayText: 'Alpha Text' }));
    addKnowledgeFact(createFactInput({ key: 'beta', displayText: 'Beta Hinweis' }));

    expect(searchKnowledgeFacts({ query: 'beta' })).toHaveLength(1);
    expect(searchKnowledgeFacts({ query: 'hinweis' })[0].key).toBe('beta');
  });

  it('filters by scope', () => {
    addKnowledgeFact(createFactInput({ scope: 'company', key: 'company_fact' }));
    addKnowledgeFact(
      createFactInput({
        scope: 'vorgang',
        scopeId: 'v-1',
        key: 'vorgang_fact',
      }),
    );

    expect(searchKnowledgeFacts({ scope: 'company' })).toHaveLength(1);
    expect(getKnowledgeFactsForScope('vorgang', 'v-1')).toHaveLength(1);
  });

  it('filters by category and active state', () => {
    const created = addKnowledgeFact(
      createFactInput({ category: 'scheduling', key: 'schedule_1' }),
    );
    addKnowledgeFact(createFactInput({ category: 'other', key: 'other_1' }));
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(searchKnowledgeFacts({ category: 'scheduling' })).toHaveLength(1);
    updateKnowledgeFact(created.fact.id, { active: false });
    expect(searchKnowledgeFacts({ active: false })).toHaveLength(1);
    expect(searchKnowledgeFacts({ active: true })).toHaveLength(1);
  });

  it('rejects duplicate active facts for same scope and key', () => {
    expect(addKnowledgeFact(createFactInput({ key: 'dup' })).success).toBe(true);
    expect(addKnowledgeFact(createFactInput({ key: 'dup' })).success).toBe(false);
    expect(getKnowledgeFacts()).toHaveLength(1);
  });

  it('loads active knowledge facts into communication context', () => {
    hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Test GmbH' });
    hydrateVorgangStore([createTestVorgang({ id: 'v-test-1', customer: 'Müller GmbH' })]);

    addKnowledgeFact(createFactInput({ key: 'company_pref', displayText: 'Firma: immer Siezen' }));
    addKnowledgeFact(
      createFactInput({
        scope: 'vorgang',
        scopeId: 'v-test-1',
        key: 'tiles',
        displayText: 'Graue Fliesen im Bad',
      }),
    );
    addKnowledgeFact(
      createFactInput({
        scope: 'customer',
        scopeId: 'Müller GmbH',
        key: 'contact',
        displayText: 'Ansprechpartner: Frau Müller',
      }),
    );
    addKnowledgeFact(
      createFactInput({
        scope: 'company',
        key: 'inactive_fact',
        displayText: 'Inaktiv',
        active: false,
      }),
    );

    const context = buildCommunicationContext({ type: 'vorgang', id: 'v-test-1' });
    const knowledgeFacts = context.facts.filter((fact) => fact.source === 'knowledge');
    expect(knowledgeFacts.some((fact) => fact.value.includes('Siezen'))).toBe(true);
    expect(knowledgeFacts.some((fact) => fact.value.includes('Graue Fliesen'))).toBe(true);
    expect(knowledgeFacts.some((fact) => fact.value.includes('Frau Müller'))).toBe(true);
    expect(knowledgeFacts.some((fact) => fact.value.includes('Inaktiv'))).toBe(false);
  });

  it('getKnowledgeFactsForCommunicationContext excludes inactive facts', () => {
    addKnowledgeFact(createFactInput({ key: 'active_one', displayText: 'Aktiv' }));
    addKnowledgeFact(createFactInput({ key: 'inactive_one', displayText: 'Inaktiv', active: false }));

    const facts = getKnowledgeFactsForCommunicationContext({ type: 'none' });
    expect(facts).toHaveLength(1);
    expect(facts[0].displayText).toBe('Aktiv');
  });

  it('resetKnowledgeFacts clears the store', () => {
    addKnowledgeFact(createFactInput());
    resetKnowledgeFacts();
    expect(getKnowledgeFacts()).toHaveLength(0);
  });
});
