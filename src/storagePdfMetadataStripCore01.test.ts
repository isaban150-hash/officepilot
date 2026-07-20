import { PDFDocument, PDFName, PDFSignature } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { stripDocumentFilePdfInfoMetadata } from './services/documentFilePdfMetadataStripService';
import { PROJECT_STATIC_DOCUMENT_FILE_TRANSFORM_CAPABILITY_SNAPSHOT } from './services/documentFileTransformCapabilityProvider';
import {
  PDF_INFO_METADATA_STRIP_KEYS,
  type DocumentFilePdfMetadataStripError,
} from './types/documentFilePdfMetadataStrip';

function isStripError(value: unknown): value is DocumentFilePdfMetadataStripError {
  return (
    value !== null &&
    typeof value === 'object' &&
    'code' in value &&
    typeof (value as { code: unknown }).code === 'string' &&
    'message' in value
  );
}

async function createPdfWithInfoMetadata(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.addPage([300, 400]);
  doc.addPage([300, 400]);
  doc.setTitle('Secret Title');
  doc.setAuthor('Secret Author');
  doc.setSubject('Secret Subject');
  doc.setKeywords(['alpha', 'beta']);
  doc.setCreator('Secret Creator');
  doc.setProducer('Secret Producer');
  doc.setCreationDate(new Date('2020-01-15T12:00:00Z'));
  doc.setModificationDate(new Date('2020-06-20T12:00:00Z'));
  return doc.save({ updateFieldAppearances: false });
}

async function createPdfWithTextField(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([300, 400]);
  const form = doc.getForm();
  const field = form.createTextField('Notes');
  field.setText('keep-me');
  field.addToPage(page, { x: 20, y: 300, width: 200, height: 24 });
  doc.setTitle('Form Title');
  return doc.save({ updateFieldAppearances: false });
}

async function createSignedPdfBytes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([200, 200]);
  const form = doc.getForm();
  const sigDict = doc.context.obj({
    FT: 'Sig',
    Type: 'Annot',
    Subtype: 'Widget',
    T: 'Signature1',
    F: 4,
    Rect: [0, 0, 100, 50],
    P: page.ref,
  });
  const sigRef = doc.context.register(sigDict);
  page.node.addAnnot(sigRef);
  const fields = form.acroForm.dict.lookup(PDFName.of('Fields'));
  if (fields && 'push' in fields) {
    (fields as { push: (ref: typeof sigRef) => void }).push(sigRef);
  }
  return doc.save({ updateFieldAppearances: false });
}

/** Minimal structural encrypted PDF trailer (Encrypt dict present). */
function createEncryptedPdfBytes(): Uint8Array {
  return new TextEncoder().encode(
    [
      '%PDF-1.4',
      '1 0 obj',
      '<< /Type /Catalog /Pages 2 0 R >>',
      'endobj',
      '2 0 obj',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      'endobj',
      '3 0 obj',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>',
      'endobj',
      '4 0 obj',
      '<< /Length 0 >>',
      'stream',
      'endstream',
      'endobj',
      '5 0 obj',
      '<< /Filter /Standard /V 1 /R 2 /O <E721D354B2689DEF0EF1CD63BEA9B397D32B638B51FCE157C1CB4D3C06309FDE> /U <A826E45F7032777881A4FB36FFF1B0DD28BF4E5E4E758A4164004E56FFFA0108> /P -4 >>',
      'endobj',
      'xref',
      '0 6',
      '0000000000 65535 f ',
      '0000000009 00000 n ',
      '0000000058 00000 n ',
      '0000000115 00000 n ',
      '0000000206 00000 n ',
      '0000000255 00000 n ',
      'trailer',
      '<< /Size 6 /Root 1 0 R /Encrypt 5 0 R /ID [<0123456789ABCDEF0123456789ABCDEF> <0123456789ABCDEF0123456789ABCDEF>] >>',
      'startxref',
      '400',
      '%%EOF',
    ].join('\n'),
  );
}

