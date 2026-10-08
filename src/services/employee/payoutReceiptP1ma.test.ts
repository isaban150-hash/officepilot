/**
 * P1 MITARBEITERZAHLUNGEN — Auszahlungsquittung: Modell, Betrag in Worten,
 * PDF (A4, Logo, Unicode, lange Namen, Unterschriftsbereiche) und die
 * einmalige Ablage im Archiv.
 *
 * Geprüft wird der Satz über das Layoutprotokoll des Renderers (dieselben
 * Aufrufe, die gezeichnet werden) und über das echte PDF (pdf-lib lädt es
 * zurück). Neutrale Beispieldaten.
 */
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentBlobDatabaseReset } from '../../test/documentBlobTestReset';
import { formatEuroAmountInWords, integerToGermanWords } from './amountInWords';
import {
  PAYOUT_RECEIPT_ADVANCE_HINT,
  PAYOUT_RECEIPT_CONFIRMATION,
  buildPayoutReceiptFilename,
  buildPayoutReceiptModel,
  formatReceiptAmount,
} from './payoutReceiptModel';
import {
  PAYOUT_RECEIPT_MARGIN_BOTTOM,
  PAYOUT_RECEIPT_MARGIN_LEFT,
  PAYOUT_RECEIPT_MARGIN_RIGHT,
  PAYOUT_RECEIPT_PAGE_HEIGHT,
  PAYOUT_RECEIPT_PAGE_WIDTH,
  generatePayoutReceiptPdf,
  type PayoutReceiptLayout,
} from './payoutReceiptPdfService';
import {
  ensurePayoutReceiptArchived,
  loadPayoutReceiptOriginal,
  resetPayoutReceiptArchiveForTests,
} from './payoutReceiptArchiveService';
import { buildPayoutReceiptDocumentId } from './payoutReceiptDocumentId';
import { createEmployee } from './employeeService';
import {
  confirmEmployeePayment,
  getEmployeePaymentById,
  prepareEmployeePaymentConfirmation,
  reverseEmployeePayment,
} from './employeePaymentService';
import { getAllDocuments, getDocumentById } from '../documentService';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { resolveDocumentLifecycle } from '../documentLifecycleService';
import { resetSyncClientForTests } from '../sync/syncClientService';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import type { CompanyProfile } from '../../types/models';
import type { EmployeePayment, EmployeePaymentDraft } from '../../types/employee';

const WS = '00000000-0000-4000-8000-00000000e1b1';
const PNG_EIN_PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function firma(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    ...DEFAULT_COMPANY_PROFILE,
    companyName: 'Beispiel Haustechnik',
    legalForm: 'GmbH',
    street: 'Musterstraße 5',
    zip: '33602',
    city: 'Bielefeld',
    phone: '0521 123456',
    email: 'info@beispiel-haustechnik.invalid',
    website: 'www.beispiel-haustechnik.invalid',
    logoDataUrl: undefined,
    ...overrides,
  };
}

function zahlung(overrides: Partial<EmployeePayment> = {}): EmployeePayment {
  return {
    id: 'pay-quittung-1',
    employeeId: 'emp-1',
    employeeName: 'Erika Beispiel',
    personnelNumber: 'P-01',
    kind: 'wage',
    amount: 1234.56,
    paymentDate: '2026-10-01',
    paymentMethod: 'cash',
    wageMonth: '2026-09',
    purpose: 'Lohn September',
    receiptReference: 'MZ-20261001-ABCD2345',
    paidByName: 'Max Muster',
    createdAt: '2026-10-01T08:00:00.000Z',
    ...overrides,
  };
}

function texte(layout: PayoutReceiptLayout): string[] {
  return layout.texts.map((run) => run.text);
}

function allesInnerhalb(layout: PayoutReceiptLayout): boolean {
  const rechts = PAYOUT_RECEIPT_PAGE_WIDTH - PAYOUT_RECEIPT_MARGIN_RIGHT + 0.5;
  return layout.texts.every(
    (run) =>
      run.x >= PAYOUT_RECEIPT_MARGIN_LEFT - 0.5 &&
      run.x + run.width <= rechts &&
      run.y >= 20 &&
      run.y <= PAYOUT_RECEIPT_PAGE_HEIGHT,
  );
}

