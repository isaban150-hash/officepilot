/**
 * E-RECHNUNG-04E3 — die ZUGFeRD-Rechnung im Rechnungsdetail.
 *
 * Dieselben drei Haltungen wie beim XRechnung-Bauteil daneben, aus denselben
 * Gründen:
 *
 *  - **Confirm-first.** Beim Öffnen wird nur nachgesehen, ob es bereits ein
 *    ZUGFeRD-Dokument gibt. Erzeugt wird erst auf ausdrückliche Anforderung —
 *    und heruntergeladen auch erst dann.
 *  - **Erst prüfen, dann erzeugen.** Was 04C nicht freigibt, bekommt keine
 *    Datei; auch keine halbe. Was fehlt, steht in verständlichen Sätzen da.
 *  - **Keine Zertifizierungsbehauptung.** Angezeigt wird, dass die interne
 *    Prüfung bestanden ist und in welchem Format die Datei vorliegt. Dass eine
 *    zuständige Stelle sie geprüft hätte, steht dort nicht.
 *
 * Und die Invariante aus 04D-FIX2 gilt hier genauso: Der Zustand trägt die
 * Rechnungskennung mit sich. Beide Rechnungen liegen unter demselben
 * Routenmuster, der Router behält dieselbe Instanz — ohne diese Kopplung
 * erschiene nach einem Wechsel der Dateiname der vorigen Rechnung.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import {
  LEGACY_INVOICE_HINT,
  describeCanonicalIssue,
  describeRenderIssue,
  looksLikeLegacyInvoice,
} from '../../services/einvoice/einvoiceIssueText';
import {
  ZUGFERD_MIME_TYPE,
  ensureZugferdArtifact,
  readZugferdArtifact,
  type ZugferdStoredArtifact,
} from '../../services/einvoice/zugferd/zugferdArtifactService';
import type { VorgangInvoice } from '../../types/models';

interface Props {
  invoice: VorgangInvoice;
  /** Injizierbar für Tests — Produktionsstandard sind die echten Dienste. */
  ensureArtifact?: typeof ensureZugferdArtifact;
  readArtifact?: typeof readZugferdArtifact;
}

type PanelPhase =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'ready'; artifact: ZugferdStoredArtifact; reused: boolean }
  | { kind: 'blocked'; messages: string[]; legacy: boolean }
  | { kind: 'failed'; message: string };

interface PanelState {
  invoiceId: string;
  phase: PanelPhase;
}

