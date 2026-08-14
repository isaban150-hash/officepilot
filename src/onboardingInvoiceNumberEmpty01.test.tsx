/**
 * ONBOARDING-INVOICE-NUMBER-EMPTY-01B — die Zahlenfelder im Schritt
 * „Rechnungsnummern“ sind vollständig löschbar und sauber überschreibbar.
 *
 * Alle Eingaben laufen über die echten Felder; kein Test befüllt den Draft
 * direkt mit dem erwarteten Endwert.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProvider } from './context/AppContext';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import { DEFAULT_SETUP } from './data/mockData';
import { FirstRunWizard } from './components/setup/FirstRunWizard';
import { SetupPage } from './pages/SetupPage';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import {
  getInvoiceNumberSequenceSnapshot,
  getNextInvoiceNumberPreview,
  hydrateInvoiceNumberSequence,
  resetInvoiceNumberSequence,
} from './services/invoiceNumberService';
import { createDefaultSetupWizardDraft, type SetupWizardDraft } from './types/setup';

const incompleteSetup = { ...DEFAULT_SETUP, setupComplete: false };

type Mount = { container: HTMLDivElement; root: Root };

function setInputValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function field(container: ParentNode, testId: string): HTMLInputElement {
  const node = container.querySelector(`[data-testid="${testId}"]`);
  expect(node, `Feld ${testId} fehlt`).not.toBeNull();
  return node as HTMLInputElement;
}

function clickNext(container: ParentNode): void {
  act(() => {
    (container.querySelector('[data-testid="setup-next"]') as HTMLButtonElement).click();
  });
}

function fillCompanyStep(container: ParentNode): void {
  setInputValue(field(container, 'setup-companyName'), 'Muster GmbH');
  setInputValue(field(container, 'setup-contactPerson'), 'Max Mustermann');
  setInputValue(field(container, 'setup-street'), 'Hauptstraße 1');
  setInputValue(field(container, 'setup-zip'), '80331');
  setInputValue(field(container, 'setup-city'), 'München');
  setInputValue(field(container, 'setup-email'), 'info@muster.de');
}

/** Von Schritt 1 bis in den Schritt „Rechnungsnummern“ durchgehen. */
function goToInvoicingStep(container: ParentNode): void {
  fillCompanyStep(container);
  clickNext(container);
  setInputValue(field(container, 'setup-taxNumber'), '123/456/78901');
  clickNext(container);
  setInputValue(field(container, 'setup-iban'), 'DE89370400440532013000');
  clickNext(container);
  expect(container.querySelector('[data-testid="setup-lastInvoiceNumber"]')).not.toBeNull();
}

function baseDraft(lastInvoiceNumber = 0): SetupWizardDraft {
  return createDefaultSetupWizardDraft(
    incompleteSetup,
    { ...DEFAULT_COMPANY_PROFILE },
    lastInvoiceNumber,
  );
}

/** FirstRunWizard direkt — der abgeschlossene Draft wird mitgeschnitten. */
function renderWizard(initialDraft: SetupWizardDraft) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const completed: SetupWizardDraft[] = [];
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter>
        <AppProvider initialSetup={incompleteSetup}>
          <FirstRunWizard
            initialDraft={initialDraft}
            onComplete={(draft) => {
              completed.push(draft);
              return { success: true };
            }}
          />
        </AppProvider>
      </MemoryRouter>,
    );
  });
  return { container, root, completed };
}

/** Echter Abschlussweg über die SetupPage inklusive Persistenz. */
function renderSetupPage(): Mount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={['/setup']}>
        <AppProvider initialSetup={incompleteSetup}>
          <Routes>
            <Route path="/setup" element={<SetupPage />} />
            <Route path="/" element={<div data-testid="heute-page">Heute</div>} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

