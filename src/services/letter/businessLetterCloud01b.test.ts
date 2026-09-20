/**
 * BRIEFE-01B — der Datenkern muss die Cloud überstehen.
 *
 * Geprüft wird genau das, was ohne Oberfläche sonst niemand sehen würde: Bleibt
 * ein Brief nach dem Abgleich erhalten, überschreiben sich zwei Briefe nicht,
 * hält eine Löschung, und fügt sich der neue Typ in den Wiederanlauf aus 01G
 * ein, statt ihn aufzuweichen.
 *
 * Neutrale Beispieldaten.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { BusinessLetter } from '../../types/businessLetter';
import type { SyncMeta } from '../../types/sync';
import {
  buildBusinessLetterCloudContentKey,
  buildBusinessLetterCloudPushPayload,
  mergeBusinessLettersFromPull,
  planBusinessLetterBackfill,
  planBusinessLetterLostAckAdoption,
  stripBusinessLetterForCloud,
  type WorkspaceBusinessLetterRow,
} from './businessLetterCloudService';
import {
  addBusinessLetter,
  deleteBusinessLetter,
  finalizeBusinessLetter,
  getBusinessLetterById,
  listBusinessLetters,
  resetBusinessLetters,
  setBusinessLetterStoreForTests,
  updateBusinessLetter,
} from '../businessLetterService';
import { hydrateCompanyProfileStore, resetCompanyProfile } from '../companyProfileService';
import { createCompanyProfileFromSetup } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { isSupabaseSyncAllowed } from '../sync/cloudSyncAllowlist';

const WORKSPACE = 'ws-letter';
const DEVICE = 'device-letter';
const UPDATED_AT = '2026-09-19T09:00:00.000Z';

function syncMeta(version: number, overrides: Partial<SyncMeta> = {}): SyncMeta {
  return {
    updatedAt: UPDATED_AT,
    version,
    deleted: false,
    deviceId: DEVICE,
    workspaceId: WORKSPACE,
    ...overrides,
  };
}

function letter(overrides: Partial<BusinessLetter> = {}): BusinessLetter {
  return {
    id: 'letter-1',
    workspaceId: WORKSPACE,
    subject: 'Terminbestätigung',
    body: 'Die Arbeiten beginnen am Montag.',
    letterDate: '2026-09-19',
    recipient: {
      name: 'Herr Mueller',
      street: 'Musterweg 1',
      zip: '33602',
      city: 'Bielefeld',
    },
    status: 'draft',
    createdAt: '2026-09-19T08:00:00.000Z',
    ...overrides,
  };
}

function row(base: BusinessLetter, rowVersion: number, deleted = false): WorkspaceBusinessLetterRow {
  return {
    workspace_id: WORKSPACE,
    client_letter_id: base.id,
    client_customer_id: base.customerId ?? null,
    client_vorgang_id: base.vorgangId ?? null,
    status: base.status,
    payload: deleted
      ? {}
      : (stripBusinessLetterForCloud(base) as unknown as Record<string, unknown>),
    row_version: rowVersion,
    deleted,
    deleted_at: deleted ? UPDATED_AT : null,
    updated_at: UPDATED_AT,
  };
}

describe('01B — der Brief übersteht den Abgleich', () => {
  beforeEach(() => {
    localStorage.clear();
    resetBusinessLetters();
    resetCompanyProfile();
  });

  it('A — der neue Typ ist für die Cloud freigegeben', () => {
    expect(isSupabaseSyncAllowed('business_letter')).toBe(true);
  });

  it('B — ein Brief aus der Cloud kommt vollständig an', () => {
    const remote = letter({ customerId: 'cust-1' });
    const merged = mergeBusinessLettersFromPull([], [row(remote, 1)], DEVICE, WORKSPACE);

    expect(merged.conflicts).toEqual([]);
    expect(merged.letters).toHaveLength(1);
    expect(merged.letters[0]?.subject).toBe('Terminbestätigung');
    expect(merged.letters[0]?.recipient.city).toBe('Bielefeld');
    expect(merged.letters[0]?.customerId).toBe('cust-1');
    expect(merged.letters[0]?.sync?.version, 'die bestätigte Serverversion').toBe(1);
  });

  it('C — zwei Briefe überschreiben einander nicht', () => {
    const a = { ...letter({ id: 'letter-a', subject: 'Erster' }), sync: syncMeta(1) };
    const b = letter({ id: 'letter-b', subject: 'Zweiter' });

    const merged = mergeBusinessLettersFromPull([a], [row(a, 1), row(b, 1)], DEVICE, WORKSPACE);

    expect(merged.letters).toHaveLength(2);
    expect(merged.letters.find((l) => l.id === 'letter-a')?.subject).toBe('Erster');
    expect(merged.letters.find((l) => l.id === 'letter-b')?.subject).toBe('Zweiter');
  });

  it('D — eine ungesendete Änderung wird nicht stillschweigend ersetzt', () => {
    /*
     * 01G — der Kern des Versionsvertrags: Die lokale Fassung ist geändert,
     * aber noch nicht bestätigt. Eine neuere Serverfassung mit anderem Inhalt
     * darf sie nicht überschreiben.
     */
    const local = { ...letter({ body: 'Mein neuer Text.' }), sync: syncMeta(1) };
    const remote = letter({ body: 'Fremder Text.' });

    const merged = mergeBusinessLettersFromPull(
      [local],
      [row(remote, 2)],
      DEVICE,
      WORKSPACE,
      new Set([local.id]),
    );

    expect(merged.conflicts).toEqual([`business_letter:${local.id}`]);
    expect(merged.letters[0]?.body, 'die eigene Arbeit bleibt').toBe('Mein neuer Text.');
  });

  it('E — eine Löschung wird nicht wiederbelebt', () => {
    const local = { ...letter(), sync: syncMeta(1) };
    const merged = mergeBusinessLettersFromPull(
      [local],
      [row(local, 2, true)],
      DEVICE,
      WORKSPACE,
    );

    expect(merged.letters, 'der Brief ist fort').toHaveLength(0);
  });

  it('E2 — ein lokaler Löschwunsch weicht keiner aktiven Serverfassung', () => {
    const local = { ...letter(), sync: syncMeta(1, { deleted: true }) };
    const merged = mergeBusinessLettersFromPull([local], [row(letter(), 1)], DEVICE, WORKSPACE);

    expect(merged.letters[0]?.sync?.deleted, 'der Löschwunsch bleibt').toBe(true);
  });

  it('F — der Abschlusszustand reist mit', () => {
    const finalized = letter({ status: 'finalized' });
    const merged = mergeBusinessLettersFromPull([], [row(finalized, 3)], DEVICE, WORKSPACE);
    expect(merged.letters[0]?.status).toBe('finalized');
  });

  it('G — der Wiederanlauf aus 01G gilt auch für Briefe', () => {
    /*
     * Anlegen, Bestätigung verloren, danach weitergearbeitet. Die unberührte
     * Erstzeile beweist, dass der Server seither nichts anderes gesehen hat —
     * also ist es der eigene Schreibvorgang.
     */
    const local = { ...letter({ body: 'Zweitfassung nach Funkloch.' }), sync: syncMeta(0) };
    const plan = planBusinessLetterLostAckAdoption(
      [local],
      [row(letter({ body: 'Erstfassung.' }), 1)],
      new Set([local.id]),
    );

    expect(plan.adopt).toEqual([local.id]);
    expect(plan.baseVersions.get(local.id)).toBe(1);
  });

  it('G2 — ein nie angekommener Anlegevorgang wird wieder sendbar (01G7)', () => {
    const local = { ...letter(), sync: syncMeta(0) };
    const plan = planBusinessLetterLostAckAdoption(
      [local],
      [],
      new Set([local.id]),
      new Map([[local.id, { contentKey: buildBusinessLetterCloudContentKey(local), deleted: false }]]),
    );

    expect(plan.notAccepted, 'ohne Serverzeile ist nichts angekommen').toEqual([local.id]);
    expect(plan.baseVersions.get(local.id), 'die Basis bleibt unbestätigt').toBe(0);
  });

  it('G3 — eine fremde neuere Fassung bleibt ein Streitfall', () => {
    const meine = { ...letter({ body: 'Meine Fassung.' }), sync: syncMeta(1) };
    const plan = planBusinessLetterLostAckAdoption(
      [meine],
      [row(letter({ body: 'Fremde Fassung.' }), 2)],
      new Set([meine.id]),
      new Map([[meine.id, { contentKey: buildBusinessLetterCloudContentKey(meine), deleted: false }]]),
    );

    expect(plan.adopt).toEqual([]);
    expect(plan.settle).toEqual([]);
    expect(plan.notAccepted).toEqual([]);
  });

  it('H — Altbestand wird nur nachgemeldet, wenn er dem Server fehlt', () => {
    const bekannt = { ...letter({ id: 'letter-a' }), sync: syncMeta(1) };
    const neu = letter({ id: 'letter-b' });
    const geloescht = { ...letter({ id: 'letter-c' }), sync: syncMeta(1, { deleted: true }) };

    const plan = planBusinessLetterBackfill([bekannt, neu, geloescht], [row(bekannt, 1)]);
    expect(plan).toEqual(['letter-b']);
  });

  it('I — die Versandform trägt Bezug und Grabstein', () => {
    const mitBezug = letter({ customerId: 'cust-1', vorgangId: 'v-1' });
    const payload = buildBusinessLetterCloudPushPayload(mitBezug, true);
    expect(payload.letter_id).toBe('letter-1');
    expect(payload.customer_id).toBe('cust-1');
    expect(payload.vorgang_id).toBe('v-1');
    expect(payload.deleted).toBe(true);
  });
});

