/**
 * FINANZ-CORE-01A — WEISS B21-C1: Die Reihenfolge der Aufträge einer Entität ist eindeutig, auch bei gleicher
 * Millisekunde. Eine endgültig abgewiesene Zahlungsrücknahme verschwindet nie hinter ihrem älteren, erledigten
 * Erstellauftrag aus der Abschlusskontrolle — gleich, wie die Warteschlange angeordnet ist.
 *
 *  O1/O2  Altbestand ohne Nummer, gleiche Millisekunde, Abweisung vorn (Einreihung) bzw. hinten (Zusammenführung eines
 *         Sync-Laufs): die Abweisung bleibt
 *  O3/O4  mit Einreihungsnummer: der jüngere Auftrag entscheidet in jeder Anordnung — abgewiesen bleibt abgewiesen,
 *         ein jüngerer erledigter Auftrag löst eine ältere Abweisung ab
 *  O5     WEISS-Gegenprobe mit 2 ms Abstand: unverändert der zeitlich jüngere
 *  O6     erneutes Senden und automatische Einreihung (Backfill-Sperre) bei gleicher Millisekunde
 *  O7     echtes Einreihen unter eingefrorener Zeit vergibt steigende Nummern, auch beim Zusammenführen
 *  O8     das Zusammenführen eines Sync-Laufs übernimmt die Nummer der lokalen Neueinreihung
 *  O9     eine Neueinreihung während eines Sync-Laufs in derselben Millisekunde wird erkannt und bleibt offen
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectRejectedExpenseEntries } from '../expense/expenseCloudSyncService';
import {
  enqueueBackfillSyncOutbox,
  enqueueSyncOutbox,
  getSyncOutboxSnapshot,
  hasFinallyDeniedOutboxEntry,
  isResendableDeniedOutboxEntry,
  resetSyncOutboxForTests,
} from './syncOutboxService';
import { isNewerOutboxEntry, newestOutboxEntriesByEntity } from './syncOutboxOrder';
import { mergeOutboxWithLocalChanges } from './syncLocalRebaseService';
import type { SyncOutboxEntry } from '../../types/sync';

const ZEIT = '2026-10-17T08:00:00.000Z';
const ZAHLUNG = 'exp-b21|pay-b21';
const ROLLE = 'finance_forbidden_role';

function auftrag(id: string, patch: Partial<SyncOutboxEntry>): SyncOutboxEntry {
  return {
    id, entityType: 'expense_payment', entityId: ZAHLUNG, operation: 'create', version: 1, queuedAt: ZEIT,
    retryCount: 0, status: 'completed', affectedMonths: ['2026-06'], ...patch,
  };
}
const erstellt = (patch: Partial<SyncOutboxEntry> = {}) => auftrag('erstellt', { operation: 'create', status: 'completed', ...patch });
const ruecknahmeAbgewiesen = (patch: Partial<SyncOutboxEntry> = {}) =>
  auftrag('ruecknahme', { operation: 'delete', status: 'failed', lastErrorMessage: ROLLE, lastErrorRetryable: false, ...patch });
const abgewiesen = (outbox: SyncOutboxEntry[]) => [...collectRejectedExpenseEntries(outbox).values()].map((e) => e.id);

beforeEach(() => resetSyncOutboxForTests([]));
afterEach(() => {
  vi.useRealTimers();
  resetSyncOutboxForTests([]);
});

describe('B21-C1 — der jüngste Auftrag einer Entität ist eindeutig', () => {
  it('O1 Altbestand, gleiche Millisekunde, die jüngere Abweisung steht vorn (WEISS-Reproduktion): sie bleibt', () => {
    expect(abgewiesen([ruecknahmeAbgewiesen(), erstellt()])).toEqual(['ruecknahme']);
  });

  it('O2 Altbestand, gleiche Millisekunde, die Abweisung steht hinten (Zusammenführung hängt an): sie bleibt (fail-closed)', () => {
    expect(abgewiesen([erstellt(), ruecknahmeAbgewiesen()])).toEqual(['ruecknahme']);
  });

  it('O3 mit Nummer: die jüngere Abweisung bleibt in jeder Anordnung', () => {
    const a = erstellt({ sequence: 1 });
    const b = ruecknahmeAbgewiesen({ sequence: 2 });
    expect(abgewiesen([b, a])).toEqual(['ruecknahme']);
    expect(abgewiesen([a, b])).toEqual(['ruecknahme']);
  });

  it('O4 mit Nummer: ein jüngerer erledigter Auftrag löst die ältere Abweisung ab — in jeder Anordnung', () => {
    const alt = ruecknahmeAbgewiesen({ sequence: 1 });
    const neu = auftrag('neu', { operation: 'delete', status: 'completed', sequence: 2 });
    expect(abgewiesen([neu, alt])).toEqual([]);
    expect(abgewiesen([alt, neu])).toEqual([]);
  });

  it('O5 WEISS-Gegenprobe mit 2 ms Abstand: der zeitlich jüngere entscheidet (Altbestand)', () => {
    const spaeter = '2026-10-17T08:00:00.002Z';
    expect(abgewiesen([ruecknahmeAbgewiesen({ queuedAt: spaeter }), erstellt()])).toEqual(['ruecknahme']);
    expect(abgewiesen([erstellt(), ruecknahmeAbgewiesen({ queuedAt: spaeter })])).toEqual(['ruecknahme']);
    const neuErledigt = auftrag('neu', { operation: 'delete', status: 'completed', queuedAt: spaeter });
    expect(abgewiesen([ruecknahmeAbgewiesen(), neuErledigt])).toEqual([]);
  });

  it('O6 erneutes Senden und Backfill-Sperre: bei gleicher Millisekunde zählt die Nummer, nicht die Zeit', () => {
    const entity = 'emp-b21';
    const alt = { ...ruecknahmeAbgewiesen({ sequence: 1 }), entityType: 'employee_payment' as const, entityId: entity, id: 'emp-alt' };
    const neu = { ...auftrag('emp-neu', { status: 'pending', sequence: 2 }), entityType: 'employee_payment' as const, entityId: entity };
    // Ein jüngerer Auftrag existiert (gleiche Zeit, hinten angehängt): die alte Abweisung ist nicht mehr das letzte Wort.
    resetSyncOutboxForTests([alt, neu]);
    expect(isResendableDeniedOutboxEntry(alt)).toBe(false);
    expect(hasFinallyDeniedOutboxEntry('employee_payment', entity)).toBe(false);
    // Die Abweisung ist der jüngste Auftrag (gleiche Zeit, vorn oder hinten): bewusst erneut sendbar, Backfill gesperrt.
    for (const reihe of [[alt, { ...neu, sequence: 0 }], [{ ...neu, sequence: 0 }, alt]]) {
      resetSyncOutboxForTests(reihe);
      expect(isResendableDeniedOutboxEntry(alt)).toBe(true);
      expect(hasFinallyDeniedOutboxEntry('employee_payment', entity)).toBe(true);
      expect(enqueueBackfillSyncOutbox({ entityType: 'employee_payment', entityId: entity, operation: 'create', version: 1 })).toBeNull();
    }
  });

  it('O7 echtes Einreihen unter eingefrorener Zeit: steigende Nummern, auch beim Zusammenführen eines offenen Auftrags', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(ZEIT));
    const a = enqueueSyncOutbox({ entityType: 'expense', entityId: 'exp-o7', operation: 'create', version: 1 });
    const b = enqueueSyncOutbox({ entityType: 'expense_payment', entityId: 'exp-o7|pay-1', operation: 'create', version: 1 });
    const zusammen = enqueueSyncOutbox({ entityType: 'expense', entityId: 'exp-o7', operation: 'update', version: 2 });
    expect([a.queuedAt, b.queuedAt, zusammen.queuedAt]).toEqual([ZEIT, ZEIT, ZEIT]);
    expect(a.sequence).toBe(1);
    expect(b.sequence).toBe(2);
    expect(zusammen.id).toBe(a.id);
    expect(zusammen.sequence).toBe(3);
    // Erledigt und danach neu eingereiht (gleiche Millisekunde): der neue Auftrag ist eindeutig der jüngste.
    resetSyncOutboxForTests(getSyncOutboxSnapshot().map((e) => ({ ...e, status: 'completed' as const })));
    const loeschen = enqueueSyncOutbox({ entityType: 'expense_payment', entityId: 'exp-o7|pay-1', operation: 'delete', version: 2 });
    expect(loeschen.sequence).toBe(4);
    const neueste = newestOutboxEntriesByEntity(getSyncOutboxSnapshot().reverse());
    expect(neueste.get('expense_payment:exp-o7|pay-1')?.id).toBe(loeschen.id);
  });

  it('O8 Zusammenführen eines Sync-Laufs: die lokale Neueinreihung behält ihre jüngere Nummer, Neues bleibt eindeutig', () => {
    const basis = erstellt({ status: 'pending', sequence: 1 });
    const kandidat = { ...basis, status: 'completed' as const };
    const lokalNeu = { ...basis, operation: 'update' as const, queuedAt: '2026-10-17T08:00:00.500Z', sequence: 3 };
    const waehrendDesLaufs = auftrag('neu-im-lauf', { status: 'pending', sequence: 2, queuedAt: ZEIT });
    const { outbox } = mergeOutboxWithLocalChanges([basis], [lokalNeu, waehrendDesLaufs], [kandidat]);
    expect(outbox.find((e) => e.id === basis.id)?.sequence).toBe(3);
    expect(outbox.at(-1)?.id).toBe('neu-im-lauf');
    expect(isNewerOutboxEntry(outbox[0]!, 0, outbox[1]!, 1)).toBe(true);
  });

  it('O9 Neueinreihung während eines Sync-Laufs in derselben Millisekunde (gleiche Version/Operation) bleibt offen', () => {
    const basis = erstellt({ status: 'pending', sequence: 1 });
    const kandidat = { ...basis, status: 'completed' as const };
    const lokalGleicheZeit = { ...basis, sequence: 2 };
    const { outbox, reopened } = mergeOutboxWithLocalChanges([basis], [lokalGleicheZeit], [kandidat]);
    expect(reopened).toBe(1);
    expect(outbox[0]).toMatchObject({ id: basis.id, status: 'pending', sequence: 2 });
    // Ohne neue Nummer (Altbestand, unverändert eingereiht) gilt weiterhin das Ergebnis des Laufs.
    const unveraendert = mergeOutboxWithLocalChanges([basis], [basis], [kandidat]);
    expect(unveraendert.outbox[0]).toMatchObject({ status: 'completed' });
  });
});
