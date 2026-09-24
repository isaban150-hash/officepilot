/**
 * E-RECHNUNG-04D — die XRechnung im Rechnungsdetail.
 *
 * Bewusst eine Aktion in der bestehenden Detailseite und keine neue Seite und
 * kein neuer Navigationspunkt: Eine E-Rechnung ist keine eigene Sache, sondern
 * eine weitere Ausgabeform derselben Rechnung — wie das PDF daneben.
 *
 * Drei Haltungen stecken in diesem kleinen Bauteil:
 *
 *  - **Confirm-first.** Nichts entsteht bei der Freigabe. Beim Öffnen wird nur
 *    nachgesehen, ob es bereits eine XRechnung gibt; erzeugt wird erst auf
 *    ausdrückliche Anforderung.
 *  - **Erst prüfen, dann erzeugen.** Fehlt etwas, entsteht keine Datei — auch
 *    keine halbe. Was fehlt, steht in verständlichen Sätzen da.
 *  - **Keine Zertifizierungsbehauptung.** Angezeigt wird, dass die interne
 *    Prüfung bestanden ist und in welchem Format die Datei vorliegt. Dass die
 *    zuständige Stelle sie geprüft hätte, steht dort nicht.
 *
 * E-RECHNUNG-04D-FIX2 — jeder Zustand gehört genau einer Rechnung.
 *
 * Realbefund der unabhängigen Abnahme: Nach dem Erzeugen der XRechnung zu
 * 2026-0025 zeigten 2026-0023 und 2026-0024 weiterhin deren Dateinamen und
 * Prüfwert. Ursache war nicht die Fachlogik, sondern die Lebensdauer dieser
 * Komponente: Beide Rechnungen liegen unter demselben Routenmuster
 * (`/rechnungen/:invoiceId`), der Router behält dieselbe Instanz, und ein
 * `useState` überlebt den Wechsel.
 *
 * Deshalb trägt der Zustand hier die Rechnungskennung mit sich. Was nicht zur
 * gerade geöffneten Rechnung gehört, wird nicht angezeigt — und ein Ergebnis,
 * das zu spät aus einem alten Abruf zurückkommt, kann den neuen Zustand nicht
 * mehr überschreiben.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { EINVOICE_STANDARDS } from '../../services/einvoice/einvoiceStandards';
import {
  LEGACY_INVOICE_HINT,
  describeCanonicalIssue,
  describeRenderIssue,
  looksLikeLegacyInvoice,
} from '../../services/einvoice/einvoiceIssueText';
import {
  XRECHNUNG_MIME_TYPE,
  ensureXRechnungArtifact,
  readXRechnungArtifact,
  type XRechnungArtifact,
} from '../../services/einvoice/xrechnungArtifactService';
import type { VorgangInvoice } from '../../types/models';

interface Props {
  invoice: VorgangInvoice;
  /** Injizierbar für Tests — Produktionsstandard sind die echten Dienste. */
  ensureArtifact?: typeof ensureXRechnungArtifact;
  readArtifact?: typeof readXRechnungArtifact;
}

type PanelPhase =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'ready'; artifact: XRechnungArtifact; reused: boolean }
  | { kind: 'blocked'; messages: string[]; legacy: boolean }
  | { kind: 'failed'; message: string };

/**
 * Der Zustand und die Rechnung, zu der er gehört — untrennbar.
 *
 * Die Kennung steht **im** Zustand und nicht daneben: Zwei getrennte Felder
 * könnten auseinanderlaufen, dieses eine Objekt nicht. Jede Anzeige prüft sie,
 * bevor sie etwas zeigt.
 */
interface PanelState {
  invoiceId: string;
  phase: PanelPhase;
}

