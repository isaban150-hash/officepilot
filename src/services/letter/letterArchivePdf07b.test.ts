/**
 * E-MAIL-07B — der Geschäftsbrief bekommt sein tatsächliches PDF im Archiv.
 *
 * Befund aus 07A: Das Brief-PDF ließ sich ansehen und herunterladen, der
 * Versandbereich meldete aber „es liegt keine PDF-Datei dazu vor".
 * `generateBusinessLetterPdf` renderte nur im Speicher,
 * `ensureBusinessLetterArchived` legte den Eintrag ohne Datei an. Jetzt legt
 * die Ablage — wie beim Angebot — das PDF als gebundene Datei ab.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { BusinessLetter } from '../../types/businessLetter';
import { ensureBusinessLetterArchived } from './businessLetterArchiveService';
import {
  addBusinessLetter,
  attachArchiveDocumentToLetter,
  finalizeBusinessLetter,
  getBusinessLetterById,
  resetBusinessLetters,
} from '../businessLetterService';
import { addDocument, getAllDocuments, getDocumentById, resetDocuments } from '../documentService';
import { getDocumentFileRefById, getDocumentFileRefStoreSnapshot, resetDocumentFileStoreForTests } from '../documentFileStoreService';
import { hydrateCompanyProfileStore, resetCompanyProfile } from '../companyProfileService';
import { createCompanyProfileFromSetup } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import {
  findArchivedDocumentPdfFileRefId,
  prepareArchivedDocumentDeliveryAttachment,
  resolveArchivedDocumentDeliveryKind,
} from '../delivery/documentDeliveryCloudService';
import { isArchivedDocumentEmailSendable } from '../../components/documents/DocumentDeliveryPanel';
import { applyStateToStores, buildPersistedStateSnapshot } from '../persistenceService';

const WORKSPACE = 'ws-letter-07b';

function fertigerBrief(subject = 'Terminbestaetigung'): BusinessLetter {
  const angelegt = addBusinessLetter(WORKSPACE, {
    subject,
    body: 'Die Arbeiten beginnen am Montag.',
    letterDate: '2026-09-19',
    recipient: { name: 'Herr Mueller', company: 'Musterbau GmbH', street: 'Musterweg 1', zip: '33602', city: 'Bielefeld' },
  });
  if (!angelegt.success) throw new Error('Brief konnte nicht angelegt werden');
  const fertig = finalizeBusinessLetter(angelegt.letter.id);
  if (!fertig.success) throw new Error('Brief konnte nicht fertiggestellt werden');
  return fertig.letter;
}

function eintraegeZu(letterId: string) {
  return getAllDocuments().filter((d) => d.linkedLetterId === letterId);
}

beforeEach(() => {
  resetBusinessLetters();
  resetDocuments();
  resetDocumentFileStoreForTests();
  resetCompanyProfile();
  hydrateCompanyProfileStore({
    ...createCompanyProfileFromSetup(DEFAULT_SETUP),
    companyName: 'Beispiel Haustechnik GmbH',
    street: 'Musterstrasse 5',
    zip: '33602',
    city: 'Bielefeld',
  });
});

describe('07B — Brief-PDF im Archiv', () => {
  it('Archivieren legt das tatsächliche PDF ab und bindet es per fileRefId', async () => {
    const brief = fertigerBrief();
    const ergebnis = await ensureBusinessLetterArchived(brief);
    expect(ergebnis.ok).toBe(true);
    if (!ergebnis.ok) return;
    expect(ergebnis.created).toBe(true);
    expect(ergebnis.pdf).toBe('attached');

    const dokument = getDocumentById(ergebnis.document.id)!;
    expect(dokument.fileRefId).toBeTruthy();
    expect(dokument.mimeType).toBe('application/pdf');
    const ref = getDocumentFileRefById(dokument.fileRefId!);
    expect(ref?.mimeType).toBe('application/pdf');
    expect(ref?.lifecycleStatus).toBe('committed');
  });

  it('danach ist der Brief versendbar — als Versandart letter, mit echtem PDF-Anhang', async () => {
    const brief = fertigerBrief();
    const ergebnis = await ensureBusinessLetterArchived(brief);
    if (!ergebnis.ok) throw new Error('nicht abgelegt');
    const dokument = getDocumentById(ergebnis.document.id)!;

    expect(findArchivedDocumentPdfFileRefId(dokument)).toBe(dokument.fileRefId);
    expect(isArchivedDocumentEmailSendable(dokument)).toBe(true);
    // Klassifiziert bleibt der Eintrag als Schriftverkehr (Ablage), versendet wird er als Brief.
    expect(dokument.classifiedKind).toBe('schriftverkehr');
    expect(resolveArchivedDocumentDeliveryKind(dokument)).toBe('letter');

    const anhang = await prepareArchivedDocumentDeliveryAttachment(dokument);
    expect(anhang.ok).toBe(true);
    if (!anhang.ok) return;
    expect(String.fromCharCode(...anhang.attachment.bytes.subarray(0, 5))).toBe('%PDF-');
    expect(anhang.attachment.filename).toBe('Terminbestaetigung.pdf');
  });

  it('idempotent: weitere Aufrufe legen weder einen zweiten Eintrag noch eine zweite Datei ab', async () => {
    const brief = fertigerBrief();
    const erst = await ensureBusinessLetterArchived(brief);
    if (!erst.ok) throw new Error('nicht abgelegt');
    const dateienNachErst = getDocumentFileRefStoreSnapshot().length;

    for (let i = 0; i < 3; i += 1) {
      const weiter = await ensureBusinessLetterArchived(getBusinessLetterById(brief.id)!);
      expect(weiter.ok).toBe(true);
      if (!weiter.ok) return;
      expect(weiter.created).toBe(false);
      expect(weiter.pdf).toBe('existing');
      expect(weiter.document.fileRefId).toBe(getDocumentById(erst.document.id)!.fileRefId);
    }
    expect(eintraegeZu(brief.id)).toHaveLength(1);
    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(dateienNachErst);
  });

  it('gleichzeitige Aufrufe teilen sich einen Lauf — eine Datei, ein Eintrag', async () => {
    const brief = fertigerBrief();
    const vorher = getDocumentFileRefStoreSnapshot().length;
    const [a, b] = await Promise.all([ensureBusinessLetterArchived(brief), ensureBusinessLetterArchived(brief)]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.document.id).toBe(b.document.id);
    expect(eintraegeZu(brief.id)).toHaveLength(1);
    expect(getDocumentFileRefStoreSnapshot().length - vorher).toBe(1);
  });

  it('ein vor 07B ohne PDF archivierter Brief wird sauber nachgerüstet — derselbe Eintrag, jetzt mit PDF', async () => {
    const brief = fertigerBrief();
    // Der alte Stand: Archiveintrag ohne Datei (so legte BRIEFE-01D ab).
    const alt = addDocument({
      title: brief.subject,
      category: 'geschaeftsschreiben',
      issuer: 'Beispiel Haustechnik GmbH',
      issueDate: brief.letterDate,
      documentDate: brief.letterDate,
      linkedCompany: 'Musterbau GmbH',
      linkedVorgang: null,
      linkedLetterId: brief.id,
      classifiedKind: 'schriftverkehr',
      digitalFolder: { id: `dig-letter-${brief.id}`, name: 'Geschäftsschreiben', path: '/Geschäftsschreiben/' },
      paperFolder: { folderId: 'paper-kunden', register: 'Sonstiges', label: 'Kunden' },
      archived: true,
      recognizedText: brief.body,
      tags: ['Geschäftsschreiben'],
    });
    if (!alt.success) throw new Error('Altbestand nicht angelegt');
    attachArchiveDocumentToLetter(brief.id, alt.document.id);
    expect(isArchivedDocumentEmailSendable(getDocumentById(alt.document.id)!)).toBe(false);

    const ergebnis = await ensureBusinessLetterArchived(getBusinessLetterById(brief.id)!);
    expect(ergebnis.ok).toBe(true);
    if (!ergebnis.ok) return;
    expect(ergebnis.created).toBe(false);
    expect(ergebnis.pdf).toBe('attached');
    expect(ergebnis.document.id).toBe(alt.document.id);
    expect(eintraegeZu(brief.id)).toHaveLength(1);
    expect(isArchivedDocumentEmailSendable(getDocumentById(alt.document.id)!)).toBe(true);
    // Der übrige Eintrag bleibt, wie er war.
    expect(getDocumentById(alt.document.id)!.recognizedText).toBe(brief.body);
    expect(getDocumentById(alt.document.id)!.category).toBe('geschaeftsschreiben');
  });

  it('ein Eintrag, der bereits eine Datei trägt, wird nie umgehängt (keine Doppelablage)', async () => {
    const brief = fertigerBrief();
    const mitFremderDatei = addDocument({
      title: brief.subject,
      category: 'geschaeftsschreiben',
      issuer: '',
      issueDate: null,
      documentDate: null,
      linkedCompany: '',
      linkedVorgang: null,
      linkedLetterId: brief.id,
      classifiedKind: 'schriftverkehr',
      digitalFolder: { id: 'dig', name: 'G', path: '/G/' },
      paperFolder: { folderId: 'paper-kunden', register: 'Sonstiges', label: 'Kunden' },
      archived: true,
      recognizedText: '',
      tags: [],
      // Eine Datei, die dieses Gerät (noch) nicht kennt — etwa vor dem Laden auf einem zweiten Gerät.
      fileRefId: 'file-ref-anderes-geraet',
    });
    if (!mitFremderDatei.success) throw new Error('nicht angelegt');
    attachArchiveDocumentToLetter(brief.id, mitFremderDatei.document.id);
    const vorher = getDocumentFileRefStoreSnapshot().length;

    const ergebnis = await ensureBusinessLetterArchived(getBusinessLetterById(brief.id)!);
    expect(ergebnis.ok).toBe(true);
    if (!ergebnis.ok) return;
    expect(ergebnis.pdf).toBe('kept');
    expect(getDocumentById(mitFremderDatei.document.id)!.fileRefId).toBe('file-ref-anderes-geraet');
    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(vorher);
  });

  it('Reload: die Bindung übersteht Speichern und erneutes Laden', async () => {
    const brief = fertigerBrief();
    const ergebnis = await ensureBusinessLetterArchived(brief);
    if (!ergebnis.ok) throw new Error('nicht abgelegt');
    const fileRefId = getDocumentById(ergebnis.document.id)!.fileRefId;

    const gespeichert = JSON.parse(JSON.stringify(buildPersistedStateSnapshot()));
    resetDocuments();
    expect(getDocumentById(ergebnis.document.id)).toBeUndefined();
    applyStateToStores(gespeichert);

    const geladen = getDocumentById(ergebnis.document.id)!;
    expect(geladen.fileRefId).toBe(fileRefId);
    expect(isArchivedDocumentEmailSendable(geladen)).toBe(true);
    expect(resolveArchivedDocumentDeliveryKind(geladen)).toBe('letter');
  });

  it('ein Entwurf wird weiterhin nicht abgelegt und bekommt kein PDF', async () => {
    const entwurf = addBusinessLetter(WORKSPACE, {
      subject: 'Entwurf',
      body: 'Text',
      letterDate: '2026-09-19',
      recipient: { name: 'Herr Mueller', company: '', street: '', zip: '', city: '' },
    });
    if (!entwurf.success) throw new Error('nicht angelegt');
    const vorher = getDocumentFileRefStoreSnapshot().length;
    const ergebnis = await ensureBusinessLetterArchived(entwurf.letter);
    expect(ergebnis).toEqual({ ok: false, reason: 'not_finalized' });
    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(vorher);
  });
});
