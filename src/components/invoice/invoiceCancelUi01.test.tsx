import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../context/AppContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { InvoiceDetailPage } from '../../pages/InvoiceDetailPage';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { InvoiceCancelDialog } from './InvoiceCancelDialog';
import { getPaymentBadgeClass } from './InvoicePaymentBadge';
import { calculatePaymentSummary } from '../../services/invoicePaymentService';
import { hasFinalSchlussrechnung, hasSchlussrechnung } from '../../services/orderBillingRules';
import { hydrateVorgangStore } from '../../services/vorgangService';
import { createTestVorgang } from '../../test/fixtures';
import type { VorgangInvoice } from '../../types/models';
import type { TranslationKey } from '../../i18n';

/**
 * FINAL-INVOICE-CANCELLATION-UI-01A — die sichtbare Stornierung.
 *
 * Geprüft wird der Bedienweg, nicht die Serverlogik: Wann erscheint die
 * Aktion, was verlangt der Dialog, wann wird der Dienst gerufen — und vor
 * allem, wann **nicht**.
 *
 * `invoiceCancellationService` ist gemockt. Der echte Dienst spricht mit der
 * Cloud; ihn hier laufen zu lassen hiesse, in einem Unittest eine Stornierung
 * zu versuchen. Die Servergrenze ist eigens abgesichert
 * (`invoiceCancellationSqlFoundation01`).
 */

const cancelMock = vi.hoisted(() => vi.fn());

vi.mock('../../services/invoice/invoiceCancellationService', () => ({
  cancelFinalizedInvoice: cancelMock,
}));

function translate(key: TranslationKey): string {
  return key;
}

function invoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-cancel-1',
    number: '2026-0400',
    type: 'schluss',
    positions: [],
    subtotal: 1000,
    taxStatus: 'standard_19',
    amount: 1190,
    status: 'versendet',
    date: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    issueDate: '2026-06-01',
    paymentDueDate: '2026-06-15',
    customerSnapshot: {
      name: 'Test Kunde',
      contactPerson: '',
      street: 'Musterweg 1',
      zip: '12345',
      city: 'Musterstadt',
      email: '',
      phone: '',
    },
    companySnapshot: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Muster GmbH' },
    legalNotices: [],
    previousAbschlagDeductions: [],
    ...overrides,
  } as VorgangInvoice;
}

let container: HTMLDivElement;
let root: Root | null = null;

async function mount(node: ReturnType<typeof createElement>) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
}

function testId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

/**
 * Tippen wie ein Mensch: React überschreibt den `value`-Setter des Elements,
 * ein direktes `element.value = …` erreicht den State deshalb nicht. Der native
 * Setter plus `input`-Event ist der Weg, der die Komponente wirklich bewegt.
 */
async function typeReason(text: string): Promise<void> {
  const field = testId('invoice-cancel-reason-input') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  await act(async () => {
    setter?.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/**
 * Bestätigen heisst hier: das Formular absenden. jsdom löst über einen
 * Buttonklick keine Formularübermittlung aus; dasselbe Muster nutzen die
 * Firmendaten-Tests bereits.
 *
 * Wichtig für die Aussagekraft: Ist die Bestätigung gesperrt, wird gar nicht
 * erst abgesendet — genau wie in der Oberfläche.
 */
function submitForm(): void {
  const submit = testId('invoice-cancel-submit') as HTMLButtonElement | null;
  if (!submit || submit.disabled) return;
  const form = testId('invoice-cancel-dialog') as HTMLFormElement;
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  cancelMock.mockReset();
  cancelMock.mockResolvedValue({ ok: true, action: 'cancelled' });
  hydrateVorgangStore([
    createTestVorgang({ id: 'v-cancel', invoices: [invoice()] }),
  ]);
});

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  container?.remove();
});

/* -------------------------------------------------------------------------- */
/* Sichtbarkeit — dieselbe Regel wie in InvoiceDetailPage                      */
/* -------------------------------------------------------------------------- */

/**
 * Die Seite entscheidet über die Sichtbarkeit; hier steht die Regel als reine
 * Funktion, damit sie einzeln prüfbar bleibt und nicht die ganze Detailseite
 * samt Routing montiert werden muss.
 */
function canCancel(entry: VorgangInvoice): boolean {
  return (
    entry.type === 'schluss' &&
    (entry.status === 'vorbereitet' || entry.status === 'versendet') &&
    !(entry.paymentStatus === 'storniert' || Boolean(entry.cancelledAt))
  );
}

