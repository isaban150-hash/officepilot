/**
 * BRIEFE-01B — der fachliche Kern der Geschäftsschreiben.
 *
 * Diese Datei trägt ausschliesslich Fachlogik: anlegen, ändern, fertigstellen,
 * löschen. Sie macht **keinen** Cloud-Aufruf; der Weg in die Cloud führt wie
 * bei Vorgangsnotizen und Aufgaben über den Änderungsverfolger und die
 * vorhandene Warteschlange.
 *
 * Die beiden Regeln, die den Brief von einer Notiz unterscheiden:
 *
 *  1. Ein fertiggestellter Brief wird nicht mehr fachlich verändert. Er ist ein
 *     Beleg; wer etwas anderes sagen will, schreibt einen neuen Brief.
 *  2. Mit der Fertigstellung werden die Absenderdaten eingefroren. Zieht der
 *     Betrieb später um oder wechselt das Logo, bleibt der abgeschickte Brief
 *     so, wie er hinausging — dieselbe Zusage, die das Produkt für freigegebene
 *     Rechnungen bereits gibt.
 */
import { persistAll } from './persistenceService';
import { getCompanyProfileStoreSnapshot } from './companyProfileService';
import {
  filterSyncActive,
  generateEntityId,
  isEntitySyncActive,
  withTombstonedCloudEntityPreservingRemoteVersion,
} from './sync/syncMetaService';
import type {
  BusinessLetter,
  BusinessLetterInput,
  BusinessLetterRecipient,
} from '../types/businessLetter';

function cloneRecipient(recipient: BusinessLetterRecipient): BusinessLetterRecipient {
  return { ...recipient };
}

function cloneLetter(letter: BusinessLetter): BusinessLetter {
  return {
    ...letter,
    recipient: cloneRecipient(letter.recipient),
    companySnapshot: letter.companySnapshot ? { ...letter.companySnapshot } : undefined,
  };
}

function normalizeRecipient(recipient: Partial<BusinessLetterRecipient>): BusinessLetterRecipient {
  return {
    name: (recipient.name ?? '').trim(),
    company: recipient.company?.trim() || undefined,
    street: (recipient.street ?? '').trim(),
    zip: (recipient.zip ?? '').trim(),
    city: (recipient.city ?? '').trim(),
    country: recipient.country?.trim() || undefined,
  };
}

function normalizeLetter(
  letter: Partial<BusinessLetter> & Pick<BusinessLetter, 'id' | 'workspaceId' | 'subject' | 'body'>,
): BusinessLetter {
  const now = new Date().toISOString();
  return {
    id: letter.id,
    workspaceId: letter.workspaceId,
    subject: letter.subject.trim(),
    body: letter.body.trim(),
    letterDate: (letter.letterDate ?? now).slice(0, 10),
    recipient: normalizeRecipient(letter.recipient ?? {}),
    customerId: letter.customerId || undefined,
    vorgangId: letter.vorgangId || undefined,
    status: letter.status ?? 'draft',
    companySnapshot: letter.companySnapshot,
    documentId: letter.documentId || undefined,
    createdAt: letter.createdAt ?? now,
    updatedAt: letter.updatedAt,
    sync: letter.sync,
  };
}

let letters: BusinessLetter[] = [];

export function getBusinessLetterStoreSnapshot(): BusinessLetter[] {
  return letters.map(cloneLetter);
}

export function hydrateBusinessLetters(items: BusinessLetter[]): void {
  letters = items.map((item) => normalizeLetter(item));
}

export function resetBusinessLetters(): void {
  letters = [];
}

export function setBusinessLetterStoreForTests(items: BusinessLetter[]): void {
  letters = items.map((item) => normalizeLetter(item));
}

/** Alle lebenden Briefe, neueste zuerst. Grabsteine bleiben aussen vor. */
export function listBusinessLetters(): BusinessLetter[] {
  return filterSyncActive(letters)
    .slice()
    .sort(
      (a, b) =>
        b.letterDate.localeCompare(a.letterDate) || b.createdAt.localeCompare(a.createdAt),
    )
    .map(cloneLetter);
}