/* ================================================================== */
describe('Betrag in Worten — nur im geprüften Bereich', () => {
  it.each([
    [0.01, 'null Euro und ein Cent'],
    [0.5, 'null Euro und fünfzig Cent'],
    [1, 'ein Euro'],
    [1.01, 'ein Euro und ein Cent'],
    [16, 'sechzehn Euro'],
    [21, 'einundzwanzig Euro'],
    [30, 'dreißig Euro'],
    [101, 'einhunderteins Euro'],
    [117, 'einhundertsiebzehn Euro'],
    [999, 'neunhundertneunundneunzig Euro'],
    [1000, 'eintausend Euro'],
    [1001, 'eintausendeins Euro'],
    [1234.56, 'eintausendzweihundertvierunddreißig Euro und sechsundfünfzig Cent'],
    [21000, 'einundzwanzigtausend Euro'],
    [100000, 'einhunderttausend Euro'],
    [1000000, 'eine Million Euro'],
    [2000000.99, 'zwei Millionen Euro und neunundneunzig Cent'],
    [3450017.4, 'drei Millionen vierhundertfünfzigtausendsiebzehn Euro und vierzig Cent'],
    [9999999.99, 'neun Millionen neunhundertneunundneunzigtausendneunhundertneunundneunzig Euro und neunundneunzig Cent'],
  ])('%s → %s', (betrag, worte) => {
    expect(formatEuroAmountInWords(betrag)).toBe(worte);
  });

  it('außerhalb des Bereichs oder ungenau: keine Worte', () => {
    for (const betrag of [0, -1, 1.005, Number.NaN, Number.POSITIVE_INFINITY, 10000000]) {
      expect(formatEuroAmountInWords(betrag)).toBeNull();
    }
    expect(integerToGermanWords(10_000_000)).toBeNull();
    expect(integerToGermanWords(0)).toBe('null');
  });
});

