/**
 * WV-LV-ROBUSTHEIT-01A-N3 — der Blockadehinweis erreicht den Nutzer wirklich.
 *
 * Der Toast wird ausschließlich in AppShell gerendert. Der Nachweis läuft
 * deshalb über den echten Benutzerweg: kg-Position anhaken, Auftragsbutton
 * klicken, Toast im DOM lesen. Kein Mock von acceptContractOrderFromProposal,
 * kein direkter Aufruf von showToast oder handleCreateContractOrder.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { AppShell } from '../components/layout/AppShell';
import { EingangDetailPage } from '../pages/EingangDetailPage';
import { buildUnitUnresolvedToast } from '../pages/EingangDetailPage';
import { TestProviders } from '../test/TestProviders';
import { DEFAULT_SETUP } from '../data/mockData';
import { hydrateInboxStore } from './inboxService';
import { hydrateVorgangStore } from './vorgangService';
import { createAuftragInboxItem } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import { t, type TranslationKey } from '../i18n';
import type { AppLanguage, InboxItem } from '../types/models';

/** Fest hinterlegt — bewusst nicht aus translate()/buildUnitUnresolvedToast erzeugt. */
const EXPECTED_TOAST_DE =
  'Einheit nicht eindeutig erkannt (kg). Es wurde keine Position übernommen — bitte Einheit im Vertrag prüfen.';
const EXPECTED_TOAST_TR =
  'Birim kesin olarak tanınamadı (kg). Hiçbir kalem aktarılmadı — lütfen sözleşmedeki birimi kontrol edin.';

const CONTRACT_WITH_KG = [
  'Werkvertrag',
  'Auftraggeber: Nordwind Bau GmbH',
  'Subunternehmer: Steinweg Montage GmbH',
  'Baustelle: Deichweg 4, 26382 Wilhelmshaven',
  'Vertragsdatum: 04.02.2027',
  '',
  'Leistungsverzeichnis',
  '1 100,00 qm Abdichtung herstellen EP 5,00 € GP 500,00 €',
  '2 250,00 kg Schüttgut liefern EP 2,00 € GP 500,00 €',
].join('\n');

function contractItem(): InboxItem {
  const pages = [{ pageNumber: 1, text: CONTRACT_WITH_KG }];
  return {
    ...createAuftragInboxItem(),
    id: 'inbox-kg-toast',
    title: 'Werkvertrag Nordwind',
    sender: 'Nordwind Bau GmbH',
    classifiedKind: 'werkvertrag',
    recognizedData: {
      Kunde: 'Nordwind Bau GmbH',
      _vertragstext: CONTRACT_WITH_KG,
      _pageTexts: JSON.stringify(pages),
    },
  };
}

type Mounted = { container: HTMLDivElement; root: Root };
const mounted: Mounted[] = [];

async function mountPage(language: AppLanguage, itemId: string): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(
        TestProviders,
        { initialSetup: { ...DEFAULT_SETUP, companyName: 'Steinweg Montage GmbH', language } },
        createElement(
          MemoryRouter,
          { initialEntries: [`/ablage/${itemId}`] },
          createElement(
            Routes,
            null,
            createElement(Route, {
              element: createElement(AppShell),
              children: createElement(Route, {
                path: '/ablage/:id',
                element: createElement(EingangDetailPage),
              }),
            }),
          ),
        ),
      ),
    );
  });

  const entry = { container, root };
  mounted.push(entry);
  return entry;
}

afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    await act(async () => {
      entry.root.unmount();
    });
    entry.container.remove();
  }
});

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

function positionRows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(
    container.querySelectorAll('[data-testid="contract-order-positions"] tbody tr'),
  ) as HTMLTableRowElement[];
}

