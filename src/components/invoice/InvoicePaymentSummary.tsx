import { useState } from 'react';
import {
  calculatePaymentSummary,
  getOverdueDays,
  getSkontoFristStatus,
  isInvoiceCancelled,
  isZahlungszielUngeklaert,
} from '../../services/invoicePaymentService';
import { zahlungszielFenster } from '../../services/fristen/fristende';
import { fristBerichtigungSperre, kalenderFristenden } from '../../services/invoice/invoiceFristKlaerungService';
import { InvoiceFristKlaerungDialog } from './InvoiceFristKlaerungDialog';
import { Button } from '../ui/Button';
import { resolveWorkspaceWriteAccess, type WorkspaceActor } from '../../services/workspace/workspaceRoleService';
import { formatDisplayDate } from '../../utils/displayFormat';
import { toBusinessDay } from '../../services/businessDateService';
import { InvoicePaymentBadge } from './InvoicePaymentBadge';
import type { VorgangInvoice } from '../../types/models';
import type { TranslationKey } from '../../i18n';
import { InlineNotice } from '../ui/States';
import { MoneyDisplay } from '../ui/Display';
import { fromCents, toCents } from '../../services/invoiceMoney';
import { usesAbschlagDeductions } from '../../services/invoiceTypeService';

interface Props {
  invoice: VorgangInvoice;
  translate: (key: TranslationKey) => string;
  /**
   * FINANZ-CORE-01A (Gesamtnacharbeit INV-01/02) — mit beidem zeigt die Übersicht bei einer ungeklärten
   * Frist den Klärungsweg an der Rechnung („Fristende klären“). `vorgangId` `null` = freie Rechnung.
   */
  vorgangId?: string | null;
  onInvoiceChange?: (invoice: VorgangInvoice) => void;
  actor?: WorkspaceActor;
}

