import {
  FormEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Card, CardMeta, CardTitle, PageHeader } from '../ui/Card';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { EmptyStateBlock } from '../ui/EmptyStateBlock';
import { useApp } from '../../context/AppContext';
import { searchOffice } from '../../services/officeSearchService';
import type { SearchResult } from '../../types/officeSearch';

const MOBILE_SEARCH_MQ = '(max-width: 767px)';

function getIsMobileViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(MOBILE_SEARCH_MQ).matches;
}

interface SearchResultsListProps {
  results: SearchResult[];
  onSelect?: (result: SearchResult) => void;
  compact?: boolean;
  /** VISUAL-POLISH-01B — im Kopfbereich: mobil nur ein Suchsymbol als Auslöser. */
  iconTrigger?: boolean;
  query?: string;
}

export function SearchResultsList({
  results,
  onSelect,
  compact = false,
  query = '',
}: SearchResultsListProps) {
  const { translate } = useApp();

  if (results.length === 0) {
    const hasQuery = query.trim().length >= 2;
    return (
      <EmptyStateBlock
        title={translate(hasQuery ? 'search.noResults.title' : 'search.emptyQuery.title')}
        description={translate(hasQuery ? 'search.noResults.desc' : 'search.emptyQuery.desc')}
        testId={hasQuery ? 'search-no-results' : 'search-empty-query'}
      />
    );
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
  /** VISUAL-POLISH-01B — im Kopfbereich: mobil nur ein Suchsymbol als Auslöser. */
  iconTrigger?: boolean;
  /** When true, search starts collapsed below 768px and expands on demand. */
  collapsibleOnMobile?: boolean;
  /** PRODUCT-ACCEPTANCE-FIX-01B (F-04) — auf der Suchseite zeigt die Trefferliste die Ergebnisse; keine zweite Vorschau. */
  showPreview?: boolean;
}

export function GlobalSearchBar({
  autoFocus = false,
  compact = false,
  collapsibleOnMobile = false,
  iconTrigger = false,
  showPreview = true,
}: GlobalSearchBarProps) {
  const { translate } = useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  /*
   * VISUAL-POLISH-01D — `?q=` gehört nur auf der Suchseite der Suche. Der
   * Assistent nutzt denselben Parameter für seine Frage; vorher füllte er
   * damit die Kopfzeilensuche und öffnete deren Vorschau über der Seite.
   */
  const [query, setQuery] = useState(location.pathname === '/suche' ? (searchParams.get('q') ?? '') : '');
  /*
   * F-04 — die Vorschau ist eine Eingabehilfe: Sie öffnet beim Tippen und
   * schließt mit Enter, mit der Auswahl eines Treffers und bei jedem
   * Routenwechsel. Vorher blieb sie nach Enter über der Ergebnisseite stehen.
   */
  const [previewOpen, setPreviewOpen] = useState(false);
  const routeKey = location.pathname + location.search;
  useEffect(() => {
    setPreviewOpen(false);
  }, [routeKey]);
  const [isMobile, setIsMobile] = useState(getIsMobileViewport);
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasMobileExpandedRef = useRef(false);
  const panelId = useId();

  const useMobileCollapse = collapsibleOnMobile && isMobile;
  const panelHidden = useMobileCollapse && !mobileExpanded;

  useEffect(() => {
    if (!collapsibleOnMobile || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const mediaQuery = window.matchMedia(MOBILE_SEARCH_MQ);
    const syncViewport = (event?: MediaQueryListEvent) => {
      const mobile =
        typeof event?.matches === 'boolean'
          ? event.matches
          : window.matchMedia(MOBILE_SEARCH_MQ).matches;
      setIsMobile(mobile);
      if (!mobile) {
        setMobileExpanded(false);
      }
    };

    syncViewport();
    mediaQuery.addEventListener('change', syncViewport);
    return () => mediaQuery.removeEventListener('change', syncViewport);
  }, [collapsibleOnMobile]);

  useEffect(() => {
    if (!useMobileCollapse) {
      wasMobileExpandedRef.current = false;
      return;
    }

    if (mobileExpanded) {
      wasMobileExpandedRef.current = true;
      const frameId = window.requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
      return () => window.cancelAnimationFrame(frameId);
    }

    if (wasMobileExpandedRef.current) {
      wasMobileExpandedRef.current = false;
      const frameId = window.requestAnimationFrame(() => {
        triggerRef.current?.focus();
      });
      return () => window.cancelAnimationFrame(frameId);
    }

    return undefined;
  }, [useMobileCollapse, mobileExpanded]);

  useEffect(() => {
    if (!useMobileCollapse || !mobileExpanded) return;

    const closeMobileSearch = () => {
      setMobileExpanded(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMobileSearch();
      }
    };

    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        closeMobileSearch();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [useMobileCollapse, mobileExpanded]);

  const previewResults = useMemo(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];
    return searchOffice({ query: trimmed, limit: compact ? 5 : 8 });
  }, [query, compact]);

  const closeAfterNavigation = () => {
    setPreviewOpen(false);
    setMobileExpanded(false);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    closeAfterNavigation();
    navigate(`/suche?q=${encodeURIComponent(trimmed)}`);
  };

  const handleSelect = (result: SearchResult) => {
    closeAfterNavigation();
    navigate(result.route);
  };

  return (
    <div
      ref={rootRef}
      className={[
        'global-search',
        compact ? 'global-search--compact' : '',
        useMobileCollapse && !mobileExpanded ? 'global-search--collapsed' : '',
        useMobileCollapse ? 'global-search--mobile-collapsible' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid="global-search"
    >
      {useMobileCollapse ? (
        <Button
          ref={triggerRef}
          type="button"
          variant="ghost"
          size="md"
          fullWidth={!iconTrigger}
          className={iconTrigger ? 'global-search__mobile-trigger global-search__mobile-trigger--icon' : 'global-search__mobile-trigger'}
          aria-expanded={mobileExpanded}
          aria-controls={panelId}
          aria-label={translate('search.title')}
          title={translate('search.title')}
          data-testid="global-search-trigger"
          onClick={() => setMobileExpanded((open) => !open)}
        >
          {iconTrigger ? <Icon id={mobileExpanded ? 'close' : 'search'} size="md" /> : translate('search.title')}
        </Button>
      ) : null}

      <div
        id={useMobileCollapse ? panelId : undefined}
        className="global-search__panel"
        hidden={panelHidden}
        data-testid="global-search-panel"
      >
        <form className="global-search__form" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="search"
            className="input global-search__input"
            placeholder={translate('search.globalPlaceholder')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPreviewOpen(true);
            }}
            autoFocus={autoFocus && !collapsibleOnMobile}
            aria-label={translate('search.globalPlaceholder')}
            data-testid="global-search-input"
          />
        </form>

        {showPreview && previewOpen && previewResults.length > 0 && (
          <div className="global-search__preview" data-testid="global-search-preview">
            <SearchResultsList results={previewResults} onSelect={handleSelect} compact={compact} />
            <button
              type="button"
              className="global-search__show-all"
              onClick={() => {
                closeAfterNavigation();
                navigate(`/suche?q=${encodeURIComponent(query.trim())}`);
              }}
            >
              {translate('search.showAll')}
            </button>
          </div>
        )}
      </div>
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
      <PageHeader
        title={translate('search.title')}
        subtitle={translate('search.subtitle')}
        backLabel={translate('common.back')}
        backHref="/"
        backTestId="search-back"
      />

      <section className="search-page__bar" data-testid="search-page-bar">
        <GlobalSearchBar autoFocus showPreview={false} />
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
          query={query}
          onSelect={(result) => navigate(result.route)}
        />
      </Card>
    </div>
  );
}