/** Führt den echten Benutzerweg aus und liefert den gerenderten Toasttext. */
async function runBlockedAcceptFlow(language: AppLanguage): Promise<string | null> {
  resetTestStores();
  const item = contractItem();
  hydrateInboxStore([item]);
  hydrateVorgangStore([]);

  const { container } = await mountPage(language, item.id);

  const scopeToggle = container.querySelector(
    '[data-testid="auftragskarte-toggle-scope"]',
  ) as HTMLElement | null;
  if (scopeToggle) await click(scopeToggle);

  const editorToggle = container.querySelector(
    '[data-testid="contract-lv-editor-disclosure"] [data-testid="show-more-toggle"]',
  ) as HTMLButtonElement | null;
  expect(editorToggle, 'LV-Editor-Umschalter fehlt').toBeTruthy();
  await click(editorToggle!);

  const rows = positionRows(container);
  expect(rows.length, 'LV-Zeilen fehlen').toBeGreaterThanOrEqual(2);

  // Beschreibung und Einheit stehen in <input value=…> — textContent greift dort nicht.
  const kgRow = rows.find((row) => {
    const inputs = Array.from(row.querySelectorAll('input')) as HTMLInputElement[];
    return inputs.some((input) => input.value.includes('Schüttgut'));
  });
  expect(kgRow, 'kg-Position nicht gefunden').toBeTruthy();
  expect(kgRow!.getAttribute('data-selection')).toBe('needs_review');
  const kgCheckbox = kgRow!.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
  expect(kgCheckbox, 'Checkbox der kg-Position fehlt').toBeTruthy();
  expect(kgCheckbox!.checked).toBe(false);
  expect(kgCheckbox!.disabled).toBe(false);
  await click(kgCheckbox!);

  const createButton = container.querySelector(
    '[data-testid="contract-create-order-button"]',
  ) as HTMLButtonElement | null;
  expect(createButton, 'Auftragserstellungsbutton fehlt').toBeTruthy();
  await click(createButton!);

  const toast = container.querySelector('.toast[role="status"]');
  expect(toast, 'Toast nicht im DOM').toBeTruthy();
  // Nur der Nachrichtentext — der Schließen-Button (×) liegt daneben.
  const message = toast!.querySelector('span');
  expect(message, 'Toast-Nachrichtenelement fehlt').toBeTruthy();
  return message!.textContent ?? null;
}

describe('WV-LV-ROBUSTHEIT-01A-N3 – echter DOM-Toast', () => {
  it('Deutsch: Toast erscheint mit kg und ohne Platzhalter', async () => {
    const text = await runBlockedAcceptFlow('de');

    expect(text).toBe(EXPECTED_TOAST_DE);
    expect(text).toContain('kg');
    expect(text).not.toContain('{units}');
  });

  it('Türkisch: Toast erscheint übersetzt, ohne deutschen Fallback', async () => {
    const text = await runBlockedAcceptFlow('tr');

    expect(text).toBe(EXPECTED_TOAST_TR);
    expect(text).toContain('kg');
    expect(text).not.toContain('{units}');
    expect(text).not.toContain('Einheit nicht eindeutig');
  });
});

/** Zusätzliche kleine Absicherung des Helfers — ersetzt den DOM-Test nicht. */
describe('WV-LV-ROBUSTHEIT-01A-N3 – Hilfsfunktion', () => {
  const UNRESOLVED = [{ positionNumber: '2', description: 'Schüttgut liefern', rawUnit: 'kg' }];

  it('setzt kg in beiden Sprachen ein', () => {
    expect(buildUnitUnresolvedToast((key: TranslationKey) => t(key, 'de'), UNRESOLVED)).toBe(
      EXPECTED_TOAST_DE,
    );
    expect(buildUnitUnresolvedToast((key: TranslationKey) => t(key, 'tr'), UNRESOLVED)).toBe(
      EXPECTED_TOAST_TR,
    );
  });

  it('mehrere Einheiten erscheinen einmalig', () => {
    const text = buildUnitUnresolvedToast((key: TranslationKey) => t(key, 'de'), [
      { positionNumber: '2', description: 'Schüttgut', rawUnit: 'kg' },
      { positionNumber: '3', description: 'Sonderleistung', rawUnit: 'Zwirbel' },
      { positionNumber: '4', description: 'Mehr Schüttgut', rawUnit: 'kg' },
    ]);

    expect(text).toContain('(kg, Zwirbel)');
    expect(text).not.toContain('{units}');
  });
});
