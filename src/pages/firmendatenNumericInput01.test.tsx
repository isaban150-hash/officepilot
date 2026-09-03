/**
 * SKONTO-NUMERIC-INPUT-01B — die Null lässt sich löschen.
 *
 * Belegter Realbefund auf iPhone/Safari: In den Firmendaten steht bei „Skonto
 * in %" eine `0`. Der Nutzer löscht sie — sie ist sofort wieder da. Er tippt
 * `2`, sichtbar wird `02`. Bei der Frist entsprechend `010`.
 *
 * Ursache war `Number('') === 0` in Verbindung mit einem kontrollierten Feld,
 * das den Zahlwert direkt rendert: Der leere Zwischenzustand konnte nicht
 * existieren, und weil der Änderungshandler bei jedem Tastendruck ein neues
 * Entwurfsobjekt erzeugt, schrieb React die `0` sofort zurück.
 *
 * Geprüft wird an der echten Seite. Der Wert im Entwurf bleibt dabei jederzeit
 * eine Zahl — die Trennung zwischen Anzeige und fachlichem Wert ist der Kern
 * dieses Blocks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { FirmendatenPage } from './FirmendatenPage';
import { formatNumericValue, parseNumericInput } from '../components/ui/NumericInput';
import * as companyProfileService from '../services/companyProfileService';
import { hydrateCompanyProfileStore } from '../services/companyProfileService';
import { setActiveStorageScope } from '../services/storage/storageScopeService';
import { resetUiSessionLiveState } from '../services/uiSession/uiSessionLiveState';
import { clearUiSessionSnapshot } from '../services/uiSession/uiSessionStore';
import { validateCompanyProfileForSettings } from '../services/setupValidationService';
import type { CompanyProfile } from '../types/models';

const ROUTE = '/firmendaten';

/** Ein Profil, das alle übrigen Pflichtprüfungen bereits erfüllt. */
const savedProfile: CompanyProfile = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Numerik GmbH',
  street: 'Werk 1',
  zip: '80331',
  city: 'München',
  country: 'Deutschland',
  contactPerson: 'A. Beispiel',
  phone: '089 111',
  email: 'a@b.invalid',
  taxNumber: '143/123/45678',
  iban: 'DE89370400440532013000',
  bankName: 'Sparkasse',
  defaultPaymentDays: 14,
  defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen.',
};

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  setActiveStorageScope({ type: 'guest' });
  resetUiSessionLiveState();
  clearUiSessionSnapshot();
  hydrateCompanyProfileStore(savedProfile);
  host = document.createElement('div');
  host.className = 'app-shell__main';
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  clearUiSessionSnapshot();
  resetUiSessionLiveState();
  vi.restoreAllMocks();
});

async function renderPage(): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[ROUTE]}>
        <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true }}>
          <Routes>
            <Route path={ROUTE} element={<FirmendatenPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
  });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

function field(id: string): HTMLInputElement {
  const element = host.querySelector<HTMLInputElement>(`#${id}`);
  if (!element) throw new Error(`Feld nicht gefunden: ${id}`);
  return element;
}

