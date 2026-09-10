/**
 * INVOICE-PDF-COMPANY-BLOCK-01 — der Firmenblock im tatsächlich erzeugten PDF.
 *
 * Der Anlass war ein belegter Ausgabekonflikt: `InvoiceFooter` zeigte
 * Geschäftsführer und Registerangaben, das über `InvoicePrintActions`
 * versendete PDF nicht. Wer die Bildschirmansicht prüfte, hielt die Angaben
 * für erledigt.
 *
 * Geprüft wird deshalb **nicht** das Markup, sondern was das PDF zeichnet:
 * `drawText` wird mitgeschnitten (und weiterhin ausgeführt) — dasselbe
 * Verfahren wie in `invoicePdfTextRendering01`. Kein OCR, kein Netz.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFPage } from 'pdf-lib';

import { generateApprovedInvoicePdf } from '../invoicePdfService';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import type { CompanyProfile, VorgangInvoice } from '../../types/models';

/** Der Snapshot aus Teil G des Auftrags. */
const SNAPSHOT_A: CompanyProfile = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Alpha Haustechnik GmbH',
  legalForm: 'GmbH',
  street: 'Werkstraße 12',
  zip: '32657',
  city: 'Lemgo',
  country: 'Deutschland',
  managingDirector: 'Max Mustermann, Erika Beispiel',
  phone: '05261 123456',
  email: 'buero@alpha.invalid',
  website: 'www.alpha.invalid',
  taxNumber: '111/222/33333',
  vatId: 'DE123456789',
  registrationAuthority: 'Amtsgericht Lemgo',
  registrationNumber: 'HRB 12345',
  bankName: 'Sparkasse Lemgo',
  iban: 'DE89 3704 0044 0532 0130 00',
  bic: 'WELADED1LIP',
};

function finalizedInvoice(company: Partial<CompanyProfile>): VorgangInvoice {
  return {
    id: 'inv-pdf-company',
    number: '2026-0042',
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-1',
        description: 'Montagearbeiten',
        quantity: 8,
        unit: 'Stunden',
        unitPrice: 55,
        lineTotal: 440,
      },
    ],
    subtotal: 440,
    taxStatus: 'standard_19',
    amount: 523.6,
    status: 'vorbereitet',
    date: '2026-09-01',
    createdAt: '2026-09-01T08:00:00.000Z',
    issueDate: '2026-09-01',
    servicePeriodFrom: '2026-08-01',
    servicePeriodTo: '2026-08-31',
    servicePeriodConfirmed: true,
    paymentDueDate: '2026-09-15',
    paymentTermsText: 'Zahlbar innerhalb von 14 Tagen.',
    customerSnapshot: {
      name: 'Beispiel Kundschaft GmbH',
      contactPerson: 'A. Beispiel',
      street: 'Musterweg 1',
      zip: '10115',
      city: 'Berlin',
      email: '',
      phone: '',
    },
    companySnapshot: { ...SNAPSHOT_A, ...company },
    legalNotices: [],
  } as unknown as VorgangInvoice;
}

/** Schneidet jeden gezeichneten Text mit, ohne das Zeichnen zu unterbinden. */
function captureDrawnText(): string[] {
  const drawn: string[] = [];
  const original = PDFPage.prototype.drawText;
  vi.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (
    this: PDFPage,
    text: string,
    options?: Parameters<PDFPage['drawText']>[1],
  ) {
    drawn.push(text);
    return original.call(this, text, options);
  });
  return drawn;
}

