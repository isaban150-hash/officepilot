import { FormEvent, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Card, CardMeta, CardTitle, PageHeader } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import { searchOffice } from '../../services/officeSearchService';
import type { SearchResult } from '../../types/officeSearch';

interface SearchResultsListProps {
  results: SearchResult[];
  onSelect?: (result: SearchResult) => void;
  compact?: boolean;
}

export function SearchResultsList({ results, onSelect, compact = false }: SearchResultsListProps) {
  const { translate } = useApp();

  if (results.length === 0) {
    return <p className="empty-state">{translate('search.noResults')}</p>;
  }

  return (
    <ul className={`search-results-list${compact ? ' search-results-list--compact' : ''}`}>
      {results.map((result) => (
        <li key={result.id}>
          <button
            type="button"
            className="search-results-list__item"
            data-testid={`search-result-${result.id}`}
            onClick={() => onSelect?.(result)}
          >
            <span className="search-results-list__icon" aria-hidden="true">
              {result.icon}
            </span>
            <span className="search-results-list__content">
              <span className="search-results-list__title">{result.title}</span>
              <span className="search-results-list__subtitle">
                {result.subtitle} · {result.source}
              </span>
              {!compact && (
                <>
                  <span className="search-results-list__snippet">{result.snippet}</span>
                  <span className="search-results-list__meta">
                    {result.matchedField}
                    {result.status ? ` · ${result.status}` : ''}
                  </span>
                </>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

interface GlobalSearchBarProps {
  autoFocus?: boolean;
  compact?: boolean;
}

export function GlobalSearchBar({ autoFocus = false, compact = false }: GlobalSearchBarProps) {
  const { translate } = useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get('q') ?? '');

  const previewResults = useMemo(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];
    return searchOffice({ query: trimmed, limit: compact ? 5 : 8 });
  }, [query, compact]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    navigate(`/suche?q=${encodeURIComponent(trimmed)}`);
  };

  const handleSelect = (result: SearchResult) => {
    navigate(result.route);
  };

  return (
    <div className={`global-search${compact ? ' global-search--compact' : ''}`} data-testid="global-search">
      <form className="global-search__form" onSubmit={handleSubmit}>
        <input
          type="search"
          className="input global-search__input"
          placeholder={translate('search.globalPlaceholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoFocus={autoFocus}
          data-testid="global-search-input"
        />
      </form>

      {previewResults.length > 0 && (
        <div className="global-search__preview" data-testid="global-search-preview">
          <SearchResultsList results={previewResults} onSelect={handleSelect} compact={compact} />
          <button
            type="button"
            className="global-search__show-all"
            onClick={() => navigate(`/suche?q=${encodeURIComponent(query.trim())}`)}
          >
            {translate('search.showAll')}
          </button>
        </div>
      )}
    </div>
  );
}

export function SearchPage() {
  const { translate } = useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const query = searchParams.get('q') ?? '';

  const results = useMemo(() => {
    if (!query.trim()) return [];
    return searchOffice({ query, limit: 40 });
  }, [query]);

  return (
    <div className="page search-page" data-testid="search-page">
      <Link to="/" className="back-link">
        ← {translate('common.back')}
      </Link>

      <PageHeader title={translate('search.title')} subtitle={translate('search.subtitle')} />

      <section className="search-page__bar" data-testid="search-page-bar">
        <GlobalSearchBar autoFocus />
      </section>

      <Card className="search-page__results" data-testid="search-page-results">
        <CardTitle>
          {query.trim()
            ? translate('search.resultsFor').replace('{query}', query)
            : translate('search.enterQuery')}
        </CardTitle>
        {query.trim() && <CardMeta>{translate('search.resultCount').replace('{count}', String(results.length))}</CardMeta>}
        <SearchResultsList
          results={results}
          onSelect={(result) => navigate(result.route)}
        />
      </Card>
    </div>
  );
}
