/**
 * BRIEFE-01C — ein Geschäftsschreiben ansehen.
 *
 * Für einen Entwurf führt hier der Weg zurück in die Bearbeitung. Ein
 * fertiggestelltes Schreiben ist ein Beleg: Es wird nur noch gelesen, und es
 * gibt bewusst keine Schaltfläche, die etwas anderes verspricht.
 *
 * BRIEFE-01D — dazu kommen das fertige Dokument und seine Ablage: ansehen,
 * herunterladen, im Archiv wiederfinden. Auch das nur für fertiggestellte
 * Schreiben; ein Entwurf hat noch kein Dokument und gehört in kein Archiv.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { PageHeader, StatusBadge } from '../components/ui/Card';
import { Page } from '../components/ui/Page';
import { DetailSection, SummaryList } from '../components/ui/Section';
import { EmptyStateBlock } from '../components/ui/EmptyStateBlock';
import { useApp } from '../context/AppContext';
import { getBusinessLetterById } from '../services/businessLetterService';
import { getCustomerById } from '../services/customerStoreService';
import { getVorgangById } from '../services/vorgangService';
import {
  downloadBusinessLetterPdf,
  generateBusinessLetterPdf,
} from '../services/letter/businessLetterPdfService';
import { ensureBusinessLetterArchived } from '../services/letter/businessLetterArchiveService';

export function BriefDetailPage() {
  const { translate, language } = useApp();
  const navigate = useNavigate();
  const { letterId } = useParams<{ letterId: string }>();
  const [ablageToken, setAblageToken] = useState(0);
  const brief = useMemo(
    () => (letterId ? getBusinessLetterById(letterId) : null),
    [letterId, ablageToken],
  );

  const istFertig = brief?.status === 'finalized';

  /*
   * Die Ablage entsteht genau einmal, sobald ein fertiggestelltes Schreiben
   * geöffnet wird. Der Dienst selbst ist idempotent; der Merker hier verhindert
   * zusätzlich, dass ein erneutes Zeichnen derselben Ansicht überhaupt danach
   * fragt.
   */
  const abgelegtFuer = useRef<string>('');
  useEffect(() => {
    if (!brief || !istFertig) return;
    if (abgelegtFuer.current === brief.id) return;
    abgelegtFuer.current = brief.id;
    const ergebnis = ensureBusinessLetterArchived(brief);
    if (ergebnis.ok && ergebnis.created) setAblageToken((wert) => wert + 1);
  }, [brief, istFertig]);

  /* Die Vorschau lebt nur, solange die Seite offen ist. */
  const [vorschauUrl, setVorschauUrl] = useState('');
  const [pdfFehler, setPdfFehler] = useState('');
  const [laeuft, setLaeuft] = useState(false);
  useEffect(
    () => () => {
      if (vorschauUrl) URL.revokeObjectURL(vorschauUrl);
    },
    [vorschauUrl],
  );

  if (!brief) {
    return (
      <Page testId="letter-detail-page">
        <PageHeader
          title={translate('businessLetter.detail.title')}
          backLabel={translate('businessLetter.detail.back')}
          backHref="/schreiben"
        />
        <EmptyStateBlock
          title={translate('businessLetter.detail.notFound')}
          description={translate('businessLetter.area.emptyHint')}
          testId="letter-detail-missing"
        />
      </Page>
    );
  }

  const kunde = brief.customerId ? getCustomerById(brief.customerId) : null;
  const vorgang = brief.vorgangId ? getVorgangById(brief.vorgangId) : null;
  const datum = brief.letterDate
    ? new Date(brief.letterDate).toLocaleDateString(language === 'de' ? 'de-DE' : undefined)
    : '';

  const anschrift = [
    brief.recipient.company,
    brief.recipient.name,
    brief.recipient.street,
    [brief.recipient.zip, brief.recipient.city].filter(Boolean).join(' '),
    brief.recipient.country,
  ].filter((zeile) => Boolean(zeile && zeile.trim()));

  const zeigePdf = async () => {
    setPdfFehler('');
    setLaeuft(true);
    try {
      const ergebnis = await generateBusinessLetterPdf(brief);
      if (!ergebnis.ok) {
        setPdfFehler(translate('businessLetter.pdf.failed'));
        return;
      }
      const blob = new Blob([ergebnis.bytes.slice()], { type: 'application/pdf' });
      setVorschauUrl((bisher) => {
        if (bisher) URL.revokeObjectURL(bisher);
        return URL.createObjectURL(blob);
      });
    } catch {
      setPdfFehler(translate('businessLetter.pdf.failed'));
    } finally {
      setLaeuft(false);
    }
  };

  const ladePdf = async () => {
    setPdfFehler('');
    setLaeuft(true);
    try {
      const ergebnis = await downloadBusinessLetterPdf(brief);
      if (!ergebnis.ok) setPdfFehler(translate('businessLetter.pdf.failed'));
    } catch {
      setPdfFehler(translate('businessLetter.pdf.failed'));
    } finally {
      setLaeuft(false);
    }
  };

  return (
    <Page className="brief-detail" testId="letter-detail-page">
      <PageHeader
        title={brief.subject}
        subtitle={translate('businessLetter.detail.title')}
        backLabel={translate('businessLetter.detail.back')}
        backHref="/schreiben"
        backTestId="letter-detail-back"
        status={
          <StatusBadge
            tone={istFertig ? 'success' : 'neutral'}
            label={translate(
              istFertig ? 'businessLetter.status.finalized' : 'businessLetter.status.draft',
            )}
            data-testid="letter-detail-status"
          />
        }
        primaryAction={
          istFertig ? (
            <Button
              type="button"
              onClick={zeigePdf}
              disabled={laeuft}
              data-testid="letter-pdf-view"
            >
              {translate('businessLetter.pdf.view')}
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => navigate(`/schreiben/${brief.id}/bearbeiten`)}
              data-testid="letter-detail-edit"
            >
              {translate('businessLetter.detail.edit')}
            </Button>
          )
        }
        secondaryAction={
          istFertig ? (
            <Button
              type="button"
              variant="outline"
              onClick={ladePdf}
              disabled={laeuft}
              data-testid="letter-pdf-download"
            >
              {translate('businessLetter.pdf.download')}
            </Button>
          ) : undefined
        }
      />

      {istFertig ? (
        <p className="form-hint" data-testid="letter-detail-finalized-hint">
          {translate('businessLetter.detail.finalizedHint')}
        </p>
      ) : null}

      {pdfFehler ? (
        <p className="form-error" data-testid="letter-pdf-error">
          {pdfFehler}
        </p>
      ) : null}

      {vorschauUrl ? (
        <DetailSection title={translate('businessLetter.pdf.previewTitle')}>
          <iframe
            className="brief-detail__preview"
            src={vorschauUrl}
            title={translate('businessLetter.pdf.previewTitle')}
            data-testid="letter-pdf-preview"
          />
        </DetailSection>
      ) : null}

      <DetailSection title={translate('businessLetter.detail.recipient')}>
        <address className="brief-detail__address" data-testid="letter-detail-recipient">
          {anschrift.map((zeile) => (
            <span key={zeile} className="brief-detail__address-line">
              {zeile}
            </span>
          ))}
        </address>
        <SummaryList columns={2}>
          <div>
            <dt>{translate('businessLetter.detail.letterDate')}</dt>
            <dd data-testid="letter-detail-date">{datum}</dd>
          </div>
          {kunde ? (
            <div>
              <dt>{translate('businessLetter.detail.customer')}</dt>
              <dd data-testid="letter-detail-customer">{kunde.name}</dd>
            </div>
          ) : null}
          {vorgang ? (
            <div>
              <dt>{translate('businessLetter.detail.vorgang')}</dt>
              <dd data-testid="letter-detail-vorgang">{vorgang.title}</dd>
            </div>
          ) : null}
          {istFertig && brief.documentId ? (
            <div>
              <dt>{translate('businessLetter.detail.archive')}</dt>
              <dd>
                <Link to={`/dokumente/${brief.documentId}`} data-testid="letter-detail-archive-link">
                  {translate('businessLetter.detail.archiveOpen')}
                </Link>
              </dd>
            </div>
          ) : null}
        </SummaryList>
      </DetailSection>

      <DetailSection title={translate('businessLetter.detail.body')}>
        <p className="brief-detail__body" data-testid="letter-detail-body">
          {brief.body}
        </p>
      </DetailSection>
    </Page>
  );
}