/* ================================================================== */
describe('Quittungsmodell', () => {
  it('enthält alle Angaben aus der Zahlung und den Firmendaten', () => {
    const ergebnis = buildPayoutReceiptModel(zahlung(), firma());
    expect(ergebnis.ok).toBe(true);
    if (!ergebnis.ok) return;
    const modell = ergebnis.model;
    expect(modell.title).toBe('Auszahlungsquittung');
    expect(modell.subtitle).toBe('Quittung über eine Barauszahlung');
    expect(modell.companyLines).toEqual(['Beispiel Haustechnik GmbH', 'Musterstraße 5', '33602 Bielefeld', 'Deutschland']);
    expect(modell.contactLine).toContain('Telefon 0521 123456');
    expect(modell.facts).toEqual([
      { label: 'Referenz', value: 'MZ-20261001-ABCD2345' },
      { label: 'Auszahlungsdatum', value: '01.10.2026' },
      { label: 'Mitarbeiter/in', value: 'Erika Beispiel' },
      { label: 'Personalnummer', value: 'P-01' },
      { label: 'Art der Zahlung', value: 'Lohn/Gehalt' },
      { label: 'Lohnmonat', value: 'September 2026' },
      { label: 'Zahlungsweg', value: 'Bar' },
      { label: 'Ausgezahlt durch', value: 'Max Muster' },
    ]);
    expect(modell.amountText).toBe('1.234,56 €');
    expect(modell.amountInWords).toBe('eintausendzweihundertvierunddreißig Euro und sechsundfünfzig Cent');
    expect(modell.confirmationText).toBe(PAYOUT_RECEIPT_CONFIRMATION);
    expect(modell.confirmationText).toBe('Ich bestätige, den oben genannten Betrag in bar erhalten zu haben.');
    expect(modell.advanceHint).toBeNull();
    expect(modell.footerLeft).toBe('Auszahlungsquittung MZ-20261001-ABCD2345');
  });

  it('Vorschuss trägt den Vorschusshinweis; ohne „ausgezahlt durch" bleibt eine Linie zum Ausfüllen', () => {
    const ergebnis = buildPayoutReceiptModel(zahlung({ kind: 'advance', wageMonth: undefined, paidByName: undefined }), firma());
    if (!ergebnis.ok) throw new Error('modell');
    expect(ergebnis.model.advanceHint).toBe(PAYOUT_RECEIPT_ADVANCE_HINT);
    expect(ergebnis.model.facts.find((fakt) => fakt.label === 'Lohnmonat')).toBeUndefined();
    expect(ergebnis.model.facts.find((fakt) => fakt.label === 'Ausgezahlt durch')).toEqual({
      label: 'Ausgezahlt durch',
      value: '',
      handwritten: true,
    });
  });

  it('nur für eine nicht stornierte Barzahlung mit gültiger Referenz', () => {
    expect(buildPayoutReceiptModel(zahlung({ paymentMethod: 'bank' }), firma())).toEqual({ ok: false, reason: 'not_cash' });
    expect(buildPayoutReceiptModel(zahlung({ reversedAt: '2026-10-02T10:00:00.000Z', reversalReason: 'Test' }), firma())).toEqual({
      ok: false,
      reason: 'reversed',
    });
    expect(buildPayoutReceiptModel(zahlung({ receiptReference: 'X-1' }), firma())).toEqual({ ok: false, reason: 'invalid_payment' });
  });

  it('formatiert Beträge und Dateinamen ohne Gebietsschema-Abhängigkeit', () => {
    expect(formatReceiptAmount(0.5)).toBe('0,50 €');
    expect(formatReceiptAmount(9999999.99)).toBe('9.999.999,99 €');
    expect(buildPayoutReceiptFilename('MZ-20261001-ABCD2345')).toBe('Auszahlungsquittung_MZ-20261001-ABCD2345.pdf');
  });
});

