/**
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4C — originweite, rein
 * lesende Inspektion der Legacy-Intents.
 *
 * Ausschließlich synthetische, neutrale Daten.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildStorageKey, resetStorageScopeForTests } from '../storage/storageScopeService';
import {
  INVOICE_FINALIZE_INTENT_STORAGE_SUFFIX,
  inspectInvoiceFinalizeIntentsForOrigin,
  isInvoiceFinalizeIntentStorageKey,
  type InvoiceFinalizeIntent,
} from './invoiceFinalizeIntentService';

const WORKSPACE_A = 'ws-c-a';
const WORKSPACE_B = 'ws-c-b';
const VORGANG_A = 'vg-c-1';
const CLIENT_A = 'inv-c-0001';
const CREATED_AT = '2026-08-21T09:00:00.000Z';

function intentKey(scope: Parameters<typeof buildStorageKey>[0]): string {
  return `${buildStorageKey(scope)}${INVOICE_FINALIZE_INTENT_STORAGE_SUFFIX}`;
}

function buildIntent(overrides: Partial<InvoiceFinalizeIntent> = {}): InvoiceFinalizeIntent {
  return {
    workspaceId: WORKSPACE_A,
    vorgangId: VORGANG_A,
    clientInvoiceId: CLIENT_A,
    contentFingerprint: 'fp-c-0001',
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function writeMap(
  scope: Parameters<typeof buildStorageKey>[0],
  map: Record<string, unknown>,
): void {
  localStorage.setItem(intentKey(scope), JSON.stringify(map));
}

function writeRaw(scope: Parameters<typeof buildStorageKey>[0], raw: string): void {
  localStorage.setItem(intentKey(scope), raw);
}

beforeEach(() => {
  localStorage.clear();
  resetStorageScopeForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  resetStorageScopeForTests();
});

describe('01P4C — originweite Intent-Inspektion', () => {
  it('L8: ein Intent unter einem fremden Scope wird gefunden', () => {
    // Aktiver Scope ist guest; der Intent liegt unter einem Workspace-Schlüssel.
    const intent = buildIntent();
    writeMap({ type: 'workspace', workspaceId: WORKSPACE_A }, { [VORGANG_A]: intent });
    writeMap({ type: 'user', userId: 'u-fremd' }, { 'vg-c-2': buildIntent({ vorgangId: 'vg-c-2', clientInvoiceId: 'inv-c-0002' }) });
    localStorage.setItem('officepilot-state:workspace:ws-c-a', '{"unrelated":true}');

    const result = inspectInvoiceFinalizeIntentsForOrigin();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    expect(result.entries.length).toBe(2);
    const found = result.entries.find((entry) => entry.mapKey === VORGANG_A);
    expect(found?.intent).toEqual(intent);
    expect(found?.storageKey).toBe(intentKey({ type: 'workspace', workspaceId: WORKSPACE_A }));
    expect(found?.unknownFields).toEqual([]);

    // Der Schlüsselerkenner bleibt kanonisch.
    expect(isInvoiceFinalizeIntentStorageKey(found!.storageKey)).toBe(true);
    expect(isInvoiceFinalizeIntentStorageKey('officepilot-state:workspace:ws-c-a')).toBe(false);
    expect(isInvoiceFinalizeIntentStorageKey('fremd:invoice-finalize-intents')).toBe(false);
  });

  it('L9: beschädigte oder teilweise gültige Speicher blockieren originweit', () => {
    const cases: [string, () => void][] = [
      [
        'kaputtes JSON',
        () => writeRaw({ type: 'workspace', workspaceId: WORKSPACE_A }, '{ kein json'),
      ],
      [
        'Wurzel ist ein Feld',
        () => writeRaw({ type: 'workspace', workspaceId: WORKSPACE_A }, '[]'),
      ],
      ['Wurzel ist null', () => writeRaw({ type: 'workspace', workspaceId: WORKSPACE_A }, 'null')],
      [
        'Eintrag ist kein Objekt',
        () => writeMap({ type: 'workspace', workspaceId: WORKSPACE_A }, { [VORGANG_A]: 'text' }),
      ],
      [
        'mapKey passt nicht zur vorgangId',
        () =>
          writeMap(
            { type: 'workspace', workspaceId: WORKSPACE_A },
            { 'vg-anders': buildIntent() },
          ),
      ],
      [
        'leere workspaceId',
        () =>
          writeMap(
            { type: 'workspace', workspaceId: WORKSPACE_A },
            { [VORGANG_A]: buildIntent({ workspaceId: '' }) },
          ),
      ],
      [
        'leere clientInvoiceId',
        () =>
          writeMap(
            { type: 'workspace', workspaceId: WORKSPACE_A },
            { [VORGANG_A]: buildIntent({ clientInvoiceId: '' }) },
          ),
      ],
      [
        'leerer Fingerprint',
        () =>
          writeMap(
            { type: 'workspace', workspaceId: WORKSPACE_A },
            { [VORGANG_A]: buildIntent({ contentFingerprint: '' }) },
          ),
      ],
      [
        'ungültiges createdAt',
        () =>
          writeMap(
            { type: 'workspace', workspaceId: WORKSPACE_A },
            { [VORGANG_A]: buildIntent({ createdAt: 'gestern' }) },
          ),
      ],
      [
        'teilweise gültige Karte',
        () =>
          writeMap(
            { type: 'workspace', workspaceId: WORKSPACE_A },
            { [VORGANG_A]: buildIntent(), 'vg-c-3': { workspaceId: WORKSPACE_A } },
          ),
      ],
      [
        'widersprüchliche doppelte clientInvoiceId',
        () =>
          writeMap(
            { type: 'workspace', workspaceId: WORKSPACE_A },
            {
              [VORGANG_A]: buildIntent(),
              'vg-c-4': buildIntent({ vorgangId: 'vg-c-4', contentFingerprint: 'fp-anders' }),
            },
          ),
      ],
      [
        'Prototypenschlüssel in der Wurzel',
        () =>
          // Bewusst als Rohtext: ein Objektliteral würde `__proto__` verschlucken.
          writeRaw(
            { type: 'workspace', workspaceId: WORKSPACE_A },
            `{"__proto__":{"polluted":true},"${VORGANG_A}":${JSON.stringify(buildIntent())}}`,
          ),
      ],
      [
        'Prototypenschlüssel im Eintrag',
        () =>
          writeRaw(
            { type: 'workspace', workspaceId: WORKSPACE_A },
            `{"${VORGANG_A}":${JSON.stringify({ ...buildIntent(), constructor: 'x' })}}`,
          ),
      ],
    ];

    for (const [label, seed] of cases) {
      localStorage.clear();
      seed();
      const result = inspectInvoiceFinalizeIntentsForOrigin();
      expect(result.ok, label).toBe(false);
      if (!result.ok) expect(result.reason, label).toBe('corrupt');

      // Nichts wurde repariert, ersetzt oder gelöscht.
      expect(localStorage.getItem(intentKey({ type: 'workspace', workspaceId: WORKSPACE_A })))
        .not.toBeNull();
    }
  });

  it('L10: eine Änderung während des Scans liefert scan_changed', () => {
    writeMap({ type: 'workspace', workspaceId: WORKSPACE_A }, { [VORGANG_A]: buildIntent() });

    const original = localStorage.getItem.bind(localStorage);
    let injected = false;
    vi.spyOn(localStorage, 'getItem').mockImplementation((key: string) => {
      const value = original(key);
      if (!injected && isInvoiceFinalizeIntentStorageKey(key)) {
        injected = true;
        // Ein Fremd-Tab schreibt zwischen erstem und zweitem Lesen.
        localStorage.setItem(
          `${buildStorageKey({ type: 'user', userId: 'u-neu' })}${INVOICE_FINALIZE_INTENT_STORAGE_SUFFIX}`,
          JSON.stringify({
            'vg-c-9': buildIntent({ vorgangId: 'vg-c-9', clientInvoiceId: 'inv-c-9' }),
          }),
        );
      }
      return value;
    });

    const result = inspectInvoiceFinalizeIntentsForOrigin();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('scan_changed');
  });

  it('L10b: ein werfender Speicher liefert scan_failed und niemals „keine Intents"', () => {
    writeMap({ type: 'workspace', workspaceId: WORKSPACE_A }, { [VORGANG_A]: buildIntent() });
    const failing = vi.spyOn(localStorage, 'key').mockImplementation(() => {
      throw new Error('simulierter Speicherfehler');
    });

    const result = inspectInvoiceFinalizeIntentsForOrigin();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('scan_failed');
    failing.mockRestore();
  });

  it('L16a: identische Kopien und unbekannte Felder werden toleriert und gemeldet', () => {
    const intent = buildIntent();
    writeMap({ type: 'workspace', workspaceId: WORKSPACE_A }, { [VORGANG_A]: intent });
    writeMap({ type: 'guest' }, { [VORGANG_A]: intent });
    writeMap(
      { type: 'workspace', workspaceId: WORKSPACE_B },
      {
        'vg-c-5': {
          ...buildIntent({ vorgangId: 'vg-c-5', clientInvoiceId: 'inv-c-0005' }),
          legacyExtra: 'alt',
        },
      },
    );

    const result = inspectInvoiceFinalizeIntentsForOrigin();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    expect(result.entries.length).toBe(3);
    const extra = result.entries.find((entry) => entry.mapKey === 'vg-c-5');
    expect(extra?.unknownFields).toEqual(['legacyExtra']);
    expect(result.warnings.some((warning) => warning.includes('legacyExtra'))).toBe(true);
    // Zwei bytegleiche Kopien sind kein Widerspruch.
    expect(result.entries.filter((entry) => entry.intent.clientInvoiceId === CLIENT_A).length).toBe(
      2,
    );
  });

  it('L20a: die Inspektion schreibt, löscht und repariert nichts', () => {
    writeMap({ type: 'workspace', workspaceId: WORKSPACE_A }, { [VORGANG_A]: buildIntent() });
    const before = localStorage.getItem(
      intentKey({ type: 'workspace', workspaceId: WORKSPACE_A }),
    );

    const setItem = vi.spyOn(localStorage, 'setItem');
    const removeItem = vi.spyOn(localStorage, 'removeItem');
    const clear = vi.spyOn(localStorage, 'clear');

    const result = inspectInvoiceFinalizeIntentsForOrigin();
    expect(result.ok).toBe(true);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(localStorage.getItem(intentKey({ type: 'workspace', workspaceId: WORKSPACE_A }))).toBe(
      before,
    );
  });
});
