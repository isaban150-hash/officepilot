/**
 * CUSTOMER-IDENTITY-DUPLICATE-01A — Darstellung.
 *
 * R7: Zwei gleichnamige Kunden mit gleicher Anschrift waren in der Kundenwahl
 * ununterscheidbar (Name + Anschrift, sonst nichts). Bei Namensgleichheit
 * zeigt die Auswahl jetzt vorhandene Unterscheidungsmerkmale (Kontakt,
 * E-Mail, Anlagedatum) — keine internen IDs, keine erfundenen Daten.
 *
 * Zusätzlich: die Dubletten-Entscheidung bietet den vorhandenen Kunden als
 * sichere Hauptaktion an und macht die Neuanlage nur bewusst möglich.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AppProvider } from '../../context/AppContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { CustomerDecisionChoice } from './CustomerDecisionChoice';
import { CustomerDuplicateDecision } from './CustomerDuplicateDecision';
import { t } from '../../i18n';
import type { Customer } from '../../types/models';
import type { CustomerDuplicateCandidate } from '../../services/customer/customerDuplicateService';

function customer(overrides: Partial<Customer> & Pick<Customer, 'id' | 'name' | 'createdAt'>): Customer {
  return {
    contactPerson: '',
    street: 'Industriestraße 27',
    zip: '33689',
    city: 'Bielefeld',
    email: '',
    phone: '',
    updatedAt: overrides.createdAt,
    ...overrides,
  };
}

const A = customer({ id: 'cust-a', name: 'Westfalen Projektbau GmbH', createdAt: '2026-03-02T10:00:00.000Z' });
const B = customer({ id: 'cust-b', name: 'Westfalen Projektbau GmbH', createdAt: '2026-09-13T10:00:00.000Z', email: 'buero@westfalen.example' });
const OTHER = customer({ id: 'cust-c', name: 'Andere Bau GmbH', createdAt: '2026-01-01T10:00:00.000Z' });

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render(element: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(createElement(AppProvider, { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } }, element));
  });
}

function optionText(id: string): string {
  return (host.querySelector(`[data-testid="customer-option-${id}"]`)?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('R7 — gleichnamige Kunden sind unterscheidbar', () => {
  it('bei Namensgleichheit erscheinen Anlagedatum bzw. Kontakt/E-Mail, nie die interne ID', async () => {
    await render(
      createElement(CustomerDecisionChoice, {
        mode: 'existing',
        onModeChange: () => {},
        customers: [A, B, OTHER],
        selectedCustomerId: null,
        onSelectCustomer: () => {},
      }),
    );
    const a = optionText('cust-a');
    const b = optionText('cust-b');
    expect(a, 'Optionen sind identisch').not.toBe(b);
    expect(a).toContain('Industriestraße 27, 33689 Bielefeld');
    expect(a).toContain('02.03.2026');
    expect(b).toContain('buero@westfalen.example');
    expect(a).not.toContain('cust-a');
    expect(b).not.toContain('cust-b');
    // Ein Kunde ohne Namensvetter bleibt wie bisher (nur Name + Anschrift).
    expect(optionText('cust-c')).toBe('Andere Bau GmbHIndustriestraße 27, 33689 Bielefeld');
    expect(host.querySelector('[data-testid="customer-distinguisher-cust-c"]')).toBeNull();
  });
});

describe('Dubletten-Entscheidung — confirm-first', () => {
  const candidates: CustomerDuplicateCandidate[] = [
    { customer: A, strength: 'strong', reasons: ['same_name', 'same_address'] },
  ];

  it('zeigt Warnung und vorhandenen Kunden; „verwenden" liefert die bestehende ID, „trotzdem" ist eine eigene bewusste Aktion', async () => {
    const onUseExisting = vi.fn();
    const onCreateAnyway = vi.fn();
    await render(
      createElement(CustomerDuplicateDecision, { candidates, onUseExisting, onCreateAnyway }),
    );
    const box = host.querySelector('[data-testid="customer-duplicate-decision"]');
    expect(box).not.toBeNull();
    expect(box!.textContent).toContain(t('customerDuplicate.title', 'de'));
    expect(box!.textContent).toContain('Westfalen Projektbau GmbH');
    expect(box!.textContent).toContain('Industriestraße 27, 33689 Bielefeld');

    const use = host.querySelector<HTMLButtonElement>('[data-testid="customer-duplicate-use-existing-cust-a"]');
    const anyway = host.querySelector<HTMLButtonElement>('[data-testid="customer-duplicate-create-anyway"]');
    expect(use).not.toBeNull();
    expect(anyway).not.toBeNull();
    expect(use!.type).toBe('button');
    expect(anyway!.type).toBe('button');

    await act(async () => use!.click());
    expect(onUseExisting).toHaveBeenCalledWith('cust-a');
    expect(onCreateAnyway).not.toHaveBeenCalled();

    await act(async () => anyway!.click());
    expect(onCreateAnyway).toHaveBeenCalledTimes(1);
  });

  it('unsicherer Kandidat wird als „möglicherweise" gekennzeichnet', async () => {
    await render(
      createElement(CustomerDuplicateDecision, {
        candidates: [{ customer: { ...A, street: '', zip: '', city: '' }, strength: 'weak', reasons: ['same_name'] }],
        onUseExisting: () => {},
        onCreateAnyway: () => {},
      }),
    );
    expect(host.textContent).toContain(t('customerDuplicate.weakHint', 'de'));
  });
});
