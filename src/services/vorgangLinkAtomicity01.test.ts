/**
 * VORGANG-LINK-ATOMICITY-01B — der Verknüpfungsweg schreibt alles oder nichts.
 *
 * `createVorgangFromInbox` wurde mit `fd49ac1` auf Snapshots, reines Staging
 * und **genau einen** `persistAll()` gehoben. `linkInboxToExistingVorgang` —
 * der Weg zu einem **bestehenden** Vorgang — blieb auf dem älteren Muster:
 * mehrere getrennte Persistenzschritte und eine Rücknahme von Hand.
 *
 * Der gefährliche Fall war dabei nicht „ein Schreibvorgang scheitert", denn
 * `persistAll` schreibt den Gesamtzustand unter einem Schlüssel. Gefährlich war
 * die Kombination: `updateVorgangInStore` rollt einen Fehlschlag intern zurück,
 * meldet ihn aber **nicht**, der Ablauf lief weiter, und ein späterer
 * erfolgreicher Schreibvorgang machte den divergenten Speicher dauerhaft — mit
 * Erfolgsmeldung an den Nutzer.
 *
 * Geprüft wird deshalb die fachliche Invariante, nicht die Schrittfolge:
 * entweder alle drei Seiten sind gesetzt, oder keine.
 *
 * Neutrale Beispieldaten, kein Netzwerk, keine Cloud.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getDocumentById,
  hydrateDocumentStore,
} from './documentService';
import {
  getInboxItemById,
  hydrateInboxStore,
  markInboxImportedToArchive,
} from './inboxService';
import { getLastPersistSuccess } from './persistenceService';
import {
  confirmFilingDecisionForTests,
  importInboxDocumentForTests,
} from '../test/confirmFilingDecisionForTests';
import {
  getVorgangById,
  hydrateVorgangStore,
  linkInboxToExistingVorgang,
} from './vorgangService';
import { createAuftragInboxItem, createTestVorgang } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import type { InboxItem } from '../types/models';

const COMPANY = 'Test GmbH';
const VORGANG_ID = 'v-link-atomic';

function seedInbox(): InboxItem {
  const item = createAuftragInboxItem({
    id: 'inbox-link-atomic',
    title: 'Subunternehmervertrag Atomar',
    sender: 'Partner GmbH',
    classifiedKind: 'subunternehmervertrag',
    markedAsCompanyDocument: true,
  });
  hydrateInboxStore([item]);
  return getInboxItemById(item.id)!;
}

function archiveInbox(item: InboxItem) {
  confirmFilingDecisionForTests(item.id);
  const imported = importInboxDocumentForTests(getInboxItemById(item.id)!, COMPANY);
  expect(imported.success).toBe(true);
  if (!imported.success) throw new Error('import failed');
  const marked = markInboxImportedToArchive(item.id, imported.document.id);
  expect(marked?.success).toBe(true);
  return {
    inbox: getInboxItemById(item.id)!,
    document: getDocumentById(imported.document.id)!,
  };
}

function seedVorgang() {
  hydrateVorgangStore([createTestVorgang({ id: VORGANG_ID, title: 'Bestandsvorgang' })]);
  return getVorgangById(VORGANG_ID)!;
}

/** Der fachliche Zustand über alle drei Stores — das, was zusammenpassen muss. */
function linkState(inboxId: string, documentId: string) {
  const inbox = getInboxItemById(inboxId);
  const vorgang = getVorgangById(VORGANG_ID);
  const document = getDocumentById(documentId);
  return {
    inboxVorgangId: inbox?.vorgangId,
    inboxVorgangTitle: inbox?.vorgangTitle,
    inboxLinkStatus: inbox?.vorgangLinkStatus,
    inboxStatus: inbox?.status,
    inboxIsNewUpload: inbox?.isNewUpload,
    vorgangDocumentCount: vorgang?.documents.filter((d) => d.companyDocumentId === documentId)
      .length,
    documentVorgangId: document?.linkedVorgang?.vorgangId ?? null,
  };
}

function failPersist() {
  return vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('quota exceeded');
  });
}