export function ZugferdPanel({
  invoice,
  ensureArtifact = ensureZugferdArtifact,
  readArtifact = readZugferdArtifact,
}: Props) {
  const [state, setState] = useState<PanelState>({ invoiceId: invoice.id, phase: { kind: 'idle' } });
  const revokeRef = useRef<(() => void) | null>(null);

  useEffect(() => () => revokeRef.current?.(), []);

  /*
   * Beim Öffnen nur nachsehen — nichts erzeugen, nichts herunterladen. Der
   * Abruf ist asynchron und kann aus der Cloud kommen, deshalb die Wache:
   * Wechselt der Nutzer inzwischen weiter, darf das späte Ergebnis den neuen
   * Zustand nicht mehr anfassen.
   */
  useEffect(() => {
    let aktuell = true;
    setState({ invoiceId: invoice.id, phase: { kind: 'idle' } });

    void (async () => {
      try {
        const vorhanden = await readArtifact(invoice);
        if (!aktuell || !vorhanden) return;
        // Doppelte Sicherung: auch der Dienst muss zur richtigen Rechnung antworten.
        if (vorhanden.sourceInvoiceId !== invoice.id) return;
        setState({
          invoiceId: invoice.id,
          phase: { kind: 'ready', artifact: vorhanden, reused: true },
        });
      } catch {
        // Kein Artefakt lesbar ist kein Fehler — dann wird eben erzeugt.
      }
    })();

    return () => {
      aktuell = false;
    };
  }, [invoice.id, readArtifact]);

  /** Was für **diese** Rechnung gilt — alles andere zählt nicht. */
  const phase: PanelPhase = state.invoiceId === invoice.id ? state.phase : { kind: 'idle' };

  const download = (artifact: ZugferdStoredArtifact): boolean => {
    /*
     * Die Sicherheitsinvariante. Ein ZUGFeRD-Dokument einer anderen Rechnung
     * wäre besonders heikel: Es enthält den maschinenlesbaren Datensatz, der
     * beim Empfänger gebucht wird. Im Zweifel lieber keine Datei.
     */
    if (artifact.sourceInvoiceId !== invoice.id) return false;
    if (artifact.mimeType !== ZUGFERD_MIME_TYPE) return false;

    revokeRef.current?.();
    const url = URL.createObjectURL(
      new Blob([artifact.bytes as BlobPart], { type: ZUGFERD_MIME_TYPE }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = artifact.fileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    revokeRef.current = () => URL.revokeObjectURL(url);
    return true;
  };

  const run = async (): Promise<void> => {
    if (phase.kind === 'working') return;
    const angefragt = invoice.id;
    setState({ invoiceId: angefragt, phase: { kind: 'working' } });

    /** Ein Ergebnis zählt nur, wenn noch dieselbe Rechnung offen ist. */
    const anwenden = (next: PanelPhase): void => {
      setState((prev) =>
        prev.invoiceId === angefragt ? { invoiceId: angefragt, phase: next } : prev,
      );
    };

    try {
      const result = await ensureArtifact(invoice);
      if (result.ok) {
        if (!download(result.artifact)) {
          anwenden({
            kind: 'failed',
            message: 'Die ZUGFeRD-Rechnung gehört zu einer anderen Rechnung.',
          });
          return;
        }
        anwenden({ kind: 'ready', artifact: result.artifact, reused: result.reused });
        return;
      }
      if (result.reason === 'canonical_incomplete') {
        anwenden({
          kind: 'blocked',
          messages: result.issues.map(describeCanonicalIssue),
          legacy: looksLikeLegacyInvoice(result.issues),
        });
        return;
      }
      if (result.reason === 'render_failed') {
        anwenden({
          kind: 'blocked',
          messages: result.issues.map(describeRenderIssue),
          legacy: false,
        });
        return;
      }
      if (result.reason === 'pdf_xml_mismatch') {
        /*
         * Der Ernstfall. Sichtbares Dokument und eingebetteter Datensatz
         * sagten Verschiedenes — dann entsteht keine Datei. Ein hybrider Beleg,
         * bei dem beide Teile auseinanderlaufen, ist schlimmer als gar keiner:
         * Der Empfänger bucht nach dem Datensatz und liest das Papier.
         */
        anwenden({
          kind: 'blocked',
          messages: [
            'Der sichtbare Teil der Rechnung und die eingebetteten Rechnungsdaten stimmen nicht überein. Es wurde deshalb keine Datei erzeugt.',
          ],
          legacy: false,
        });
        return;
      }
      if (result.reason === 'no_archive_document') {
        anwenden({
          kind: 'blocked',
          messages: [
            'Zu dieser Rechnung gibt es kein Archivdokument, an dem die ZUGFeRD-Rechnung abgelegt werden könnte.',
          ],
          legacy: false,
        });
        return;
      }
      anwenden({ kind: 'failed', message: 'Die ZUGFeRD-Rechnung konnte nicht gespeichert werden.' });
    } catch {
      anwenden({ kind: 'failed', message: 'Die ZUGFeRD-Rechnung konnte nicht erzeugt werden.' });
    }
  };

  return (
    <section className="invoice-einvoice__format" data-testid="invoice-zugferd-panel">
      <h4 className="invoice-einvoice__format-title">ZUGFeRD</h4>
      <p className="hint-text" data-testid="invoice-zugferd-hint">
        PDF/A-3-Rechnung mit eingebetteten strukturierten Rechnungsdaten. Die Datei wird erst auf
        Ihre Anforderung hin erzeugt und nicht automatisch versendet.
      </p>

      <Button
        type="button"
        variant="outline"
        fullWidth
        disabled={phase.kind === 'working'}
        onClick={() => void run()}
        data-testid="invoice-zugferd-action"
      >
        {phase.kind === 'working'
          ? 'ZUGFeRD wird erzeugt …'
          : phase.kind === 'ready'
            ? 'ZUGFeRD erneut herunterladen'
            : 'ZUGFeRD erzeugen und herunterladen'}
      </Button>

      {phase.kind === 'ready' && (
        <div className="invoice-einvoice__result" data-testid="invoice-zugferd-result">
          <p>
            {phase.reused
              ? 'Für diese Rechnung liegt bereits eine ZUGFeRD-Rechnung vor.'
              : 'Die ZUGFeRD-Rechnung wurde erzeugt und heruntergeladen.'}
          </p>
          {/*
            * Sachlich und ohne Zertifizierungsbehauptung: was vorliegt, in
            * welchem Format, mit welchem Prüfwert und wo es liegt.
            */}
          <dl className="invoice-einvoice__facts">
            <dt>Rechnung</dt>
            <dd data-testid="invoice-zugferd-source">{phase.artifact.sourceInvoiceNumber}</dd>
            <dt>Datei</dt>
            <dd data-testid="invoice-zugferd-filename">{phase.artifact.fileName}</dd>
            <dt>Format</dt>
            <dd data-testid="invoice-zugferd-format">
              ZUGFeRD {phase.artifact.standardVersion} · {phase.artifact.profile} ·{' '}
              {phase.artifact.pdfConformance}
            </dd>
            <dt>Interne Prüfung</dt>
            <dd>bestanden</dd>
            <dt>Ablage</dt>
            <dd data-testid="invoice-zugferd-durability">
              {phase.artifact.durability === 'cloud_backed'
                ? 'Lokal und in der Cloud gesichert'
                : 'Lokal gespeichert · Cloud-Sicherung steht noch aus'}
            </dd>
            <dt>Prüfwert (SHA-256)</dt>
            <dd className="invoice-einvoice__hash" data-testid="invoice-zugferd-sha">
              {phase.artifact.contentSha256}
            </dd>
          </dl>
        </div>
      )}

      {phase.kind === 'blocked' && (
        <div className="invoice-einvoice__blocked" data-testid="invoice-zugferd-blocked">
          <p>Für diese Rechnung kann keine ZUGFeRD-Rechnung erzeugt werden:</p>
          <ul>
            {phase.messages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
          {phase.legacy && <p className="hint-text">{LEGACY_INVOICE_HINT}</p>}
        </div>
      )}

      {phase.kind === 'failed' && (
        <p className="form-error" data-testid="invoice-zugferd-error">
          {phase.message}
        </p>
      )}
    </section>
  );
}
