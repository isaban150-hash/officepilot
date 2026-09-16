import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DocumentArchiveTruthFactsCard } from '../components/documents/DocumentArchiveTruthFactsCard';
import { DocumentUnderstandingCard } from '../components/documents/DocumentUnderstandingCard';
import { DocumentDetailPreview } from '../components/documents/DocumentDetailPreview';
import { DocumentDerivativeRecoveryStatusPanel } from '../components/documents/DocumentDerivativeRecoveryStatusPanel';
import { DocumentOriginalFilePanel } from '../components/documents/DocumentOriginalFilePanel';
import { DocumentFilingCard } from '../components/documents/DocumentFilingCard';
import { DocumentLifecycleCard } from '../components/documents/DocumentLifecycleCard';
import { DocumentForm } from '../components/documents/DocumentForm';
import { CommunicationIntegrationPanel } from '../components/communication/CommunicationIntegrationPanel';
import { DOCUMENT_COMMUNICATION_BUTTON_KEYS } from '../components/communication/communicationNavigation';
import { DetailExperienceCard } from '../components/detail/DetailExperienceCard';
import { DocumentFreeQuestionPanel } from '../components/documents/DocumentFreeQuestionPanel';
import { Button } from '../components/ui/Button';
import { Badge, Card, DataRow } from '../components/ui/Card';
import { StatusBadge } from '../components/ui/Badge';
import type { StatusTone } from '../services/ui/statusTone';
import { findInvoiceById } from '../services/invoice/invoiceRegistryService';
import { formatInvoiceCurrency } from '../services/invoicePrintModel';
import { FileTypeIcon } from '../components/ui/FileTypeIcon';
import { ShowMoreSection } from '../components/ui/ShowMoreSection';
import { PageHeader } from '../components/ui/PageHeader';
import { DetailSection, SummaryList } from '../components/ui/Section';
import { useApp } from '../context/AppContext';
import { formatPaperFilingInstruction } from '../services/paperFolderService';
import {
  getDocumentById,
  isGeneratedOutgoingInvoiceDocument,
  isInvoiceCorrectionDocument,
} from '../services/documentService';
import { buildInvoiceReachPath } from '../services/invoiceNavigation';
import { deleteGeneratedInvoiceDocumentWithCloud } from '../services/document/generatedInvoiceDocumentDeleteService';
import { unlinkInboxItemFromVorgang } from '../services/vorgangService';
import { SimpleConfirmDialog } from '../components/ui/SimpleConfirmDialog';
import { getDocumentLifecycleStatusLabelKey, resolveDocumentLifecycle } from '../services/documentLifecycleService';
import { recordDocumentContext } from '../services/brain/companySessionService';
import type { CompanyDocument } from '../types/models';
import type { TranslationKey } from '../i18n';
import {
  formatSafeDocumentDate,
  formatDocumentValidUntil,
} from '../utils/documentDateDisplay';