describe('01B — der fachliche Kern', () => {
  beforeEach(() => {
    localStorage.clear();
    resetBusinessLetters();
    resetCompanyProfile();
    hydrateCompanyProfileStore(createCompanyProfileFromSetup(DEFAULT_SETUP));
  });

  it('J — anlegen, ändern, fertigstellen', () => {
    const angelegt = addBusinessLetter(WORKSPACE, {
      subject: 'Terminbestätigung',
      body: 'Wir beginnen am Montag.',
      recipient: { name: 'Herr Mueller', street: 'Weg 1', zip: '33602', city: 'Bielefeld' },
    });
    expect(angelegt.success).toBe(true);
    const id = angelegt.success ? angelegt.letter.id : '';

    expect(
      angelegt.success ? angelegt.letter.sync : undefined,
      'ein neuer Brief behauptet keine bestätigte Version',
    ).toBeUndefined();

    const geaendert = updateBusinessLetter(id, { body: 'Wir beginnen am Dienstag.' });
    expect(geaendert.success).toBe(true);
    expect(getBusinessLetterById(id)?.body).toBe('Wir beginnen am Dienstag.');

    const fertig = finalizeBusinessLetter(id);
    expect(fertig.success).toBe(true);
    expect(getBusinessLetterById(id)?.status).toBe('finalized');
    expect(
      getBusinessLetterById(id)?.companySnapshot,
      'die Absenderdaten sind eingefroren',
    ).toBeTruthy();
  });

  it('K — ein fertiggestellter Brief wird nicht mehr umgeschrieben', () => {
    const angelegt = addBusinessLetter(WORKSPACE, {
      subject: 'Kündigung',
      body: 'Hiermit kündigen wir.',
      recipient: { name: 'Firma X', street: 'Weg 2', zip: '33602', city: 'Bielefeld' },
    });
    const id = angelegt.success ? angelegt.letter.id : '';
    finalizeBusinessLetter(id);

    const versuch = updateBusinessLetter(id, { body: 'Doch nicht.' });
    expect(versuch.success).toBe(false);
    expect(versuch.success === false ? versuch.errorKey : '').toBe(
      'businessLetter.finalizedImmutable',
    );
    expect(getBusinessLetterById(id)?.body, 'der Beleg bleibt').toBe('Hiermit kündigen wir.');
  });

  it('L — zwei Briefe bestehen unabhängig nebeneinander', () => {
    addBusinessLetter(WORKSPACE, {
      subject: 'Erster',
      body: 'Text eins.',
      recipient: { name: 'A', street: 'W 1', zip: '1', city: 'O' },
    });
    addBusinessLetter(WORKSPACE, {
      subject: 'Zweiter',
      body: 'Text zwei.',
      recipient: { name: 'B', street: 'W 2', zip: '2', city: 'O' },
    });

    const alle = listBusinessLetters();
    expect(alle).toHaveLength(2);
    expect(new Set(alle.map((l) => l.id)).size, 'unterschiedliche Kennungen').toBe(2);
  });

  it('M — die Löschung erhöht die bestätigte Version nicht', () => {
    /*
     * TOMBSTONE-VERSION-CONTRACT-02 — der Grabstein ist eine lokale Änderung.
     * Ein selbst erhöhter Wert würde vom Serververtrag abgewiesen, und die
     * Löschung käme auf dem zweiten Gerät nie an.
     */
    setBusinessLetterStoreForTests([{ ...letter(), sync: syncMeta(4) }]);
    const geloescht = deleteBusinessLetter('letter-1');

    expect(geloescht.success).toBe(true);
    const sync = geloescht.success ? geloescht.letter.sync : undefined;
    expect(sync?.deleted).toBe(true);
    expect(sync?.version, 'die bestätigte Version bleibt stehen').toBe(4);
    expect(listBusinessLetters(), 'aus der Liste verschwunden').toHaveLength(0);
  });
});