export function InvoicePaymentSummary({ invoice, translate, vorgangId, onInvoiceChange, actor }: Props) {
  const [klaerungOffen, setKlaerungOffen] = useState(false);
  /* END18-R2 — derselbe Dialog dient der ersten Klärung und der Berichtigung einer eindeutigen Grundlage. */
  const [klaerungModus, setKlaerungModus] = useState<'klaeren' | 'berichtigen'>('klaeren');
  const summary = calculatePaymentSummary(invoice);
  const overdueDays = getOverdueDays(invoice);
  /*
   * FINANZ-CORE-01A (Feiertage, § 193 BGB) — die Skontozahlung liegt nach dem frühestmöglichen, aber vor
   * dem spätestmöglichen Fristende: Ob sie rechtzeitig war, hängt an einem Feiertag am Sitz des Kunden.
   * Kein „verspätet“ und keine Mahnung — sichtbar die Bitte, den Ort am Kunden zu klären.
   */
  const skontoFrist = isInvoiceCancelled(invoice) ? null : getSkontoFristStatus(invoice);
  const skontoUnclear = skontoFrist?.status === 'ungeklaert' ? skontoFrist : null;
  // INV-01/02 — das Zahlungsziel ist vielleicht schon überschritten, vielleicht noch nicht.
  const zielUnclear = isInvoiceCancelled(invoice) ? null : isZahlungszielUngeklaert(invoice) ? zahlungszielFenster(invoice) : null;
  // Wie jede Finanzentscheidung nur für Inhaber und Verwaltung (der Server weist alle anderen ab).
  const darfKlaeren = !actor || resolveWorkspaceWriteAccess(actor).canWrite;
  const klaerbar = vorgangId !== undefined && Boolean(onInvoiceChange) && darfKlaeren;
  /*
   * FINANZ-CORE-01A (END18-R2) — eine schon eindeutige Grundlage (bei der Freigabe gebunden, aus dem Bestand oder
   * geklärt) bleibt berichtigbar, solange keine wirksame Schlussrechnung den Abschlag abgerechnet hat, die
   * Rechnung nicht storniert und die Verschiebung nicht abbedungen ist. Sonst steht der Grund da.
   */
  const hatFrist = Boolean(invoice.fristBasis) && (() => {
    const enden = kalenderFristenden(invoice);
    return Boolean(enden.skonto || enden.zahlungsziel);
  })();
  const sperre = hatFrist ? fristBerichtigungSperre(vorgangId ?? null, invoice) : null;
  const berichtigbar = klaerbar && hatFrist && !skontoUnclear && !zielUnclear && sperre === null;
  /*
   * FC01A-Nacharbeit (A7) — ausgeglichen, aber weniger gezahlt als berechnet: Das ist das
   * fristgerecht gewährte Skonto (dieselbe Regel wie der offene Betrag). Bisher stand
   * „Gesamtbetrag 476 / Bezahlt 466,48 / Offen 0" ohne Erklärung der Differenz.
   */
  const skontoGranted =
    !isInvoiceCancelled(invoice) &&
    summary.openAmount <= 0 &&
    summary.paidAmount > 0 &&
    toCents(summary.totalDue) > toCents(summary.paidAmount)
      ? fromCents(toCents(summary.totalDue) - toCents(summary.paidAmount))
      : 0;
  // Bei einer Schlussrechnung ist der Betrag der Rest nach Abzug der Abschläge, nicht die Gesamtleistung.
  const afterDeductions =
    usesAbschlagDeductions(invoice.type) && (invoice.previousAbschlagDeductions ?? []).length > 0;

  return (
    <section className="invoice-payment-summary">
      <div className="invoice-payment-summary__header">
        <h3 className="invoice-payment-summary__title">{translate('payment.summaryTitle')}</h3>
        <InvoicePaymentBadge status={summary.status} translate={translate} />
      </div>

      {isInvoiceCancelled(invoice) && (
        <InlineNotice tone="neutral">{translate('payment.invoiceCancelledNotice')}</InlineNotice>
      )}

      {summary.status === 'ueberfaellig' && !isInvoiceCancelled(invoice) && (
        <InlineNotice tone="critical">{translate('payment.invoiceOverdueNotice')}</InlineNotice>
      )}

      {skontoUnclear && (
        <InlineNotice tone="warning" testId="payment-summary-skonto-unclear">
          {(skontoUnclear.fenster.spaetestens === null
            ? translate('payment.skontoUnclearOpenNotice')
            : translate('payment.skontoUnclearNotice').replace('{latest}', formatDisplayDate(skontoUnclear.fenster.spaetestens))
          ).replace('{earliest}', formatDisplayDate(skontoUnclear.fenster.fruehestens))}
        </InlineNotice>
      )}

      {zielUnclear && (
        <InlineNotice tone="warning" testId="payment-summary-due-unclear">
          {(zielUnclear.spaetestens === null
            ? translate('payment.dueUnclearOpenNotice')
            : translate('payment.dueUnclearNotice').replace('{latest}', formatDisplayDate(zielUnclear.spaetestens))
          ).replace('{earliest}', formatDisplayDate(zielUnclear.fruehestens))}
        </InlineNotice>
      )}

      {(skontoUnclear || zielUnclear) && !darfKlaeren && (
        <p className="invoice-payment-summary__frist-note" data-testid="payment-summary-frist-role-hint">
          {translate('invoice.frist.roleHint')}
        </p>
      )}

      {(skontoUnclear || zielUnclear) && klaerbar && (
        <div className="invoice-payment-summary__actions">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setKlaerungModus('klaeren');
              setKlaerungOffen(true);
            }}
            data-testid="payment-summary-frist-clarify"
          >
            {translate('invoice.frist.open')}
          </Button>
        </div>
      )}

      {klaerbar && (
        <InvoiceFristKlaerungDialog
          vorgangId={vorgangId ?? null}
          invoice={invoice}
          open={klaerungOffen}
          onClose={() => setKlaerungOffen(false)}
          onClarified={(updated) => onInvoiceChange?.(updated)}
          translate={translate}
          actor={actor}
          modus={klaerungModus}
        />
      )}

      {invoice.fristBasis?.quelle === 'klaerung' && invoice.fristBasis.klaerung && (
        <p className="invoice-payment-summary__frist-note" data-testid="payment-summary-frist-clarified">
          {translate('invoice.frist.clarifiedNote')
            // Bericht 20 — der Geschäftstag der Klärung, nicht das UTC-Datum des Zeitstempels (00–02 Uhr war es der Vortag).
            .replace('{date}', formatDisplayDate(toBusinessDay(invoice.fristBasis.klaerung.am ?? invoice.fristBasis.festgelegtAm)))
            .replace('{reason}', invoice.fristBasis.klaerung.begruendung)}
        </p>
      )}

      {berichtigbar && (
        <div className="invoice-payment-summary__actions">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setKlaerungModus('berichtigen');
              setKlaerungOffen(true);
            }}
            data-testid="payment-summary-frist-correct"
          >
            {translate('invoice.frist.correct')}
          </Button>
        </div>
      )}

      {hatFrist && sperre === 'invoice.frist.finalInvoiceExists' && invoice.fristBasis?.quelle === 'klaerung' && (
        <p className="invoice-payment-summary__frist-note" data-testid="payment-summary-frist-locked">
          {translate('invoice.frist.lockedByFinal')}
        </p>
      )}

      <dl className="invoice-payment-summary__rows summary-list summary-list--single">
        <div className="invoice-payment-summary__row">
          <dt>{translate(afterDeductions ? 'payment.totalDueAfterDeductions' : 'payment.totalDue')}</dt>
          <dd><MoneyDisplay value={summary.totalDue} /></dd>
        </div>
        <div className="invoice-payment-summary__row">
          <dt>{translate('payment.paidAmount')}</dt>
          <dd><MoneyDisplay value={summary.paidAmount} /></dd>
        </div>
        {skontoGranted > 0 && (
          <div className="invoice-payment-summary__row" data-testid="payment-summary-skonto">
            <dt>{translate('payment.skontoGranted')}</dt>
            <dd><MoneyDisplay value={skontoGranted} /></dd>
          </div>
        )}
        <div className="invoice-payment-summary__row">
          <dt>{translate('payment.openAmount')}</dt>
          <dd><MoneyDisplay value={summary.openAmount} /></dd>
        </div>
        {summary.overpaidAmount > 0 && (
          <div className="invoice-payment-summary__row invoice-payment-summary__row--overpaid">
            <dt>{translate('payment.overpaidAmount')}</dt>
            <dd><MoneyDisplay value={summary.overpaidAmount} /></dd>
          </div>
        )}
      </dl>

      {overdueDays > 0 && (
        <p className="invoice-payment-summary__overdue-days">
          {translate('payment.overdueDays').replace('{days}', String(overdueDays))}
        </p>
      )}
    </section>
  );
}