export function getBusinessLetterById(letterId: string): BusinessLetter | null {
  const letter = letters.find((item) => item.id === letterId && isEntitySyncActive(item));
  return letter ? cloneLetter(letter) : null;
}

export function getBusinessLettersForCustomer(customerId: string): BusinessLetter[] {
  return listBusinessLetters().filter((letter) => letter.customerId === customerId);
}

export function getBusinessLettersForVorgang(vorgangId: string): BusinessLetter[] {
  return listBusinessLetters().filter((letter) => letter.vorgangId === vorgangId);
}

export type BusinessLetterMutationResult =
  | { success: true; letter: BusinessLetter }
  | { success: false; errorKey: string };

function validate(input: Partial<BusinessLetterInput>): string | null {
  if (input.subject !== undefined && !input.subject.trim()) return 'businessLetter.subjectRequired';
  if (input.body !== undefined && !input.body.trim()) return 'businessLetter.bodyRequired';
  if (input.recipient) {
    const recipient = normalizeRecipient(input.recipient);
    if (!recipient.name && !recipient.company) return 'businessLetter.recipientRequired';
  }
  return null;
}

export function addBusinessLetter(
  workspaceId: string,
  input: BusinessLetterInput,
): BusinessLetterMutationResult {
  if (!workspaceId) return { success: false, errorKey: 'businessLetter.workspaceRequired' };
  const problem = validate(input);
  if (problem) return { success: false, errorKey: problem };
  if (!input.subject?.trim()) return { success: false, errorKey: 'businessLetter.subjectRequired' };
  if (!input.body?.trim()) return { success: false, errorKey: 'businessLetter.bodyRequired' };

  /*
   * SYNC-VERSION-CONTRACT-02 — der neue Brief bekommt **keine** Sync-Meta.
   *
   * `sync.version` ist ausschliesslich die zuletzt vom Server bestätigte
   * Version. Ein selbst gesetzter Startwert wäre eine Behauptung, die der
   * Server nie bestätigt hat, und liesse den ersten Versand mit einer falschen
   * Erwartung antreten.
   */
  const letter = normalizeLetter({
    id: generateEntityId('letter'),
    workspaceId,
    subject: input.subject,
    body: input.body,
    letterDate: input.letterDate,
    recipient: input.recipient,
    customerId: input.customerId,
    vorgangId: input.vorgangId,
    status: 'draft',
  });

  letters = [letter, ...letters];
  persistAll();
  return { success: true, letter: cloneLetter(letter) };
}

export function updateBusinessLetter(
  letterId: string,
  changes: Partial<BusinessLetterInput>,
): BusinessLetterMutationResult {
  const index = letters.findIndex((item) => item.id === letterId && isEntitySyncActive(item));
  if (index === -1) return { success: false, errorKey: 'businessLetter.notFound' };

  /*
   * Ein fertiggestellter Brief ist ein Beleg. Er wird nicht nachträglich
   * umgeschrieben — sonst hiesse dasselbe Schreiben morgen etwas anderes als
   * das, was der Empfänger bekommen hat.
   */
  if (letters[index].status === 'finalized') {
    return { success: false, errorKey: 'businessLetter.finalizedImmutable' };
  }

  const problem = validate(changes);
  if (problem) return { success: false, errorKey: problem };

  const current = letters[index];
  // Lokale Fachänderung — `sync` bleibt unangetastet, wie bei Notiz und Vorgang.
  const updated = normalizeLetter({
    ...current,
    subject: changes.subject ?? current.subject,
    body: changes.body ?? current.body,
    letterDate: changes.letterDate ?? current.letterDate,
    recipient: changes.recipient ?? current.recipient,
    customerId: changes.customerId !== undefined ? changes.customerId : current.customerId,
    vorgangId: changes.vorgangId !== undefined ? changes.vorgangId : current.vorgangId,
    updatedAt: new Date().toISOString(),
  });

  letters = [...letters.slice(0, index), updated, ...letters.slice(index + 1)];
  persistAll();
  return { success: true, letter: cloneLetter(updated) };
}

/**
 * Der Abschluss: Ab hier steht der Brief fest.
 *
 * Die Absenderdaten werden aus dem **aktuellen** Firmenprofil übernommen und
 * am Brief festgehalten. Alles Weitere — Anschrift des Empfängers, Betreff,
 * Text, Datum — steht ohnehin schon am Brief selbst und wird nie mehr aus
 * fremden Beständen nachgezogen.
 */
