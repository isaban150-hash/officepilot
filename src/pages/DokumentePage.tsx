import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Badge, PageHeader, StatusBadge } from '../components/ui/Card';
import { BusinessList, BusinessListItem } from '../components/ui/Lists';
import { Page, PageToolbar } from '../components/ui/Page';
import { FilterChips, SearchField } from '../components/ui/Toolbar';
import { Button } from '../components/ui/Button';
import { EmptyStateBlock } from '../components/ui/EmptyStateBlock';
import { useApp } from '../context/AppContext';
import {
  getAllDocuments,
  isGeneratedOutgoingInvoiceDocument,
  searchDocuments,
} from '../services/documentService';
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

  const areaOptions = DOCUMENT_AREA_FILTER_IDS.map((id) => ({ id, label: translate(getDocumentAreaLabelKey(id) as TranslationKey) }));

  /* UIUX-FOUNDATION-01F — Dokumentarchiv: PageHeader, Toolbar, Business-Liste mit Vorschau. */
  return (
    <Page testId="dokumente-page">
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

      <PageToolbar
        search={
          <SearchField
            label={translate('document.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            testId="document-search"
          />
        }
        filters={
          <FilterChips
            options={areaOptions}
            value={area}
            onChange={setArea}
            label={translate('document.area.toolbar')}
            testIdPrefix="document-area-chip"
            testId="document-area-chips"
            className="document-area-chips"
          />
        }
      />

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
        <EmptyStateBlock title={translate('document.area.empty')} description="" testId="document-area-empty" />
      ) : (
        <BusinessList testId="document-area-list" ariaLabel={translate('document.title')}>
          {filtered.map((doc) => {
            /*
             * Die maßgebliche Erkennung bleibt in `documentService` — dieselbe
             * Funktion, die Detailseite und Lifecycle seit 02F verwenden. Sie
             * wird hier ausgewertet, weil der Katalog `documentService` nicht
             * importieren darf, ohne einen Importzyklus zu schliessen.
             *
             * `not_required` bekommt kein Abzeichen: Ein selbst erzeugtes
             * Dokument hat keinen Papierzustand, über den etwas zu sagen wäre.
             */
            const paperStatus = resolveDocumentPaperListStatus(doc, {
              skipPhysicalFiling: isGeneratedOutgoingInvoiceDocument(doc),
            });
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
              <BusinessListItem
                key={doc.id}
                to={`/dokumente/${doc.id}`}
                testId={`document-summary-list-${doc.id}`}
                leading={<DocumentCardThumbnail documentId={doc.id} placeholder={doc.imagePreview ?? ''} />}
                title={summaryView.title}
                subtitle={
                  <>
                    <span data-testid={`document-card-date-${doc.id}`}>
                      {summaryView.subtitle || doc.issuer || translate('document.noIssuer')} · {cardDate.formatted}
                    </span>
                    {validUntilLabel ? (
                      <>
                        {' · '}
                        <span data-testid={`document-card-deadline-${doc.id}`}>
                          {translate('document.date.validUntil')}: {validUntilLabel}
                        </span>
                      </>
                    ) : null}
                  </>
                }
                meta={
                  summaryView.factsLine ? (
                    <span data-testid={`document-card-summary-facts-${doc.id}`}>
                      {summaryView.facts.slice(0, 3).map((f) => f.value).join(' · ')}
                    </span>
                  ) : undefined
                }
                status={
                  paperStatus !== 'not_required' || doc.linkedVorgang ? (
                    <>
                      {paperStatus !== 'not_required' && (
                        <span data-testid={`document-paper-status-${doc.id}`}>
                          <StatusBadge tone={paperStatus === 'filed' ? 'success' : 'warning'} label={translate(paperKey)} icon={false} />
                        </span>
                      )}
                      {doc.linkedVorgang && <Badge tone="neutral">{doc.linkedVorgang.vorgangTitle}</Badge>}
                    </>
                  ) : undefined
                }
              />
            );
          })}
        </BusinessList>
      )}
    </Page>
  );
}
