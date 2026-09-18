import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../ui/Button';
import { StatusBadge } from '../ui/Badge';
import { DateDisplay, MoneyDisplay } from '../ui/Display';
import { BusinessListItem } from '../ui/Lists';
import { DropdownMenu } from '../ui/DropdownMenu';
import {
  getPaymentSavedToastKey,
  InvoicePaymentForm,
} from './InvoicePaymentForm';
import { paymentStatusTone } from '../../services/ui/statusTone';
import { isInvoiceCancelled } from '../../services/invoicePaymentService';
import { buildInvoiceReachPath } from '../../services/invoiceNavigation';
import { buildKommunikationPath } from '../communication/communicationNavigation';
import {
  canDocumentDunningForInvoice,
  formatDunningKindLabel,
  getLatestDunningDocumentation,
} from '../../services/dunningDocumentationService';
import type { InvoiceOverviewItem } from '../../services/invoiceOverviewService';
import type { VorgangInvoice } from '../../types/models';
import type { TranslationKey } from '../../i18n';

interface Props {
  item: InvoiceOverviewItem;
  translate: (key: TranslationKey) => string;
  onInvoiceUpdated?: (item: InvoiceOverviewItem) => void;
  onPaymentToast?: (message: string) => void;
}

function invoiceTypeLabel(invoice: VorgangInvoice, translate: (key: TranslationKey) => string): string {
  const key = `invoice.type.${invoice.type}` as TranslationKey;
  const label = translate(key);
  if (invoice.type === 'abschlag' && invoice.abschlagNumber) {
    return `${label} ${invoice.abschlagNumber}`;
  }
  return label;
}

function workflowStatusLabel(
  status: VorgangInvoice['status'],
  translate: (key: TranslationKey) => string,
): string {
  return translate(`invoice.status.${status}` as TranslationKey);
}

