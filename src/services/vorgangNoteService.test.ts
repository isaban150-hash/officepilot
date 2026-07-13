import { beforeEach, describe, expect, it } from 'vitest';
import { getActiveStorageKey } from './persistenceService';
import { createTestVorgang } from '../test/fixtures';
import { hydrateVorgangStore } from './vorgangService';
import {
  addVorgangNote,
  deleteVorgangNote,
  getNotesForVorgang,
  hydrateVorgangNotes,
  searchVorgangNotes,
  updateVorgangNote,
} from './vorgangNoteService';

describe('vorgangNoteService CRUD', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateVorgangStore([createTestVorgang()]);
    hydrateVorgangNotes([]);
  });

  it('adds a note to a vorgang', () => {
    const result = addVorgangNote('v-test-1', { body: 'Kunde möchte graue Fliesen' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.note.body).toBe('Kunde möchte graue Fliesen');
    }
    expect(getNotesForVorgang('v-test-1')).toHaveLength(1);
  });

  it('rejects empty body', () => {
    const result = addVorgangNote('v-test-1', { body: '   ' });
    expect(result.success).toBe(false);
  });

  it('updates and deletes a note', () => {
    const created = addVorgangNote('v-test-1', { body: 'Erste Notiz' });
    if (!created.success) throw new Error('setup failed');

    const updated = updateVorgangNote(created.note.id, { body: 'Geänderte Notiz' });
    expect(updated.success).toBe(true);
    expect(getNotesForVorgang('v-test-1')[0].body).toBe('Geänderte Notiz');

    const removed = deleteVorgangNote(created.note.id);
    expect(removed.success).toBe(true);
    expect(getNotesForVorgang('v-test-1')).toHaveLength(0);
  });

  it('searches notes by text', () => {
    addVorgangNote('v-test-1', { body: 'Kunde möchte graue Fliesen' });
    addVorgangNote('v-test-1', { body: 'Bauleiter informiert' });
    expect(searchVorgangNotes('graue', 'v-test-1')).toHaveLength(1);
  });

  it('persists notes to localStorage', () => {
    addVorgangNote('v-test-1', { body: 'Persistenz-Test' });
    const raw = localStorage.getItem(getActiveStorageKey());
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.vorgangNotes).toHaveLength(1);
    expect(parsed.vorgangNotes[0].body).toBe('Persistenz-Test');
  });
});