describe('ONBOARDING-INVOICE-NUMBER-EMPTY-01B', () => {
  let mounted: { container: HTMLDivElement; root: Root } | undefined;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE });
    resetInvoiceNumberSequence();
  });

  afterEach(() => {
    if (mounted) {
      act(() => mounted!.root.unmount());
      mounted.container.remove();
      mounted = undefined;
    }
    localStorage.clear();
  });

  it('Fall A — die 0 lässt sich löschen, danach ergibt 6 exakt 6', () => {
    const view = renderWizard(baseDraft(0));
    mounted = view;
    goToInvoicingStep(view.container);

    const input = field(view.container, 'setup-lastInvoiceNumber');
    expect(input.value).toBe('0');

    setInputValue(input, '');
    expect(field(view.container, 'setup-lastInvoiceNumber').value).toBe('');

    setInputValue(field(view.container, 'setup-lastInvoiceNumber'), '6');
    const after = field(view.container, 'setup-lastInvoiceNumber');
    expect(after.value).toBe('6');
    expect(after.value).not.toBe('06');
  });

  it('Fall B — der Rohwert 06 wird zu 6 und wird so übergeben', () => {
    const view = renderWizard(baseDraft(0));
    mounted = view;
    goToInvoicingStep(view.container);

    setInputValue(field(view.container, 'setup-lastInvoiceNumber'), '06');
    expect(field(view.container, 'setup-lastInvoiceNumber').value).toBe('6');

    // Führende Nullen werden auch bei mehreren Stellen entfernt.
    setInputValue(field(view.container, 'setup-lastInvoiceNumber'), '00012');
    expect(field(view.container, 'setup-lastInvoiceNumber').value).toBe('12');

    setInputValue(field(view.container, 'setup-lastInvoiceNumber'), '06');
    clickNext(view.container);
    clickNext(view.container);
    expect(view.completed).toHaveLength(1);
    expect(view.completed[0]?.lastInvoiceNumber).toBe(6);
  });

  it('Fall C — leeres Feld geht ohne Fehler weiter und bedeutet 0', () => {
    const view = renderWizard(baseDraft(0));
    mounted = view;
    goToInvoicingStep(view.container);

    setInputValue(field(view.container, 'setup-lastInvoiceNumber'), '');
    expect(field(view.container, 'setup-lastInvoiceNumber').value).toBe('');

    clickNext(view.container);
    expect(view.container.querySelector('.form-error')).toBeNull();
    clickNext(view.container);

    expect(view.completed).toHaveLength(1);
    expect(view.completed[0]?.lastInvoiceNumber).toBe(0);
  });

  it('Fall D — eine gespeicherte Nummer wird beim Öffnen angezeigt', () => {
    const view = renderWizard(baseDraft(7));
    mounted = view;
    goToInvoicingStep(view.container);
    expect(field(view.container, 'setup-lastInvoiceNumber').value).toBe('7');
  });

  it('Fall E — negative, dezimale und textuelle Eingaben landen nicht im Draft', () => {
    const view = renderWizard(baseDraft(0));
    mounted = view;
    goToInvoicingStep(view.container);

    setInputValue(field(view.container, 'setup-lastInvoiceNumber'), '5');
    expect(field(view.container, 'setup-lastInvoiceNumber').value).toBe('5');

    for (const invalid of ['-3', '2.5', '2,5', 'abc', '1e3', '3 ']) {
      setInputValue(field(view.container, 'setup-lastInvoiceNumber'), invalid);
      const shown = field(view.container, 'setup-lastInvoiceNumber').value;
      // Der sichtbare Wert bleibt eine reine Ziffernfolge oder leer.
      expect(shown === '' || /^\d+$/.test(shown)).toBe(true);
    }

    // Zurück auf einen gültigen Wert, damit der Abschluss prüfbar ist.
    setInputValue(field(view.container, 'setup-lastInvoiceNumber'), '9');
    clickNext(view.container);
    clickNext(view.container);

    const saved = view.completed[0]?.lastInvoiceNumber;
    expect(saved).toBe(9);
    expect(Number.isInteger(saved)).toBe(true);
    expect(saved).toBeGreaterThanOrEqual(0);
  });

  it('Fall F — 12 wird gespeichert, die nächste Nummer ist 13', () => {
    const view = renderSetupPage();
    mounted = view;
    goToInvoicingStep(view.container);

    setInputValue(field(view.container, 'setup-lastInvoiceNumber'), '12');
    clickNext(view.container);
    clickNext(view.container);

    expect(view.container.querySelector('[data-testid="heute-page"]')).not.toBeNull();
    expect(getInvoiceNumberSequenceSnapshot().lastIssuedNumber).toBe(12);
    expect(getNextInvoiceNumberPreview()).toContain('13');
  });

  it('Fall G — das Zahlungsziel ist ebenso löschbar und aktualisiert den Text', () => {
    const view = renderWizard(baseDraft(0));
    mounted = view;
    goToInvoicingStep(view.container);

    const days = field(view.container, 'setup-paymentDays');
    expect(days.value).toBe('14');

    setInputValue(days, '');
    expect(field(view.container, 'setup-paymentDays').value).toBe('');

    setInputValue(field(view.container, 'setup-paymentDays'), '30');
    expect(field(view.container, 'setup-paymentDays').value).toBe('30');

    clickNext(view.container);
    clickNext(view.container);
    expect(view.completed[0]?.defaultPaymentDays).toBe(30);
    expect(view.completed[0]?.defaultPaymentTerms).toContain('30 Tagen');
  });

  it('eine vorhandene Sequenz bleibt die Anzeigequelle des Felds', () => {
    hydrateInvoiceNumberSequence({ year: new Date().getFullYear(), lastIssuedNumber: 7 });
    const view = renderSetupPage();
    mounted = view;
    goToInvoicingStep(view.container);
    expect(field(view.container, 'setup-lastInvoiceNumber').value).toBe('7');
  });
});
