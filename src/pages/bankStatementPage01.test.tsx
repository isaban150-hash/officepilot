/**
 * BANKABGLEICH-V1 BLOCK 1 — die Kontoauszugsseite.
 *
 * Geprueft wird die Seite so, wie der Nutzer sie erlebt: ueber die Route des
 * Finanzen-Hubs erreichbar, Datei auswaehlen, Vorschau lesen — und nirgends
 * eine Schaltfläche, die etwas speichern oder buchen wuerde.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { FINANZEN_HUB_GROUPS } from '../components/layout/navConfig';
import { BankStatementPage } from './BankStatementPage';
import {
  listBankTransactions,
  resetBankTransactionsForTests,
} from '../services/bank/bankTransactionStore';
import { listBankAccounts, resetBankAccountsForTests } from '../services/bank/bankAccountStore';
import { hydrateInvoiceStore } from '../services/invoice/invoiceStore';
import { hydrateExpenseStore } from '../services/expenseStore';
import { hydrateVorgangStore } from '../services/vorgangService';
import {
  applyConfirmedReconciliation,
  listBankReconciliations,
  resetBankReconciliationsForTests,
} from '../services/bank/bankReconciliationStore';

const KOPF = 'Buchungstag;Wertstellung;Beguenstigter/Zahlungspflichtiger;Verwendungszweck;IBAN;Betrag';
/**
 * BLOCK 2B — ein Auszug, der sein eigenes Konto nennt.
 *
 * Fuer die Uebernahme-Faelle: Dort geht es um Bestand und Entdopplung, nicht
 * um die Kontozuordnung. Die bleibt den Faellen mit 'KOPF' vorbehalten, die
 * genau deshalb kein Konto nennen.
 */
const KOPF_KONTO =
  'Auftragskonto;Buchungstag;Wertstellung;Beguenstigter/Zahlungspflichtiger;Verwendungszweck;IBAN;Betrag';

/** Begriffe, die ein Handwerksbetrieb nicht lesen soll. */
const TECHNISCHE_BEGRIFFE = [
  'BankTransaction',
  'Parser',
  'Reconciliation',
  'Delimiter',
  'amountCents',
  'bookingDate',
  'counterparty',
  'possibleDuplicate',
  'row_empty',
  'date_unreadable',
  'amount_unreadable',
  'missing_required_column',
];

/**
 * Worte, die eine Geldwirkung behaupten wuerden.
 *
 * „Uebernehmen“ stand hier bis Block 1 mit auf der Liste, weil damals gar
 * nichts gespeichert wurde. Seit Block 2 ist es das vereinbarte Produktwort
 * fuer das Aufbewahren — verboten bleibt, was nach **Zahlung** klingt.
 */
const VERBOTENE_AKTIONEN = ['bezahlt', 'Bezahlt', 'verbucht', 'Verbucht', 'abgeglichen', 'Abgeglichen'];

type Mount = { container: HTMLDivElement; root: Root };

function mount(): Mount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={['/finanzen/kontoauszug']}>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <Routes>
            <Route path="/finanzen/kontoauszug" element={<BankStatementPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

/**
 * Eine Datei auswaehlen, wie der Nutzer es tut.
 *
 * `File.arrayBuffer` wird gesetzt, weil jsdom es nicht mitbringt; der Inhalt
 * ist derselbe, den der Browser liefern wuerde.
 */
async function waehleDatei(container: HTMLDivElement, inhalt: string, name = 'auszug.csv'): Promise<void> {
  const bytes = new TextEncoder().encode(inhalt);
  const file = new File([inhalt], name, { type: 'text/csv' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });

  const input = container.querySelector<HTMLInputElement>('[data-testid="bank-statement-input"]');
  if (!input) throw new Error('Dateiauswahl fehlt');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });

  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    /* Das Lesen der Datei ist asynchron. */
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * Der sichtbare Text **ohne** die Hinweiszeilen.
 *
 * Die Hinweise verneinen eine Geldwirkung ausdruecklich („keine Rechnung
 * bezahlt“). Eine Verneinung ist das Gegenteil einer Behauptung; sie hier
 * mitzupruefen wuerde genau die Zusage verbieten, auf die es ankommt.
 */
