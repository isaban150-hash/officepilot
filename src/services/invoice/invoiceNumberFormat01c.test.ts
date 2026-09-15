/**
 * PRODUCT-BASIS-FIRMENPROFIL-01C — lokaler Spiegel des Nummernformats.
 *
 *  - buildInvoiceNumber spiegelt build_workspace_invoice_number (Beispiele der Vorgabe)
 *  - validateInvoiceNumberFormat spiegelt die Serverregeln
 *  - Vorschau nutzt den Format-Cache; Cache ueberlebt den Jahreswechsel
 *  - lokale Sperrregel: Jahr mit Nummern ist festgelegt (Lokalbetrieb)
 *  - Lokalbetrieb (ohne Cloud): speichern erlaubt, gesperrt nach erster Nummer
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as supabaseLib from '../../lib/supabase';
import {
  DEFAULT_INVOICE_NUMBER_FORMAT,
  buildInvoiceNumber,
  formatInvoiceNumber,
  getInvoiceNumberFormat,
  getNextInvoiceNumberPreview,
  hydrateInvoiceNumberSequence,
  isInvoiceNumberFormatLockedForYear,
  setInvoiceNumberFormat,
  validateInvoiceNumberFormat,
  withInvoiceNumberFormat,
} from '../invoiceNumberService';
import { loadInvoiceNumberFormat, saveInvoiceNumberFormat } from './invoiceNumberFormatCloudService';
import { resetTestStores } from '../../test/resetStores';

const YEAR = new Date().getFullYear();

describe('01C — Formatspiegel', () => {
  it('bildet die Vorgabe-Beispiele: 2026-0001 / RE-2026-0001 / RE-0001; Padding waechst nie unter die Ziffernzahl', () => {
    expect(buildInvoiceNumber({ prefix: '', yearInNumber: true, padding: 4 }, 2026, 1)).toBe('2026-0001');
    expect(buildInvoiceNumber({ prefix: 'RE', yearInNumber: true, padding: 4 }, 2026, 1)).toBe('RE-2026-0001');
    expect(buildInvoiceNumber({ prefix: 'RE', yearInNumber: false, padding: 4 }, 2026, 1)).toBe('RE-0001');
    expect(buildInvoiceNumber({ prefix: 'RE', yearInNumber: false, padding: 3 }, 2026, 12345)).toBe('RE-12345');
  });

  it('validiert wie der Server: Prefix-Zeichen/Laenge/Leerraum, padding 3..8', () => {
    expect(validateInvoiceNumberFormat({ prefix: '', yearInNumber: true, padding: 4 })).toBeNull();
    expect(validateInvoiceNumberFormat({ prefix: 'RE-A1', yearInNumber: false, padding: 8 })).toBeNull();
    expect(validateInvoiceNumberFormat({ prefix: 'RE ', yearInNumber: true, padding: 4 })).toBe('invoiceNumberFormat.prefixInvalid');
    expect(validateInvoiceNumberFormat({ prefix: 'RE/26', yearInNumber: true, padding: 4 })).toBe('invoiceNumberFormat.prefixInvalid');
    expect(validateInvoiceNumberFormat({ prefix: 'x'.repeat(11), yearInNumber: true, padding: 4 })).toBe('invoiceNumberFormat.prefixInvalid');
    expect(validateInvoiceNumberFormat({ prefix: 'RE', yearInNumber: true, padding: 2 })).toBe('invoiceNumberFormat.paddingInvalid');
    expect(validateInvoiceNumberFormat({ prefix: 'RE', yearInNumber: true, padding: 9 })).toBe('invoiceNumberFormat.paddingInvalid');
  });
});

describe('01C — Vorschau, Cache und lokale Sperre', () => {
  beforeEach(() => resetTestStores());
  afterEach(() => { resetTestStores(); vi.restoreAllMocks(); });

  it('Vorschau folgt dem Cache; ohne Cache Legacy-Format; Cache ueberlebt den Jahreswechsel', () => {
    hydrateInvoiceNumberSequence({ year: YEAR, lastIssuedNumber: 0 });
    expect(getInvoiceNumberFormat()).toEqual(DEFAULT_INVOICE_NUMBER_FORMAT);
    expect(getNextInvoiceNumberPreview()).toBe(`${YEAR}-0001`);
    setInvoiceNumberFormat({ prefix: 'RE', yearInNumber: true, padding: 5 });
    expect(getNextInvoiceNumberPreview()).toBe(`RE-${YEAR}-00001`);
    hydrateInvoiceNumberSequence({ year: YEAR - 1, lastIssuedNumber: 3, format: { prefix: 'RE', yearInNumber: true, padding: 5 } });
    expect(formatInvoiceNumber(YEAR, 1)).toBe(`RE-${YEAR}-00001`);
    expect(getNextInvoiceNumberPreview()).toBe(`RE-${YEAR}-00001`);
  });

  it('01C2 Lokalbetrieb: Standard aenderbar; Jahr mit Nummern behaelt eingefrorene Kopie; Folgejahr uebernimmt den Standard', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
    hydrateInvoiceNumberSequence({ year: YEAR, lastIssuedNumber: 0 });
    const saved = await saveInvoiceNumberFormat({ prefix: 'RE', yearInNumber: true, padding: 4 }, 0);
    expect(saved.outcome).toBe('ok');
    expect(saved.outcome === 'ok' && saved.state).toMatchObject({ source: 'local', currentYearLocked: false, effectiveFromYear: YEAR, format: { prefix: 'RE' } });
    // erste Nummer des Jahres friert RE-… lokal ein
    hydrateInvoiceNumberSequence({ year: YEAR, lastIssuedNumber: 1, format: { prefix: 'RE', yearInNumber: true, padding: 4 }, lockedFormat: { prefix: 'RE', yearInNumber: true, padding: 4 } });
    expect(isInvoiceNumberFormatLockedForYear(YEAR)).toBe(true);
    const changed = await saveInvoiceNumberFormat({ prefix: 'RG', yearInNumber: false, padding: 5 }, 0);
    expect(changed.outcome).toBe('ok');
    expect(changed.outcome === 'ok' && changed.state).toMatchObject({ currentYearLocked: true, effectiveFromYear: YEAR + 1 });
    // laufendes Jahr: weiterhin die eingefrorene Kopie; Folgejahr: der neue Standard
    expect(formatInvoiceNumber(YEAR, 2)).toBe(`RE-${YEAR}-0002`);
    expect(formatInvoiceNumber(YEAR + 1, 1)).toBe('RG-00001');
    const invalid = await saveInvoiceNumberFormat({ prefix: 'RE ', yearInNumber: true, padding: 4 }, 0);
    expect(invalid).toEqual({ outcome: 'invalid', errorKey: 'invoiceNumberFormat.prefixInvalid' });
    const loaded = await loadInvoiceNumberFormat();
    expect(loaded.outcome === 'ok' && loaded.state.currentYearLocked).toBe(true);
  });

  it('01C2 Serverstand per Pull: Vorschau des gesperrten Jahres folgt der eingefrorenen Kopie, nicht dem Standard', () => {
    hydrateInvoiceNumberSequence(withInvoiceNumberFormat({ year: YEAR - 1, lastIssuedNumber: 9 }, { prefix: 'RG', yearInNumber: true, padding: 5 }, YEAR, { prefix: 'RE', yearInNumber: true, padding: 4 }));
    expect(getNextInvoiceNumberPreview()).toBe(`RE-${YEAR}-0001`);
    expect(formatInvoiceNumber(YEAR + 1, 1)).toBe(`RG-${YEAR + 1}-00001`);
    // ohne eingefrorene Kopie gilt der Standard
    hydrateInvoiceNumberSequence(withInvoiceNumberFormat(undefined, { prefix: 'RG', yearInNumber: true, padding: 5 }, YEAR));
    expect(getNextInvoiceNumberPreview()).toBe(`RG-${YEAR}-00001`);
  });
});
