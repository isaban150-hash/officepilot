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
import { findInvoiceById } from '../services/invoice/invoiceRegistryService';
import { formatInvoiceCurrency, formatInvoiceDate } from '../services/invoicePrintModel';
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

/** Hauptfilter, die immer sichtbar sind (Alle, Rechnungen, Belege, Kunden, Aufträge). */
const PRIMARY_AREA_FILTER_COUNT = 5;

export function DokumentePage() {
  const { translate, setup } = useApp();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [moreFilters, setMoreFilters] = useState(false);
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
  /*
   * VISUAL-POLISH-01C — keine Chip-Wand: die Hauptfilter stehen direkt, der
   * Rest liegt hinter „Weitere Filter". Ein aktiver Nebenfilter hält die Reihe
   * offen, damit die Auswahl nie unsichtbar wird. Filterlogik unverändert.
   */
  const primaryAreaOptions = areaOptions.slice(0, PRIMARY_AREA_FILTER_COUNT);
  const secondaryAreaOptions = areaOptions.slice(PRIMARY_AREA_FILTER_COUNT);
  const secondaryActive = secondaryAreaOptions.some((option) => option.id === area);
  const showAllFilters = moreFilters || secondaryActive;
  const visibleAreaOptions = showAllFilters ? areaOptions : primaryAreaOptions;

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
          <div className="work-filters">
            <FilterChips
              options={visibleAreaOptions}
              value={area}
              onChange={setArea}
              label={translate('document.area.toolbar')}
              testIdPrefix="document-area-chip"
              testId="document-area-chips"
              className="document-area-chips"
            />
            {secondaryAreaOptions.length > 0 && !secondaryActive ? (
              <button
                type="button"
                className="work-filters__more"
                aria-expanded={showAllFilters}
                onClick={() => setMoreFilters((open) => !open)}
                data-testid="document-area-more-filters"
              >
                {translate(showAllFilters ? 'document.area.lessFilters' : 'document.area.moreFilters')}
              </button>
            ) : null}
          </div>
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
            /*
             * 01D — eigene Ausgangsrechnungen müssen in der Liste geschäftlich
             * unterscheidbar sein: Nummer, Kunde, Rechnungsdatum, Betrag aus der
             * verknüpften Rechnung (keine neue Datenhaltung). Der Projektname
             * bleibt als Abzeichen. Andere Dokumentarten behalten ihre Darstellung.
             */
            const ownInvoice =
              isGeneratedOutgoingInvoiceDocument(doc) && doc.linkedInvoiceId
                ? findInvoiceById(doc.linkedInvoiceId)
                : undefined;
            const invoiceView = ownInvoice
              ? {
                  title:
                    doc.classifiedKind === 'rechnungskorrektur'
                      ? doc.title
                      : `${translate('document.list.invoiceTitle')} ${ownInvoice.number}`,
                  customer: ownInvoice.customerSnapshot?.name || doc.issuer || translate('document.noIssuer'),
                  date: formatInvoiceDate(ownInvoice.issueDate ?? ownInvoice.date),
                  amount: formatInvoiceCurrency(ownInvoice.amount),
                }
              : null;
            return (
              <BusinessListItem
                key={doc.id}
                to={`/dokumente/${doc.id}`}
                testId={`document-summary-list-${doc.id}`}
                leading={<DocumentCardThumbnail documentId={doc.id} placeholder={doc.imagePreview ?? ''} />}
                title={invoiceView ? invoiceView.title : summaryView.title}
                subtitle={
                  <>
                    <span data-testid={`document-card-date-${doc.id}`}>
                      {invoiceView
                        ? `${invoiceView.customer} · ${invoiceView.date}`
                        : `${summaryView.subtitle || doc.issuer || translate('document.noIssuer')} · ${cardDate.formatted}`}
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
                amount={
                  invoiceView ? (
                    <span data-testid={`document-card-invoice-amount-${doc.id}`}>{invoiceView.amount}</span>
                  ) : undefined
                }
                meta={
                  !invoiceView && summaryView.factsLine ? (
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