function textOhneHinweise(container: HTMLDivElement): string {
  const kopie = container.cloneNode(true) as HTMLDivElement;
  for (const hinweis of kopie.querySelectorAll('.bank-statement__notice')) hinweis.remove();
  return kopie.textContent ?? '';
}

/**
 * Einen Wert so setzen, dass React die Aenderung bemerkt.
 *
 * Ein direktes `input.value = …` umgeht Reacts eigenen Setter; das Feld
 * sieht dann gefuellt aus, der Zustand bleibt aber leer.
 */
function setReactValue(feld: HTMLInputElement, wert: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(feld, wert);
  feld.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Ein Konto anlegen, wie der Nutzer es tut. */
async function legeKontoAn(container: HTMLDivElement, name: string): Promise<void> {
  const feld = container.querySelector<HTMLInputElement>('[data-testid="bank-statement-account-name"]');
  if (!feld) throw new Error('Namensfeld fehlt');
  await act(async () => {
    setReactValue(feld, name);
    await Promise.resolve();
  });
  await klicke(container, 'bank-statement-account-create');
}

/** Eine Schaltflaeche betaetigen, wie der Nutzer es tut. */
async function klicke(container: HTMLDivElement, testId: string): Promise<void> {
  const knopf = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!knopf) throw new Error(`Schaltflaeche fehlt: ${testId}`);
  await act(async () => {
    knopf.click();
    await Promise.resolve();
  });
}

