import { useMemo, useState } from 'react';
import { Badge, Card, CardMeta, CardTitle } from '../ui/Card';
import { Button } from '../ui/Button';
import { useApp } from '../../context/AppContext';
import {
  addKnowledgeFact,
  deleteKnowledgeFact,
  searchKnowledgeFacts,
  updateKnowledgeFact,
} from '../../services/knowledgeService';
import {
  KNOWLEDGE_CATEGORIES,
  KNOWLEDGE_SCOPES,
  type KnowledgeCategory,
  type KnowledgeFact,
  type KnowledgeScope,
} from '../../types/knowledge';
import type { TranslationKey } from '../../i18n';

interface KnowledgeFormState {
  scope: KnowledgeScope;
  scopeId: string;
  scopeLabel: string;
  category: KnowledgeCategory;
  key: string;
  value: string;
  displayText: string;
  active: boolean;
}

const EMPTY_FORM: KnowledgeFormState = {
  scope: 'company',
  scopeId: '',
  scopeLabel: '',
  category: 'other',
  key: '',
  value: '',
  displayText: '',
  active: true,
};

function factToForm(fact: KnowledgeFact): KnowledgeFormState {
  return {
    scope: fact.scope,
    scopeId: fact.scopeId ?? '',
    scopeLabel: fact.scopeLabel ?? '',
    category: fact.category,
    key: fact.key,
    value: fact.value,
    displayText: fact.displayText,
    active: fact.active,
  };
}

