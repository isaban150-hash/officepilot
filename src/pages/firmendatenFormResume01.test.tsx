/**
 * MOBILE-RESUME-STATE-02B — Firmendaten überstehen einen Neuaufbau.
 *
 * Belegter Realbefund auf iPhone/Safari: Firmendaten öffnen, zu Skonto scrollen,
 * „Skonto aktivieren" einschalten, 2 % und 10 Tage eintragen, zu einer anderen
 * App wechseln — und nach der Rückkehr ist alles wieder auf dem gespeicherten
 * Stand. Der Entwurf lag ausschliesslich in `useState`.
 *
 * Geprüft wird an der echten Seite mit einer **zweiten Komponenteninstanz** auf
 * derselben Route: genau das, was nach einem verworfenen Tab oder einem Reload
 * geschieht.
 *
 * Zwei Dinge, die dabei wichtiger sind als das blosse Wiederkommen der Werte:
 * der Basisabgleich (ein alter Entwurf darf einen inzwischen geänderten
 * gespeicherten Stand nicht überschreiben) und die Reihenfolge (der Formzustand
 * steht, bevor die Scrollposition angewandt wird).
 *
 * Synthetische Daten, kein Netz.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { FirmendatenPage } from './FirmendatenPage';
import { hydrateCompanyProfileStore } from '../services/companyProfileService';
import { setActiveStorageScope } from '../services/storage/storageScopeService';
import * as uiSessionCapture from '../services/uiSession/uiSessionCapture';
import {
  captureAndPersistUiSession,
  buildUiSessionSnapshot,
} from '../services/uiSession/uiSessionCapture';
import {
  patchUiSessionLiveChrome,
  resetUiSessionLiveState,
  setPendingUiSessionApply,
} from '../services/uiSession/uiSessionLiveState';
import {
  clearUiSessionSnapshot,
  loadUiSessionSnapshot,
} from '../services/uiSession/uiSessionStore';
import { decideUiSessionRestore } from '../services/uiSession/uiSessionRestore';
import type { CompanyProfile } from '../types/models';

const ROUTE = '/firmendaten';

const savedProfile: CompanyProfile = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Bestand GmbH',
  street: 'Werk 1',
  zip: '80331',
  city: 'München',
  iban: 'DE89370400440532013000',
  bankName: 'Sparkasse',
  phone: '089 111',
  email: 'a@b.invalid',
  taxNumber: '143/123/45678',
  contactPerson: 'A. Beispiel',
  country: 'Deutschland',
  defaultPaymentDays: 14,
  defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen.',
};

let root: Root;
let host: HTMLDivElement;

/** Eine `.app-shell__main` wird für Scroll-Erfassung und -Anwendung gebraucht. */
function mountShell(): void {
  host = document.createElement('div');
  host.className = 'app-shell__main';
  document.body.appendChild(host);
  root = createRoot(host);
}