/** Tippen, wie der Browser es meldet: fokussieren, Wert setzen, `input` feuern. */
async function type(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    element.focus();
    element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  });
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      element,
      value,
    );
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function blur(element: HTMLInputElement): Promise<void> {
  await act(async () => {
    element.blur();
    // React delegiert onBlur ueber focusout.
    element.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

async function enableSkonto(): Promise<void> {
  const box = Array.from(host.querySelectorAll('input[type="checkbox"]')).find((el) =>
    (el.closest('fieldset')?.textContent ?? '').toLowerCase().includes('skonto'),
  ) as HTMLInputElement | undefined;
  if (!box) throw new Error('Skonto-Schalter nicht gefunden');
  if (!box.checked) {
    await act(async () => {
      box.click();
    });
  }
}

/** Der zuletzt an `updateCompanyProfile` übergebene Stand. */
function spyOnSave() {
  const original = companyProfileService.updateCompanyProfile;
  return vi.spyOn(companyProfileService, 'updateCompanyProfile').mockImplementation((partial) => {
    return original(partial);
  });
}

async function submit(): Promise<void> {
  const form = host.querySelector('form') as HTMLFormElement;
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

describe('SKONTO-NUMERIC-INPUT-01B — Eingabe im Formular', () => {
  // R1 / R2 — der Realbefund.
  it('R1/R2: die Null im Prozentfeld lässt sich löschen, danach steht dort 2', async () => {
    await renderPage();
    await enableSkonto();

    const percent = field('profile-skonto-percent');
    expect(percent.value).toBe('0');

    await type(percent, '');
    expect(percent.value).toBe('');

    await type(percent, '2');
    expect(percent.value).toBe('2');
    expect(percent.value).not.toBe('02');
  });

  // R3
  it('R3: die Frist lässt sich leeren und auf 10 setzen', async () => {
    await renderPage();
    await enableSkonto();

    const days = field('profile-skonto-days');
    await type(days, '');
    expect(days.value).toBe('');

    await type(days, '10');
    expect(days.value).toBe('10');
    expect(days.value).not.toBe('010');
  });

  // R4
  it('R4: das Zahlungsziel lässt sich leeren und neu setzen', async () => {
    await renderPage();

    const paymentDays = field('profile-payment-days');
    expect(paymentDays.value).toBe('14');

    await type(paymentDays, '');
    expect(paymentDays.value).toBe('');

    await type(paymentDays, '7');
    expect(paymentDays.value).toBe('7');
    expect(paymentDays.value).not.toBe('07');
  });

  // R5 — deutsches Dezimaltrennzeichen.
  it('R5: 2,5 wird angenommen und nicht still zu 0', async () => {
    await renderPage();
    await enableSkonto();

    const percent = field('profile-skonto-percent');
    await type(percent, '2,5');
    expect(percent.value).toBe('2,5');
    expect(percent.value).not.toBe('0');
  });

  // R6
  it('R6: 2.5 mit Punkt wird ebenfalls angenommen', async () => {
    await renderPage();
    await enableSkonto();

    const percent = field('profile-skonto-percent');
    await type(percent, '2.5');
    expect(percent.value).toBe('2.5');
  });

  /*
   * R7 — der halb getippte Wert.
   *
   * `2,` darf stehen bleiben; wer sofort auf `2` zurückformatiert, nimmt dem
   * Nutzer die Möglichkeit, die Nachkommastelle zu tippen.
   */
  it('R7: ein unvollständiges 2, springt nicht auf 2 zurück', async () => {
    await renderPage();
    await enableSkonto();

    const percent = field('profile-skonto-percent');
    await type(percent, '2,');
    expect(percent.value).toBe('2,');

    await type(percent, '2,5');
    expect(percent.value).toBe('2,5');
  });

  // Buchstaben und zweite Trennzeichen werden gar nicht erst übernommen.
  it('R7b: unzulässige Zeichen erscheinen nicht im Feld', async () => {
    await renderPage();
    await enableSkonto();

    const percent = field('profile-skonto-percent');
    await type(percent, '2,5,7abc');
    expect(percent.value).toBe('2,57');

    const days = field('profile-skonto-days');
    await type(days, '1,0');
    expect(days.value).toBe('10');
  });

  /*
   * R8 / R16 — nach dem Verlassen zeigt das Feld wieder den fachlichen Wert.
   *
   * Erst hier wird normalisiert, nicht beim Tippen.
   */
  it('R8: ein leer verlassenes Feld zeigt danach den fachlichen Wert 0', async () => {
    await renderPage();
    await enableSkonto();

    const percent = field('profile-skonto-percent');
    await type(percent, '2');
    await type(percent, '');
    expect(percent.value).toBe('');

    await blur(percent);
    expect(percent.value).toBe('0');
  });
});

describe('SKONTO-NUMERIC-INPUT-01B — Speichern und Validierung', () => {
  // R9
  it('R9: aktiviertes Skonto mit Prozent 0 blockiert das Speichern', async () => {
    await renderPage();
    await enableSkonto();
    await type(field('profile-skonto-days'), '10');

    const saveSpy = spyOnSave();
    await submit();

    expect(saveSpy).not.toHaveBeenCalled();
  });

  // R10
  it('R10: aktiviertes Skonto mit Frist 0 blockiert das Speichern', async () => {
    await renderPage();
    await enableSkonto();
    await type(field('profile-skonto-percent'), '2');

    const saveSpy = spyOnSave();
    await submit();

    expect(saveSpy).not.toHaveBeenCalled();
  });

  // R11
  it('R11: ein Prozentsatz über 100 blockiert das Speichern', async () => {
    await renderPage();
    await enableSkonto();
    await type(field('profile-skonto-percent'), '120');
    await type(field('profile-skonto-days'), '10');

    const saveSpy = spyOnSave();
    await submit();

    expect(saveSpy).not.toHaveBeenCalled();
  });

  /*
   * R12 / R14 — der gute Fall, und was dabei gespeichert wird.
   *
   * Der Payload muss saubere Zahlen tragen: kein leerer String, kein NaN.
   */
  it('R12/R14: 2 % und 10 Tage werden als Zahlen gespeichert', async () => {
    await renderPage();
    await enableSkonto();
    await type(field('profile-skonto-percent'), '2');
    await type(field('profile-skonto-days'), '10');

    const saveSpy = spyOnSave();
    await submit();

    expect(saveSpy).toHaveBeenCalledTimes(1);
    const payload = saveSpy.mock.calls[0]![0] as CompanyProfile;
    expect(payload.skontoEnabled).toBe(true);
    expect(payload.skontoPercent).toBe(2);
    expect(payload.skontoDays).toBe(10);
    expect(typeof payload.skontoPercent).toBe('number');
    expect(typeof payload.skontoDays).toBe('number');
    expect(Number.isNaN(payload.skontoPercent)).toBe(false);
  });

  // Dezimalwert bis in den Payload.
  it('R12b: 2,5 % landet als 2.5 im gespeicherten Stand', async () => {
    await renderPage();
    await enableSkonto();
    await type(field('profile-skonto-percent'), '2,5');
    await type(field('profile-skonto-days'), '14');

    const saveSpy = spyOnSave();
    await submit();

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect((saveSpy.mock.calls[0]![0] as CompanyProfile).skontoPercent).toBe(2.5);
  });

  // R13
  it('R13: bei ausgeschaltetem Skonto blockieren 0/0 das Speichern nicht', async () => {
    await renderPage();

    const saveSpy = spyOnSave();
    await submit();

    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  // R14b — auch nach Leeren und Neutippen bleibt der Payload sauber.
  it('R14b: nach Leeren und Neutippen enthält der Payload eine Zahl', async () => {
    await renderPage();

    const paymentDays = field('profile-payment-days');
    await type(paymentDays, '');
    await type(paymentDays, '7');

    const saveSpy = spyOnSave();
    await submit();

    const payload = saveSpy.mock.calls[0]![0] as CompanyProfile;
    expect(payload.defaultPaymentDays).toBe(7);
    expect(typeof payload.defaultPaymentDays).toBe('number');
  });
});

describe('SKONTO-NUMERIC-INPUT-01B — Bausteine und Validator', () => {
  it('parseNumericInput liefert nie NaN', () => {
    expect(parseNumericInput('')).toBeNull();
    expect(parseNumericInput('2,')).toBeNull();
    expect(parseNumericInput('.')).toBeNull();
    expect(parseNumericInput('2,5')).toBe(2.5);
    expect(parseNumericInput('2.5')).toBe(2.5);
    expect(parseNumericInput('10')).toBe(10);
  });

  it('formatNumericValue schreibt deutsch und ohne überflüssige Nachkommastelle', () => {
    expect(formatNumericValue(2, 'decimal')).toBe('2');
    expect(formatNumericValue(2.5, 'decimal')).toBe('2,5');
    expect(formatNumericValue(10, 'integer')).toBe('10');
  });

  /*
   * R17 — die bestehende Zahlungsziel-Prüfung bleibt unverändert, und die neue
   * Skonto-Regel greift ausschliesslich bei eingeschaltetem Skonto.
   */
  it('R17: der Validator prüft Skonto nur bei aktiviertem Schalter', () => {
    const off = validateCompanyProfileForSettings({
      ...savedProfile,
      skontoEnabled: false,
      skontoPercent: 0,
      skontoDays: 0,
    });
    expect(off.valid).toBe(true);

    const on = validateCompanyProfileForSettings({
      ...savedProfile,
      skontoEnabled: true,
      skontoPercent: 0,
      skontoDays: 0,
    });
    expect(on.valid).toBe(false);
    expect(on.errors.skontoPercent).toBe('companyProfile.skontoPercentInvalid');
    expect(on.errors.skontoDays).toBe('companyProfile.skontoDaysInvalid');

    const good = validateCompanyProfileForSettings({
      ...savedProfile,
      skontoEnabled: true,
      skontoPercent: 2,
      skontoDays: 10,
    });
    expect(good.valid).toBe(true);

    // Das bestehende Zahlungsziel-Gate bleibt wirksam.
    const badDays = validateCompanyProfileForSettings({
      ...savedProfile,
      defaultPaymentDays: -1,
    });
    expect(badDays.valid).toBe(false);
  });
});