describe('Sichtbarkeit der Stornoaktion', () => {
  it('A: freigegebene Schlussrechnung bietet die Aktion an', () => {
    expect(canCancel(invoice({ status: 'versendet' }))).toBe(true);
    expect(canCancel(invoice({ status: 'vorbereitet' }))).toBe(true);
  });

  it('B: eine Abschlagsrechnung bietet sie nicht an', () => {
    expect(canCancel(invoice({ type: 'abschlag', abschlagNumber: 1 }))).toBe(false);
    for (const type of ['rechnung', 'teilrechnung', 'gutschrift', 'storno'] as const) {
      expect(canCancel(invoice({ type })), type).toBe(false);
    }
  });

  it('C: ein Entwurf bietet sie nicht an', () => {
    expect(canCancel(invoice({ status: 'entwurf' }))).toBe(false);
  });

  it('D: eine bereits stornierte Rechnung bietet sie nicht erneut an', () => {
    expect(canCancel(invoice({ cancelledAt: '2026-06-20T09:00:00.000Z' }))).toBe(false);
    expect(canCancel(invoice({ paymentStatus: 'storniert' }))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Confirm-first                                                              */
/* -------------------------------------------------------------------------- */

describe('Bestätigungsdialog', () => {
  it('E: der Dialog zeigt, welche Rechnung betroffen ist', async () => {
    await mount(
      createElement(InvoiceCancelDialog, {
        vorgangId: 'v-cancel',
        invoice: invoice(),
        open: true,
        onClose: vi.fn(),
        onCancelled: vi.fn(),
        translate,
      }),
    );

    expect(testId('invoice-cancel-dialog')).toBeTruthy();
    expect(testId('invoice-cancel-number')?.textContent).toContain('2026-0400');
    expect(testId('invoice-cancel-type')?.textContent).toContain('Schlussrechnung');
    expect(testId('invoice-cancel-date')?.textContent).toContain('2026-06-01');
    expect(testId('invoice-cancel-amount')?.textContent).toContain('1.190,00');
    /* Die Aussagen über Erhalt und Endgültigkeit stehen im Dialog. */
    expect(testId('invoice-cancel-notice')).toBeTruthy();
  });

  it('F: solange nicht bestätigt wurde, ruft nichts den Dienst', async () => {
    await mount(
      createElement(InvoiceCancelDialog, {
        vorgangId: 'v-cancel',
        invoice: invoice(),
        open: true,
        onClose: vi.fn(),
        onCancelled: vi.fn(),
        translate,
      }),
    );

    expect(cancelMock).not.toHaveBeenCalled();
    /* Ohne Grund ist die Bestätigung gesperrt. */
    expect((testId('invoice-cancel-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('G: ein Grund aus reinen Leerzeichen genügt nicht', async () => {
    await mount(
      createElement(InvoiceCancelDialog, {
        vorgangId: 'v-cancel',
        invoice: invoice(),
        open: true,
        onClose: vi.fn(),
        onCancelled: vi.fn(),
        translate,
      }),
    );

    await typeReason('   ');

    expect((testId('invoice-cancel-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('H: Abbrechen schliesst den Dialog ohne jede Wirkung', async () => {
    const onClose = vi.fn();
    await mount(
      createElement(InvoiceCancelDialog, {
        vorgangId: 'v-cancel',
        invoice: invoice(),
        open: true,
        onClose,
        onCancelled: vi.fn(),
        translate,
      }),
    );

    await act(async () => {
      (testId('invoice-cancel-abort') as HTMLButtonElement).click();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('I: mit gültigem Grund wird der Dienst genau einmal gerufen', async () => {
    const onCancelled = vi.fn();
    const onClose = vi.fn();
    await mount(
      createElement(InvoiceCancelDialog, {
        vorgangId: 'v-cancel',
        invoice: invoice(),
        open: true,
        onClose,
        onCancelled,
        translate,
      }),
    );

    await typeReason('  Falscher Leistungszeitraum  ');

    await act(async () => {
      submitForm();
    });

    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(cancelMock).toHaveBeenCalledWith({
      vorgangId: 'v-cancel',
      invoiceId: 'inv-cancel-1',
      /* Getrimmt — Leerraum gehört nicht in die Buchhaltung. */
      reason: 'Falscher Leistungszeitraum',
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('J: Doppelklick erzeugt keinen zweiten Storno', async () => {
    let release: (value: unknown) => void = () => {};
    cancelMock.mockImplementation(
      () => new Promise((resolve) => {
        release = resolve;
      }),
    );

    await mount(
      createElement(InvoiceCancelDialog, {
        vorgangId: 'v-cancel',
        invoice: invoice(),
        open: true,
        onClose: vi.fn(),
        onCancelled: vi.fn(),
        translate,
      }),
    );

    await typeReason('Doppelklick');

    await act(async () => {
      submitForm();
      submitForm();
      submitForm();
    });

    expect(cancelMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      release({ ok: true, action: 'cancelled' });
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Fehlerausgänge                                                             */
/* -------------------------------------------------------------------------- */

describe('Fehlerbehandlung', () => {
  async function submitWithReason(entry: VorgangInvoice = invoice()) {
    await mount(
      createElement(InvoiceCancelDialog, {
        vorgangId: 'v-cancel',
        invoice: entry,
        open: true,
        onClose: vi.fn(),
        onCancelled: vi.fn(),
        translate,
      }),
    );
    await typeReason('Grund');
    await act(async () => {
      submitForm();
    });
  }

  it('K: eine aktive Zahlung blockiert verständlich und ohne Dienstaufruf', async () => {
    const withPayment = invoice({
      payments: [
        { id: 'pay-1', date: '2026-06-05', amount: 1190, createdAt: '2026-06-05T10:00:00.000Z' },
      ],
    });

    await mount(
      createElement(InvoiceCancelDialog, {
        vorgangId: 'v-cancel',
        invoice: withPayment,
        open: true,
        onClose: vi.fn(),
        onCancelled: vi.fn(),
        translate,
      }),
    );

    expect(testId('invoice-cancel-payment-block')?.textContent).toContain(
      'invoice.cancel.error.activePayments',
    );
    expect((testId('invoice-cancel-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('L: die Servergründe erscheinen als Satz, nie als technischer Code', async () => {
    const cases: Array<[string, string]> = [
      ['has_active_payments', 'invoice.cancel.error.activePayments'],
      ['type_not_supported', 'invoice.cancel.error.typeNotSupported'],
      ['not_finalized', 'invoice.cancel.error.notFinalized'],
      ['not_found', 'invoice.cancel.error.notFound'],
      ['forbidden', 'invoice.cancel.error.forbidden'],
      ['offline', 'invoice.cancel.error.offline'],
      ['unknown', 'invoice.cancel.error.unknown'],
    ];

    for (const [reason, key] of cases) {
      cancelMock.mockResolvedValue({ ok: false, reason });
      await submitWithReason();
      expect(testId('invoice-cancel-error')?.textContent, reason).toBe(key);
      expect(testId('invoice-cancel-error')?.textContent, reason).not.toContain('invoice_cancel_');
      if (root) {
        await act(async () => root!.unmount());
        root = null;
      }
      container.remove();
    }
  });

  it('M: offline storniert nichts lokal', async () => {
    cancelMock.mockResolvedValue({ ok: false, reason: 'offline' });
    const onCancelled = vi.fn();
    await mount(
      createElement(InvoiceCancelDialog, {
        vorgangId: 'v-cancel',
        invoice: invoice(),
        open: true,
        onClose: vi.fn(),
        onCancelled,
        translate,
      }),
    );
    await typeReason('Grund');
    await act(async () => {
      submitForm();
    });

    expect(onCancelled).not.toHaveBeenCalled();
    expect(testId('invoice-cancel-error')?.textContent).toBe('invoice.cancel.error.offline');
  });

  it('N2: nach local_persist_failed ist ein zweiter Storno gesperrt', async () => {
    /*
     * Der gefährlichste Ausgang: Die Cloud hat storniert, nur der lokale
     * Nachtrag fehlt. Würde die Oberfläche hier einen Fehler zeigen und den
     * Knopf offen lassen, würde der Nutzer eine bereits vollzogene Handlung
     * wiederholen.
     */
    cancelMock.mockResolvedValue({ ok: false, reason: 'local_persist_failed' });
    await submitWithReason();

    expect(testId('invoice-cancel-error')?.textContent).toBe(
      'invoice.cancel.error.localPersistFailed',
    );
    expect((testId('invoice-cancel-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(cancelMock).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Zustand nach dem Storno                                                    */
/* -------------------------------------------------------------------------- */

describe('Darstellung nach dem Storno', () => {
  const cancelled = {
    cancelledAt: '2026-06-20T09:30:00.000Z',
    cancelReason: 'Leistungszeitraum falsch',
  };

  it('O: der Zahlungsstatus meldet „storniert"', () => {
    const summary = calculatePaymentSummary(invoice(cancelled), '2026-07-01');
    expect(summary.status).toBe('storniert');
    /* Der Badge liest denselben Status — keine zweite Quelle. */
    expect(getPaymentBadgeClass(summary.status)).toContain('storniert');
  });

  it('P: Grund und Zeitpunkt stehen am Beleg', () => {
    const entry = invoice(cancelled);
    expect(entry.cancelReason).toBe('Leistungszeitraum falsch');
    expect(entry.cancelledAt?.slice(0, 10)).toBe('2026-06-20');
  });

  it('Q: die Originalrechnung bleibt unverändert erhalten', () => {
    const before = invoice();
    const after = invoice(cancelled);

    /* Nummer, Beträge, Positionen, Typ und Versandstatus sind unberührt. */
    expect(after.number).toBe(before.number);
    expect(after.amount).toBe(before.amount);
    expect(after.subtotal).toBe(before.subtotal);
    expect(after.type).toBe(before.type);
    /* „versendet" bleibt ein Faktum der Vergangenheit. */
    expect(after.status).toBe('versendet');
  });

  /**
   * Die echte Detailseite, nicht nur der Dialog: gerendert mit demselben
   * Provider-/Router-Muster, das `ux05DetailPages` bereits verwendet.
   */
  function renderDetailPage(entry: VorgangInvoice): string {
    hydrateVorgangStore([
      createTestVorgang({ id: 'v-detail', title: 'Bad Müller', invoices: [entry] }),
    ]);
    return renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/vorgaenge/v-detail/rechnungen/${entry.id}`]}>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <Routes>
            <Route path="/vorgaenge/:id/rechnungen/:invoiceId" element={<InvoiceDetailPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
  }

  it('S: die Detailseite bietet die Stornoaktion bei einer freigegebenen Schlussrechnung an', () => {
    const html = renderDetailPage(invoice());
    expect(html).toContain('data-testid="invoice-cancel-action"');
    expect(html).not.toContain('data-testid="invoice-cancelled-panel"');
  });

  it('T: bei Abschlagsrechnung und Entwurf fehlt die Aktion auf der Seite', () => {
    expect(renderDetailPage(invoice({ id: 'inv-ab', type: 'abschlag', abschlagNumber: 1 })))
      .not.toContain('data-testid="invoice-cancel-action"');
    expect(renderDetailPage(invoice({ id: 'inv-entw', status: 'entwurf' })))
      .not.toContain('data-testid="invoice-cancel-action"');
  });

  it('U: nach dem Storno zeigt die Seite Grund und Datum — und bietet kein zweites Storno an', () => {
    const html = renderDetailPage(invoice({ id: 'inv-storniert', ...cancelled }));

    expect(html).toContain('data-testid="invoice-cancelled-panel"');
    expect(html).toContain('data-testid="invoice-cancelled-at"');
    expect(html).toContain('2026-06-20');
    expect(html).toContain('data-testid="invoice-cancelled-reason"');
    expect(html).toContain('Leistungszeitraum falsch');
    /* Kein erneutes Storno, und keine Zahlungserfassung auf einem stornierten Beleg. */
    expect(html).not.toContain('data-testid="invoice-cancel-action"');
    /* Die Rechnung selbst bleibt sichtbar. */
    expect(html).toContain('2026-0400');
    expect(html).toContain('data-testid="invoice-print-document"');
  });

  it('R: eine stornierte Schlussrechnung blockiert die Ersatzrechnung nicht mehr', () => {
    const vorgang = createTestVorgang({
      id: 'v-nach-storno',
      invoices: [invoice(cancelled)],
    });

    expect(hasSchlussrechnung(vorgang)).toBe(false);
    expect(hasFinalSchlussrechnung(vorgang)).toBe(false);

    /* Eine wirksame Schlussrechnung sperrt weiterhin. */
    const mitWirksamer = createTestVorgang({
      id: 'v-wirksam',
      invoices: [invoice(cancelled), invoice({ id: 'inv-neu', number: '2026-0401' })],
    });
    expect(hasSchlussrechnung(mitWirksamer)).toBe(true);
  });
});
