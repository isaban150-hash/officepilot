import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Badge, Card, CardMeta, CardTitle, PageHeader } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { EmptyStateBlock } from '../components/ui/EmptyStateBlock';
import { useApp } from '../context/AppContext';
import { getAllDocuments, searchDocuments } from '../services/documentService';
import {
  getDocumentAreaLabelKey,
  resolveDocumentPaperListStatus,
} from '../services/documentAreaCatalog';
import {
  DOCUMENT_AREA_FILTER_IDS,
  parseDocumentAreaFilter,
  type DocumentAreaFilterId,
} from '../types/documentArea';
import { getAllUploadedDocuments } from '../services/uploadedDocumentService';
import { DocumentCardThumbnail } from '../components/documents/DocumentCardThumbnail';
import { UploadedDocumentsSection } from '../components/documents/UploadedDocumentsSection';
import {
  formatDocumentValidUntil,
  resolveDocumentCardDate,
} from '../utils/documentDateDisplay';
import {
  buildSummaryForCompanyDocument,
  toDocumentSummaryCompactView,
} from '../services/documentSummaryPresentation';
import type { TranslationKey } from '../i18n';

export function DokumentePage() {
  const { translate, setup } = useApp();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [documents, setDocuments] = useState(getAllDocuments);
  const [uploads, setUploads] = useState(getAllUploadedDocuments);

  const area: DocumentAreaFilterId = parseDocumentAreaFilter(searchParams.get('area'));

  useEffect(() => {
    setDocuments(getAllDocuments());
    setUploads(getAllUploadedDocuments());
  }, [location.pathname, location.key]);

  useEffect(() => {
    const raw = searchParams.get('area');
    if (raw && parseDocumentAreaFilter(raw) === 'alle' && raw !== 'alle') {
      const next = new URLSearchParams(searchParams);
      next.delete('area');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const setArea = (nextArea: DocumentAreaFilterId) => {
    const next = new URLSearchParams(searchParams);
    if (nextArea === 'alle') {
      next.delete('area');
    } else {
      next.set('area', nextArea);
    }
    setSearchParams(next, { replace: true });
  };

  const filtered = useMemo(
    () => searchDocuments(query, { area }),
    [query, area, documents],
  );

  const unrecognizedDate = translate('document.date.unrecognized');

  return (
    <div className="page">
      <PageHeader
        title={translate('document.title')}
        subtitle={translate('document.subtitle')}
        primaryAction={
          <Link to="/dokumente/upload">
            <Button variant="primary" fullWidth data-testid="document-upload-link">
              {translate('document.upload.action')}
            </Button>
          </Link>
        }
        secondaryAction={
          <Link to="/dokumente/neu">
            <Button variant="outline" fullWidth>
              {translate('document.add')}
            </Button>
          </Link>
        }
      />

      <UploadedDocumentsSection items={uploads} />

      <div className="document-toolbar">
        <input
          type="search"
          className="input document-search"
          placeholder={translate('document.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={translate('document.searchPlaceholder')}
        />
      </div>

      <div
        className="chip-group document-area-chips"
        data-testid="document-area-chips"
        role="toolbar"
        aria-label={translate('document.area.toolbar')}
      >
        {DOCUMENT_AREA_FILTER_IDS.map((id) => (
          <button
            key={id}
            type="button"
            className={`chip ${area === id ? 'chip--active' : ''}`}
            data-testid={`document-area-chip-${id}`}
            aria-pressed={area === id}
            onClick={() => setArea(id)}
          >
            {translate(getDocumentAreaLabelKey(id) as TranslationKey)}
          </button>
        ))}
      </div>

      {filtered.length === 0 && uploads.length === 0 ? (
        <EmptyStateBlock
          title={translate('document.empty.title')}
          description={translate('document.empty.desc')}
          testId="document-empty-state"
          actions={
            <>
              <Link to="/dokumente/upload">
                <Button fullWidth>{translate('document.upload.action')}</Button>
              </Link>
              <Link to="/dokumente/neu">
                <Button variant="outline" fullWidth>
                  {translate('document.empty.action')}
                </Button>
              </Link>
            </>
          }
        />
      ) : filtered.length === 0 ? (
        <p className="document-archive-empty-hint" data-testid="document-area-empty">
          {translate('document.area.empty')}
        </p>
      ) : (
        <div className="card-list" data-testid="document-area-list">
          {filtered.map((doc) => {
            const paperStatus = resolveDocumentPaperListStatus(doc.id);
            const paperKey =
              paperStatus === 'filed'
                ? 'document.area.paper.filed'
                : 'document.area.paper.pending';
            const cardDate = resolveDocumentCardDate(doc, setup.language, unrecognizedDate);
            const validUntilLabel = formatDocumentValidUntil(doc.validUntil, setup.language);
            const summaryView = toDocumentSummaryCompactView(
              buildSummaryForCompanyDocument(doc, { translate, language: setup.language }),
              translate,
            );
            return (
              <Link key={doc.id} to={`/dokumente/${doc.id}`} className="card-link">
                <Card data-testid={`document-summary-list-${doc.id}`}>
                  <div className="document-card__header">
                    <DocumentCardThumbnail
                      documentId={doc.id}
                      placeholder={doc.imagePreview ?? ''}
                    />
                    <div>
                      <CardTitle>{summaryView.title}</CardTitle>
                      <CardMeta>
                        <span data-testid={`document-card-date-${doc.id}`}>
                          {summaryView.subtitle ||
                            doc.issuer ||
                            translate('document.noIssuer')}{' '}
                          · {cardDate.formatted}
                        </span>
                        {validUntilLabel ? (
                          <>
                            {' · '}
                            <span data-testid={`document-card-deadline-${doc.id}`}>
                              {translate('document.date.validUntil')}: {validUntilLabel}
                            </span>
                          </>
                        ) : null}
                      </CardMeta>
                      {summaryView.factsLine ? (
                        <p
                          className="document-card__summary-facts"
                          data-testid={`document-card-summary-facts-${doc.id}`}
                        >
                          {summaryView.facts.slice(0, 3).map((f) => f.value).join(' · ')}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className="badge-row">
                    <span data-testid={`document-paper-status-${doc.id}`}>
                      <Badge tone={paperStatus === 'filed' ? 'success' : 'warning'}>
                        {translate(paperKey)}
                      </Badge>
                    </span>
                    {doc.linkedVorgang && <Badge>{doc.linkedVorgang.vorgangTitle}</Badge>}
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
