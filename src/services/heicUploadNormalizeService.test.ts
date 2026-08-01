import { afterEach, describe, expect, it } from 'vitest';
import {
  prepareUploadFileForPipeline,
  setHeicToConverterForTests,
} from './heicUploadNormalizeService';

describe('heicUploadNormalizeService', () => {
  afterEach(() => {
    setHeicToConverterForTests(null);
  });

  it('lässt JPG unverändert', async () => {
    const file = new File(['jpg-bytes'], 'scan.jpg', { type: 'image/jpeg' });
    const result = await prepareUploadFileForPipeline(file);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.convertedFromHeic).toBe(false);
      expect(result.file).toBe(file);
    }
  });

  it('konvertiert HEIC → JPEG erfolgreich', async () => {
    setHeicToConverterForTests(async () => new Blob(['jpeg-bytes'], { type: 'image/jpeg' }));
    const file = new File(['heic-bytes'], 'iphone.heic', { type: 'image/heic' });
    const result = await prepareUploadFileForPipeline(file);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.convertedFromHeic).toBe(true);
      expect(result.file.type).toBe('image/jpeg');
      expect(result.file.name).toBe('iphone.jpg');
      expect(await result.file.text()).toBe('jpeg-bytes');
    }
  });

  it('liefert heic_conversion_failed bei leerem Ergebnis', async () => {
    setHeicToConverterForTests(async () => new Blob([], { type: 'image/jpeg' }));
    const file = new File(['heic-bytes'], 'broken.heic', { type: 'image/heic' });
    const result = await prepareUploadFileForPipeline(file);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('heic_conversion_failed');
    }
  });

  it('liefert heic_conversion_failed bei Converter-Fehler', async () => {
    setHeicToConverterForTests(async () => {
      throw new Error('decode failed');
    });
    const file = new File(['heic-bytes'], 'broken.heic', { type: 'image/heic' });
    const result = await prepareUploadFileForPipeline(file);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('heic_conversion_failed');
    }
  });
});