export function InvoiceOverviewCard({
  item,
  translate,
  onInvoiceUpdated,
  onPaymentToast,
}: Props) {
  const navigate = useNavigate();
  const [currentItem, setCurrentItem] = useState(item);
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const { invoice, paymentSummary } = currentItem;
  /*
   * MANUAL-INVOICE-UI-01B2 — der Vorgangslink bleibt der Vorgangsrechnung
   * vorbehalten; Öffnen/Drucken/PDF laufen für beide über den kanonischen
   * Erreichpfad (`buildInvoiceReachPath`): Vorgangsdetailseite mit Auftrag,
   * globale Detailseite `/rechnungen/:invoiceId` ohne. Kein `/vorgaenge/null/…`.
   */
  const hasVorgangLink = currentItem.vorgangId !== null;
  const detailPath = buildInvoiceReachPath(currentItem.vorgangId, invoice.id);

  useEffect(() => {
    setCurrentItem(item);
  }, [item]);

  const openInvoice = () => {
    navigate(`${detailPath}?from=overview`);
  };

  /*
   * PAYMENT-REMINDER-WITHOUT-VORGANG-01 — eine Zeile, eine zusätzliche
   * Handlung: Bei überfälligen Rechnungen steht „Erinnern" sichtbar neben der
   * Zahlungserfassung, sonst liegt sie im vorhandenen „Mehr"-Menü. Der
   * dokumentierte Mahnstand erscheint als Kennzahl in der Fußzeile — kein
   * zusätzlicher Knopf, keine zweite Kartenebene. Ohne Auftrag entfällt nur
   * der `vorgangId`-Parameter im Weg zur Kommunikation.
   */
  const canRemind = canDocumentDunningForInvoice(invoice);
  const isOverdue = paymentSummary.status === 'ueberfaellig';
  const latestDunning = getLatestDunningDocumentation(currentItem.vorgangId, invoice.id);
  const remind = () => {
    navigate(
      buildKommunikationPath(
        currentItem.vorgangId
          ? { type: 'invoice', id: invoice.id, vorgangId: currentItem.vorgangId }
          : { type: 'invoice', id: invoice.id },
      ),
    );
  };

  const triggerPrint = () => {
    navigate(`${detailPath}?auto=print`);
  };

  const triggerPdf = () => {
    navigate(`${detailPath}?auto=pdf`);
  };

  const handlePaymentSaved = (updated: VorgangInvoice) => {
    const nextItem = {
      ...currentItem,
      invoice: updated,
    };
    setCurrentItem(nextItem);
    onInvoiceUpdated?.(nextItem);
    onPaymentToast?.(translate(getPaymentSavedToastKey(updated)));
  };

  /*
   * UIUX-FOUNDATION-01E — Business-Zeile statt Karte: Identität (Nummer · Art,
   * Vorgang · Kunde, Baustelle), Fakten (Fälligkeit, Zahlungsstatus, offener
   * Betrag), darunter Kennzahlen und die bestehenden Aktionen. Testids und
   * Aktionslogik unverändert.
   */
  const paymentStatusLabel = translate(`payment.status.${paymentSummary.status}` as TranslationKey);
  return (
    <>
      <BusinessListItem
        className="invoice-overview-card"
        testId="invoice-overview-card"
        title={`${invoice.number} · ${invoiceTypeLabel(invoice, translate)}`}
        subtitle={
          <>
            {hasVorgangLink ? (
              <>
                <Link to={`/vorgaenge/${currentItem.vorgangId}`}>{currentItem.vorgangTitle}</Link>
                {' · '}
              </>
            ) : null}
            {currentItem.customer}
          </>
        }
        meta={currentItem.baustelle || undefined}
        status={<StatusBadge tone={paymentStatusTone(paymentSummary.status)} label={paymentStatusLabel} icon={false} />}
        date={
          <>
            {translate('invoice.paymentDueDate')}: <DateDisplay value={invoice.paymentDueDate ?? null} />
          </>
        }
        amount={<MoneyDisplay value={paymentSummary.openAmount} emphasis />}
        footer={
          <>
            {/*
              * VISUAL-POLISH-01C — geschäftlich lesbar in einer Zeile: Rechnungsdatum,
              * Gesamt, bezahlt (nur wenn etwas bezahlt ist), Arbeitsstatus. Der
              * offene Betrag steht bereits rechts als Hauptzahl.
              */}
            <dl className="business-list__figures" data-testid="invoice-overview-card-figures">
              <div>
                <dt>{translate('invoice.issueDate')}</dt>
                <dd>
                  <DateDisplay value={invoice.issueDate ?? invoice.date} />
                </dd>
              </div>
              <div>
                <dt>{translate('payment.totalDue')}</dt>
                <dd>
                  <MoneyDisplay value={paymentSummary.totalDue} />
                </dd>
              </div>
              {paymentSummary.paidAmount > 0 ? (
                <div>
                  <dt>{translate('payment.paidAmount')}</dt>
                  <dd>
                    <MoneyDisplay value={paymentSummary.paidAmount} />
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>{translate('payment.workflowStatus')}</dt>
                <dd>{workflowStatusLabel(invoice.status, translate)}</dd>
              </div>
              {latestDunning ? (
                <div data-testid="invoice-overview-card-dunning-status">
                  <dt>{translate('invoice.dunning.statusLabel')}</dt>
                  <dd>{formatDunningKindLabel(latestDunning.kind, translate)}</dd>
                </div>
              ) : null}
            </dl>
            <div className="invoice-overview-card__actions" data-testid="invoice-overview-card-actions">
              <Button type="button" size="sm" onClick={openInvoice} data-testid="invoice-overview-card-open">
                {translate('invoice.open')}
              </Button>
              {!isInvoiceCancelled(invoice) && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setShowPaymentForm(true)}
                  data-testid="invoice-overview-card-payment"
                >
                  {translate('payment.recordShort')}
                </Button>
              )}
              {canRemind && isOverdue ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={remind}
                  data-testid="invoice-overview-card-remind"
                >
                  {translate('invoice.dunning.remindShort')}
                </Button>
              ) : null}
              <DropdownMenu
                testId="invoice-overview-card-more"
                ariaLabel={translate('invoice.moreActions')}
                align="end"
                trigger={<span>{translate('invoice.moreActions')}</span>}
                items={[
                  ...(canRemind && !isOverdue
                    ? [
                        {
                          id: 'remind',
                          label: translate('invoice.dunning.writeReminder'),
                          onSelect: remind,
                          testId: 'invoice-overview-card-remind-menu',
                        },
                      ]
                    : []),
                  {
                    id: 'print',
                    label: translate('invoice.print'),
                    onSelect: triggerPrint,
                    testId: 'invoice-overview-card-print',
                  },
                  {
                    id: 'pdf',
                    label: translate('invoice.savePdf'),
                    onSelect: triggerPdf,
                    testId: 'invoice-overview-card-pdf',
                  },
                ]}
              />
              {invoice.archiveDocumentId && (
                <Link to={`/dokumente/${invoice.archiveDocumentId}`} className="invoice-overview-card__archive">
                  <Button type="button" size="sm" variant="ghost">
                    {translate('overview.archive')}
                  </Button>
                </Link>
              )}
            </div>
          </>
        }
      />
      <InvoicePaymentForm
        vorgangId={currentItem.vorgangId}
        invoice={invoice}
        open={showPaymentForm}
        onClose={() => setShowPaymentForm(false)}
        onSaved={handlePaymentSaved}
        translate={translate}
      />
    </>
  );
}
