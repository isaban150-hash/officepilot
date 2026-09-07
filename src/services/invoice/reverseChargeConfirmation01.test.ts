/**
 * INVOICE-MOBILE-RESUME-01B — der Bindungsvertrag der §13b-Bestätigung.
 *
 * Die Bestätigung darf einen App-Wechsel überleben, aber ausschliesslich für
 * genau den Entwurf, für den sie gegeben wurde. Diese Suite prüft jede
 * Bindungsachse einzeln: Weicht eine ab, ist die Bestätigung nicht vorhanden.
 *
 * Synthetische Daten, kein Netz.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildReverseChargeConfirmationKey,
  clearReverseChargeConfirmation,
  hasValidReverseChargeConfirmation,
  isValidReverseChargeConfirmation,
  REVERSE_CHARGE_CONFIRMATION_KIND,
  writeReverseChargeConfirmation,
  type ReverseChargeConfirmationContext,
} from './reverseChargeConfirmationService';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const context: ReverseChargeConfirmationContext = {
  sourceScopeKey: 'workspace:ws-13b',
  workspaceId: 'ws-13b',
  vorgangId: 'v-test-1',
  invoiceType: 'rechnung',
  draftId: 'draft-1',
  draftSha256: HASH_A,
};

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('INVOICE-MOBILE-RESUME-01B — Bestätigung schreiben und lesen', () => {
  it('C1: derselbe Kontext findet die Bestätigung wieder', () => {
    expect(writeReverseChargeConfirmation(context)).not.toBeNull();
    expect(hasValidReverseChargeConfirmation(context)).toBe(true);
  });

  it('C2: ohne Eintrag gilt sie als nicht gegeben', () => {
    expect(hasValidReverseChargeConfirmation(context)).toBe(false);
  });

  it('C3: Abwählen entfernt sie', () => {
    writeReverseChargeConfirmation(context);
    clearReverseChargeConfirmation(context);
    expect(hasValidReverseChargeConfirmation(context)).toBe(false);
  });
});

describe('INVOICE-MOBILE-RESUME-01B — jede Abweichung schliesst', () => {
  const deviations: Array<[string, Partial<ReverseChargeConfirmationContext>]> = [
    ['C4: anderer Entwurf', { draftId: 'draft-2' }],
    ['C5: geänderter Entwurfsinhalt', { draftSha256: HASH_B }],
    ['C6: andere Rechnungsart', { invoiceType: 'schluss' }],
    ['C7: anderer Vorgang', { vorgangId: 'v-test-2' }],
    ['C8: anderer Scope', { sourceScopeKey: 'workspace:ws-other' }],
    ['C9: anderer Workspace', { workspaceId: 'ws-other' }],
  ];

  for (const [name, deviation] of deviations) {
    it(name, () => {
      writeReverseChargeConfirmation(context);
      expect(hasValidReverseChargeConfirmation({ ...context, ...deviation })).toBe(false);
    });
  }

  /*
   * C9 verdient eine eigene Erklärung: Scope und Workspace stehen beide im
   * Eintrag, aber nur der Scope im Schlüssel. Ein abweichender Workspace muss
   * deshalb beim Vergleich des Inhalts scheitern, nicht erst beim Suchen.
   */
  it('C10: ein fremder Workspace scheitert am Inhalt, nicht nur am Schlüssel', () => {
    writeReverseChargeConfirmation(context);
    const raw = localStorage.getItem(buildReverseChargeConfirmationKey(context));
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).workspaceId).toBe('ws-13b');
    expect(hasValidReverseChargeConfirmation({ ...context, workspaceId: 'ws-other' })).toBe(false);
  });
});

describe('INVOICE-MOBILE-RESUME-01B — fail-closed bei Störungen', () => {
  it('C11: ein beschädigter Eintrag gilt als nicht vorhanden', () => {
    localStorage.setItem(buildReverseChargeConfirmationKey(context), '{nicht json');
    expect(hasValidReverseChargeConfirmation(context)).toBe(false);
  });

  it('C12: eine fremde Version wird nicht gelesen', () => {
    localStorage.setItem(
      buildReverseChargeConfirmationKey(context),
      JSON.stringify({ ...context, kind: REVERSE_CHARGE_CONFIRMATION_KIND, version: 99, confirmedAt: 'x' }),
    );
    expect(hasValidReverseChargeConfirmation(context)).toBe(false);
  });

  it('C13: ein unvollständiger Kontext schreibt nichts und liest nichts', () => {
    expect(writeReverseChargeConfirmation({ ...context, draftId: '' })).toBeNull();
    expect(hasValidReverseChargeConfirmation({ ...context, draftSha256: 'kein-hash' })).toBe(false);
  });

  /*
   * Ohne Speicher — privates Fenster, gesperrte Website-Daten — bleibt es beim
   * bisherigen Verhalten: unbequem, aber niemals unsicher.
   */
  it('C14: ein blockierter Speicher führt zu „nicht bestätigt", nicht zu einem Absturz', () => {
    vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(writeReverseChargeConfirmation(context)).toBeNull();

    vi.spyOn(globalThis.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(hasValidReverseChargeConfirmation(context)).toBe(false);
  });

  it('C15: die Formprüfung weist Fremdobjekte ab', () => {
    expect(isValidReverseChargeConfirmation(null)).toBe(false);
    expect(isValidReverseChargeConfirmation([])).toBe(false);
    expect(isValidReverseChargeConfirmation({ ...context })).toBe(false);
  });
});