beforeEach(() => {
  setActiveStorageScope({ type: 'guest' });
  resetUiSessionLiveState();
  clearUiSessionSnapshot();
  hydrateCompanyProfileStore(savedProfile);
  mountShell();
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

/** Simuliert, was der Tracker bei `pagehide` tut: erfassen und ablegen. */
function captureNow(scrollTop = 0): void {
  captureAndPersistUiSession({
    pathname: ROUTE,
    search: '',
    hash: '',
    historyKey: 'k1',
    mainScrollTop: scrollTop,
    userId: null,
    source: 'auto',
  });
}

/** Der Neuaufbau: neue Instanz, derselbe Pfad, Schnappschuss aus dem Speicher. */
async function remount(): Promise<void> {
  await act(async () => root.unmount());
  host.remove();
  mountShell();

  const decision = decideUiSessionRestore({
    userId: null,
    currentPathname: ROUTE,
    currentSearch: '',
  });
  if (decision.intent === 'silent' && decision.snapshot) {
    setPendingUiSessionApply(decision.snapshot);
  }
  await renderPage();
}

function field(id: string): HTMLInputElement | null {
  return host.querySelector(`#${id}`);
}

function inputByLabelValue(value: string): HTMLInputElement | undefined {
  return Array.from(host.querySelectorAll('input')).find((el) => el.value === value);
}

async function setValue(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const proto =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function toggle(element: HTMLInputElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

/** Der Skonto-Schalter — er blendet die beiden Zahlenfelder ein. */
function skontoToggle(): HTMLInputElement {
  const box = Array.from(host.querySelectorAll('input[type="checkbox"]')).find((el) =>
    (el.closest('fieldset')?.textContent ?? '').toLowerCase().includes('skonto'),
  ) as HTMLInputElement | undefined;
  if (!box) throw new Error('Skonto-Schalter nicht gefunden');
  return box;
}

describe('MOBILE-RESUME-STATE-02B — Firmendaten-Wiederaufnahme', () => {
  // R1
  it('R1: ohne Entwurf stehen die gespeicherten Werte im Formular', async () => {
    await renderPage();
    expect(inputByLabelValue('Bestand GmbH')).not.toBeUndefined();
    expect(loadUiSessionSnapshot()).toBeNull();
  });

  // R15 — ein unverändertes Formular erzeugt keinen 24-Stunden-Entwurf.
  it('R15: ohne Änderung entsteht kein Dirty-Entwurf', async () => {
    await renderPage();
    captureNow();
    expect(loadUiSessionSnapshot()?.drafts.dirty).toBe(false);
    expect(loadUiSessionSnapshot()?.drafts.values ?? {}).toEqual({});
  });

  // R2
  it('R2: ein geänderter Firmenname überlebt den Neuaufbau', async () => {
    await renderPage();
    const name = inputByLabelValue('Bestand GmbH')!;
    await setValue(name, 'Neuer Name GmbH');
    captureNow();

    expect(loadUiSessionSnapshot()?.drafts.dirty).toBe(true);

    await remount();
    expect(inputByLabelValue('Neuer Name GmbH')).not.toBeUndefined();
    expect(inputByLabelValue('Bestand GmbH')).toBeUndefined();
  });

  /*
   * R3 — der Realbefund.
   *
   * Der Schalter blendet die beiden Zahlenfelder ein; nach dem Neuaufbau müssen
   * Schalter **und** Werte zurück sein, sonst fehlen die Felder wieder.
   */
  it('R3: Skonto aktiv, 2 % und 10 Tage überleben den Neuaufbau', async () => {
    await renderPage();
    await toggle(skontoToggle());
    await setValue(field('profile-skonto-percent')!, '2');
    await setValue(field('profile-skonto-days')!, '10');
    captureNow();

    await remount();

    expect(skontoToggle().checked).toBe(true);
    expect(field('profile-skonto-percent')).not.toBeNull();
    expect(field('profile-skonto-percent')!.value).toBe('2');
    expect(field('profile-skonto-days')!.value).toBe('10');
  });

  /*
   * R4 — die Reihenfolge, nicht nur das Ergebnis.
   *
   * Geprüft wird der Zustand des Dokuments **im Moment** der Scrollanwendung:
   * Die bedingten Skontofelder müssen dann bereits im DOM stehen. Sonst würde
   * die alte Position auf eine kürzere Seite angewandt und geklemmt — genau der
   * Sprung, über den sich Nutzer beschweren.
   */
  it('R4: der Formzustand steht, bevor die Scrollposition angewandt wird', async () => {
    await renderPage();
    await toggle(skontoToggle());
    await setValue(field('profile-skonto-percent')!, '2');
    captureNow(320);

    await act(async () => root.unmount());
    host.remove();
    mountShell();

    let fieldsPresentAtScrollTime: boolean | null = null;
    vi.spyOn(uiSessionCapture, 'applyMainScrollTop').mockImplementation(() => {
      fieldsPresentAtScrollTime = document.querySelector('#profile-skonto-percent') !== null;
    });

    const decision = decideUiSessionRestore({
      userId: null,
      currentPathname: ROUTE,
      currentSearch: '',
    });
    if (decision.intent === 'silent' && decision.snapshot) {
      setPendingUiSessionApply(decision.snapshot);
    }
    await renderPage();

    expect(fieldsPresentAtScrollTime, 'applyMainScrollTop wurde nicht aufgerufen').not.toBeNull();
    expect(fieldsPresentAtScrollTime).toBe(true);
  });

  // R5
  it('R5: nach erfolgreichem Speichern kommt der alte Entwurf nicht zurück', async () => {
    await renderPage();
    const name = inputByLabelValue('Bestand GmbH')!;
    await setValue(name, 'Gespeichert GmbH');

    const form = host.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 0));
      });
    }
    // Ohne erfolgreichen Speichervorgang pruefte der Test nichts.
    expect(host.querySelector('.form-error, [role="alert"]')?.textContent ?? '').toBe('');
    captureNow();

    expect(loadUiSessionSnapshot()?.drafts.dirty).toBe(false);

    await remount();
    expect(inputByLabelValue('Gespeichert GmbH')).not.toBeUndefined();
  });

  // R14 — Fehlermeldungen sind kein Arbeitsstand.
  it('R14: Fehlerzustände werden nicht gemeldet', async () => {
    await renderPage();
    const name = inputByLabelValue('Bestand GmbH')!;
    await setValue(name, '');
    captureNow();

    const values = loadUiSessionSnapshot()?.drafts.values ?? {};
    expect(Object.keys(values).some((key) => key.toLowerCase().includes('error'))).toBe(false);
  });

  // R11 — eine Dateiauswahl wird nicht vorgetäuscht.
  it('R11: keine Datei- oder Object-URL-Werte im Entwurf', async () => {
    await renderPage();
    await setValue(inputByLabelValue('Bestand GmbH')!, 'Mit Logo GmbH');
    captureNow();

    const values = loadUiSessionSnapshot()?.drafts.values ?? {};
    const serialized = JSON.stringify(values);
    expect(serialized).not.toContain('blob:');
    expect(serialized).not.toContain('selectedLogo');
    expect(serialized).not.toContain('data:image');
  });

  // Die Allowlist gilt: verschachtelte Verträge verlassen die Seite nicht.
  it('R11b: branding und logoDataUrl gelangen nicht in den Entwurf', async () => {
    await renderPage();
    await setValue(inputByLabelValue('Bestand GmbH')!, 'Allowlist GmbH');
    captureNow();

    const values = loadUiSessionSnapshot()?.drafts.values ?? {};
    expect(Object.keys(values)).not.toContain('companyProfile.branding');
    expect(Object.keys(values)).not.toContain('companyProfile.logoDataUrl');
    expect(Object.keys(values).every((key) => key.startsWith('companyProfile.'))).toBe(true);
  });
});

