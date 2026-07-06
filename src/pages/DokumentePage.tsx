import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Badge, Card, CardMeta, CardTitle, PageHeader } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { EmptyStateBlock } from '../components/ui/EmptyStateBlock';
import { useApp } from '../context/AppContext';
import {
  COMPANY_DOCUMENT_CATEGORIES,
  getAllDocuments,
  searchDocuments,
} from '../services/documentService';
import { getAllUploadedDocuments } from '../services/uploadedDocumentService';
import { UploadedDocumentsSection } from '../components/documents/UploadedDocumentsSection';
import type { CompanyDocumentCategory } from '../types/models';
import type { TranslationKey } from '../i18n';

function formatDate(value: string | null): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleDateString('de-DE');
  } catch {
    return value;
  }
}

export function DokumentePage() {
  const { translate } = useApp();
  const location = useLocation();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CompanyDocumentCategory | 'all'>('all');
  const [documents, setDocuments] = useState(getAllDocuments);
  const [uploads, setUploads] = useState(getAllUploadedDocuments);

  useEffect(() => {
    setDocuments(getAllDocuments());
    setUploads(getAllUploadedDocuments());
  }, [location.pathname, location.key]);

  const filtered = useMemo(
    () => searchDocuments(query, category),
    [query, category, documents],
  );

  return (
    <div className="page">
      <PageHeader title={translate('document.title')} subtitle={translate('document.subtitle')} />

      <div className="page-header__actions page-header__actions--row">
        <Link to="/dokumente/upload">
          <Button variant="primary" fullWidth data-testid="document-upload-link">
            {translate('document.upload.action')}
          </Button>
        </Link>
        <Link to="/dokumente/neu">
          <Button variant="outline" fullWidth>
            {translate('document.add')}
          </Button>
        </Link>
      </div>

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

      <div className="chip-group document-categories">
        <button
          type="button"
          className={`chip ${category === 'all' ? 'chip--active' : ''}`}
          onClick={() => setCategory('all')}
        >
          {translate('document.categoryAll')}
        </button>
        {COMPANY_DOCUMENT_CATEGORIES.map((cat) => {
          const key = `document.category.${cat}` as TranslationKey;
          return (
            <button
              key={cat}
              type="button"
              className={`chip ${category === cat ? 'chip--active' : ''}`}
              onClick={() => setCategory(cat)}
            >
              {translate(key)}
            </button>
          );
        })}
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
                <Button variant="outline" fullWidth>{translate('document.empty.action')}</Button>
              </Link>
            </>
          }
        />
      ) : filtered.length === 0 ? (
        <p className="document-archive-empty-hint">{translate('document.emptyArchiveOnly')}</p>
      ) : (
        <div className="card-list">
          {filtered.map((doc) => {
            const categoryKey = `document.category.${doc.category}` as TranslationKey;
            return (
              <Link key={doc.id} to={`/dokumente/${doc.id}`} className="card-link">
                <Card>
                  <div className="document-card__header">
                    <span
                      className={`document-card__preview${doc.imagePreview ? '' : ' document-card__preview--placeholder'}`}
                      aria-hidden
                    >
                      {doc.imagePreview ?? ''}
                    </span>
                    <div>
                      <CardTitle>{doc.title}</CardTitle>
                      <CardMeta>
                        {doc.issuer || translate('document.noIssuer')} ·{' '}
                        {formatDate(doc.validUntil)}
                      </CardMeta>
                    </div>
                  </div>
                  <div className="badge-row">
                    <Badge tone="info">{translate(categoryKey)}</Badge>
                    {doc.linkedVorgang && (
                      <Badge>{doc.linkedVorgang.vorgangTitle}</Badge>
                    )}
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
