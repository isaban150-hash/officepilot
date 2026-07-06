import { describe, expect, it } from 'vitest';
import {
  MAX_UPLOAD_FILE_SIZE_BYTES,
  validateUploadFile,
} from '../services/documentUploadValidation';

describe('documentUploadValidation', () => {
  it('akzeptiert gültige PNG-Datei', () => {
    const file = new File(['png'], 'scan.png', { type: 'image/png' });
    expect(validateUploadFile(file)).toEqual({ valid: true });
  });

  it('akzeptiert gültige PDF-Datei', () => {
    const file = new File(['%PDF'], 'rechnung.pdf', { type: 'application/pdf' });
    expect(validateUploadFile(file)).toEqual({ valid: true });
  });

  it('lehnt falschen Dateityp ab', () => {
    const file = new File(['text'], 'notes.txt', { type: 'text/plain' });
    expect(validateUploadFile(file)).toEqual({ valid: false, error: 'invalid_type' });
  });

  it('lehnt zu große Datei ab', () => {
    const file = new File([new Uint8Array(MAX_UPLOAD_FILE_SIZE_BYTES + 1)], 'big.pdf', {
      type: 'application/pdf',
    });
    expect(validateUploadFile(file)).toEqual({ valid: false, error: 'file_too_large' });
  });
});
