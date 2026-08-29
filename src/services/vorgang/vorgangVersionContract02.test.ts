/**
 * SYNC-VERSION-CONTRACT-02 — `sync.version` ist die bekannte Serverversion.
 *
 * Bisher diente dasselbe Feld drei Zwecken: lokale Revision, zuletzt bekannte
 * `row_version` und erwartete Serverversion beim Push. Jede lokale Änderung
 * erhöhte es, der Push sendete den erhöhten Wert — die RPC verlangt aber die
 * Version, die **aktuell auf dem Server steht**. Ergebnis: Jeder Vorgang, der
 * nach einem erfolgreichen Push lokal geändert wurde, lief dauerhaft in einen
 * Versionskonflikt.
 *
 * Real belegt: Remote `row_version = 1`, lokal nach einer Statusänderung 2,
 * Push sendete 2 → `Versionskonflikt` → Outbox `blocked`.
 *
 * Zwei Regeln stellen den Vertrag her:
 *   1. Lokale Fachänderungen lassen `sync.version` unberührt.
 *   2. Der Pull entscheidet **dirty-bewusst**: Ein sauberer lokaler Stand
 *      übernimmt eine neuere Remote-Fassung, ein ungesendeter meldet Konflikt.
 *
 * Regel 2 behebt zugleich einen zweiten, bisher unbemerkten Fehler: Ein
 * Vorgang, den ein Gerät bereits kennt, übernahm **nie** die Änderung eines
 * anderen Geräts — jede Versionsabweichung galt als Konflikt.
 *
 * Neutrale Beispieldaten.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyVorgangPushResultToState,
  mergeCloudVorgangIntoLocal,
  mergeVorgaengeFromPull,
  stripVorgangForCloud,
  type WorkspaceVorgangRow,
} from './vorgangCloudService';
import {
  commitVorgangMutation,
  getVorgangById,
  hydrateVorgangStore,
} from '../vorgangService';
import { createTestVorgang } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import type { SyncMeta } from '../../types/sync';
import type { Vorgang } from '../../types/models';

const DEVICE = 'device-version-02';
const WORKSPACE = 'ws-version-02';
const ID = 'v-version-02';

function syncMeta(version: number): SyncMeta {
  return {
    updatedAt: '2026-08-29T09:00:00.000Z',
    version,
    deleted: false,
    deviceId: DEVICE,
    workspaceId: WORKSPACE,
  };
}

function vorgang(version: number | undefined, overrides: Partial<Vorgang> = {}): Vorgang {
  const base = createTestVorgang({ id: ID, title: 'Beispielauftrag', ...overrides });
  return version === undefined ? { ...base, sync: undefined } : { ...base, sync: syncMeta(version) };
}

function row(source: Vorgang, rowVersion: number): WorkspaceVorgangRow {
  return {
    workspace_id: WORKSPACE,
    vorgang_id: source.id,
    payload: stripVorgangForCloud(source) as unknown as Record<string, unknown>,
    row_version: rowVersion,
    deleted: false,
    deleted_at: null,
    updated_at: '2026-08-29T09:00:00.000Z',
    updated_by: 'other-device',
  };
}

/** Der Wert, den `extractCloudSyncEntity` als `p_row_version` senden würde. */
function expectedPushVersion(id: string): number {
  return getVorgangById(id)?.sync?.version ?? 0;
}

