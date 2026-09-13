/**
 * CUSTOMER-IDENTITY-DUPLICATE-01A — Wiedererkennung wahrscheinlicher
 * Kundendubletten bei der Neuanlage (confirm-first, kein Merge).
 *
 * Realbefund (lokal reproduziert über die manuelle Rechnung): „Westfalen
 * Projektbau GmbH, Industriestraße 27, 33689 Bielefeld" ließ sich ohne jede
 * Warnung ein zweites Mal anlegen (auch als „westfalen projektbau gmbh ").
 *
 * Die Regel ist eine Warnregel, keine Identitätsbehauptung:
 *  - gleicher normalisierter Name + gleiche vollständige Anschrift → starker Kandidat
 *  - gleicher Name, Anschrift auf einer Seite unvollständig → unsicherer Kandidat (Warnung)
 *  - gleicher Name, deutlich andere vollständige Anschrift → kein Kandidat (Neuanlage frei)
 *  - nie automatisch zusammenführen; die bewusste Neuanlage bleibt möglich
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { getCustomerStoreSnapshot, hydrateCustomerStore } from '../customerStoreService';
import { createCustomer, validateCustomerDecisionForCreate } from '../customerService';
import { findCustomerDuplicateCandidates } from './customerDuplicateService';
import { setActiveStorageScope } from '../storage/storageScopeService';
import { DEFAULT_COMPANY_PROFILE } from '../../data/mockData';
import type { Customer } from '../../types/models';

const OWN = 'Cirmak Haustechnik GmbH';
const NOW = '2026-09-01T08:00:00.000Z';

function customer(overrides: Partial<Customer> & Pick<Customer, 'id' | 'name'>): Customer {
  return {
    contactPerson: '',
    street: '',
    zip: '',
    city: '',
    email: '',
    phone: '',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const EXISTING = customer({
  id: 'cust-existing',
  name: 'Sägewerk Ernst Flisch GmbH',
  street: 'Industriestraße 27',
  zip: '33689',
  city: 'Bielefeld',
});

beforeEach(() => {
  setActiveStorageScope({ type: 'guest' });
  localStorage.clear();
  hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: OWN });
  hydrateCustomerStore([EXISTING]);
});

describe('Duplicate Candidate — zentrale Regel', () => {
  it('R1: gleicher Name + gleiche Anschrift → starker Kandidat', () => {
    const candidates = findCustomerDuplicateCandidates({
      name: 'Sägewerk Ernst Flisch GmbH',
      street: 'Industriestraße 27',
      zip: '33689',
      city: 'Bielefeld',
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.customer.id).toBe('cust-existing');
    expect(candidates[0]!.strength).toBe('strong');
    expect(candidates[0]!.reasons).toEqual(expect.arrayContaining(['same_name', 'same_address']));
  });

  it('R2: Groß-/Kleinschreibung, Leerraum und triviale Formatierung ändern die Firma nicht', () => {
    const candidates = findCustomerDuplicateCandidates({
      name: '  sägewerk   ernst flisch gmbh ',
      street: 'Industriestr. 27',
      zip: ' 33689 ',
      city: 'bielefeld',
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.strength).toBe('strong');
  });

  it('R3: gleicher Name + deutlich andere vollständige Anschrift → kein stiller Identitätskandidat', () => {
    const candidates = findCustomerDuplicateCandidates({
      name: 'Sägewerk Ernst Flisch GmbH',
      street: 'Hafenweg 3',
      zip: '20457',
      city: 'Hamburg',
    });
    expect(candidates.filter((c) => c.strength === 'strong')).toHaveLength(0);
    // Neuanlage frei — der Service blockiert nicht.
    const created = createCustomer({ name: 'Sägewerk Ernst Flisch GmbH', street: 'Hafenweg 3', zip: '20457', city: 'Hamburg' });
    expect(created.success).toBe(true);
    expect(getCustomerStoreSnapshot()).toHaveLength(2);
  });

  it('R4: gleicher Name ohne belastbare Anschrift → unsicherer Kandidat, keine automatische Zusammenführung', () => {
    const withoutAddress = findCustomerDuplicateCandidates({ name: 'Sägewerk Ernst Flisch GmbH' });
    expect(withoutAddress).toHaveLength(1);
    expect(withoutAddress[0]!.strength).toBe('weak');

    hydrateCustomerStore([customer({ id: 'cust-noaddr', name: 'Sägewerk Ernst Flisch GmbH' })]);
    const otherSideMissing = findCustomerDuplicateCandidates({
      name: 'Sägewerk Ernst Flisch GmbH',
      street: 'Industriestraße 27',
      zip: '33689',
      city: 'Bielefeld',
    });
    expect(otherSideMissing).toHaveLength(1);
    expect(otherSideMissing[0]!.strength).toBe('weak');
    // Kein Merge: der Bestand bleibt unverändert, es wird nichts umgeschrieben.
    expect(getCustomerStoreSnapshot().map((c) => c.id)).toEqual(['cust-noaddr']);
    // Unsichere Kandidaten sperren den Dienst nicht (die Oberfläche fragt nach) — zwei Betriebe
    // gleichen Namens ohne belastbare Anschrift bleiben anlegbar, als getrennte Datensätze.
    const created = createCustomer({ name: 'Sägewerk Ernst Flisch GmbH' });
    expect(created.success).toBe(true);
    expect(getCustomerStoreSnapshot()).toHaveLength(2);
  });
});

describe('Confirm-first im Service (alle Anlagewege laufen hier durch)', () => {
  it('R1b: createCustomer ohne Bestätigung → kein zweiter Datensatz, Kandidaten werden zurückgegeben', () => {
    const result = createCustomer({
      name: 'sägewerk ernst flisch gmbh',
      street: 'Industriestraße 27',
      zip: '33689',
      city: 'Bielefeld',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorKey).toBe('customer.duplicateCandidate');
      expect(result.duplicates?.map((c) => c.customer.id)).toEqual(['cust-existing']);
    }
    expect(getCustomerStoreSnapshot()).toHaveLength(1);
  });

  it('R5: „vorhandenen Kunden verwenden" = Entscheidung existing → kein neuer Datensatz, bestehende ID', () => {
    const check = validateCustomerDecisionForCreate({ kind: 'existing', customerId: 'cust-existing' });
    expect(check.ok).toBe(true);
    expect(getCustomerStoreSnapshot().map((c) => c.id)).toEqual(['cust-existing']);
  });

  it('R6: „trotzdem neuen Kunden anlegen" (bewusst) → Neuanlage bleibt möglich', () => {
    const decision = validateCustomerDecisionForCreate({
      kind: 'new',
      input: { name: 'Sägewerk Ernst Flisch GmbH', street: 'Industriestraße 27', zip: '33689', city: 'Bielefeld' },
      allowDuplicate: true,
    });
    expect(decision.ok).toBe(true);
    const created = createCustomer(
      { name: 'Sägewerk Ernst Flisch GmbH', street: 'Industriestraße 27', zip: '33689', city: 'Bielefeld' },
      { allowDuplicate: true },
    );
    expect(created.success).toBe(true);
    expect(getCustomerStoreSnapshot()).toHaveLength(2);
    // Zwei getrennte Datensätze, keine ID umgeschrieben.
    expect(getCustomerStoreSnapshot().map((c) => c.id)).toContain('cust-existing');
  });

  it('R6b: Vorgangs-/Vertragsweg (CustomerDecision new) ohne Bestätigung → duplicateCandidate', () => {
    const decision = validateCustomerDecisionForCreate({
      kind: 'new',
      input: { name: 'Sägewerk Ernst Flisch GmbH', street: 'Industriestraße 27', zip: '33689', city: 'Bielefeld' },
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.errorKey).toBe('customer.duplicateCandidate');
  });

  it('R8: eigene Firma bleibt abgewiesen — vor jeder Dublettenprüfung', () => {
    hydrateCustomerStore([EXISTING, customer({ id: 'cust-own-legacy', name: OWN })]);
    const result = createCustomer({ name: OWN });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errorKey).toBe('customer.ownCompanyNotAllowed');
    expect(findCustomerDuplicateCandidates({ name: OWN })).toHaveLength(0);
  });
});