describe('MOBILE-RESUME-STATE-02B — Basisabgleich und Scope', () => {
  /*
   * R10 — der wichtigste Schutz.
   *
   * Der Entwurf entstand auf einem bestimmten gespeicherten Stand. Hat sich
   * dieser inzwischen geändert — anderes Gerät, Sync —, wird der Entwurf
   * verworfen. Lieber Tipparbeit verlieren als aktuelle Firmendaten
   * überschreiben; zusammengeführt wird ausdrücklich nichts.
   */
  it('R10: ein veralteter Entwurf wird nicht über einen neueren Stand gelegt', async () => {
    await renderPage();
    await setValue(inputByLabelValue('Bestand GmbH')!, 'Entwurf GmbH');
    captureNow();
    expect(loadUiSessionSnapshot()?.drafts.dirty).toBe(true);

    // Der gespeicherte Stand ändert sich zwischenzeitlich von aussen.
    hydrateCompanyProfileStore({ ...savedProfile, companyName: 'Extern Geändert GmbH' });

    await remount();
    expect(inputByLabelValue('Extern Geändert GmbH')).not.toBeUndefined();
    expect(inputByLabelValue('Entwurf GmbH')).toBeUndefined();
  });

  /*
   * R7/R8/R9 — Benutzer, Workspace und Haltbarkeit.
   *
   * Diese Prüfungen liegen zentral in `validateUiSessionSnapshot` und sind in
   * `src/uiSessionRecovery01.test.ts` bereits belegt (fremder Benutzer, fremder
   * Workspace, falscher `scopeKey`, TTL regulär und dirty). Hier wird nur die
   * Naht geprüft: Ein Firmendaten-Entwurf hängt tatsächlich an diesem Vertrag
   * und wird bei fremdem Scope nicht angeboten.
   */
  it('R7-R9: ein Firmendaten-Entwurf aus fremdem Scope wird nicht wiederhergestellt', async () => {
    await renderPage();
    await setValue(inputByLabelValue('Bestand GmbH')!, 'Fremder Entwurf GmbH');
    captureNow();
    expect(loadUiSessionSnapshot()?.drafts.dirty).toBe(true);

    // Ein anderer Speicher-Scope — wie nach einem Benutzer-/Workspacewechsel.
    setActiveStorageScope({ type: 'workspace', workspaceId: 'ws-fremd' });
    const decision = decideUiSessionRestore({
      userId: null,
      currentPathname: ROUTE,
      currentSearch: '',
    });
    expect(decision.intent).toBe('ignore');

    setActiveStorageScope({ type: 'guest' });
  });

  // Der Baustein schreibt nur benannte Primitive, nie ein ganzes Objekt.
  it('Der Schnappschuss trägt ausschliesslich primitive Werte', async () => {
    await renderPage();
    await toggle(skontoToggle());
    await setValue(field('profile-skonto-percent')!, '2');
    captureNow();

    const values = loadUiSessionSnapshot()?.drafts.values ?? {};
    for (const value of Object.values(values)) {
      expect(['string', 'number', 'boolean']).toContain(typeof value);
    }
    expect(buildUiSessionSnapshot).toBeTypeOf('function');
    expect(patchUiSessionLiveChrome).toBeTypeOf('function');
  });
});