describe('VORGANG-LINK-ATOMICITY-01B', () => {
  beforeEach(() => {
    hydrateDocumentStore([]);
    hydrateVorgangStore([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
  });

  /*
   * F3 — der bisher kritischste Fall: Scheitert das Speichern, darf **keine**
   * Seite der Verknüpfung dauerhaft gesetzt sein, und der Nutzer darf keinen
   * Erfolg gemeldet bekommen.
   */
  it('F3: ein Persistenzfehler hinterlässt keine halbe Verknüpfung', () => {
    const seeded = seedInbox();
    const { inbox, document } = archiveInbox(seeded);
    seedVorgang();
    const before = linkState(inbox.id, document.id);

    const setItemSpy = failPersist();
    const result = linkInboxToExistingVorgang(inbox, VORGANG_ID);

    expect(setItemSpy, 'Es wurde gar nicht erst zu speichern versucht').toHaveBeenCalled();
    expect(result, 'Trotz Persistenzfehler wurde ein Erfolg gemeldet').toBeNull();
    expect(
      getLastPersistSuccess(),
      'Ein späterer Teilpersist meldete falschen Erfolg',
    ).toBe(false);

    // Kein Zustand B: Die Inbox zeigt auf nichts.
    expect(getInboxItemById(inbox.id)?.vorgangId, 'Zustand B entstanden').toBeUndefined();
    // Kein Zustand A: Der Vorgang trägt das Dokument nicht.
    expect(linkState(inbox.id, document.id)).toEqual(before);
  });

  /*
   * F3b — der eigentliche Realfall, und der Grund für diesen Block.
   *
   * Ein dauerhaft blockierter Speicher ist harmlos: Dann scheitert **jeder**
   * Schritt und alles wird zurückgenommen. Gefährlich ist der **vorübergehende**
   * Fehler — ein einzelner Schreibvorgang scheitert, der nächste gelingt. Genau
   * das erzeugt ein voller `localStorage`, der zwischendurch Platz bekommt.
   *
   * Beim alten Mehrschritt-Weg fiel der erste Schreibvorgang (Vorgang mit
   * Dokument) aus, wurde aber nicht gemeldet; der zweite (Inbox-Link) gelang
   * und schrieb den divergenten Zustand fest. Ergebnis: Die Inbox zeigt auf den
   * Vorgang, der Vorgang kennt das Dokument nicht — und `getLastPersistSuccess`
   * meldet Erfolg, weil es nur den letzten Schreibvorgang kennt.
   *
   * Mit einem einzigen Schreibvorgang kann dieser Zustand nicht mehr entstehen.
   */
  it('F3b: ein vorübergehender Persistenzfehler erzeugt keinen Zustand B', () => {
    const seeded = seedInbox();
    const { inbox, document } = archiveInbox(seeded);
    seedVorgang();
    const before = linkState(inbox.id, document.id);

    let failures = 0;
    const setItemSpy = vi
      .spyOn(localStorage, 'setItem')
      .mockImplementationOnce(() => {
        failures += 1;
        throw new Error('quota exceeded');
      });

    const result = linkInboxToExistingVorgang(inbox, VORGANG_ID);

    expect(failures, 'Der simulierte Fehler trat nicht ein').toBe(1);
    expect(setItemSpy).toHaveBeenCalled();

    const after = linkState(inbox.id, document.id);

    /*
     * Entweder vollständig verknüpft oder unverändert — alles dazwischen ist
     * der Fehler. Insbesondere darf die Inbox niemals auf einen Vorgang zeigen,
     * der das Dokument nicht trägt.
     */
    const fullyLinked =
      after.inboxVorgangId === VORGANG_ID &&
      after.vorgangDocumentCount === 1 &&
      after.documentVorgangId === VORGANG_ID;
    const untouched =
      after.inboxVorgangId === undefined &&
      after.vorgangDocumentCount === 0 &&
      after.documentVorgangId === null;

    expect(
      fullyLinked || untouched,
      `Halber Zustand entstanden: ${JSON.stringify(after)}`,
    ).toBe(true);

    // Und die Meldung an den Nutzer muss zum Ergebnis passen.
    if (result === null) {
      expect(after, 'Fehler gemeldet, aber etwas wurde verknüpft').toEqual(before);
    }
  });

  /*
   * F3c — derselbe vorübergehende Fehler, aber **ohne** Archivdokument.
   *
   * Das ist der Fall ohne Zufallsnetz: Trägt der Posteingangseintrag ein
   * Archivdokument, hängt der nachgelagerte Bindeschritt das Dokument ohnehin
   * noch einmal an den Vorgang und heilt den Verlust versehentlich. Ohne
   * Archivdokument kehrt dieser Schritt sofort zurück — und der verlorene
   * Dokumenteintrag bleibt verloren, während der Inbox-Link gesetzt wird.
   */
  it('F3c: ohne Archivdokument erzeugt ein vorübergehender Fehler keinen Zustand B', () => {
    const item = createAuftragInboxItem({
      id: 'inbox-link-atomic-plain',
      title: 'Auftrag ohne Archivdokument',
      sender: 'Partner GmbH',
    });
    hydrateInboxStore([item]);
    const inbox = getInboxItemById(item.id)!;
    expect(inbox.archiveDocumentId, 'Die Fixture trägt doch ein Archivdokument').toBeFalsy();
    seedVorgang();

    const documentsBefore = getVorgangById(VORGANG_ID)!.documents.length;

    let failures = 0;
    vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
      failures += 1;
      throw new Error('quota exceeded');
    });

    const result = linkInboxToExistingVorgang(inbox, VORGANG_ID);
    expect(failures, 'Der simulierte Fehler trat nicht ein').toBe(1);

    const linkedInbox = getInboxItemById(inbox.id)!;
    const linkedVorgang = getVorgangById(VORGANG_ID)!;

    if (result === null) {
      // Fehler gemeldet: dann darf nichts gesetzt sein.
      expect(linkedInbox.vorgangId, 'Fehler gemeldet, Inbox trotzdem verknüpft').toBeUndefined();
      expect(linkedVorgang.documents).toHaveLength(documentsBefore);
      return;
    }

    // Erfolg gemeldet: dann muss der Vorgang das Dokument auch wirklich tragen.
    expect(linkedInbox.vorgangId).toBe(VORGANG_ID);
    expect(
      linkedVorgang.documents.length,
      'Erfolg gemeldet, aber der Vorgang hat das Dokument nicht (Zustand B)',
    ).toBe(documentsBefore + 1);
  });

  /*
   * F4 — dieselbe Invariante von der anderen Seite: alle drei Stores exakt wie
   * vorher, nicht nur „irgendwie unverknüpft".
   */
  it('F4: nach dem Fehlschlag stehen alle drei Stores auf dem Ausgangszustand', () => {
    const seeded = seedInbox();
    const { inbox, document } = archiveInbox(seeded);
    const vorgangBefore = seedVorgang();
    const documentsBefore = getDocumentById(document.id)!.linkedVorgang ?? null;

    failPersist();
    expect(linkInboxToExistingVorgang(inbox, VORGANG_ID)).toBeNull();

    expect(getVorgangById(VORGANG_ID)!.documents).toEqual(vorgangBefore.documents);
    expect(getInboxItemById(inbox.id)!.vorgangLinkStatus).toBeUndefined();
    expect(getInboxItemById(inbox.id)!.archiveDocumentId).toBe(document.id);
    expect(getDocumentById(document.id)!.linkedVorgang ?? null).toEqual(documentsBefore);
  });

  /*
   * F5 — die Reparierbarkeit. Nach einem Fehlschlag darf der Nutzer es erneut
   * versuchen, und der zweite Versuch muss sauber durchgehen: genau eine
   * Dokumentzuordnung, genau ein Link, kein Rest aus dem ersten Versuch.
   */
  it('F5: ein zweiter Versuch nach dem Fehlschlag gelingt vollständig und ohne Dublette', () => {
    const seeded = seedInbox();
    const { inbox, document } = archiveInbox(seeded);
    const vorgang = seedVorgang();

    const setItemSpy = failPersist();
    expect(linkInboxToExistingVorgang(inbox, VORGANG_ID)).toBeNull();
    setItemSpy.mockRestore();

    const retry = linkInboxToExistingVorgang(getInboxItemById(inbox.id)!, VORGANG_ID);
    expect(retry, 'Der zweite Versuch wurde blockiert').not.toBeNull();

    const after = linkState(inbox.id, document.id);
    expect(after.inboxVorgangId).toBe(VORGANG_ID);
    expect(after.inboxVorgangTitle).toBe(vorgang.title);
    expect(after.inboxLinkStatus).toBe('linked');
    expect(after.inboxStatus).toBe('geprueft');
    expect(after.inboxIsNewUpload).toBe(false);
    expect(after.vorgangDocumentCount, 'Dokument mehrfach zugeordnet').toBe(1);
    expect(after.documentVorgangId).toBe(VORGANG_ID);
    expect(getLastPersistSuccess()).toBe(true);
  });

  /*
   * F6 — der bestehende Guard bleibt: Ein bereits verknüpftes Dokument wird
   * nicht ein zweites Mal zugeordnet.
   */
  it('F6: ein bereits verknüpftes Dokument bleibt ein No-op', () => {
    const seeded = seedInbox();
    const { inbox, document } = archiveInbox(seeded);
    seedVorgang();

    expect(linkInboxToExistingVorgang(inbox, VORGANG_ID)).not.toBeNull();
    const afterFirst = linkState(inbox.id, document.id);

    expect(linkInboxToExistingVorgang(getInboxItemById(inbox.id)!, VORGANG_ID)).toBeNull();
    expect(linkState(inbox.id, document.id)).toEqual(afterFirst);
    expect(afterFirst.vorgangDocumentCount).toBe(1);
  });

  /*
   * Der Erfolgspfad **ohne** Archivdokument. Er hat kein zweites Netz: Trägt
   * der Eintrag ein Archivdokument, hängt der Bindeschritt den Verweis ohnehin
   * noch einmal an. Ohne ihn muss die erste Zuordnung sitzen.
   */
  it('F7: auch ohne Archivdokument trägt der Vorgang das Dokument nach dem Verknüpfen', () => {
    const item = createAuftragInboxItem({
      id: 'inbox-link-atomic-plain-ok',
      title: 'Auftrag ohne Archivdokument',
      sender: 'Partner GmbH',
    });
    hydrateInboxStore([item]);
    const inbox = getInboxItemById(item.id)!;
    seedVorgang();
    const documentsBefore = getVorgangById(VORGANG_ID)!.documents.length;

    const result = linkInboxToExistingVorgang(inbox, VORGANG_ID);
    expect(result, 'Die Verknüpfung schlug fehl').not.toBeNull();

    expect(
      getVorgangById(VORGANG_ID)!.documents.length,
      'Der Vorgang hat das Dokument nicht erhalten',
    ).toBe(documentsBefore + 1);
    expect(getInboxItemById(inbox.id)!.vorgangId).toBe(VORGANG_ID);
    expect(result!.vorgang.documents.length).toBe(documentsBefore + 1);
  });

  /*
   * Die Bauform selbst: genau **ein** Schreibvorgang im Erfolgsfall. Mehrere
   * Persistenzpunkte sind die Ursache der ganzen Fehlerklasse, deshalb wird
   * ihre Anzahl geprüft und nicht nur das Ergebnis.
   */
  it('P1: der Erfolgspfad schreibt genau einmal', () => {
    const seeded = seedInbox();
    const { inbox } = archiveInbox(seeded);
    seedVorgang();

    const setItemSpy = vi.spyOn(localStorage, 'setItem');
    expect(linkInboxToExistingVorgang(inbox, VORGANG_ID)).not.toBeNull();

    expect(setItemSpy.mock.calls.length, 'Mehr als ein Schreibvorgang').toBe(1);
  });

  it('P2: auch der Fehlerpfad versucht genau einmal zu schreiben', () => {
    const seeded = seedInbox();
    const { inbox } = archiveInbox(seeded);
    seedVorgang();

    const setItemSpy = failPersist();
    expect(linkInboxToExistingVorgang(inbox, VORGANG_ID)).toBeNull();

    expect(
      setItemSpy.mock.calls.length,
      'Die Rücknahme hat erneut zu speichern versucht',
    ).toBe(1);
  });
});