describe('SYNC-VERSION-CONTRACT-02 — lokale Änderungen', () => {
  beforeEach(() => {
    resetTestStores();
  });

  it('1: ein nie synchronisierter Vorgang trägt keine bestätigte Serverversion', () => {
    /*
     * Vor dem ersten erfolgreichen Push gibt es keine `row_version`, die der
     * Client kennen könnte. Eine künstliche 1 würde behaupten, der Server habe
     * bereits bestätigt — und könnte eine fremde Zeile als gültige Basis
     * missdeuten.
     */
    hydrateVorgangStore([vorgang(undefined)]);
    expect(expectedPushVersion(ID)).toBe(0);
  });

  it('2: nach erfolgreichem Push gilt die Serverversion', () => {
    const applied = applyVorgangPushResultToState(
      [vorgang(undefined)],
      ID,
      1,
      '2026-08-29T10:00:00.000Z',
      false,
      DEVICE,
      WORKSPACE,
    );
    expect(applied[0]!.sync?.version).toBe(1);
  });

  it('3: eine lokale Fachänderung lässt die Version unberührt', () => {
    hydrateVorgangStore([vorgang(1)]);
    const committed = commitVorgangMutation(ID, (current) => ({ ...current, title: 'Neu' }));
    expect(committed.ok).toBe(true);
    expect(expectedPushVersion(ID)).toBe(1);
    expect(getVorgangById(ID)?.title).toBe('Neu');
  });

  it('4: drei lokale Änderungen ändern die Version nicht', () => {
    hydrateVorgangStore([vorgang(1)]);
    for (const title of ['A', 'B', 'C']) {
      expect(commitVorgangMutation(ID, (current) => ({ ...current, title })).ok).toBe(true);
    }
    expect(expectedPushVersion(ID)).toBe(1);
    expect(getVorgangById(ID)?.title).toBe('C');
  });

  it('5: zehn lokale Änderungen auf Version 5 bleiben bei 5', () => {
    hydrateVorgangStore([vorgang(5)]);
    for (let index = 0; index < 10; index += 1) {
      expect(
        commitVorgangMutation(ID, (current) => ({ ...current, baustelle: `Weg ${index}` })).ok,
      ).toBe(true);
    }
    expect(expectedPushVersion(ID)).toBe(5);
    expect(getVorgangById(ID)?.baustelle).toBe('Weg 9');
    // Die übrigen Sync-Metadaten bleiben erhalten, nichts wird gelöscht.
    expect(getVorgangById(ID)?.sync?.workspaceId).toBe(WORKSPACE);
  });
});