export function finalizeBusinessLetter(letterId: string): BusinessLetterMutationResult {
  const index = letters.findIndex((item) => item.id === letterId && isEntitySyncActive(item));
  if (index === -1) return { success: false, errorKey: 'businessLetter.notFound' };

  const current = letters[index];
  if (current.status === 'finalized') {
    return { success: false, errorKey: 'businessLetter.alreadyFinalized' };
  }
  if (!current.subject.trim() || !current.body.trim()) {
    return { success: false, errorKey: 'businessLetter.incompleteForFinalize' };
  }
  const recipient = normalizeRecipient(current.recipient);
  if (!recipient.name && !recipient.company) {
    return { success: false, errorKey: 'businessLetter.recipientRequired' };
  }

  const profile = getCompanyProfileStoreSnapshot();
  if (!profile) return { success: false, errorKey: 'businessLetter.companyProfileMissing' };

  const finalized = normalizeLetter({
    ...current,
    status: 'finalized',
    companySnapshot: { ...profile },
    updatedAt: new Date().toISOString(),
  });

  letters = [...letters.slice(0, index), finalized, ...letters.slice(index + 1)];
  persistAll();
  return { success: true, letter: cloneLetter(finalized) };
}

/**
 * BRIEFE-01D — bindet das Archivdokument an einen fertiggestellten Brief.
 *
 * Die einzige Änderung, die ein fertiggestellter Brief noch erlaubt. Sie
 * berührt den eingefrorenen Inhalt nicht: Betreff, Text, Datum, Empfänger und
 * Absenderdaten bleiben unangetastet, es kommt nur der Verweis auf die Ablage
 * hinzu. Der Server-Guard aus 01B lässt genau diesen Fall ausdrücklich zu,
 * indem er `documentId` vom Inhaltsvergleich ausnimmt.
 *
 * Ein bereits gesetzter Verweis wird nie überschrieben — sonst entstünden zwei
 * Ablagen zu einem Brief.
 */
export function attachArchiveDocumentToLetter(
  letterId: string,
  documentId: string,
): BusinessLetterMutationResult {
  const index = letters.findIndex((item) => item.id === letterId && isEntitySyncActive(item));
  if (index === -1) return { success: false, errorKey: 'businessLetter.notFound' };

  const current = letters[index];
  if (current.status !== 'finalized') {
    return { success: false, errorKey: 'businessLetter.archiveDraftNotAllowed' };
  }
  const gewuenscht = documentId.trim();
  if (!gewuenscht) return { success: false, errorKey: 'businessLetter.archiveFailed' };
  if (current.documentId?.trim()) {
    // Schon abgelegt — das ist kein Fehler, sondern der Normalfall beim zweiten Aufruf.
    return { success: true, letter: cloneLetter(current) };
  }

  const verknuepft = normalizeLetter({ ...current, documentId: gewuenscht });
  letters = [...letters.slice(0, index), verknuepft, ...letters.slice(index + 1)];
  persistAll();
  return { success: true, letter: cloneLetter(verknuepft) };
}

export function deleteBusinessLetter(letterId: string): BusinessLetterMutationResult {
  const index = letters.findIndex((item) => item.id === letterId && isEntitySyncActive(item));
  if (index === -1) return { success: false, errorKey: 'businessLetter.notFound' };

  /*
   * TOMBSTONE-VERSION-CONTRACT-02 — die Löschung ist eine lokale Fachänderung
   * und darf die bestätigte Serverversion nicht erhöhen. Der Versand schickt
   * sie als Erwartung mit; ein selbst erhöhter Wert würde abgewiesen, und die
   * Löschung käme auf dem zweiten Gerät nie an.
   */
  const tombstoned = withTombstonedCloudEntityPreservingRemoteVersion(
    cloneLetter(letters[index]),
    'business_letter',
  );

  letters = [...letters.slice(0, index), tombstoned, ...letters.slice(index + 1)];
  persistAll();
  return { success: true, letter: cloneLetter(tombstoned) };
}
