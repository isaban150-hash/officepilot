import { beforeEach, describe, expect, it } from 'vitest';
import { createAuftragInboxItem, createTestVorgang } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import {
  canTransitionVorgangStatus,
  getAllowedVorgangStatusTransitions,
  migrateVorgangStatus,
} from './services/vorgangLifecycleService';
import {
  createVorgangFromInbox,
  getVorgangById,
  hydrateVorgangStore,
  updateVorgangStatus,
} from './services/vorgangService';
import { createVorgangFromInboxWithContract } from './services/intakeWorkflowService';
import { hydrateInboxStore } from './services/inboxService';
import type { VorgangStatus } from './types/models';

describe('VORGANG-LIFECYCLE-01', () => {
  beforeEach(() => {
    resetTestStores();
  });

  describe('Statusmigration', () => {
    it('migriert Legacy-Status neu nach eingegangen', () => {
      expect(migrateVorgangStatus('neu')).toBe('eingegangen');
      expect(migrateVorgangStatus(undefined)).toBe('eingegangen');
    });

    it('lässt gültige Lifecycle-Status unverändert', () => {
      const statuses: VorgangStatus[] = [
        'eingegangen',
        'in_pruefung',
        'in_verhandlung',
        'beauftragt',
        'in_bearbeitung',
        'wartet',
        'abgeschlossen',
      ];
      for (const status of statuses) {
        expect(migrateVorgangStatus(status)).toBe(status);
      }
    });

    it('migriert beim Hydrate von Store-Daten', () => {
      hydrateVorgangStore([
        {
          ...createTestVorgang({ id: 'v-legacy', status: 'neu' }),
        },
      ]);
      expect(getVorgangById('v-legacy')?.status).toBe('eingegangen');
    });
  });

  describe('Transitionen', () => {
    it('erlaubt nur die definierten Folgestatus', () => {
      expect(getAllowedVorgangStatusTransitions('eingegangen')).toEqual(['in_pruefung']);
      expect(getAllowedVorgangStatusTransitions('in_pruefung')).toEqual(['in_verhandlung']);
      expect(getAllowedVorgangStatusTransitions('in_verhandlung')).toEqual(['beauftragt']);
      expect(getAllowedVorgangStatusTransitions('beauftragt')).toEqual(['in_bearbeitung']);
      expect(getAllowedVorgangStatusTransitions('in_bearbeitung')).toEqual([
        'wartet',
        'abgeschlossen',
      ]);
      expect(getAllowedVorgangStatusTransitions('wartet')).toEqual([
        'in_bearbeitung',
        'abgeschlossen',
      ]);
      expect(getAllowedVorgangStatusTransitions('abgeschlossen')).toEqual([]);
    });

    it('akzeptiert gültige Transitionen und lehnt ungültige ab', () => {
      expect(canTransitionVorgangStatus('eingegangen', 'in_pruefung')).toBe(true);
      expect(canTransitionVorgangStatus('eingegangen', 'beauftragt')).toBe(false);
      expect(canTransitionVorgangStatus('beauftragt', 'eingegangen')).toBe(false);
      expect(canTransitionVorgangStatus('abgeschlossen', 'in_bearbeitung')).toBe(false);
      expect(canTransitionVorgangStatus('neu', 'in_pruefung')).toBe(true);
    });

    it('updateVorgangStatus setzt gültige Transitionen und persistiert', () => {
      hydrateVorgangStore([createTestVorgang({ id: 'v-trans', status: 'eingegangen' })]);

      const ok = updateVorgangStatus('v-trans', 'in_pruefung');
      expect(ok.success).toBe(true);
      if (ok.success) {
        expect(ok.vorgang.status).toBe('in_pruefung');
      }
      expect(getVorgangById('v-trans')?.status).toBe('in_pruefung');

      const invalid = updateVorgangStatus('v-trans', 'beauftragt');
      expect(invalid.success).toBe(false);
      if (!invalid.success) {
        expect(invalid.errorKey).toBe('vorgang.status.invalidTransition');
      }
      expect(getVorgangById('v-trans')?.status).toBe('in_pruefung');
    });
  });

  describe('Vorgang aus Werkvertrag / Inbox', () => {
    it('legt Vorgang aus Inbox mit Status eingegangen an', () => {
      const item = createAuftragInboxItem({ id: 'inbox-life-1' });
      hydrateInboxStore([item]);
      const created = createVorgangFromInbox(item);
      expect(created).not.toBeNull();
      expect(created!.vorgang.status).toBe('eingegangen');
      expect(created!.vorgang.status).not.toBe('beauftragt');
      expect(created!.vorgang.status).not.toBe('neu');
    });

    it('legt Vorgang aus Vertrag mit Status eingegangen an – nicht beauftragt', () => {
      const item = createAuftragInboxItem({
        id: 'inbox-life-contract',
        classifiedKind: 'werkvertrag',
        recognizedData: {
          Kunde: 'Müller Bau',
          Baustelle: 'Hauptstr. 1',
          Leistung: 'Badrenovierung',
        },
      });
      hydrateInboxStore([item]);
      const created = createVorgangFromInboxWithContract(item);
      expect(created).not.toBeNull();
      expect(created!.vorgang.status).toBe('eingegangen');
      expect(created!.vorgang.status).not.toBe('beauftragt');
    });
  });
});