/* ================================================================== */
describe('Quittungs-PDF', () => {
  it('ist ein echtes A4-PDF mit genau einer Seite und Fusszeile „Seite 1 von 1"', async () => {
    const ergebnis = await generatePayoutReceiptPdf(zahlung(), { company: firma(), loadLogo: async () => null });
    expect(ergebnis.ok).toBe(true);
    if (!ergebnis.ok) return;
    expect(String.fromCharCode(...ergebnis.bytes.slice(0, 5))).toBe('%PDF-');
    const pdf = await PDFDocument.load(ergebnis.bytes);
    expect(pdf.getPageCount()).toBe(1);
    const { width, height } = pdf.getPage(0).getSize();
    expect(width).toBeCloseTo(595.28, 1);
    expect(height).toBeCloseTo(841.89, 1);
    expect(ergebnis.layout.pageCount).toBe(1);
    expect(ergebnis.filename).toBe('Auszahlungsquittung_MZ-20261001-ABCD2345.pdf');

    const alle = texte(ergebnis.layout);
    for (const erwartet of [
      'Beispiel Haustechnik GmbH',
      'Auszahlungsquittung',
      'Quittung über eine Barauszahlung',
      'MZ-20261001-ABCD2345',
      '01.10.2026',
      'Erika Beispiel',
      'P-01',
      'Lohn/Gehalt',
      'September 2026',
      'Bar',
      '1.234,56 €',
      'Max Muster',
      'Ort, Datum',
      'Unterschrift Empfänger/in',
      'Unterschrift Auszahlende/r',
      'Seite 1 von 1',
      'Auszahlungsquittung MZ-20261001-ABCD2345',
    ]) {
      expect(alle, erwartet).toContain(erwartet);
    }
    expect(alle.join(' ')).toContain('Ich bestätige, den oben genannten Betrag in bar erhalten zu haben.');
    expect(alle.join(' ')).toContain('in Worten: eintausendzweihundertvierunddreißig Euro');
    expect(allesInnerhalb(ergebnis.layout)).toBe(true);
    /* Kein Produktbranding auf dem Beleg. */
    expect(alle.join(' ')).not.toMatch(/OfficeTakt|OfficePilot/);
  });

  it('der Betrag ist hervorgehoben — größer als jeder andere Text, im Rahmen', async () => {
    const ergebnis = await generatePayoutReceiptPdf(zahlung(), { company: firma(), loadLogo: async () => null });
    if (!ergebnis.ok) throw new Error('pdf');
    const betrag = ergebnis.layout.texts.find((run) => run.text === '1.234,56 €')!;
    expect(betrag.bold).toBe(true);
    expect(betrag.size).toBe(Math.max(...ergebnis.layout.texts.map((run) => run.size)));
    expect(ergebnis.layout.boxes.some((box) => box.role === 'amount')).toBe(true);
  });

  it('Unterschriftsbereiche: Ort/Datum, großes Feld Empfänger, kleineres Feld Auszahlender — zusammen auf einer Seite', async () => {
    const ergebnis = await generatePayoutReceiptPdf(zahlung(), { company: firma(), loadLogo: async () => null });
    if (!ergebnis.ok) throw new Error('pdf');
    const box = (role: string) => ergebnis.layout.boxes.find((entry) => entry.role === role)!;
    const empfaenger = box('signature_recipient');
    const zahler = box('signature_payer');
    const ort = box('place_date');
    expect(empfaenger && zahler && ort).toBeTruthy();
    expect(empfaenger.width * empfaenger.height).toBeGreaterThan(zahler.width * zahler.height);
    expect(empfaenger.height).toBeGreaterThanOrEqual(55);
    expect(new Set([empfaenger.page, zahler.page, ort.page]).size).toBe(1);
    expect(empfaenger.y).toBeGreaterThanOrEqual(PAYOUT_RECEIPT_MARGIN_BOTTOM - 0.5);
    /* Nichts überlappt: Ort/Datum steht über den Feldern, die Felder nebeneinander. */
    expect(ort.y).toBeGreaterThan(empfaenger.y + empfaenger.height);
    expect(zahler.x).toBeGreaterThanOrEqual(empfaenger.x + empfaenger.width);
  });

  it('bettet ein vorhandenes Logo ein und kommt ohne Logo genauso zurecht', async () => {
    const mit = await generatePayoutReceiptPdf(zahlung(), { company: firma({ logoDataUrl: PNG_EIN_PIXEL }) });
    const ohne = await generatePayoutReceiptPdf(zahlung(), { company: firma() });
    expect(mit.ok && ohne.ok).toBe(true);
    if (!mit.ok || !ohne.ok) return;
    expect(mit.layout.boxes.some((box) => box.role === 'logo')).toBe(true);
    expect(ohne.layout.boxes.some((box) => box.role === 'logo')).toBe(false);
    expect(mit.bytes.byteLength).toBeGreaterThan(ohne.bytes.byteLength);
    /* Ein nicht ladbares Logo verhindert die Quittung nicht. */
    const kaputt = await generatePayoutReceiptPdf(zahlung(), {
      company: firma({ branding: { logo: { assetId: 'asset-fehlt', mimeType: 'image/png' } } }),
    });
    expect(kaputt.ok).toBe(true);
    if (kaputt.ok) expect(kaputt.layout.boxes.some((box) => box.role === 'logo')).toBe(false);
  });

  it('Umlaute, ß, Euro und fremde Schriftzeichen werden gesetzt, nicht verworfen', async () => {
    const ergebnis = await generatePayoutReceiptPdf(
      zahlung({ employeeName: 'Jürgen Öztürk-Weiß', purpose: 'Auslagen für Straßenbahn – 12,50 € bar', kind: 'reimbursement', wageMonth: undefined }),
      { company: firma({ companyName: 'Müller & Söhne Bäckerei' }), loadLogo: async () => null },
    );
    expect(ergebnis.ok).toBe(true);
    if (!ergebnis.ok) return;
    const alle = texte(ergebnis.layout).join(' ');
    expect(alle).toContain('Jürgen Öztürk-Weiß');
    expect(alle).toContain('Müller & Söhne Bäckerei GmbH');
    expect(alle).toContain('Auslagen für Straßenbahn – 12,50 € bar');
    expect(alle).toContain('Auslagenerstattung');
  });

  it('lange Namen und Texte brechen um — nichts läuft über den Rand, alles bleibt auf einer Seite', async () => {
    const langerName = `${'Maximiliane-Friederike '.repeat(4)}${'X'.repeat(30)}`.slice(0, 120);
    const ohneLeerzeichen = 'Z'.repeat(120);
    const langerText = 'Erstattung für Material, Fahrtkosten und Parkgebühren laut beiliegenden Belegen. '.repeat(6).slice(0, 500);
    for (const name of [langerName, ohneLeerzeichen]) {
      const ergebnis = await generatePayoutReceiptPdf(
        zahlung({ employeeName: name, purpose: langerText, note: langerText, paidByName: 'P'.repeat(120) }),
        {
          company: firma({ companyName: 'Sehr lange Firmenbezeichnung '.repeat(4), street: 'Straße '.repeat(10) }),
          loadLogo: async () => null,
        },
      );
      expect(ergebnis.ok).toBe(true);
      if (!ergebnis.ok) return;
      expect(ergebnis.layout.pageCount).toBe(1);
      expect(allesInnerhalb(ergebnis.layout)).toBe(true);
      /* Der ganze Name steht auf dem Beleg — über mehrere Zeilen verteilt, nicht abgeschnitten. */
      const zusammen = texte(ergebnis.layout).join('');
      expect(zusammen.replace(/\s+/g, '')).toContain(name.replace(/\s+/g, ''));
      expect(texte(ergebnis.layout)).toContain('Seite 1 von 1');
    }
  });
});