export function DokumentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { translate, showToast, setup } = useApp();
  const navigate = useNavigate();
  const [document, setDocument] = useState<CompanyDocument | undefined>(() =>
    id ? getDocumentById(id) : undefined,
  );
  const [isEditing, setIsEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [unlinkConfirmOpen, setUnlinkConfirmOpen] = useState(false);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [detailRevision, setDetailRevision] = useState(0);
  const [previewRevision, setPreviewRevision] = useState(0);

  useEffect(() => {
    if (id) {
      setDocument(getDocumentById(id));
      setIsEditing(false);
      setConfirmDelete(false);
      setShowDetails(false);
    }
  }, [id]);

  useEffect(() => {
    if (id) {
      recordDocumentContext(id);
    }
  }, [id]);

  useEffect(() => {
    if (id && !getDocumentById(id)) {
      navigate('/dokumente', { replace: true });
    }
  }, [id, navigate]);

  if (!document) return null;

  const categoryKey = `document.category.${document.category}` as TranslationKey;
  const categoryLabel = translate(categoryKey);
  /**
   * GENERATED-INVOICE-UNDERSTANDING-02D — die Aufforderung „Original ablegen"
   * ganz oben gilt eingehender Post. Eine selbst erzeugte Ausgangsrechnung hat
   * kein Papieroriginal; der Ablageort bleibt am Dokument und im aufgeklappten
   * Bereich sichtbar, nur die Handlungspflicht entfällt.
   */
  const isGeneratedInvoice = isGeneratedOutgoingInvoiceDocument(document);
  const paperInstruction = isGeneratedInvoice
    ? undefined
    : formatPaperFilingInstruction(document.paperFolder);

  /**
   * 02F — auf eine selbst gestellte Rechnung antwortet niemand. Gefiltert wird
   * nur dieser eine Knopf: Frage, E-Mail und WhatsApp bleiben, und die
   * gemeinsame Dokumentliste bleibt für alle anderen Dokumente unverändert.
   */
  const communicationButtonKeys = isGeneratedInvoice
    ? DOCUMENT_COMMUNICATION_BUTTON_KEYS.filter(
        (key) => key !== 'communication.integration.inbox.reply',
      )
    : DOCUMENT_COMMUNICATION_BUTTON_KEYS;

  /**
   * DOCUMENT-UNLINK-DELETE-01G — derselbe atomare Service wie im Eingang, nur
   * hier erreichbar: ein archiviertes Dokument ist dort ausgeblendet, der
   * Nutzer steht auf dieser Seite. Gelöst wird nur die Zuordnung; der Vorgang
   * und ein bestätigter Auftrag bleiben unverändert, gelöscht wird nichts.
   */
  const handleConfirmUnlinkVorgang = (): boolean => {
    const origin = document.sourceInboxItemId?.trim();
    if (!origin) return false;

    const result = unlinkInboxItemFromVorgang(origin);
    if (!result.success) {
      setUnlinkError(translate(result.errorKey as TranslationKey));
      return false;
    }
    // Der Store ist die Wahrheit — die Seite liest ihn neu, statt zu raten.
    setDocument(getDocumentById(document.id));
    setUnlinkConfirmOpen(false);
    setUnlinkError(null);
    showToast(translate('inbox.unlinkVorgang.success'));
    return true;
  };

  /*
   * 05C1B — für ein cloudbekanntes Ausgangsrechnungs-Dokument setzt der Dienst
   * erst den Cloud-Grabstein und löscht danach lokal. Umgekehrt käme die aktive
   * Cloud-Zeile beim nächsten Bootstrap zurück. Für alle anderen Dokumentarten
   * läuft unverändert der rein lokale Weg aus fa953da.
   */
  const handleDelete = async () => {
    const result = await deleteGeneratedInvoiceDocumentWithCloud(document.id);
    if (result.ok) {
      showToast(translate('document.deleted'));
      navigate('/dokumente', { replace: true });
      return;
    }
    // Der Guard im Service ist die Wahrheit — hier wird sein Grund nur sichtbar.
    setDeleteError(translate(result.errorKey as TranslationKey));
    setConfirmDelete(false);
  };

  if (isEditing) {
    return (
      <div className="page">
        <PageHeader
          title={document.title}
          subtitle={categoryLabel}
          backLabel={translate('common.back')}
          onBack={() => setIsEditing(false)}
          backTestId="document-detail-edit-back"
        />
        <DetailExperienceCard
          recognizedTitle={document.title}
          recognizedSummary={categoryLabel}
          assistantMessage={translate('document.experience.editing')}
          paperInstruction={paperInstruction}
          testId="document-detail-experience"
        />
        <DocumentForm
          mode="edit"
          document={document}
          onSaved={(updated) => {
            setDocument(updated);
            setIsEditing(false);
          }}
          onCancel={() => setIsEditing(false)}
        />
      </div>
    );
  }

  const lifecycle = resolveDocumentLifecycle({ documentId: document.id });
  const openReasons = lifecycle?.openReasons ?? [];
  /*
   * VISUAL-POLISH-01C — Kopf nach den fünf Fragen: Dokumentart als Eyebrow,
   * Titel, „von wem/für wen · Datum · Betrag", Stand als StatusBadge. Der
   * Betrag kommt bei eigenen Rechnungen aus der verknüpften Rechnung (01D),
   * neue Daten entstehen nicht.
   */
  const lifecycleStatusKey = lifecycle ? getDocumentLifecycleStatusLabelKey(lifecycle.status) : null;
  const lifecycleTone: StatusTone = !lifecycle
    ? 'neutral'
    : lifecycle.status === 'done' || lifecycle.status === 'filed' || lifecycle.status === 'answered'
      ? 'success'
      : lifecycle.status === 'needs_action'
        ? 'warning'
        : lifecycle.status === 'waiting'
          ? 'info'
          : 'neutral';
  const linkedInvoice =
    isGeneratedInvoice && document.linkedInvoiceId ? findInvoiceById(document.linkedInvoiceId) : undefined;
  const headerMeta = [
    linkedInvoice?.customerSnapshot?.name || document.issuer || null,
    document.issueDate
      ? formatSafeDocumentDate(document.issueDate, setup.language, translate('document.date.unrecognized'))
      : null,
    linkedInvoice ? formatInvoiceCurrency(linkedInvoice.amount) : null,
  ].filter(Boolean);
  const lifecycleResolved = lifecycle != null;
  const replyOpen = lifecycleResolved && openReasons.includes('reply_open');
  const fileOriginalOpen = lifecycleResolved && openReasons.includes('file_original');
  const otherOpen =
    lifecycleResolved && openReasons.length > 0 && !replyOpen && !fileOriginalOpen;
  /** Fallback when lifecycle cannot be resolved: keep previous Experience reply CTA. */
  const showReplyPrimary = replyOpen || !lifecycleResolved;
  const filingMarkPrimary = Boolean(fileOriginalOpen && !replyOpen);

  const openOrderButton = document.linkedVorgang ? (
    <Button
      key="open-order"
      variant="outline"
      fullWidth
      data-testid="document-detail-open-order"
      onClick={() => navigate(`/vorgaenge/${document.linkedVorgang!.vorgangId}`)}
    >
      {translate('detail.action.openOrder')}
    </Button>
  ) : null;

  const replyButton = (
    <Button
      key="reply"
      fullWidth
      data-testid="document-detail-reply-action"
      onClick={() => navigate(`/kommunikation?context=document&id=${document.id}`)}
    >
      {translate('detail.action.writeMessage')}
    </Button>
  );

  let experienceActions: ReactNode;
  if (showReplyPrimary) {
    experienceActions = (
      <>
        {replyButton}
        {openOrderButton}
      </>
    );
  } else if (fileOriginalOpen) {
    experienceActions = openOrderButton;
  } else if (otherOpen) {
    experienceActions = (
      <>
        <p
          className="detail-experience-section__value detail-experience-section__value--assistant"
          data-testid="document-detail-next-step"
        >
          {lifecycle.nextStep}
        </p>
        {openOrderButton}
      </>
    );
  } else {
    experienceActions = openOrderButton;
  }

  const originalPanel = (
      <Card className="document-detail__preview">
        <DocumentDetailPreview documentId={document.id} revision={previewRevision} />
        {document.fileRefId ? (
          <DocumentOriginalFilePanel
            fileRefId={document.fileRefId}
            translate={translate}
            onPromoted={() => showToast(translate('document.original.promote.success'))}
          />
        ) : (
          <>
            <div className="document-detail__image">
              {document.imagePreview ? (
                <span aria-hidden>{document.imagePreview}</span>
              ) : (
                <FileTypeIcon
                  mimeType={document.mimeType}
                  fileName={document.title}
                  size="lg"
                />
              )}
            </div>
            {/*
              02F — bei Fremdpost heißt „keine Datei“ tatsächlich „das Original
              liegt im Ordner“. Eine selbst erzeugte Rechnung hat schlicht kein
              Papieroriginal; der Satz wäre dort eine falsche Auskunft.
            */}
            {isGeneratedInvoice ? null : (
              <p className="document-detail__preview-hint">{translate('document.previewHint')}</p>
            )}
          </>
        )}
      </Card>
  );

  const technicalPanels = (
    <>
      <DocumentDerivativeRecoveryStatusPanel
        documentId={document.id}
        onRecovered={() => setPreviewRevision((value) => value + 1)}
      />

      <DetailSection title={translate('document.section.technical')} testId="document-detail-section-data">
        <SummaryList>
        <DataRow label={translate('document.fieldCategory')} value={categoryLabel} />
        <DataRow label={translate('document.fieldIssuer')} value={document.issuer || '—'} />
        <DataRow
          label={translate('document.fieldValidity')}
          value={`${
            document.issueDate
              ? formatSafeDocumentDate(
                  document.issueDate,
                  setup.language,
                  translate('document.date.unrecognized'),
                )
              : '—'
          } – ${
            formatDocumentValidUntil(document.validUntil, setup.language) ?? '—'
          }`}
        />
        <DataRow
          label={translate('document.fieldDigitalFolder')}
          value={`${document.digitalFolder.name} (${document.digitalFolder.path})`}
        />
        {document.linkedCompany && (
          <DataRow label={translate('document.fieldLinkedCompany')} value={document.linkedCompany} />
        )}
        {document.linkedVorgang && (
          <DataRow
            label={translate('document.fieldLinkedVorgang')}
            value={
              <Link to={`/vorgaenge/${document.linkedVorgang.vorgangId}`}>
                {document.linkedVorgang.vorgangTitle}
              </Link>
            }
          />
        )}
        {/*
          * NORMAL-INVOICE-CANCELLATION-01B — kanonische Rechnungsnavigation:
          * mit Auftrag der Vorgangsweg, ohne Auftrag die globale Detailroute.
          * Ein Korrekturbeleg führt in seine eigene Ansicht (`?doc=korrektur`),
          * das Original-Archivdokument zur Originalrechnung.
          */}
        {document.linkedInvoiceId && (
          <DataRow
            label={translate('document.fieldLinkedInvoice')}
            value={
              <>
                <Link
                  to={`${buildInvoiceReachPath(document.linkedVorgang?.vorgangId ?? null, document.linkedInvoiceId)}${
                    isInvoiceCorrectionDocument(document) ? '?doc=korrektur' : '?from=overview'
                  }`}
                  data-testid="document-open-invoice"
                >
                  {translate(
                    isInvoiceCorrectionDocument(document)
                      ? 'invoice.cancel.openCorrection'
                      : 'document.openInvoice',
                  )}
                </Link>
                {' · '}
                <Link to="/rechnungen/offen">{translate('overview.title')}</Link>
              </>
            }
          />
        )}
        {document.tags.length > 0 && (
          <div className="badge-row document-detail__tags">
            {document.tags.map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </div>
        )}
        {/*
          Der erkannte Rohtext wird hier bewusst nicht mehr ausgegeben: Er war
          für den Nutzer keine Information, sondern eine Wand, durch die er bis
          zu den Aktionen scrollen musste. Der Text bleibt vollständig auf der
          Entität — Klassifikation, Suche, Contract Intelligence und die freien
          Dokumentfragen lesen ihn dort. Korrigieren lässt er sich weiterhin im
          Bearbeiten-Modus (DocumentForm).
        */}
        </SummaryList>
      </DetailSection>

      <DocumentLifecycleCard documentId={document.id} revision={detailRevision} />

      <CommunicationIntegrationPanel
        contextRef={{ type: 'document', id: document.id }}
        buttonKeys={communicationButtonKeys}
        testIdPrefix="dokument"
      />

      {deleteError ? (
        <p className="error-text" data-testid="document-delete-blocked">
          {deleteError}
        </p>
      ) : null}
      {/* Nur wenn es eine aktive Zuordnung gibt und der Eingangsbezug bekannt ist. */}
      {document.linkedVorgang && document.sourceInboxItemId?.trim() ? (
        <div className="form-actions document-detail__unlink">
          <Button
            variant="ghost"
            onClick={() => {
              setUnlinkError(null);
              setUnlinkConfirmOpen(true);
            }}
            data-testid="document-unlink-vorgang-trigger"
          >
            {translate('inbox.unlinkVorgang.action')}
          </Button>
        </div>
      ) : null}
      <SimpleConfirmDialog
        open={unlinkConfirmOpen}
        title={translate('inbox.unlinkVorgang.confirmTitle')}
        message={translate('inbox.unlinkVorgang.confirmMessage')}
        confirmLabel={translate('inbox.unlinkVorgang.confirmButton')}
        cancelLabel={translate('common.cancel')}
        failureMessage={unlinkError ?? undefined}
        dialogTestId="document-unlink-dialog"
        confirmTestId="document-unlink-confirm"
        cancelTestId="document-unlink-cancel"
        onConfirm={handleConfirmUnlinkVorgang}
        onCancel={() => {
          setUnlinkConfirmOpen(false);
          setUnlinkError(null);
        }}
      />
      <div className="detail-actions document-detail__actions">
        <Button variant="outline" onClick={() => setIsEditing(true)}>
          {translate('document.edit')}
        </Button>
        {!confirmDelete ? (
          <Button
            variant="danger"
            data-testid="document-detail-delete-trigger"
            onClick={() => {
              setDeleteError(null);
              setConfirmDelete(true);
            }}
          >
            {translate('document.delete')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {translate('common.cancel')}
            </Button>
            <Button
              variant="danger"
              data-testid="document-detail-delete-confirm"
              onClick={() => void handleDelete()}
            >
              {translate('document.deleteConfirm')}
            </Button>
          </>
        )}
      </div>
    </>
  );

  return (
    <div className="page document-detail-page" data-testid="document-detail-page">
      {/*
        * UIUX-FOUNDATION-01E — Detailmuster: Back (klarer Parent /dokumente),
        * Identität (Titel, Kategorie · Aussteller). Die fachlichen nächsten
        * Schritte bleiben in der Experience-Card; Rohtext bleibt sekundär.
        */}
      <PageHeader
        eyebrow={categoryLabel}
        title={document.title}
        subtitle={headerMeta.length > 0 ? headerMeta.join(' · ') : undefined}
        status={
          lifecycleStatusKey ? (
            <StatusBadge tone={lifecycleTone} label={translate(lifecycleStatusKey)} icon={false} />
          ) : undefined
        }
        backLabel={translate('common.back')}
        backHref="/dokumente"
        backTestId="document-detail-back"
        testId="document-detail-header"
        className="work-detail-head"
      />

      {/*
        * Zwei Spalten ab 1024 px: links „Muss ich etwas tun?" und die fachliche
        * Erklärung (01C, unverändert), rechts „Auf einen Blick", Original und
        * Ablage. Die Markup-Reihenfolge (Experience → Understanding → Filing →
        * Frage → Details) bleibt für Screenreader und Tests erhalten.
        */}
      <div className="work-detail-grid document-detail__grid">
        <div className="work-detail-grid__main">
          <DetailExperienceCard
            recognizedTitle={document.title}
            recognizedSummary={categoryLabel}
            assistantMessage={translate('document.experience.saved')}
            paperInstruction={paperInstruction}
            actions={experienceActions}
            hideIdentity
            testId="document-detail-experience"
          />

          <DocumentUnderstandingCard documentId={document.id} />
        </div>

        <div className="work-detail-grid__side">
          <DocumentArchiveTruthFactsCard document={document} />

          <section className="document-detail__original" data-testid="document-detail-original">
            <h2 className="document-detail__original-title">{translate('document.section.original')}</h2>
            {originalPanel}
          </section>

          <DocumentFilingCard
            documentId={document.id}
            markFiledVariant={filingMarkPrimary ? 'primary' : 'outline'}
            onChanged={() => setDetailRevision((value) => value + 1)}
          />
        </div>
      </div>

      <DocumentFreeQuestionPanel
        source={{ type: 'document', document }}
        testIdPrefix="document-free-question"
      />

      <ShowMoreSection
        expanded={showDetails}
        onToggle={() => setShowDetails((open) => !open)}
        showLabel={translate('common.showMore')}
        hideLabel={translate('common.showLess')}
        testId="document-detail-show-more"
      >
        {technicalPanels}
      </ShowMoreSection>
    </div>
  );
}