export function KnowledgePanel() {
  const { translate, showToast } = useApp();
  const [query, setQuery] = useState('');
  const [scopeFilter, setScopeFilter] = useState<KnowledgeScope | 'all'>('all');
  const [categoryFilter, setCategoryFilter] = useState<KnowledgeCategory | 'all'>('all');
  const [activeFilter, setActiveFilter] = useState<boolean | 'all'>('all');
  const [refreshKey, setRefreshKey] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<KnowledgeFormState>(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);

  const facts = useMemo(
    () =>
      searchKnowledgeFacts({
        query,
        scope: scopeFilter,
        category: categoryFilter,
        active: activeFilter,
      }),
    [query, scopeFilter, categoryFilter, activeFilter, refreshKey],
  );

  const bump = () => setRefreshKey((value) => value + 1);

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setErrorKey(null);
    setShowForm(true);
  };

  const openEdit = (fact: KnowledgeFact) => {
    setEditingId(fact.id);
    setForm(factToForm(fact));
    setErrorKey(null);
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setErrorKey(null);
  };

  const handleSubmit = () => {
    setErrorKey(null);
    const payload = {
      scope: form.scope,
      scopeId: form.scopeId || undefined,
      scopeLabel: form.scopeLabel || undefined,
      category: form.category,
      key: form.key,
      value: form.value,
      displayText: form.displayText,
      active: form.active,
      sourceType: 'user' as const,
    };

    const result = editingId
      ? updateKnowledgeFact(editingId, payload)
      : addKnowledgeFact(payload);

    if (!result.success) {
      setErrorKey(result.errorKey as TranslationKey);
      return;
    }

    showToast(translate(editingId ? 'knowledge.updated' : 'knowledge.saved'));
    closeForm();
    bump();
  };

  const handleDelete = (id: string) => {
    const result = deleteKnowledgeFact(id);
    if (!result.success) {
      showToast(translate(result.errorKey as TranslationKey));
      return;
    }
    showToast(translate('knowledge.deleted'));
    if (editingId === id) closeForm();
    bump();
  };

  const handleToggleActive = (fact: KnowledgeFact) => {
    const result = updateKnowledgeFact(fact.id, { active: !fact.active });
    if (!result.success) {
      showToast(translate(result.errorKey as TranslationKey));
      return;
    }
    bump();
  };

  return (
    <div className="knowledge-panel" data-testid="knowledge-panel">
      <div className="knowledge-toolbar">
        <input
          type="search"
          className="input knowledge-search"
          placeholder={translate('knowledge.searchPlaceholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          data-testid="knowledge-search"
        />
        <Button type="button" onClick={openCreate} data-testid="knowledge-create">
          {translate('knowledge.add')}
        </Button>
      </div>

      <div className="chip-group knowledge-filters">
        <button
          type="button"
          className={`chip ${scopeFilter === 'all' ? 'chip--active' : ''}`}
          onClick={() => setScopeFilter('all')}
        >
          {translate('knowledge.scopeAll')}
        </button>
        {KNOWLEDGE_SCOPES.map((scope) => (
          <button
            key={scope}
            type="button"
            className={`chip ${scopeFilter === scope ? 'chip--active' : ''}`}
            onClick={() => setScopeFilter(scope)}
            data-testid={`knowledge-filter-scope-${scope}`}
          >
            {translate(`knowledge.scope.${scope}` as TranslationKey)}
          </button>
        ))}
      </div>

      <div className="chip-group knowledge-filters">
        <button
          type="button"
          className={`chip ${categoryFilter === 'all' ? 'chip--active' : ''}`}
          onClick={() => setCategoryFilter('all')}
        >
          {translate('knowledge.categoryAll')}
        </button>
        {KNOWLEDGE_CATEGORIES.map((category) => (
          <button
            key={category}
            type="button"
            className={`chip ${categoryFilter === category ? 'chip--active' : ''}`}
            onClick={() => setCategoryFilter(category)}
            data-testid={`knowledge-filter-category-${category}`}
          >
            {translate(`knowledge.category.${category}` as TranslationKey)}
          </button>
        ))}
      </div>

      <div className="chip-group knowledge-filters">
        {(['all', true, false] as const).map((option) => (
          <button
            key={String(option)}
            type="button"
            className={`chip ${activeFilter === option ? 'chip--active' : ''}`}
            onClick={() => setActiveFilter(option)}
            data-testid={`knowledge-filter-active-${String(option)}`}
          >
            {translate(
              option === 'all'
                ? 'knowledge.activeAll'
                : option
                  ? 'knowledge.activeOnly'
                  : 'knowledge.inactiveOnly',
            )}
          </button>
        ))}
      </div>

      {showForm && (
        <Card className="knowledge-form-card" data-testid="knowledge-form">
          <CardTitle>
            {translate(editingId ? 'knowledge.editTitle' : 'knowledge.createTitle')}
          </CardTitle>
          <div className="knowledge-form-grid">
            <label className="form-group">
              <span>{translate('knowledge.field.scope')}</span>
              <select
                className="input"
                value={form.scope}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    scope: event.target.value as KnowledgeScope,
                  }))
                }
              >
                {KNOWLEDGE_SCOPES.map((scope) => (
                  <option key={scope} value={scope}>
                    {translate(`knowledge.scope.${scope}` as TranslationKey)}
                  </option>
                ))}
              </select>
            </label>

            {form.scope !== 'company' && (
              <label className="form-group">
                <span>{translate('knowledge.field.scopeId')}</span>
                <input
                  className="input"
                  value={form.scopeId}
                  onChange={(event) => setForm((current) => ({ ...current, scopeId: event.target.value }))}
                />
              </label>
            )}

            <label className="form-group">
              <span>{translate('knowledge.field.scopeLabel')}</span>
              <input
                className="input"
                value={form.scopeLabel}
                onChange={(event) => setForm((current) => ({ ...current, scopeLabel: event.target.value }))}
              />
            </label>

            <label className="form-group">
              <span>{translate('knowledge.field.category')}</span>
              <select
                className="input"
                value={form.category}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    category: event.target.value as KnowledgeCategory,
                  }))
                }
              >
                {KNOWLEDGE_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {translate(`knowledge.category.${category}` as TranslationKey)}
                  </option>
                ))}
              </select>
            </label>

            <label className="form-group">
              <span>{translate('knowledge.field.key')}</span>
              <input
                className="input"
                value={form.key}
                onChange={(event) => setForm((current) => ({ ...current, key: event.target.value }))}
              />
            </label>

            <label className="form-group">
              <span>{translate('knowledge.field.value')}</span>
              <input
                className="input"
                value={form.value}
                onChange={(event) => setForm((current) => ({ ...current, value: event.target.value }))}
              />
            </label>

            <label className="form-group knowledge-form-grid__full">
              <span>{translate('knowledge.field.displayText')}</span>
              <textarea
                className="input"
                rows={3}
                value={form.displayText}
                onChange={(event) => setForm((current) => ({ ...current, displayText: event.target.value }))}
              />
            </label>

            <label className="form-group knowledge-form-grid__checkbox">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(event) => setForm((current) => ({ ...current, active: event.target.checked }))}
              />
              <span>{translate('knowledge.field.active')}</span>
            </label>
          </div>

          {errorKey && <p className="form-error">{translate(errorKey)}</p>}

          <div className="form-actions">
            <Button type="button" variant="ghost" onClick={closeForm}>
              {translate('common.cancel')}
            </Button>
            <Button type="button" onClick={handleSubmit} data-testid="knowledge-save">
              {translate('knowledge.confirmSave')}
            </Button>
          </div>
        </Card>
      )}

      {facts.length === 0 ? (
        <p className="empty-state">{translate('knowledge.empty')}</p>
      ) : (
        facts.map((fact) => (
          <div key={fact.id} data-testid="knowledge-item">
            <Card className={!fact.active ? 'knowledge-item--inactive' : ''}>
              <div className="knowledge-item__header">
                <CardTitle>{fact.displayText}</CardTitle>
                <div className="badge-row">
                  <Badge tone={fact.active ? 'success' : 'default'}>
                    {translate(fact.active ? 'knowledge.activeBadge' : 'knowledge.inactiveBadge')}
                  </Badge>
                  <Badge tone="info">{translate(`knowledge.scope.${fact.scope}` as TranslationKey)}</Badge>
                  <Badge>{translate(`knowledge.category.${fact.category}` as TranslationKey)}</Badge>
                </div>
              </div>
              <CardMeta>
                {fact.key}: {fact.value}
                {fact.scopeLabel ? ` · ${fact.scopeLabel}` : ''}
              </CardMeta>
              <div className="form-actions knowledge-item__actions">
                <Button type="button" variant="outline" onClick={() => openEdit(fact)}>
                  {translate('knowledge.edit')}
                </Button>
                <Button type="button" variant="outline" onClick={() => handleToggleActive(fact)}>
                  {translate(fact.active ? 'knowledge.deactivate' : 'knowledge.activate')}
                </Button>
                <Button type="button" variant="danger" onClick={() => handleDelete(fact.id)}>
                  {translate('knowledge.delete')}
                </Button>
              </div>
            </Card>
          </div>
        ))
      )}
    </div>
  );
}