describe('BANKABGLEICH-01 Kontoauszugsseite', () => {
  beforeEach(() => {
    localStorage.clear();
    resetBankTransactionsForTests();
    resetBankAccountsForTests();
    hydrateVorgangStore([]);
    hydrateInvoiceStore([]);
    hydrateExpenseStore([]);
    resetBankReconciliationsForTests();
  });

  let mounted: Mount | undefined;

  afterEach(() => {
    if (mounted) {
      const { root, container } = mounted;
      act(() => root.unmount());
      container.remove();
      mounted = undefined;
    }
  });

  it('G1 — der Kontoauszug haengt im Finanzen-Hub, nicht in der Hauptnavigation', () => {
    const eintraege = FINANZEN_HUB_GROUPS.flatMap((gruppe) => gruppe.items);
    const kontoauszug = eintraege.find((eintrag) => eintrag.to === '/finanzen/kontoauszug');
    expect(kontoauszug).toBeDefined();
    expect(kontoauszug?.key).toBe('finanzen.bankStatement');
  });

  it('G2 — die Seite ist erreichbar und zeigt zunaechst eine ruhige leere Ansicht', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/finanzen/kontoauszug']}>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <BankStatementPage />
        </AppProvider>
      </MemoryRouter>,
    );
    expect(html).toContain('data-testid="bank-statement-page"');
    expect(html).toContain('data-testid="bank-statement-empty"');
    expect(html).toContain('Kontoauszug');
    expect(html).not.toContain('data-testid="bank-statement-rows"');
  });

  it('G2b — es fuehrt ein sichtbarer Weg zurueck in die Finanzen (sichtbar gefunden)', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/finanzen/kontoauszug']}>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <BankStatementPage />
        </AppProvider>
      </MemoryRouter>,
    );
    /* PageHeader zeigt den Rueckweg nur, wenn auch ein Label gesetzt ist. */
    expect(html).toContain('data-testid="bank-statement-back"');
    expect(html).toContain('href="/finanzen"');
  });

  it('G3 — die Seite nennt keine technischen Begriffe', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <BankStatementPage />
        </AppProvider>
      </MemoryRouter>,
    );
    /* Nur den sichtbaren Text pruefen — data-testid darf technisch heissen. */
    const sichtbar = html.replace(/<[^>]*>/g, ' ');
    for (const begriff of TECHNISCHE_BEGRIFFE) {
      expect(sichtbar).not.toContain(begriff);
    }
  });

  it('G4 — es gibt keine Aktion, die speichern oder buchen wuerde', async () => {
    mounted = mount();
    await waehleDatei(
      mounted.container,
      [KOPF, '04.10.2026;;Kunde Nord;Zahlung;;100,00'].join('\n'),
    );
    const sichtbar = textOhneHinweise(mounted.container);
    for (const wort of VERBOTENE_AKTIONEN) {
      expect(sichtbar).not.toContain(wort);
    }
    /* Und der Hinweis sagt es ausdruecklich. */
    /* Die Zusage selbst muss dastehen — sie steht in der Hinweiszeile. */
    expect(mounted.container.textContent ?? '').toContain(
      'Es wird dabei keine Rechnung bezahlt und kein Zahlungsstatus verändert.',
    );
  });

  it('G5 — die Vorschau zeigt Datei, Anzahl, Richtung und Verwendungszweck', async () => {
    mounted = mount();
    await waehleDatei(
      mounted.container,
      [
        KOPF,
        '04.10.2026;04.10.2026;Kunde Nord;Zahlung RE-2026-014;DE11;2.380,00',
        '05.10.2026;05.10.2026;Baustoff GmbH;Eingangsrechnung;DE22;-1.190,50',
      ].join('\n'),
      'sparkasse-oktober.csv',
    );

    const text = mounted.container.textContent ?? '';
    expect(text).toContain('sparkasse-oktober.csv');
    expect(text).toContain('2 Bewegungen erkannt');
    expect(text).toContain('Kunde Nord');
    expect(text).toContain('Zahlung RE-2026-014');
    expect(text).toContain('Eingang');
    expect(text).toContain('Ausgang');
    expect(mounted.container.querySelectorAll('[data-testid^="bank-statement-row-"]')).toHaveLength(2);
  });

  it('G6 — eine Problemzeile ist sichtbar und die gueltigen Zeilen bleiben stehen', async () => {
    mounted = mount();
    await waehleDatei(
      mounted.container,
      [KOPF, '04.10.2026;;Kunde Nord;Zahlung;;100,00', 'kaputt;;Firma;Zweck;;50,00'].join('\n'),
    );

    const text = mounted.container.textContent ?? '';
    expect(text).toContain('1 Bewegung erkannt');
    expect(text).toContain('1 Zeile prüfen');
    expect(text).toContain('Datum nicht lesbar');
    expect(mounted.container.querySelector('[data-testid="bank-statement-issues"]')).toBeTruthy();
  });

  it('G7 — moegliche Dubletten werden benannt, nicht entfernt', async () => {
    mounted = mount();
    await waehleDatei(
      mounted.container,
      [KOPF, '04.10.2026;;Vermieter;Miete;;-800,00', '04.10.2026;;Vermieter;Miete;;-800,00'].join('\n'),
    );

    const text = mounted.container.textContent ?? '';
    expect(text).toContain('2 Bewegungen erkannt');
    expect(text).toContain('Möglicherweise doppelt in dieser Datei');
    expect(mounted.container.querySelectorAll('[data-testid^="bank-statement-row-"]')).toHaveLength(2);
  });

  /* ---- BLOCK 2 — Uebernehmen, Bestand, keine falschen Worte ---- */

  it('H1 — die Vorschau allein speichert nichts; erst die Uebernahme', async () => {
    mounted = mount();
    await waehleDatei(mounted.container, [KOPF_KONTO, 'DE01;04.10.2026;;Kunde Nord;Zahlung;;500,00'].join('\n'));

    expect(listBankTransactions()).toHaveLength(0);
    expect(mounted.container.querySelector('[data-testid="bank-statement-stored-empty"]')).toBeTruthy();

    await klicke(mounted.container, 'bank-statement-commit');

    expect(listBankTransactions()).toHaveLength(1);
    expect(mounted.container.textContent).toContain('1 Bewegung übernommen.');
  });

  it('H2 — der Plan nennt neu, bereits vorhanden und nicht uebernommene Zeilen', async () => {
    mounted = mount();
    await waehleDatei(mounted.container, [KOPF_KONTO, 'DE01;04.10.2026;;Kunde Nord;Zahlung;;500,00'].join('\n'));
    await klicke(mounted.container, 'bank-statement-commit');

    await waehleDatei(
      mounted.container,
      [
        KOPF_KONTO,
        'DE01;04.10.2026;;Kunde Nord;Zahlung;;500,00',
        'DE01;05.10.2026;;Neuer Kunde;Zahlung;;120,00',
        'DE01;kaputt;;Firma;Zweck;;10,00',
      ].join('\n'),
    );

    const plan = mounted.container.querySelector('[data-testid="bank-statement-plan"]')?.textContent ?? '';
    expect(plan).toContain('1 neue Bewegung');
    expect(plan).toContain('1 bereits vorhanden');
    expect(plan).toContain('1 Zeile wird nicht übernommen');
  });

  it('H3 — eine vollstaendig bekannte Datei bietet keine Uebernahme an', async () => {
    mounted = mount();
    const datei = [KOPF_KONTO, 'DE01;04.10.2026;;Kunde Nord;Zahlung;;500,00'].join('\n');
    await waehleDatei(mounted.container, datei);
    await klicke(mounted.container, 'bank-statement-commit');
    await waehleDatei(mounted.container, datei);

    const knopf = mounted.container.querySelector<HTMLButtonElement>('[data-testid="bank-statement-commit"]');
    expect(knopf?.disabled).toBe(true);
    expect(knopf?.textContent).toContain('Alles bereits vorhanden');
    expect(listBankTransactions()).toHaveLength(1);
  });

  it('H4 — der Bestand erscheint und ueberlebt ein neues Aufbauen der Seite', async () => {
    mounted = mount();
    await waehleDatei(mounted.container, [KOPF_KONTO, 'DE01;04.10.2026;;Kunde Nord;Zahlung;;500,00'].join('\n'));
    await klicke(mounted.container, 'bank-statement-commit');

    /* Wie ein Reload: Seite neu aufbauen, Speicher bleibt. */
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = mount();

    const text = mounted.container.textContent ?? '';
    expect(text).toContain('Aufbewahrte Bankbewegungen');
    expect(text).toContain('1 Bewegung aufbewahrt');
    expect(text).toContain('Kunde Nord');
    expect(mounted.container.querySelector('[data-testid="bank-statement-rows"]')).toBeNull();
  });

  it('H5b — kein Text behauptet mehr, es werde nichts gespeichert (sichtbar gefunden)', () => {
    /*
     * Untertitel und Hinweis stammten aus Block 1, wo wirklich nichts
     * gespeichert wurde. Seit Block 2 waere dieser Satz eine Unwahrheit.
     */
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <BankStatementPage />
        </AppProvider>
      </MemoryRouter>,
    );
    expect(html).not.toContain('gespeichert wird dabei nichts');
    expect(html).not.toContain('Es wird nichts gespeichert');
  });

  it('H5 — fuer reine Bankbewegungen faellt kein Wort wie bezahlt, verbucht oder abgeglichen', async () => {
    mounted = mount();
    await waehleDatei(mounted.container, [KOPF_KONTO, 'DE01;04.10.2026;;Kunde Nord;Zahlung RE-1;;500,00'].join('\n'));
    await klicke(mounted.container, 'bank-statement-commit');

    const text = textOhneHinweise(mounted.container);
    for (const wort of ['bezahlt', 'Bezahlt', 'verbucht', 'Verbucht', 'abgeglichen', 'Abgeglichen', 'gebucht']) {
      expect(text).not.toContain(wort);
    }
    expect(text).toContain('übernommen');
  });

  /* ---- BLOCK 2B — Konto erkennen, Konto waehlen, ohne Konto nichts ---- */

  it('I1 — nennt die Datei ein Konto, zeigt die Seite es ruhig an', async () => {
    mounted = mount();
    await waehleDatei(mounted.container, [KOPF_KONTO, 'DE89370400440532013000;04.10.2026;;Kunde;Zahlung;;500,00'].join('\n'));

    const erkannt = mounted.container.querySelector('[data-testid="bank-statement-account-detected"]');
    expect(erkannt?.textContent).toContain('Konto erkannt');
    /* Die vollstaendige Kontonummer steht nicht in der Uebersicht. */
    expect(erkannt?.textContent).not.toContain('DE89370400440532013000');
    expect(listBankAccounts()).toHaveLength(1);
  });

  it('I2 — nennt die Datei kein Konto, verlangt die Seite eine Zuordnung', async () => {
    mounted = mount();
    await waehleDatei(mounted.container, [KOPF, '04.10.2026;;Kunde;Zahlung;;500,00'].join('\n'));

    expect(mounted.container.querySelector('[data-testid="bank-statement-account-needed"]')).toBeTruthy();
    const knopf = mounted.container.querySelector<HTMLButtonElement>('[data-testid="bank-statement-commit"]');
    expect(knopf?.disabled).toBe(true);
    expect(mounted.container.textContent).toContain('Ordnen Sie den Auszug zuerst einem Konto zu.');
  });

  it('I3 — ein neues Konto anlegen gibt die Uebernahme frei', async () => {
    mounted = mount();
    await waehleDatei(mounted.container, [KOPF, '04.10.2026;;Kunde;Zahlung;;500,00'].join('\n'));

    const feld = mounted.container.querySelector<HTMLInputElement>('[data-testid="bank-statement-account-name"]');
    if (!feld) throw new Error('Namensfeld fehlt');
    await act(async () => {
      setReactValue(feld, 'Geschäftskonto Sparkasse');
      await Promise.resolve();
    });
    await klicke(mounted.container, 'bank-statement-account-create');

    expect(listBankAccounts()[0]?.displayName).toBe('Geschäftskonto Sparkasse');
    const knopf = mounted.container.querySelector<HTMLButtonElement>('[data-testid="bank-statement-commit"]');
    expect(knopf?.disabled).toBe(false);

    await klicke(mounted.container, 'bank-statement-commit');
    expect(listBankTransactions()).toHaveLength(1);
    expect(listBankTransactions()[0]?.accountKey).toBe(listBankAccounts()[0]?.id);
  });

  it('I4 — zwei Konten halten dieselbe Bewegung getrennt (sichtbare Logik)', async () => {
    mounted = mount();
    const datei = [KOPF, '04.10.2026;;Vermieter;Miete;;-800,00'].join('\n');

    await waehleDatei(mounted.container, datei);
    await legeKontoAn(mounted.container, 'Konto A');
    await klicke(mounted.container, 'bank-statement-commit');

    await waehleDatei(mounted.container, datei);
    await legeKontoAn(mounted.container, 'Konto B');
    await klicke(mounted.container, 'bank-statement-commit');

    expect(listBankAccounts()).toHaveLength(2);
    expect(listBankTransactions()).toHaveLength(2);
  });

  it('I5 — ohne Konto behauptet keine Zeile, sie sei bereits vorhanden (sichtbar gefunden)', async () => {
    mounted = mount();
    await waehleDatei(mounted.container, [KOPF, '04.10.2026;;Kunde;Zahlung;;500,00'].join('\n'));

    /*
     * Ohne gewaehltes Konto gibt es keinen Plan — und damit nichts zu
     * behaupten. Vorher stand an jeder Zeile „Bereits vorhanden".
     */
    const status = (): string[] =>
      [...mounted!.container.querySelectorAll('[data-testid^="bank-statement-status-"]')]
        .map((el) => el.textContent?.trim() ?? '')
        .filter(Boolean);

    expect(status()).toEqual([]);

    await legeKontoAn(mounted.container, 'Konto A');
    expect(status()).toEqual(['Neu']);
  });

  /* ---- BLOCK 3 — Zuordnungsvorschlaege ---- */

  it('J1 — ein starker Rechnungsvorschlag erscheint mit Gruenden und offenem Betrag', async () => {
    hydrateInvoiceStore([
      {
        vorgangId: null,
        invoice: {
          id: 'inv-1',
          number: 'RE-2026-0014',
          status: 'versendet',
          date: '2026-10-01',
          issueDate: '2026-10-01',
          type: 'schlussrechnung',
          positions: [],
          subtotal: 2000,
          taxStatus: 'standard_19',
          taxAmount: 380,
          total: 2380,
          amount: 2380,
          payments: [],
          customerSnapshot: { name: 'Westfalen Projektbau GmbH' },
        } as never,
      },
    ]);

    mounted = mount();
    await waehleDatei(
      mounted.container,
      [KOPF_KONTO, 'DE01;04.10.2026;;Westfalen Projektbau GmbH;Zahlung RE-2026-0014;;2.380,00'].join('\n'),
    );
    await klicke(mounted.container, 'bank-statement-commit');

    const text = mounted.container.textContent ?? '';
    expect(text).toContain('Sehr passender Vorschlag');
    expect(text).toContain('Rechnung RE-2026-0014');
    expect(text).toContain('Westfalen Projektbau GmbH');
    expect(text).toContain('Offen');
    expect(text).toContain('Rechnungsnummer im Verwendungszweck erkannt');
    expect(text).toContain('Betrag stimmt mit dem offenen Betrag überein');
  });

  it('J2 — Mehrdeutigkeit wird ehrlich gezeigt, nicht als Treffer', async () => {
    const basis = (id: string, nummer: string) => ({
      vorgangId: null,
      invoice: {
        id,
        number: nummer,
        status: 'versendet',
        date: '2026-10-01',
        issueDate: '2026-10-01',
        type: 'schlussrechnung',
        positions: [],
        subtotal: 2000,
        taxStatus: 'standard_19',
        taxAmount: 380,
        total: 2380,
        amount: 2380,
        payments: [],
        customerSnapshot: { name: 'Westfalen Projektbau GmbH' },
      } as never,
    });
    hydrateInvoiceStore([basis('inv-1', 'RE-2026-0001'), basis('inv-2', 'RE-2026-0002')]);

    mounted = mount();
    await waehleDatei(
      mounted.container,
      [KOPF_KONTO, 'DE01;04.10.2026;;Westfalen Projektbau GmbH;Ueberweisung;;2.380,00'].join('\n'),
    );
    await klicke(mounted.container, 'bank-statement-commit');

    const text = mounted.container.textContent ?? '';
    expect(text).toContain('2 mögliche Rechnungen');
    expect(text).not.toContain('Sehr passender Vorschlag');
  });

  it('J3 — ohne Kandidaten steht das auch so da', async () => {
    mounted = mount();
    await waehleDatei(
      mounted.container,
      [KOPF_KONTO, 'DE01;04.10.2026;;Fremde Firma;Irgendwas;;77,00'].join('\n'),
    );
    await klicke(mounted.container, 'bank-statement-commit');

    expect(mounted.container.textContent).toContain('Keine passende Rechnung gefunden');
  });

  it('J4 — ein Ausgang zeigt den Ausgabenvorschlag', async () => {
    hydrateExpenseStore([
      {
        id: 'exp-1',
        status: 'gebucht',
        category: 'material',
        supplierName: 'Baustoff Handel GmbH',
        invoiceNumber: 'LR-2026-55123',
        title: 'Materiallieferung',
        description: '',
        issueDate: '2026-10-01',
        paymentDueDate: '2026-10-20',
        taxStatus: 'standard_19',
        netAmount: 1000,
        taxAmount: 190,
        grossAmount: 1190.5,
        currency: 'EUR',
        paymentStatus: 'offen',
        payments: [],
        positions: [],
        allocations: [],
        isCreditNote: false,
        dedupeKey: 'baustoff handel gmbh|lr-2026-55123',
        tags: [],
        digitalFolder: { id: 'd', name: 'Ausgaben', path: '/Ausgaben/' },
        paperFolder: { folderId: 'f', register: 'A', label: 'T' },
        createdAt: '2026-10-01T10:00:00.000Z',
        updatedAt: '2026-10-01T10:00:00.000Z',
      } as never,
    ]);

    mounted = mount();
    await waehleDatei(
      mounted.container,
      [KOPF_KONTO, 'DE01;05.10.2026;;Baustoff Handel GmbH;Rechnung LR-2026-55123;;-1.190,50'].join('\n'),
    );
    await klicke(mounted.container, 'bank-statement-commit');

    const text = mounted.container.textContent ?? '';
    expect(text).toContain('Sehr passender Vorschlag');
    expect(text).toContain('Ausgabe LR-2026-55123');
  });

  it('J5 — ein abweichender Betrag wird benannt', async () => {
    hydrateInvoiceStore([
      {
        vorgangId: null,
        invoice: {
          id: 'inv-1',
          number: 'RE-2026-0014',
          status: 'versendet',
          date: '2026-10-01',
          issueDate: '2026-10-01',
          type: 'schlussrechnung',
          positions: [],
          subtotal: 2000,
          taxStatus: 'standard_19',
          taxAmount: 380,
          total: 2380,
          amount: 2380,
          payments: [],
          customerSnapshot: { name: 'Westfalen Projektbau GmbH' },
        } as never,
      },
    ]);

    mounted = mount();
    await waehleDatei(
      mounted.container,
      [KOPF_KONTO, 'DE01;04.10.2026;;Westfalen Projektbau GmbH;Zahlung RE-2026-0014;;2.300,00'].join('\n'),
    );
    await klicke(mounted.container, 'bank-statement-commit');

    const text = mounted.container.textContent ?? '';
    expect(text).toContain('Betrag weicht ab');
    expect(text).not.toContain('Sehr passender Vorschlag');
  });

  it('J6 — kein Vorschlag behauptet eine Zahlung oder bietet eine Zuordnung an', async () => {
    hydrateInvoiceStore([
      {
        vorgangId: null,
        invoice: {
          id: 'inv-1',
          number: 'RE-2026-0014',
          status: 'versendet',
          date: '2026-10-01',
          issueDate: '2026-10-01',
          type: 'schlussrechnung',
          positions: [],
          subtotal: 2000,
          taxStatus: 'standard_19',
          taxAmount: 380,
          total: 2380,
          amount: 2380,
          payments: [],
          customerSnapshot: { name: 'Westfalen Projektbau GmbH' },
        } as never,
      },
    ]);

    mounted = mount();
    await waehleDatei(
      mounted.container,
      [KOPF_KONTO, 'DE01;04.10.2026;;Westfalen Projektbau GmbH;Zahlung RE-2026-0014;;2.380,00'].join('\n'),
    );
    await klicke(mounted.container, 'bank-statement-commit');

    const text = textOhneHinweise(mounted.container);
    for (const wort of ['bezahlt', 'Bezahlt', 'verbucht', 'abgeglichen', 'zugeordnet']) {
      expect(text, `verbotenes Wort: ${wort}`).not.toContain(wort);
    }
    /*
     * BLOCK 4 — die Schaltflaeche „Zuordnen und Zahlung erfassen" gibt es
     * jetzt; bis Block 3 war sie zu Recht verboten. Geprueft wird deshalb,
     * was weiterhin gilt: Sie oeffnet nur eine Zusammenfassung, und solange
     * niemand sie drueckt, entsteht keine Zahlung.
     */
    const knoepfe = [...mounted.container.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(knoepfe.join(' ')).toContain('Zuordnen und Zahlung erfassen');
    expect(mounted.container.querySelector('[data-testid^="bank-confirm-dialog-"]')).toBeNull();
    expect(listBankReconciliations()).toEqual([]);
  });

  /* ---- BLOCK 4 — bestaetigte Zuordnung ---- */

  async function mitVorschlag(betrag = '2.380,00') {
    hydrateInvoiceStore([
      {
        vorgangId: null,
        invoice: {
          id: 'inv-1',
          number: 'RE-2026-0014',
          status: 'versendet',
          date: '2026-10-01',
          issueDate: '2026-10-01',
          type: 'schlussrechnung',
          positions: [],
          subtotal: 2000,
          taxStatus: 'standard_19',
          taxAmount: 380,
          total: 2380,
          amount: 2380,
          payments: [],
          customerSnapshot: { name: 'Westfalen Projektbau GmbH' },
        } as never,
      },
    ]);
    mounted = mount();
    await waehleDatei(
      mounted.container,
      [KOPF_KONTO, `DE01;04.10.2026;;Westfalen Projektbau GmbH;Zahlung RE-2026-0014;;${betrag}`].join('\n'),
    );
    await klicke(mounted.container, 'bank-statement-commit');
  }

  it('K1 — der Vorschlag allein veraendert nichts; die Aktion oeffnet nur eine Zusammenfassung', async () => {
    await mitVorschlag();

    expect(mounted!.container.textContent).toContain('Zuordnen und Zahlung erfassen');
    expect(listBankReconciliations()).toEqual([]);

    const knopf = mounted!.container.querySelector<HTMLButtonElement>('[data-testid^="bank-confirm-open-"]');
    expect(knopf).toBeTruthy();
    await act(async () => {
      knopf!.click();
      await Promise.resolve();
    });

    expect(mounted!.container.querySelector('[data-testid^="bank-confirm-dialog-"]')).toBeTruthy();
    /* Das Oeffnen allein bucht nichts. */
    expect(listBankReconciliations()).toEqual([]);
  });

  it('K2 — der Dialog zeigt Ziel, offenen Betrag, Zahlungsbetrag und Datum', async () => {
    await mitVorschlag();
    const knopf = mounted!.container.querySelector<HTMLButtonElement>('[data-testid^="bank-confirm-open-"]');
    await act(async () => {
      knopf!.click();
      await Promise.resolve();
    });

    const text = mounted!.container.textContent ?? '';
    expect(text).toContain('Zuordnung bestätigen');
    expect(text).toContain('Rechnung RE-2026-0014');
    expect(text).toContain('Offener Betrag');
    expect(text).toContain('Zahlungsbetrag');
    expect(text).toContain('Zahlungsdatum');
    expect(text).toContain('04.10.2026');
  });

  it('K3 — Abbrechen veraendert nichts', async () => {
    await mitVorschlag();
    const knopf = mounted!.container.querySelector<HTMLButtonElement>('[data-testid^="bank-confirm-open-"]');
    await act(async () => {
      knopf!.click();
      await Promise.resolve();
    });
    const abbrechen = mounted!.container.querySelector<HTMLButtonElement>('[data-testid^="bank-confirm-cancel-"]');
    await act(async () => {
      abbrechen!.click();
      await Promise.resolve();
    });

    expect(mounted!.container.querySelector('[data-testid^="bank-confirm-dialog-"]')).toBeNull();
    expect(listBankReconciliations()).toEqual([]);
  });

  it('K4 — eine Teilzahlung wird im Dialog ausdruecklich benannt', async () => {
    await mitVorschlag('1.000,00');
    const knopf = mounted!.container.querySelector<HTMLButtonElement>('[data-testid^="bank-confirm-open-"]');
    await act(async () => {
      knopf!.click();
      await Promise.resolve();
    });

    expect(mounted!.container.textContent).toContain('Teilzahlung');
    /* Und nirgends die Behauptung, die Rechnung sei bezahlt. */
    expect(textOhneHinweise(mounted!.container)).not.toContain('bezahlt');
  });

  it('K5 — eine Ueberzahlung wird erklaert statt angeboten', async () => {
    await mitVorschlag('5.000,00');

    expect(mounted!.container.textContent).toContain('Bankbetrag ist höher als der offene Betrag.');
    expect(mounted!.container.querySelector('[data-testid^="bank-confirm-open-"]')).toBeNull();
  });

  it('K6 — nach erfolgreicher Zuordnung steht der Status und keine zweite Aktion', async () => {
    await mitVorschlag();
    const bewegungen = listBankTransactions();
    expect(bewegungen).toHaveLength(1);

    /* Den Serverstand uebernehmen, wie es der Dienst nach Erfolg tut. */
    applyConfirmedReconciliation({
      id: 'brec-1',
      bankTransactionId: bewegungen[0]!.id,
      targetType: 'invoice',
      targetId: 'inv-1',
      paymentId: 'pay-1',
      amountCents: 238000,
      paidOn: '2026-10-04',
      confirmedAt: '2026-10-04T12:00:00.000Z',
    });

    act(() => mounted!.root.unmount());
    mounted!.container.remove();
    mounted = mount();

    const text = mounted.container.textContent ?? '';
    expect(text).toContain('Zugeordnet');
    expect(text).toContain('04.10.2026');
    /* Keine zweite Aktion auf derselben Bewegung. */
    expect(mounted.container.querySelector('[data-testid^="bank-confirm-open-"]')).toBeNull();
    expect(mounted.container.textContent).not.toContain('Sehr passender Vorschlag');
  });

  it('G8 — eine unverstaendliche Datei erzeugt eine verstaendliche Meldung', async () => {
    mounted = mount();
    await waehleDatei(mounted.container, 'Verwendungszweck;Betrag\nZweck;100,00');

    const fehler = mounted.container.querySelector('[data-testid="bank-statement-error"]');
    expect(fehler).toBeTruthy();
    expect(fehler?.textContent).toContain('das Buchungsdatum');
    expect(mounted.container.querySelector('[data-testid="bank-statement-rows"]')).toBeNull();
  });
});