export function XRechnungPanel({
  invoice,
  ensureArtifact = ensureXRechnungArtifact,
  readArtifact = readXRechnungArtifact,
}: Props) {
  const [state, setState] = useState<PanelState>({ invoiceId: invoice.id, phase: { kind: 'idle' } });
  const revokeRef = useRef<(() => void) | null>(null);

  useEffect(() => () => revokeRef.current?.(), []);

  /*
   * Beim Öffnen einer Rechnung: Zustand zurücksetzen und nachsehen, ob es
   * bereits eine XRechnung gibt. Der Abruf ist asynchron, deshalb die Wache —
   * wechselt der Nutzer währenddessen weiter, darf das späte Ergebnis den
   * neuen Zustand nicht mehr anfassen.
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
        setState({ invoiceId: invoice.id, phase: { kind: 'ready', artifact: vorhanden, reused: true } });
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

  const download = (artifact: XRechnungArtifact): boolean => {
    /*
     * Die Sicherheitsinvariante. Selbst wenn oben etwas schiefginge, darf
     * niemals die XRechnung einer anderen Rechnung ausgeliefert werden: Der
     * Empfänger bekäme einen Beleg über fremde Beträge unter der falschen
     * Nummer. Im Zweifel lieber keine Datei.
     */
    if (artifact.sourceInvoiceId !== invoice.id) return false;

    revokeRef.current?.();
    const url = URL.createObjectURL(
      new Blob([artifact.bytes as BlobPart], { type: XRECHNUNG_MIME_TYPE }),
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
      setState((prev) => (prev.invoiceId === angefragt ? { invoiceId: angefragt, phase: next } : prev));
    };

    try {
      const result = await ensureArtifact(invoice);
      if (result.ok) {
        if (!download(result.artifact)) {
          anwenden({ kind: 'failed', message: 'Die XRechnung gehört zu einer anderen Rechnung.' });
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
        anwenden({ kind: 'blocked', messages: result.issues.map(describeRenderIssue), legacy: false });
        return;
      }
      if (result.reason === 'no_archive_document') {
        anwenden({
          kind: 'blocked',
          messages: [
            'Zu dieser Rechnung gibt es kein Archivdokument, an dem die XRechnung abgelegt werden könnte.',
          ],
          legacy: false,
        });
        return;
      }
      anwenden({ kind: 'failed', message: 'Die XRechnung konnte nicht gespeichert werden.' });
    } catch {
      anwenden({ kind: 'failed', message: 'Die XRechnung konnte nicht erzeugt werden.' });
    }
  };

  return (
    /*
     * E-RECHNUNG-04E3 — kein eigener Rahmen mehr.
     *
     * XRechnung und ZUGFeRD sind zwei Formate **einer** Funktion und stehen
     * deshalb in einem gemeinsamen Bereich (`EInvoicePanel`). Zwei Karten
     * nebeneinander hätten zwei getrennte Funktionen behauptet.
     */
    <section className="invoice-einvoice__format" data-testid="invoice-xrechnung-panel">
      <h4 className="invoice-einvoice__format-title">XRechnung</h4>
      <p className="hint-text" data-testid="invoice-xrechnung-hint">
        Strukturierte XML-Rechnung (XRechnung {EINVOICE_STANDARDS.xrechnung.generation}). Die Datei
        wird erst auf Ihre Anforderung hin erzeugt und nicht automatisch versendet.
      </p>

      <Button
        type="button"
        variant="outline"
        fullWidth
        disabled={phase.kind === 'working'}
        onClick={() => void run()}
        data-testid="invoice-xrechnung-action"
      >
        {phase.kind === 'working'
          ? 'XRechnung wird erzeugt …'
          : phase.kind === 'ready'
            ? 'XRechnung erneut herunterladen'
            : 'XRechnung erzeugen und herunterladen'}
      </Button>

      {phase.kind === 'ready' && (
        <div className="invoice-einvoice__result" data-testid="invoice-xrechnung-result">
          <p>
            {phase.reused
              ? 'Für diese Rechnung liegt bereits eine XRechnung vor.'
              : 'Die XRechnung wurde erzeugt und heruntergeladen.'}
          </p>
          {/*
            * Sachlich und ohne Zertifizierungsbehauptung: was vorliegt, in
            * welchem Format, mit welchem Prüfwert. Ob die zuständige Stelle die
            * Datei akzeptiert, entscheidet sie und nicht diese Anzeige.
            */}
          <dl className="invoice-einvoice__facts">
            <dt>Rechnung</dt>
            <dd data-testid="invoice-xrechnung-source">{phase.artifact.sourceInvoiceNumber}</dd>
            <dt>Datei</dt>
            <dd data-testid="invoice-xrechnung-filename">{phase.artifact.fileName}</dd>
            <dt>Format</dt>
            <dd>
              XRechnung {phase.artifact.standardVersion} · CII · Stand {phase.artifact.bundleVersion}
            </dd>
            <dt>Interne Prüfung</dt>
            <dd>bestanden</dd>
            {/*
              * E-RECHNUNG-04D3 — wo die Datei nachweislich liegt.
              *
              * „Gesichert" steht nur da, wenn der Sync die Datei tatsächlich
              * registriert hat. Solange das nicht der Fall ist — offline, Sync
              * noch nicht gelaufen, Upload fehlgeschlagen —, sagt die Anzeige
              * das offen. Ein Betrieb, der glaubt, sein Beleg liege revisionsfest
              * in der Cloud, während er nur in diesem Browser existiert, hätte
              * genau dann ein Problem, wenn es darauf ankommt.
              */}
            <dt>Ablage</dt>
            <dd data-testid="invoice-xrechnung-durability">
              {phase.artifact.durability === 'cloud_backed'
                ? 'Lokal und in der Cloud gesichert'
                : 'Lokal gespeichert · Cloud-Sicherung steht noch aus'}
            </dd>
            <dt>Prüfwert (SHA-256)</dt>
            {/*
              * Der Prüfwert ist 64 Zeichen ohne Trennstelle und lief auf einem
              * schmalen Bildschirm rechts heraus. `anywhere` bricht ihn an
              * beliebiger Stelle um — bei einer Hexfolge ohne Wortgrenzen ist
              * das die einzige Umbruchregel, die überhaupt greift.
              */}
            <dd className="invoice-einvoice__hash" data-testid="invoice-xrechnung-sha">
              {phase.artifact.contentSha256}
            </dd>
          </dl>
        </div>
      )}

      {phase.kind === 'blocked' && (
        <div className="invoice-einvoice__blocked" data-testid="invoice-xrechnung-blocked">
          <p>Für diese Rechnung kann keine XRechnung erzeugt werden:</p>
          <ul>
            {phase.messages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
          {phase.legacy && <p className="hint-text">{LEGACY_INVOICE_HINT}</p>}
        </div>
      )}

      {phase.kind === 'failed' && (
        <p className="form-error" data-testid="invoice-xrechnung-error">
          {phase.message}
        </p>
      )}
    </section>
  );
}
