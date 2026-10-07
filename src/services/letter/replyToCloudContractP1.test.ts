/**
 * P1 EINGANGSSCHREIBEN Phase 1 — S: der Cloud-Vertrag für Client B.
 *
 *  Brief `replyTo`:
 *   - reist im Payload, wird gepullt und landet am Brief des zweiten Geräts
 *   - zählt im Inhaltsschlüssel (Änderungs- und Konflikterkennung)
 *   - ein Brief ohne Herkunft behält exakt seinen bisherigen Schlüssel (kein Schein-Versand)
 *   - ungültige Werte fallen weg; der Dienst schreibt die Herkunft beim Ändern nicht um
 *  Kommunikationsereignis `answerRef`:
 *   - reist im Payload und wird gepullt; ungültige Werte fallen weg
 *   - ein Ereignis ohne Nachweis behält seinen bisherigen Schlüssel
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { BusinessLetter } from '../../types/businessLetter';
import type { CommunicationEvent } from '../../types/communicationHistory';
import { resetTestStores } from '../../test/resetStores';
import {
  buildBusinessLetterCloudContentKey,
  buildBusinessLetterCloudPushPayload,
  mergeBusinessLettersFromPull,
  parseBusinessLetterCloudPayload,
  stripBusinessLetterForCloud,
  type WorkspaceBusinessLetterRow,
} from './businessLetterCloudService';
import {
  addBusinessLetter,
  hydrateBusinessLetters,
  listBusinessLetters,
  updateBusinessLetter,
} from '../businessLetterService';
import {
  buildCommunicationEventCloudContentKey,
  buildCommunicationEventCloudPushPayload,
  parseCommunicationEventCloudPayload,
  stripCommunicationEventForCloud,
} from '../communication/communicationEventCloudService';

const WS = 'ws-p1-sync';

function brief(overrides: Partial<BusinessLetter> = {}): BusinessLetter {
  return {
    id: 'letter-p1',
    workspaceId: WS,
    subject: 'Ihr Schreiben vom 05.10.2026 – Anhörung',
    body: 'Wir nehmen Stellung.',
    letterDate: '2026-10-07',
    recipient: { name: 'Bauamt Musterstadt', street: 'Amtsweg 1', zip: '33602', city: 'Bielefeld' },
    status: 'draft',
    createdAt: '2026-10-07T10:00:00.000Z',
    ...overrides,
  };
}

function row(payload: Record<string, unknown>, rowVersion = 3): WorkspaceBusinessLetterRow {
  return {
    workspace_id: WS,
    client_letter_id: String(payload.id),
    client_customer_id: null,
    client_vorgang_id: null,
    status: 'draft',
    payload,
    row_version: rowVersion,
    deleted: false,
    deleted_at: null,
    updated_at: '2026-10-07T10:05:00.000Z',
  };
}

beforeEach(() => {
  resetTestStores();
});

describe('P1 — S: Brief replyTo im Cloud-Vertrag', () => {
  it('reist im Payload, wird gepullt und landet am Brief von Gerät B', () => {
    const mitHerkunft = brief({ replyTo: { type: 'inbox', id: 'inbox-upload-1' } });
    const push = buildBusinessLetterCloudPushPayload(mitHerkunft);
    expect((push.payload as Record<string, unknown>).replyTo).toEqual({ type: 'inbox', id: 'inbox-upload-1' });

    const parsed = parseBusinessLetterCloudPayload(push.payload as Record<string, unknown>);
    expect(parsed?.replyTo).toEqual({ type: 'inbox', id: 'inbox-upload-1' });

    // Gerät B: kein lokaler Brief — der gepullte Brief trägt die Herkunft.
    const { letters, conflicts } = mergeBusinessLettersFromPull([], [row(push.payload as Record<string, unknown>)], 'device-b', WS);
    expect(conflicts).toEqual([]);
    expect(letters[0]?.replyTo).toEqual({ type: 'inbox', id: 'inbox-upload-1' });
  });

  it('zählt im Inhaltsschlüssel; ein Brief ohne Herkunft behält seinen bisherigen Schlüssel', () => {
    const ohne = brief();
    const mit = brief({ replyTo: { type: 'document', id: 'doc-1' } });
    expect(buildBusinessLetterCloudContentKey(mit)).not.toBe(buildBusinessLetterCloudContentKey(ohne));
    expect(buildBusinessLetterCloudContentKey(ohne)).not.toContain('replyTo');
    expect(Object.keys(stripBusinessLetterForCloud(ohne))).not.toContain('replyTo');
  });

  it('ungültige Herkunft fällt weg — beim Senden wie beim Lesen', () => {
    const kaputt = brief({ replyTo: { type: 'vorgang', id: 'v-1' } as never });
    expect(stripBusinessLetterForCloud(kaputt).replyTo).toBeUndefined();
    expect(parseBusinessLetterCloudPayload({ ...stripBusinessLetterForCloud(brief()), replyTo: { type: 'inbox', id: '  ' } })?.replyTo).toBeUndefined();
  });

  it('der Dienst übernimmt die Herkunft beim Anlegen und schreibt sie beim Ändern nicht um', () => {
    const angelegt = addBusinessLetter(WS, {
      subject: 'Ihr Schreiben – Anhörung',
      body: 'Text',
      recipient: { name: 'Bauamt', street: '', zip: '', city: '' },
      replyTo: { type: 'inbox', id: 'inbox-upload-7' },
    });
    expect(angelegt.success).toBe(true);
    if (!angelegt.success) return;
    const geaendert = updateBusinessLetter(angelegt.letter.id, {
      subject: 'Neuer Betreff',
      replyTo: { type: 'document', id: 'doc-anders' },
    });
    expect(geaendert.success).toBe(true);
    expect(listBusinessLetters()[0]?.replyTo).toEqual({ type: 'inbox', id: 'inbox-upload-7' });

    // Laden aus dem Speicher (Normalisierung) erhält die Herkunft ebenfalls.
    hydrateBusinessLetters(listBusinessLetters());
    expect(listBusinessLetters()[0]?.replyTo).toEqual({ type: 'inbox', id: 'inbox-upload-7' });
  });
});

describe('P1 — S: answerRef am Kommunikationsereignis', () => {
  const basis: CommunicationEvent = {
    id: 'comm-evt-p1',
    timestamp: '2026-10-07T11:00:00.000Z',
    type: 'marked_answered',
    contextRef: { type: 'inbox', id: 'inbox-upload-1' },
    status: 'complete',
    disclaimerShown: false,
    resultExcerpt: 'Antwort per Brief erfasst',
  };

  it('reist im Payload und wird gepullt', () => {
    const event: CommunicationEvent = { ...basis, channel: 'letter', answerRef: { kind: 'letter', id: 'letter-p1' } };
    const push = buildCommunicationEventCloudPushPayload(event);
    expect(push.event_type).toBe('marked_answered');
    expect((push.payload as Record<string, unknown>).answerRef).toEqual({ kind: 'letter', id: 'letter-p1' });
    const parsed = parseCommunicationEventCloudPayload(push as Record<string, unknown>);
    expect(parsed?.answerRef).toEqual({ kind: 'letter', id: 'letter-p1' });
    expect(parsed?.channel).toBe('letter');
  });

  it('ohne Nachweis bleibt der Schlüssel wie bisher; ungültige Nachweise fallen weg', () => {
    expect(buildCommunicationEventCloudContentKey(basis)).not.toContain('answerRef');
    expect(stripCommunicationEventForCloud({ ...basis, answerRef: { kind: 'fax', id: 'x' } as never }).answerRef).toBeUndefined();
    expect(parseCommunicationEventCloudPayload({ payload: { ...stripCommunicationEventForCloud(basis), answerRef: { kind: 'email', id: '' } } })?.answerRef).toBeUndefined();
  });
});
