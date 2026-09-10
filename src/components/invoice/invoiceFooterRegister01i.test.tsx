/**
 * COMPANY-PROFILE-REGISTER-01I — die Registerangabe im Rechnungsfuß.
 *
 * Für eine eingetragene Gesellschaft sind Registergericht und Registernummer
 * Pflichtangaben auf dem Geschäftsbrief, und eine Rechnung ist ein
 * Geschäftsbrief. Bis zu diesem Block trug der Fuß Firmierung, Anschrift,
 * Geschäftsführer, Steuernummern und Bankverbindung — nur den Registerteil
 * nicht.
 *
 * Die Gegenprobe ist ebenso wichtig wie die Hauptaussage: Ein Betrieb ohne
 * Registereintrag darf keine leere Zeile und keinen Platzhalter auf seiner
 * Rechnung finden.
 *
 * Reines Markup, kein Netz.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InvoiceFooter } from './InvoiceFooter';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import type { CompanyProfile, InvoicePrintModel } from '../../types/models';

const COMPANY: CompanyProfile = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Çırmak Haustechnik',
  legalForm: 'GmbH',
  street: 'Werkstraße 2',
  zip: '33602',
  city: 'Bielefeld',
  managingDirector: 'S. Çırmak',
  phone: '0521 123456',
  email: 'buero@example.invalid',
  taxNumber: '305/5678/9012',
  vatId: 'DE123456789',
  bankName: 'Sparkasse Lemgo',
  iban: 'DE89 4765 0130 0001 2345 67',
  bic: 'WELADED1LIP',
};

function render(company: Partial<CompanyProfile>): string {
  const model = {
    company: { ...COMPANY, ...company },
    footerNotes: '',
  } as unknown as InvoicePrintModel;
  return renderToStaticMarkup(<InvoiceFooter model={model} />);
}

describe('01I — K: Registerangaben im Rechnungsfuß', () => {
  it('K1: beide Werte gesetzt → eine kompakte Registerzeile', () => {
    const html = render({
      registrationAuthority: 'Amtsgericht Lemgo',
      registrationNumber: 'HRB 12345',
    });

    expect(html).toContain('Registergericht: Amtsgericht Lemgo · HRB 12345');
  });

  it('K2: beide leer → gar keine Registerzeile', () => {
    const html = render({});

    expect(html).not.toContain('Registergericht');
    expect(html).not.toContain('invoice-footer-register');
  });

  it('K2b: nur Leerzeichen zählen als leer', () => {
    const html = render({ registrationAuthority: '   ', registrationNumber: '  ' });

    expect(html).not.toContain('invoice-footer-register');
  });

  it('K3: nur Registergericht → kein ins Leere zeigender Trenner', () => {
    const html = render({ registrationAuthority: 'Amtsgericht Lemgo' });

    expect(html).toContain('Registergericht: Amtsgericht Lemgo');
    expect(html).not.toContain('Amtsgericht Lemgo ·');
  });

  it('K4: nur Registernummer → die Kennung allein, ohne leere Bezeichnung', () => {
    const html = render({ registrationNumber: 'HRB 12345' });

    expect(html).toContain('HRB 12345');
    expect(html).not.toContain('Registergericht:');
    expect(html).not.toContain('· HRB 12345');
  });

  it('K5: die bestehenden Zeilen bleiben unverändert', () => {
    const html = render({
      registrationAuthority: 'Amtsgericht Lemgo',
      registrationNumber: 'HRB 12345',
    });

    expect(html).toContain('Çırmak Haustechnik GmbH');
    expect(html).toContain('Werkstraße 2 · 33602 Bielefeld');
    expect(html).toContain('Geschäftsführer/Inhaber: S. Çırmak');
    expect(html).toContain('Tel. 0521 123456 · buero@example.invalid');
    expect(html).toContain('St.-Nr. 305/5678/9012 · USt-IdNr. DE123456789');
    expect(html).toContain('Sparkasse Lemgo · IBAN DE89 4765 0130 0001 2345 67 · BIC WELADED1LIP');
  });

  it('K6: gedruckt wird der historische Stand der Rechnung, nicht das heutige Profil', () => {
    /*
     * Der Fuß liest ausschließlich `model.company` — und das ist bei einer
     * finalisierten Rechnung deren eingefrorener `companySnapshot`. Ein
     * späterer Registerwechsel darf einen alten Beleg nicht rückwirkend
     * umschreiben.
     */
    const historisch = render({
      registrationAuthority: 'Amtsgericht Lemgo',
      registrationNumber: 'HRB 12345',
    });
    const heute = render({
      registrationAuthority: 'Amtsgericht Bielefeld',
      registrationNumber: 'HRB 99999',
    });

    expect(historisch).toContain('Amtsgericht Lemgo · HRB 12345');
    expect(historisch).not.toContain('HRB 99999');
    expect(heute).toContain('Amtsgericht Bielefeld · HRB 99999');
  });
});
