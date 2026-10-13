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
import { useEffect, useState } from 'react';
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
  reviseOffer,
} from '../services/offer/offerService';
import { ensureOfferArchived, type OfferArchiveFailureReason } from '../services/offer/offerArchiveService';
import { offerServerRejectionKey } from '../services/offer/offerServerRejection';
import { useDraftCloudTick } from '../services/order/useDraftCloudTick';
import { buildOfferPrintModel } from '../services/offer/offerPrintModel';
import { downloadOfferPdf, generateOfferPdf } from '../services/offer/offerPdfService';
import { canAcceptOffer, canSendOffer } from '../services/offer/offerService';
import { acceptOfferWithCloud } from '../services/offer/offerAcceptCloudService';
import { useOptionalAuth } from '../context/AuthContext';
import { isSupabaseConfigured } from '../lib/supabase';
import { resolveWorkspaceWriteAccess } from '../services/workspace/workspaceRoleService';
import { getVorgangById } from '../services/vorgangService';
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
  const { translate, showToast } = useApp();
  const navigate = useNavigate();
  const { offerId } = useParams<{ offerId: string }>();
  /* ANGEBOT->AUFTRAG-02B — Annahme legt einen Vorgang an: dieselbe Rolle wie jeder Vorgangs-Write. */
  const user = useOptionalAuth()?.user ?? null;
  const writeAccess = resolveWorkspaceWriteAccess({ userId: user?.id, cloudConfigured: isSupabaseConfigured() });
  const [annahmeOffen, setAnnahmeOffen] = useState(false);
  const [annahmeLaeuft, setAnnahmeLaeuft] = useState(false);
  const [annahmeFehler, setAnnahmeFehler] = useState('');
  const [version, setVersion] = useState(0);
  const offer = offerId ? getOfferById(offerId) : null;
  const frozen = Boolean(offer && offer.status !== 'entwurf');

  /*
   * FINANZ-CORE-01A (ANG-13) — ein Abgleich kann Angebot und Ablage ändern (Ablage
   * eines anderen Geräts, Statuswechsel). Die Seite liest danach neu.
   */
  useDraftCloudTick();
  const [archiveDoc, setArchiveDoc] = useState<CompanyDocument | null>(null);
  const [archiveFailure, setArchiveFailure] = useState<OfferArchiveFailureReason | null>(null);
  const [archiveAttempt, setArchiveAttempt] = useState(0);
  const offerKey = offer?.id ?? '';
  /*
   * FINANZ-CORE-01A (ANG-12) — der Effekt hängt an der Kennung, nicht am Objekt.
   * `getOfferById` liefert bei jedem Rendern einen neuen Klon. Jedes Neurendern setzte
   * deshalb `alive = false`, ein Wächter verhinderte den Neustart, und das Ergebnis
   * der Ablage ging verloren: „wird vorbereitet …" blieb stehen, ohne Ablage kein
   * Versand. Einen zweiten gleichzeitigen Lauf fängt `ensureOfferArchived` ab.
   */
  useEffect(() => {
    if (!offerKey || !frozen) return;
    /*
     * GO-LIVE-SECURITY-01 — die Ablage ordnet nur ein Inhaber- oder Admin-Gerät
     * zu: Sie ändert den Beleg (archiveDocumentId), und das dürfen Mitglieder
     * nicht mehr. Ein Mitglied sieht die Ablage des Inhabers zudem nicht und
     * erzeugte sonst eine doppelte.
     */
    if (!writeAccess.canWrite) return;
    let alive = true;
    void ensureOfferArchived(offerKey).then((r) => {
      if (!alive) return;
      if (r.ok) {
        setArchiveDoc(r.document);
        setArchiveFailure(null);
      } else {
        setArchiveFailure(r.reason);
      }
    });
    return () => {
      alive = false;
    };
  }, [offerKey, frozen, version, writeAccess.canWrite, archiveAttempt]);
  // FINANZ-CORE-01A (ANG-12) — „Erneut ablegen" bzw. „Erneut prüfen".
  const legeErneutAb = () => {
    setArchiveFailure(null);
    setArchiveAttempt((n) => n + 1);
  };

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
    // GO-LIVE-SECURITY-01 — verbindliche Status setzen nur Inhaber und Admin.
    if (!writeAccess.canWrite) {
      setAktion(null);
      setAktionFehler(translate('offer.status.roleHint'));
      return true;
    }
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

  /*
   * FINANZ-CORE-01A (ANG-11) — ein offenes Angebot wird überarbeitet (der Entwurf ersetzt
   * es mit seiner Freigabe), ein abgeschlossenes dient als Vorlage.
   */
  const offen = offer.status === 'freigegeben' || offer.status === 'versendet';
  const ueberarbeite = () => {
    const r = reviseOffer(offer.id);
    if (!r.success) {
      setAktionFehler(translate(r.errorKey as TranslationKey));
      return;
    }
    navigate(`/angebote/${r.offer.id}/bearbeiten`);
  };
  const vorgaenger = offer.supersedesOfferId ? getOfferById(offer.supersedesOfferId) : null;

  const titel = offer.offerNumber ? `${translate('offer.detail.title')} ${offer.offerNumber}` : translate('offer.detail.title');

  const annehmbar = canAcceptOffer(offer);
  const angenommen = offer.status === 'angenommen' && Boolean(offer.resultingVorgangId);
  const auftrag = angenommen ? getVorgangById(offer.resultingVorgangId ?? '') : undefined;
  const annehmen = async (): Promise<boolean> => {
    setAnnahmeOffen(false);
    setAnnahmeFehler('');
    setAnnahmeLaeuft(true);
    try {
      const r = await acceptOfferWithCloud(offer.id);
      if (!r.ok) {
        const key: TranslationKey =
          r.reason === 'not_acceptable'
            ? 'offer.accept.notAcceptable'
            : r.reason === 'cloud_required'
              ? 'offer.accept.cloudRequired'
              : r.reason === 'sync_pending'
                ? 'offer.accept.syncPending'
                : r.reason === 'sync_conflict'
                  ? 'offer.accept.syncConflict'
                : r.reason === 'stale_version'
                  ? 'offer.accept.staleVersion'
                : r.reason === 'network'
                  ? 'offer.accept.network'
                  : r.reason === 'server_rejected'
                    ? (offerServerRejectionKey(r.message, 'accept') ?? 'offer.accept.serverRejected')
                    : 'offer.error.notFound';
        // FINANZ-CORE-01A (ANG-14) — nur übersetzte Texte; der rohe Servertext bleibt draußen.
        setAnnahmeFehler(translate(key));
        return true;
      }
      showToast(translate('offer.accept.success').replace('{number}', r.vorgang.orderNumber ?? ''));
      navigate(`/vorgaenge/${r.vorgang.id}`);
      return true;
    } finally {
      setAnnahmeLaeuft(false);
    }
  };

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
          ) : annehmbar && writeAccess.canWrite ? (
            <Button onClick={() => setAnnahmeOffen(true)} disabled={annahmeLaeuft} data-testid="offer-accept">
              {translate('offer.accept.action')}
            </Button>
          ) : angenommen ? (
            <Button onClick={() => navigate(`/vorgaenge/${offer.resultingVorgangId}`)} data-testid="offer-open-order">
              {translate('offer.detail.orderOpen')}
              {auftrag?.orderNumber ? ` · ${auftrag.orderNumber}` : ''}
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
      {vorgaenger ? (
        <p className="form-hint" data-testid="offer-detail-supersedes">
          {translate('offer.detail.supersedes').replace('{number}', vorgaenger.offerNumber ?? '')}
        </p>
      ) : null}
      {angenommen ? <p className="form-hint" data-testid="offer-detail-accepted">{translate('offer.detail.acceptedHint')}</p> : null}
      {annehmbar && !writeAccess.canWrite ? <p className="form-hint" data-testid="offer-accept-role-hint">{translate('offer.accept.roleHint')}</p> : null}
      {annahmeFehler ? <p className="form-error" data-testid="offer-accept-error">{annahmeFehler}</p> : null}
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
          {writeAccess.canWrite ? (
            <Button type="button" variant="secondary" onClick={ueberarbeite} data-testid="offer-revise">
              {translate(offen ? 'offer.detail.revise' : 'offer.detail.copyAsTemplate')}
            </Button>
          ) : null}
          {writeAccess.canWrite
            ? listOfferStatusActions(offer).map((a) => (
                <Button key={a} type="button" variant="ghost" onClick={() => setAktion(a as Aktion)} data-testid={`offer-action-${a}`}>
                  {translate(AKTION_LABEL[a as Aktion])}
                </Button>
              ))
            : null}
        </div>
      ) : null}
      {frozen && !writeAccess.canWrite && listOfferStatusActions(offer).length > 0 ? (
        <p className="form-hint" data-testid="offer-status-role-hint">{translate('offer.status.roleHint')}</p>
      ) : null}
      {pdfFehler ? <p className="form-error" data-testid="offer-pdf-error">{pdfFehler}</p> : null}
      {aktionFehler ? <p className="form-error" data-testid="offer-action-error">{aktionFehler}</p> : null}
      {frozen && !archiveDocument && writeAccess.canWrite ? (
        archiveFailure ? (
          <div className="form-hint" data-testid="offer-archive-failed">
            <p>{translate(archiveFailure === 'archive_missing' ? 'offer.detail.archiveMissing' : 'offer.detail.archiveFailed')}</p>
            <Button type="button" size="sm" variant="secondary" onClick={legeErneutAb} data-testid="offer-archive-retry">
              {translate(archiveFailure === 'archive_missing' ? 'offer.detail.archiveRecheck' : 'offer.detail.archiveRetry')}
            </Button>
          </div>
        ) : (
          <p className="form-hint" data-testid="offer-archive-pending">
            {translate('offer.detail.archivePending')}
          </p>
        )
      ) : null}

      {vorschauUrl ? (
        <DetailSection title={translate('offer.detail.pdfView')}>
          <iframe className="brief-detail__preview" src={vorschauUrl} title={translate('offer.detail.pdfView')} data-testid="offer-pdf-preview" />
        </DetailSection>
      ) : null}

      {frozen && archiveDocument && !canSendOffer(offer) ? (
        <p className="form-hint" data-testid="offer-send-closed">
          {translate('offer.detail.sendClosed')}
        </p>
      ) : null}

      {frozen && archiveDocument && canSendOffer(offer) ? (
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

      <SimpleConfirmDialog
        open={annahmeOffen}
        title={translate('offer.accept.title')}
        message={`${translate('offer.accept.text')
          .replace('{number}', offer.offerNumber ?? '')
          .replace('{customer}', offer.customer.name)
          .replace('{total}', formatInvoiceCurrency(totals.total))}${
          expired ? ` ${translate('offer.accept.expired').replace('{validUntil}', formatInvoiceDate(offer.validUntil))}` : ''
        }`}
        confirmLabel={translate(expired ? 'offer.accept.confirmExpired' : 'offer.accept.confirm')}
        cancelLabel={translate('common.cancel')}
        dialogTestId="offer-accept-dialog"
        confirmTestId="offer-accept-confirm"
        cancelTestId="offer-accept-cancel"
        onConfirm={annehmen}
        onCancel={() => setAnnahmeOffen(false)}
      />
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