/** Erzeugt das echte PDF und gibt den gezeichneten Text zurück. */
async function drawnTextOf(company: Partial<CompanyProfile> = {}): Promise<string[]> {
  const drawn = captureDrawnText();
  const result = await generateApprovedInvoicePdf(finalizedInvoice(company));
  expect(result, JSON.stringify({ ok: result.ok })).toMatchObject({ ok: true });
  return drawn;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('01 — G: der Firmenblock steht im erzeugten PDF', () => {
  it('G1: Geschäftsführer, Register, Steuer- und Bankangaben sind vorhanden', async () => {
    const drawn = await drawnTextOf();
    const text = drawn.join('\n');

    /* Vertretung — beide Namen, unzerschnitten. */
    expect(text).toContain('Geschäftsführer/Inhaber');
    expect(text).toContain('Max Mustermann');
    expect(text).toContain('Erika Beispiel');

    /* Register. */
    expect(text).toContain('Registergericht');
    expect(text).toContain('Amtsgericht Lemgo');
    expect(text).toContain('HRB 12345');

    /* Was vorher schon da war, ist unverändert da. */
    expect(text).toContain('111/222/33333');
    expect(text).toContain('DE123456789');
    expect(text).toContain('DE89 3704 0044 0532 0130 00');
    expect(text).toContain('WELADED1LIP');
    expect(text).toContain('Sparkasse Lemgo');
    expect(text).toContain('Alpha Haustechnik GmbH');
  });

  it('I: mehrere Namen erscheinen vollständig, nichts wird auf den ersten gekürzt', async () => {
    const drawn = await drawnTextOf({
      managingDirector: 'Max Mustermann, Erika Beispiel',
    });

    /*
     * Der Wert darf umbrechen — er darf nicht verschwinden. Deshalb wird über
     * alle gezeichneten Stücke gesucht statt eine einzelne Zeile zu erwarten.
     */
    const joined = drawn.join(' ');
    expect(joined).toContain('Max Mustermann');
    expect(joined).toContain('Erika Beispiel');
    expect(joined).not.toContain('undefined');
    expect(joined).not.toContain('null');
  });

  it('ein leerer Geschäftsführer erzeugt keine Beschriftung', async () => {
    const drawn = await drawnTextOf({ managingDirector: '' });

    expect(drawn.join('\n')).not.toContain('Geschäftsführer/Inhaber');
  });

  it('nur Leerzeichen zählen wie leer', async () => {
    const drawn = await drawnTextOf({ managingDirector: '   ' });

    expect(drawn.join('\n')).not.toContain('Geschäftsführer/Inhaber');
  });
});

describe('01 — H: die optionalen Registerfälle im PDF', () => {
  it('H1: beide gesetzt → beide sichtbar, mit Trenner', async () => {
    const drawn = await drawnTextOf();

    expect(drawn).toContain('Registergericht: Amtsgericht Lemgo · HRB 12345');
  });

  it('H2: nur Registergericht → nur das Gericht', async () => {
    const drawn = await drawnTextOf({ registrationNumber: '' });

    expect(drawn).toContain('Registergericht: Amtsgericht Lemgo');
    expect(drawn.join('\n')).not.toContain('HRB 12345');
  });

  it('H3: nur Registernummer → die Kennung ohne leeren Trenner', async () => {
    const drawn = await drawnTextOf({ registrationAuthority: '' });
    const text = drawn.join('\n');

    expect(drawn).toContain('HRB 12345');
    expect(text).not.toContain('Registergericht');
    expect(text).not.toContain('· HRB 12345');
  });

  it('H4: beide leer → keine Registerbeschriftung', async () => {
    const drawn = await drawnTextOf({ registrationAuthority: '', registrationNumber: '' });

    expect(drawn.join('\n')).not.toContain('Registergericht');
  });

  it('H5: nur Leerzeichen verhält sich wie leer', async () => {
    const drawn = await drawnTextOf({ registrationAuthority: '  ', registrationNumber: ' ' });

    expect(drawn.join('\n')).not.toContain('Registergericht');
  });
});

describe('01 — J: das PDF einer alten Rechnung bleibt bei ihrem Stand', () => {
  it('eine spätere Profiländerung erreicht das historische PDF nicht', async () => {
    /*
     * Der Beweis läuft über den echten Erzeugungspfad: Die Rechnung trägt
     * Snapshot A, das lebende Firmenprofil wird auf B gesetzt — und das PDF
     * zeigt weiterhin A. `invoicePdfService` liest ausschliesslich
     * `invoice.companySnapshot`; dieser Test hält genau das fest.
     */
    const { hydrateCompanyProfileStore } = await import('../companyProfileService');
    hydrateCompanyProfileStore({
      ...SNAPSHOT_A,
      companyName: 'Beta Betrieb GmbH',
      managingDirector: 'Bea Bergmann',
      registrationAuthority: 'Amtsgericht Bielefeld',
      registrationNumber: 'HRB 99999',
    });

    const drawn = await drawnTextOf();
    const text = drawn.join('\n');

    expect(text).toContain('Max Mustermann');
    expect(text).toContain('Amtsgericht Lemgo');
    expect(text).toContain('HRB 12345');

    expect(text).not.toContain('Bea Bergmann');
    expect(text).not.toContain('Amtsgericht Bielefeld');
    expect(text).not.toContain('HRB 99999');
  });
});

describe('01 — L: Layout', () => {
  it('ein sehr langer Wert bricht um, statt aus dem Satzspiegel zu laufen', async () => {
    const langeVertretung =
      'Dr. Maximilian Alexander von Mustermann-Beispielhausen, Erika Charlotte Beispiel-Musterfrau, Friedrich Wilhelm Schmidt';
    const drawn = await drawnTextOf({
      managingDirector: langeVertretung,
      registrationAuthority: 'Amtsgericht Charlottenburg (Berlin) Zweigstelle Nord',
      registrationNumber: 'HRB 123456789 B',
    });

    /*
     * Umbrochen heisst: Der volle Wert wird **nirgends** als ein Stück
     * gezeichnet, und mindestens zwei Stücke tragen Teile davon. Ohne die
     * zweite Bedingung wäre der Test auch dann grün, wenn der Wert einfach
     * fehlte.
     */
    const volleZeile = `Geschäftsführer/Inhaber: ${langeVertretung}`;
    expect(drawn).not.toContain(volleZeile);

    const teileDerVertretung = drawn.filter(
      (line) =>
        line.includes('Mustermann-Beispielhausen') ||
        line.includes('Beispiel-Musterfrau') ||
        line.includes('Friedrich Wilhelm Schmidt'),
    );
    expect(teileDerVertretung.length).toBeGreaterThanOrEqual(2);

    const joined = drawn.join(' ');
    expect(joined).toContain('Mustermann-Beispielhausen');
    expect(joined).toContain('Friedrich Wilhelm Schmidt');
    expect(joined).toContain('Amtsgericht Charlottenburg');
    expect(joined).toContain('HRB 123456789 B');

    /* Die Bankzeile bleibt eigenständig und vollständig. */
    expect(joined).toContain('DE89 3704 0044 0532 0130 00');
  });
});

/**
 * INVOICE-PDF-COMPANY-BLOCK-01 — K: die Gegenprobe gegen **beide** Validatoren.
 *
 * 01I hatte nur die Liste des Cloud-Payload-Validators ergänzt. Der
 * Prepared-Finalize-Request-Validator führt eine **zweite** geschlossene Liste,
 * und die blieb stehen: Der Request eines eingetragenen Betriebs wurde mit
 * `unknown_field` abgewiesen. Aufgefallen ist das erst im Regressionslauf
 * dieses Blocks — deshalb steht die Prüfung jetzt ausdrücklich hier.
 */
describe('01 — K: Registerfelder in beiden Rechnungsverträgen', () => {
  const invoice = finalizedInvoice({});

  it('der Cloud-Payload-Validator akzeptiert die Registerfelder', async () => {
    const { buildWorkspaceInvoiceFinalizePayload } = await import('./workspaceInvoiceCloudService');
    const { validateWorkspaceInvoiceCloudPayload } = await import(
      './workspaceInvoiceCloudPayloadValidator'
    );

    const payload = JSON.parse(
      JSON.stringify(buildWorkspaceInvoiceFinalizePayload(invoice)),
    );
    const result = validateWorkspaceInvoiceCloudPayload(payload);

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  });

  it('der Prepared-Finalize-Request-Validator akzeptiert die Registerfelder', async () => {
    const { buildInvoicePayloadV1 } = await import('./workspaceInvoiceFinalizeRequestValidator');

    const built = buildInvoicePayloadV1(JSON.parse(JSON.stringify(invoice)));
    expect(built).not.toBeNull();

    const snapshot = built!.companySnapshot as Record<string, unknown>;
    expect(snapshot.registrationAuthority).toBe('Amtsgericht Lemgo');
    expect(snapshot.registrationNumber).toBe('HRB 12345');
    expect(snapshot.managingDirector).toBe('Max Mustermann, Erika Beispiel');
  });

  it('ein Registerfeld falschen Typs wird weiterhin abgewiesen', async () => {
    const { validateWorkspaceInvoiceCloudPayload } = await import(
      './workspaceInvoiceCloudPayloadValidator'
    );
    const { buildWorkspaceInvoiceFinalizePayload } = await import('./workspaceInvoiceCloudService');

    const payload = JSON.parse(
      JSON.stringify(buildWorkspaceInvoiceFinalizePayload(invoice)),
    ) as Record<string, unknown>;
    (payload.companySnapshot as Record<string, unknown>).registrationNumber = 12345;

    expect(validateWorkspaceInvoiceCloudPayload(payload).ok).toBe(false);
  });
});