describe('SYNC-VERSION-CONTRACT-02 — Pull-Merge', () => {
  beforeEach(() => {
    resetTestStores();
  });

  function merge(
    local: Vorgang,
    remote: Vorgang,
    remoteVersion: number,
    dirty: boolean,
  ): ReturnType<typeof mergeVorgaengeFromPull> {
    return mergeVorgaengeFromPull([local], [row(remote, remoteVersion)], DEVICE, WORKSPACE, {
      dirtyVorgangIds: dirty ? new Set([local.id]) : new Set<string>(),
    });
  }

  it('A: sauber, gleiche Version — kein Konflikt', () => {
    const result = merge(vorgang(1), vorgang(1), 1, false);
    expect(result.conflicts).toEqual([]);
    expect(result.vorgaenge[0]!.sync?.version).toBe(1);
  });

  it('B: ungesendet, gleiche Version — lokale Änderung bleibt', () => {
    const local = vorgang(1, { title: 'Lokal geändert' });
    const result = merge(local, vorgang(1, { title: 'Alt aus der Cloud' }), 1, true);
    expect(result.conflicts).toEqual([]);
    expect(result.vorgaenge[0]!.title).toBe('Lokal geändert');
  });

  it('C: ungesendet, Remote neuer — echter Konflikt, lokal bleibt', () => {
    const local = vorgang(1, { title: 'Lokal geändert' });
    const result = merge(local, vorgang(2, { title: 'Fremd geändert' }), 2, true);
    expect(result.conflicts).toEqual([`vorgang:${ID}`]);
    expect(result.vorgaenge[0]!.title).toBe('Lokal geändert');
    expect(result.vorgaenge[0]!.sync?.version).toBe(1);
  });

  it('D: sauber, Remote neuer — Remote wird übernommen', () => {
    /*
     * Bisher meldete auch dieser Fall einen Konflikt. Damit erreichte eine
     * Änderung von Gerät A niemals ein Gerät B, das den Vorgang schon kannte.
     */
    const result = merge(vorgang(1), vorgang(2, { title: 'Fremd geändert' }), 2, false);
    expect(result.conflicts).toEqual([]);
    expect(result.vorgaenge[0]!.title).toBe('Fremd geändert');
    expect(result.vorgaenge[0]!.sync?.version).toBe(2);
  });

  it('E: Legacy — lokale Version höher als Remote wird nicht still übernommen', () => {
    /*
     * Bestand aus der alten Bump-Semantik. Ob der lokale Vorsprung echt oder
     * nur Buchhaltung ist, kann der Code nicht entscheiden — also kein
     * automatisches Überschreiben. Die Bereinigung ist ein eigener Schritt.
     */
    const local = vorgang(2, { title: 'Lokal' });
    const result = merge(local, vorgang(1, { title: 'Remote' }), 1, false);
    expect(result.vorgaenge[0]!.title).toBe('Lokal');
    expect(result.vorgaenge[0]!.sync?.version).toBe(2);
  });

  it('F: ein lokal neuer, ungesendeter Vorgang wird von einer Remote-Zeile nicht überschrieben', () => {
    const local = vorgang(undefined, { title: 'Lokal neu' });
    const result = merge(local, vorgang(1, { title: 'Remote' }), 1, true);
    expect(result.vorgaenge[0]!.title).toBe('Lokal neu');
  });

  it('G: ohne Dirty-Angabe bleibt das bisherige, vorsichtige Verhalten', () => {
    // Aufrufer ohne Kenntnis des Zustands dürfen nichts stillschweigend verlieren.
    const result = mergeVorgaengeFromPull(
      [vorgang(1, { title: 'Lokal' })],
      [row(vorgang(2, { title: 'Remote' }), 2)],
      DEVICE,
      WORKSPACE,
    );
    expect(result.conflicts).toEqual([`vorgang:${ID}`]);
    expect(result.vorgaenge[0]!.title).toBe('Lokal');
  });

  it('H: der Zwei-Client-Konflikt wird erkannt', () => {
    /*
     * A und B stehen auf 3. A pusht erfolgreich, remote wird 4. B hat eine
     * eigene Änderung und erwartet weiterhin 3 — der Push muss scheitern.
     */
    hydrateVorgangStore([vorgang(3)]);
    expect(commitVorgangMutation(ID, (current) => ({ ...current, title: 'B' })).ok).toBe(true);
    expect(expectedPushVersion(ID)).toBe(3);

    const pulled = merge(getVorgangById(ID)!, vorgang(4, { title: 'A' }), 4, true);
    expect(pulled.conflicts).toEqual([`vorgang:${ID}`]);
    expect(pulled.vorgaenge[0]!.title).toBe('B');
  });

  it('I: nach erfolgreichem Push im selben Lauf gilt der Vorgang als sauber', () => {
    /*
     * Der Push setzt die Version auf 2 und markiert seinen Outbox-Eintrag als
     * abgeschlossen. Der anschliessende Pull derselben Zeile darf daraus keinen
     * Dirty-Konflikt machen — sonst läse er einen überholten Zustand.
     */
    const pushed = applyVorgangPushResultToState(
      [vorgang(1, { title: 'Lokal' })],
      ID,
      2,
      '2026-08-29T10:00:00.000Z',
      false,
      DEVICE,
      WORKSPACE,
    );
    const result = mergeVorgaengeFromPull(
      pushed,
      [row(vorgang(2, { title: 'Lokal' }), 2)],
      DEVICE,
      WORKSPACE,
      { dirtyVorgangIds: new Set<string>() },
    );
    expect(result.conflicts).toEqual([]);
    expect(result.vorgaenge[0]!.sync?.version).toBe(2);
  });

  it('J: der Einzel-Merge trägt dieselbe Entscheidung', () => {
    const clean = mergeCloudVorgangIntoLocal(
      vorgang(1),
      stripVorgangForCloud(vorgang(2, { title: 'Remote' })),
      2,
      '2026-08-29T09:00:00.000Z',
      false,
      DEVICE,
      WORKSPACE,
      { dirty: false },
    );
    expect(clean.conflict).toBe(false);
    expect(clean.vorgang?.title).toBe('Remote');

    const dirty = mergeCloudVorgangIntoLocal(
      vorgang(1, { title: 'Lokal' }),
      stripVorgangForCloud(vorgang(2, { title: 'Remote' })),
      2,
      '2026-08-29T09:00:00.000Z',
      false,
      DEVICE,
      WORKSPACE,
      { dirty: true },
    );
    expect(dirty.conflict).toBe(true);
    expect(dirty.vorgang?.title).toBe('Lokal');
  });
});
