/**
 * ANGEBOT-01B — die Detailseite eines Angebots.
 *
 * Ein Entwurf zeigt Zusammenfassung und führt in den Editor. Ein
 * freigegebenes Angebot ist ein Beleg: Es wird gezeigt, als PDF erzeugt, im
 * Archiv abgelegt (einmalig, idempotent) und über den vorhandenen
 * Dokumentversand verschickt. Die einzigen Handlungen danach sind
 * Zustandswechsel (versendet, abgelehnt, storniert) — jeder mit Bestätigung.
 *
 * „Angebot annehmen → Auftrag" gibt es hier bewusst noch nicht (Block B).
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/Card';
import { Page } from '../components/ui/Page';
import { DetailSection } from '../components/ui/Section';
import { SimpleConfirmDialog } from '../components/ui/SimpleConfirmDialog';
import { OfferDocumentView } from '../components/offer/OfferDocumentView';
import { OfferStatusBadge } from '../components/offer/OfferStatusBadge';
import { DocumentDeliveryPanel } from '../components/documents/DocumentDeliveryPanel';
import { useApp } from '../context/AppContext';
import { getDocumentById } from '../services/documentService';
import { formatInvoiceCurrency, formatInvoiceDate } from '../services/invoicePrintModel';
import {
  cancelOffer,
  getOfferById,
  getOfferTotals,
  isOfferExpired,
  listOfferStatusActions,
  markOfferSent,
  rejectOffer,
} from '../services/offer/offerService';
import { ensureOfferArchived } from '../services/offer/offerArchiveService';
import { buildOfferPrintModel } from '../services/offer/offerPrintModel';
import { downloadOfferPdf, generateOfferPdf } from '../services/offer/offerPdfService';
import type { OfferStatus } from '../types/offer';
import type { CompanyDocument } from '../types/models';
import type { TranslationKey } from '../i18n';

type Aktion = Extract<OfferStatus, 'versendet' | 'abgelehnt' | 'storniert'>;

const AKTION_LABEL: Record<Aktion, TranslationKey> = {
  versendet: 'offer.detail.markSent',
  abgelehnt: 'offer.detail.reject',
  storniert: 'offer.detail.cancel',
};
const AKTION_FRAGE: Record<Aktion, TranslationKey> = {
  versendet: 'offer.detail.markSentConfirm',
  abgelehnt: 'offer.detail.rejectConfirm',
  storniert: 'offer.detail.cancelConfirm',
};

export function AngebotDetailPage() {
  const { translate } = useApp();
  const navigate = useNavigate();
  const { offerId } = useParams<{ offerId: string }>();
  const [version, setVersion] = useState(0);
  const offer = offerId ? getOfferById(offerId) : null;
  const frozen = Boolean(offer && offer.status !== 'entwurf');

  const [archiveDoc, setArchiveDoc] = useState<CompanyDocument | null>(null);
  const [archiveFailed, setArchiveFailed] = useState(false);
  const abgelegtFuer = useRef('');
  useEffect(() => {
    if (!offer || !frozen) return;
    if (abgelegtFuer.current === `${offer.id}:${version}`) return;
    abgelegtFuer.current = `${offer.id}:${version}`;
    let alive = true;
    void ensureOfferArchived(offer.id).then((r) => {
      if (!alive) return;
      if (r.ok) setArchiveDoc(r.document);
      else setArchiveFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [offer, frozen, version]);

  const [vorschauUrl, setVorschauUrl] = useState('');
  const [pdfFehler, setPdfFehler] = useState('');
  const [laeuft, setLaeuft] = useState(false);
  useEffect(() => () => {
    if (vorschauUrl) URL.revokeObjectURL(vorschauUrl);
  }, [vorschauUrl]);

  const [aktion, setAktion] = useState<Aktion | null>(null);
  const [aktionFehler, setAktionFehler] = useState('');

  if (!offer) {
    return (
      <Page testId="offer-detail-missing">
        <PageHeader title={translate('offer.detail.title')} backLabel={translate('offer.editor.back')} backHref="/angebote" />
        <p className="form-error">{translate('offer.error.notFound')}</p>
      </Page>
    );
  }

  const totals = getOfferTotals(offer);
  const expired = isOfferExpired(offer);
  const model = buildOfferPrintModel(offer);
  const archiveDocument = archiveDoc ?? (offer.archiveDocumentId ? getDocumentById(offer.archiveDocumentId) ?? null : null);

  const zeigePdf = async () => {
    setPdfFehler('');
    setLaeuft(true);
    try {
      const r = await generateOfferPdf(offer);
      if (!r.ok) {
        setPdfFehler(translate('offer.detail.pdfFailed'));
        return;
      }
      const blob = new Blob([r.bytes.slice()], { type: 'application/pdf' });
      setVorschauUrl((alt) => {
        if (alt) URL.revokeObjectURL(alt);
        return URL.createObjectURL(blob);
      });
    } finally {
      setLaeuft(false);
    }
  };

  const ladePdf = async () => {
    setPdfFehler('');
    setLaeuft(true);
    try {
      const r = await downloadOfferPdf(offer);
      if (!r.ok) setPdfFehler(translate('offer.detail.pdfFailed'));
    } finally {
      setLaeuft(false);
    }
  };

  const fuehreAktionAus = (): boolean => {
    if (!aktion) return true;
    const r = aktion === 'versendet' ? markOfferSent(offer.id) : aktion === 'abgelehnt' ? rejectOffer(offer.id) : cancelOffer(offer.id);
    setAktion(null);
    if (!r.success) {
      setAktionFehler(translate(r.errorKey as TranslationKey));
      return true;
    }
    setAktionFehler('');
    setVersion((v) => v + 1);
    return true;
  };

  const titel = offer.offerNumber ? `${translate('offer.detail.title')} ${offer.offerNumber}` : translate('offer.detail.title');

  return (
    <Page className="offer-detail" testId="offer-detail-page">
      <PageHeader
        title={titel}
        subtitle={offer.title}
        backLabel={translate('offer.editor.back')}
        backHref="/angebote"
        backTestId="offer-detail-back"
        primaryAction={
          !frozen ? (
            <Button onClick={() => navigate(`/angebote/${offer.id}/bearbeiten`)} data-testid="offer-detail-edit">
              {translate('offer.editor.editTitle')}
            </Button>
          ) : undefined
        }
      />

      <div className="offer-detail__facts" data-testid="offer-detail-facts">
        <OfferStatusBadge offer={offer} />
        <span>
          {translate('offer.number')}: <strong data-testid="offer-detail-number">{offer.offerNumber ?? translate('offer.status.entwurf')}</strong>
        </span>
        <span>
          {translate('offer.validUntil')}: <strong data-testid="offer-detail-valid-until">{formatInvoiceDate(offer.validUntil)}</strong>
        </span>
        <span>
          {translate('offer.total')}: <strong data-testid="offer-detail-total">{formatInvoiceCurrency(totals.total)}</strong>
        </span>
        {offer.finalizedAt ? (
          <span>
            {translate('offer.detail.finalizedAt')}: {formatInvoiceDate(offer.finalizedAt)}
          </span>
        ) : null}
        {offer.sentAt ? (
          <span>
            {translate('offer.detail.sentAt')}: {formatInvoiceDate(offer.sentAt)}
          </span>
        ) : null}
      </div>

      {frozen ? <p className="form-hint" data-testid="offer-detail-frozen">{translate('offer.detail.frozenHint')}</p> : null}
      {expired ? <p className="form-error" data-testid="offer-detail-expired">{translate('offer.detail.expiredHint')}</p> : null}

      {frozen ? (
        <div className="form-actions offer-detail__actions">
          <Button type="button" onClick={zeigePdf} disabled={laeuft} data-testid="offer-pdf-view">
            {translate('offer.detail.pdfView')}
          </Button>
          <Button type="button" variant="secondary" onClick={ladePdf} disabled={laeuft} data-testid="offer-pdf-download">
            {translate('offer.detail.pdfDownload')}
          </Button>
          {archiveDocument ? (
            <Link to={`/dokumente/${archiveDocument.id}`} className="btn btn--ghost" data-testid="offer-archive-open">
              {translate('offer.detail.archiveOpen')}
            </Link>
          ) : null}
          {listOfferStatusActions(offer).map((a) => (
            <Button key={a} type="button" variant="ghost" onClick={() => setAktion(a as Aktion)} data-testid={`offer-action-${a}`}>
              {translate(AKTION_LABEL[a as Aktion])}
            </Button>
          ))}
        </div>
      ) : null}
      {pdfFehler ? <p className="form-error" data-testid="offer-pdf-error">{pdfFehler}</p> : null}
      {aktionFehler ? <p className="form-error" data-testid="offer-action-error">{aktionFehler}</p> : null}
      {frozen && !archiveDocument ? (
        <p className="form-hint" data-testid={archiveFailed ? 'offer-archive-failed' : 'offer-archive-pending'}>
          {translate(archiveFailed ? 'offer.detail.archiveFailed' : 'offer.detail.archivePending')}
        </p>
      ) : null}

      {vorschauUrl ? (
        <DetailSection title={translate('offer.detail.pdfView')}>
          <iframe className="brief-detail__preview" src={vorschauUrl} title={translate('offer.detail.pdfView')} data-testid="offer-pdf-preview" />
        </DetailSection>
      ) : null}

      {frozen && archiveDocument ? (
        <DetailSection title={translate('offer.detail.send')} description={translate('offer.detail.sendHint')} testId="offer-send-section">
          <DocumentDeliveryPanel
            document={archiveDocument}
            recipientEmail={offer.customer.email || null}
            onAccepted={() => {
              markOfferSent(offer.id);
              setVersion((v) => v + 1);
            }}
          />
        </DetailSection>
      ) : null}

      <DetailSection title={translate('offer.editor.preview')} testId="offer-detail-document">
        <OfferDocumentView model={model} />
      </DetailSection>

      {frozen ? <p className="form-hint">{translate('offer.detail.acceptLater')}</p> : null}

      <SimpleConfirmDialog
        open={aktion !== null}
        title={aktion ? translate(AKTION_LABEL[aktion]) : ''}
        message={aktion ? translate(AKTION_FRAGE[aktion]) : ''}
        confirmLabel={aktion ? translate(AKTION_LABEL[aktion]) : ''}
        cancelLabel={translate('common.cancel')}
        confirmVariant={aktion === 'storniert' ? 'danger' : 'primary'}
        dialogTestId="offer-action-dialog"
        confirmTestId="offer-action-confirm"
        cancelTestId="offer-action-cancel"
        onConfirm={fuehreAktionAus}
        onCancel={() => setAktion(null)}
      />
    </Page>
  );
}