/* ================================================================== */
describe('Quittung im Archiv — einmal, unter fester Kennung', () => {
  useDocumentBlobDatabaseReset();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-08T10:00:00.000Z'));
    resetPayoutReceiptArchiveForTests();
    resetSyncClientForTests({
      deviceId: 'dev-a',
      workspaceId: 'local-ws-a',
      serverWorkspaceId: WS,
      createdAt: '2026-01-01T00:00:00.000Z',
      syncPolicy: 'cloud_ready',
    });
    hydrateCompanyProfileStore(firma());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function bestaetigt(patch: Partial<EmployeePaymentDraft> = {}): EmployeePayment {
    const mitarbeiter = createEmployee({ name: 'Erika Beispiel' });
    if (!mitarbeiter.success) throw new Error('mitarbeiter');
    const vorbereitet = prepareEmployeePaymentConfirmation({
      employeeId: mitarbeiter.employee.id,
      kind: 'wage',
      amount: '800',
      paymentDate: '2026-10-02',
      paymentMethod: 'cash',
      ...patch,
    });
    if (!vorbereitet.ok) throw new Error(vorbereitet.errorKey);
    const ergebnis = confirmEmployeePayment(vorbereitet.intent);
    if (!ergebnis.success) throw new Error(ergebnis.errorKey);
    return ergebnis.payment;
  }

  it('legt die Quittung genau einmal ab — Personal, Mitarbeiter/Zahlungsnachweise/Jahr — und setzt receiptDocumentId', async () => {
    const zahlungA = bestaetigt();
    expect(getAllDocuments()).toHaveLength(0);

    const erst = await ensurePayoutReceiptArchived(zahlungA.id);
    expect(erst.ok).toBe(true);
    if (!erst.ok) return;
    expect(erst.created).toBe(true);
    expect(erst.document.id).toBe(buildPayoutReceiptDocumentId(zahlungA.id));
    expect(erst.document.id).toBe(`emp-receipt-${zahlungA.id}`);
    expect(erst.document).toMatchObject({
      category: 'personal',
      archived: true,
      mimeType: 'application/pdf',
      digitalFolder: { path: '/Mitarbeiter/Zahlungsnachweise/2026/' },
      paperFolder: { folderId: 'paper-personal', register: 'Lohn' },
    });
    expect(erst.document.fileRefId).toBeTruthy();
    expect(getEmployeePaymentById(zahlungA.id)?.receiptDocumentId).toBe(erst.document.id);

    for (let i = 0; i < 3; i += 1) {
      const weiter = await ensurePayoutReceiptArchived(zahlungA.id);
      expect(weiter).toMatchObject({ ok: true, created: false });
      if (weiter.ok) expect(weiter.document.id).toBe(erst.document.id);
    }
    expect(getAllDocuments().filter((doc) => doc.id.startsWith('emp-receipt-'))).toHaveLength(1);
  });

  it('gleichzeitige Aufrufe erzeugen kein zweites Original', async () => {
    const zahlungA = bestaetigt();
    const [a, b] = await Promise.all([ensurePayoutReceiptArchived(zahlungA.id), ensurePayoutReceiptArchived(zahlungA.id)]);
    expect(a.ok && b.ok).toBe(true);
    expect(getAllDocuments().filter((doc) => doc.id.startsWith('emp-receipt-'))).toHaveLength(1);
  });

  it('öffnet immer das Original — auch nachdem sich die Firmendaten geändert haben', async () => {
    const zahlungA = bestaetigt();
    const erst = await ensurePayoutReceiptArchived(zahlungA.id);
    if (!erst.ok) throw new Error('archiv');
    const original = await loadPayoutReceiptOriginal(zahlungA.id);
    expect(original.ok).toBe(true);
    if (!original.ok) return;
    const vorher = new Uint8Array(await original.blob.arrayBuffer());
    expect(String.fromCharCode(...vorher.slice(0, 5))).toBe('%PDF-');

    hydrateCompanyProfileStore(firma({ companyName: 'Ganz Andere Firma', street: 'Neue Gasse 9' }));
    const nochmal = await ensurePayoutReceiptArchived(zahlungA.id);
    expect(nochmal).toMatchObject({ ok: true, created: false });
    const spaeter = await loadPayoutReceiptOriginal(zahlungA.id);
    if (!spaeter.ok) throw new Error('original');
    const nachher = new Uint8Array(await spaeter.blob.arrayBuffer());
    expect(nachher).toEqual(vorher);
    expect(spaeter.filename).toBe(`Auszahlungsquittung_${zahlungA.receiptReference}.pdf`);
  });

  it('keine Quittung für Bank, keine neue nach dem Storno — eine vorhandene bleibt', async () => {
    const bank = bestaetigt({ paymentMethod: 'bank' });
    expect(await ensurePayoutReceiptArchived(bank.id)).toEqual({ ok: false, reason: 'not_cash' });

    const storniert = bestaetigt({ amount: '40' });
    reverseEmployeePayment(storniert.id, 'Doppelt erfasst');
    expect(await ensurePayoutReceiptArchived(storniert.id)).toEqual({ ok: false, reason: 'reversed' });
    expect(getDocumentById(buildPayoutReceiptDocumentId(storniert.id))).toBeUndefined();

    const mitQuittung = bestaetigt({ amount: '55' });
    const erst = await ensurePayoutReceiptArchived(mitQuittung.id);
    if (!erst.ok) throw new Error('archiv');
    reverseEmployeePayment(mitQuittung.id, 'Storno nach Quittung');
    const danach = await ensurePayoutReceiptArchived(mitQuittung.id);
    expect(danach).toMatchObject({ ok: true, created: false });
    expect(getDocumentById(erst.document.id)).toBeTruthy();
  });

  it('die erzeugte Quittung verlangt kein „Original abheften" — das gilt der unterschriebenen Fassung', async () => {
    const zahlungA = bestaetigt();
    const erst = await ensurePayoutReceiptArchived(zahlungA.id);
    if (!erst.ok) throw new Error('archiv');
    const lebenslauf = resolveDocumentLifecycle({ documentId: erst.document.id }, '2026-10-08');
    expect(lebenslauf?.openReasons ?? []).not.toContain('file_original');
  });
});