describe('STORAGE-PDF-METADATA-STRIP-CORE-01', () => {
  it('clears classic Info metadata fields', async () => {
    const input = await createPdfWithInfoMetadata();
    const before = await PDFDocument.load(input, { updateMetadata: false });
    expect(before.getTitle()).toBe('Secret Title');
    expect(before.getAuthor()).toBe('Secret Author');
    expect(before.getSubject()).toBe('Secret Subject');
    expect(before.getKeywords()).toEqual('alpha beta');
    expect(before.getCreator()).toBe('Secret Creator');
    expect(before.getProducer()).toBe('Secret Producer');
    expect(before.getCreationDate()?.toISOString()).toBe('2020-01-15T12:00:00.000Z');
    expect(before.getModificationDate()?.toISOString()).toBe('2020-06-20T12:00:00.000Z');

    const result = await stripDocumentFilePdfInfoMetadata({ bytes: input });
    expect(result.mimeType).toBe('application/pdf');
    expect(result.clearedInfoKeys).toEqual([...PDF_INFO_METADATA_STRIP_KEYS]);

    const after = await PDFDocument.load(result.bytes, { updateMetadata: false });
    expect(after.getTitle()).toBeUndefined();
    expect(after.getAuthor()).toBeUndefined();
    expect(after.getSubject()).toBeUndefined();
    expect(after.getKeywords()).toBeUndefined();
    expect(after.getCreator()).toBeUndefined();
    expect(after.getProducer()).toBeUndefined();
    expect(after.getCreationDate()).toBeUndefined();
    expect(after.getModificationDate()).toBeUndefined();
  });

  it('preserves page count and does not flatten form fields', async () => {
    const input = await createPdfWithTextField();
    const before = await PDFDocument.load(input, { updateMetadata: false });
    expect(before.getPageCount()).toBe(1);
    expect(before.getForm().getTextField('Notes').getText()).toBe('keep-me');

    const result = await stripDocumentFilePdfInfoMetadata({ bytes: input });
    expect(result.pageCount).toBe(1);

    const after = await PDFDocument.load(result.bytes, { updateMetadata: false });
    expect(after.getPageCount()).toBe(1);
    expect(after.getForm().getTextField('Notes').getText()).toBe('keep-me');
    expect(after.getTitle()).toBeUndefined();
  });

  it('leaves input bytes unchanged', async () => {
    const input = await createPdfWithInfoMetadata();
    const snapshot = Uint8Array.from(input);

    await stripDocumentFilePdfInfoMetadata({ bytes: input });

    expect(input).toEqual(snapshot);
  });

  it('rejects encrypted PDFs', async () => {
    try {
      await stripDocumentFilePdfInfoMetadata({ bytes: createEncryptedPdfBytes() });
      expect.fail('expected encrypted rejection');
    } catch (error) {
      expect(isStripError(error)).toBe(true);
      if (isStripError(error)) {
        expect(error.code).toBe('encrypted');
      }
    }
  });

  it('rejects corrupt PDFs', async () => {
    try {
      await stripDocumentFilePdfInfoMetadata({
        bytes: new TextEncoder().encode('this is not a pdf document at all'),
      });
      expect.fail('expected corrupt rejection');
    } catch (error) {
      expect(isStripError(error)).toBe(true);
      if (isStripError(error)) {
        expect(error.code).toBe('corrupt');
      }
    }
  });

  it('rejects signed PDFs (AcroForm signature field)', async () => {
    const signed = await createSignedPdfBytes();
    const loaded = await PDFDocument.load(signed, { updateMetadata: false });
    expect(loaded.getForm().getFields().some((f) => f instanceof PDFSignature)).toBe(true);

    try {
      await stripDocumentFilePdfInfoMetadata({ bytes: signed });
      expect.fail('expected signed rejection');
    } catch (error) {
      expect(isStripError(error)).toBe(true);
      if (isStripError(error)) {
        expect(error.code).toBe('signed');
      }
    }
  });

  it('rejects PDFs with /ByteRange signature markers', async () => {
    const base = await createPdfWithInfoMetadata();
    const marker = new TextEncoder().encode('\n/ByteRange [0 1 2 3]\n');
    const withMarker = new Uint8Array(base.byteLength + marker.byteLength);
    withMarker.set(base, 0);
    withMarker.set(marker, base.byteLength);

    try {
      await stripDocumentFilePdfInfoMetadata({ bytes: withMarker });
      expect.fail('expected signed rejection');
    } catch (error) {
      expect(isStripError(error)).toBe(true);
      if (isStripError(error)) {
        expect(error.code).toBe('signed');
      }
    }
  });

  it('rejects invalid input without claiming XMP full removal', async () => {
    try {
      await stripDocumentFilePdfInfoMetadata({ bytes: new Uint8Array() });
      expect.fail('expected invalid_input');
    } catch (error) {
      expect(isStripError(error)).toBe(true);
      if (isStripError(error)) {
        expect(error.code).toBe('invalid_input');
      }
    }

    const result = await stripDocumentFilePdfInfoMetadata({
      bytes: await createPdfWithInfoMetadata(),
    });
    expect(result.xmpFullyRemoved).toBe(false);
    // Contract: Info strip must not advertise a full XMP wipe.
    expect(Object.keys(result)).not.toContain('xmpRemoved');
    expect(Object.keys(result)).not.toContain('xmpCleared');
  });

  it('does not change write_pdf capability baseline', () => {
    expect(PROJECT_STATIC_DOCUMENT_FILE_TRANSFORM_CAPABILITY_SNAPSHOT.write_pdf).toBe('supported');
  });
});
