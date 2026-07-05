import { persistAll } from './persistenceService';
import { getVorgangById } from './vorgangService';
import {
  filterSyncActive,
  generateEntityId,
  isEntitySyncActive,
  withNewEntitySync,
  withTombstonedEntity,
  withUpdatedEntitySync,
} from './sync/syncMetaService';
import type { VorgangNote, VorgangNoteInput } from '../types/communication';

function cloneNote(note: VorgangNote): VorgangNote {
  return {
    ...note,
    tags: note.tags ? [...note.tags] : undefined,
  };
}

function normalizeNote(note: Partial<VorgangNote> & Pick<VorgangNote, 'id' | 'vorgangId' | 'body'>): VorgangNote {
  const now = new Date().toISOString();
  const vorgang = getVorgangById(note.vorgangId);
  return {
    id: note.id,
    vorgangId: note.vorgangId,
    vorgangTitle: note.vorgangTitle ?? vorgang?.title ?? 'Unbekannter Vorgang',
    body: note.body.trim(),
    tags: note.tags ? [...note.tags] : [],
    occurredAt: note.occurredAt?.slice(0, 10) ?? now.slice(0, 10),
    createdAt: note.createdAt ?? now,
    updatedAt: note.updatedAt,
    source: note.source ?? 'user',
    linkedCommunicationEventId: note.linkedCommunicationEventId,
    linkedInboxId: note.linkedInboxId,
    pinned: note.pinned ?? false,
    sync: note.sync,
  };
}

let notes: VorgangNote[] = [];

export function getVorgangNoteStoreSnapshot(): VorgangNote[] {
  return notes.map(cloneNote);
}

export function hydrateVorgangNotes(items: VorgangNote[]): void {
  notes = items.map((item) => normalizeNote(item));
}

export function resetVorgangNotes(): void {
  notes = [];
}

export function setVorgangNoteStoreForTests(items: VorgangNote[]): void {
  notes = items.map((item) => normalizeNote(item));
}

export function getNotesForVorgang(vorgangId: string): VorgangNote[] {
  return filterSyncActive(notes)
    .filter((note) => note.vorgangId === vorgangId)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.createdAt.localeCompare(a.createdAt))
    .map(cloneNote);
}

export type VorgangNoteMutationResult =
  | { success: true; note: VorgangNote }
  | { success: false; errorKey: string };

export function addVorgangNote(
  vorgangId: string,
  input: VorgangNoteInput,
): VorgangNoteMutationResult {
  if (!getVorgangById(vorgangId)) {
    return { success: false, errorKey: 'vorgangNote.vorgangNotFound' };
  }
  if (!input.body?.trim()) {
    return { success: false, errorKey: 'vorgangNote.bodyRequired' };
  }

  const note = withNewEntitySync(
    normalizeNote({
      id: generateEntityId('note'),
      vorgangId,
      body: input.body,
      tags: input.tags,
      occurredAt: input.occurredAt,
      source: input.source ?? 'user',
      linkedInboxId: input.linkedInboxId,
    }),
    'vorgang_note',
  );

  notes = [note, ...notes];
  persistAll();
  return { success: true, note: cloneNote(note) };
}

export function updateVorgangNote(
  noteId: string,
  changes: Partial<VorgangNoteInput>,
): VorgangNoteMutationResult {
  const index = notes.findIndex((note) => note.id === noteId && isEntitySyncActive(note));
  if (index === -1) return { success: false, errorKey: 'vorgangNote.notFound' };

  const current = notes[index];
  if (changes.body !== undefined && !changes.body.trim()) {
    return { success: false, errorKey: 'vorgangNote.bodyRequired' };
  }

  const updated = withUpdatedEntitySync(
    normalizeNote({
      ...current,
      body: changes.body ?? current.body,
      tags: changes.tags ?? current.tags,
      occurredAt: changes.occurredAt ?? current.occurredAt,
      updatedAt: new Date().toISOString(),
    }),
    'vorgang_note',
  );

  notes = [...notes.slice(0, index), updated, ...notes.slice(index + 1)];
  persistAll();
  return { success: true, note: cloneNote(updated) };
}

export function deleteVorgangNote(noteId: string): VorgangNoteMutationResult {
  const index = notes.findIndex((note) => note.id === noteId && isEntitySyncActive(note));
  if (index === -1) return { success: false, errorKey: 'vorgangNote.notFound' };
  const tombstoned = withTombstonedEntity(cloneNote(notes[index]), 'vorgang_note');
  notes = [...notes.slice(0, index), tombstoned, ...notes.slice(index + 1)];
  persistAll();
  return { success: true, note: cloneNote(tombstoned) };
}

export function searchVorgangNotes(query: string, vorgangId?: string): VorgangNote[] {
  const normalized = query.trim().toLowerCase();
  const filtered = vorgangId
    ? filterSyncActive(notes).filter((note) => note.vorgangId === vorgangId)
    : filterSyncActive(notes);

  if (!normalized) {
    return filtered.map(cloneNote).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  }

  return filtered
    .filter((note) => {
      const haystack = [note.body, note.vorgangTitle, ...(note.tags ?? [])].join(' ').toLowerCase();
      return haystack.includes(normalized);
    })
    .map(cloneNote)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}
