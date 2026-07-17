import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setPdfDocumentLoaderForTests,
  type PdfDocumentError,
} from './services/pdfDocumentService';
import { preflightDocumentFileTransformPdf } from './services/documentFileTransformPdfPreflightService';
import * as pdfDocumentService from './services/pdfDocumentService';

describe('STORAGE-TRANSFORM-PDF-PREFLIGHT-01', () => {
  afterEach(() => {
    setPdfDocumentLoaderForTests(null);
    vi.restoreAllMocks();
  });

  describe('Fall A–B: gültige PDF und Gesamtseitenzahl', () => {
    it('liefert ok mit tatsächlicher Gesamtseitenzahl > 1', async () => {
      const destroy = vi.fn(async () => undefined);
      setPdfDocumentLoaderForTests(async () => ({
        pdf: { numPages: 5, destroy },
        pageCount: 5,
      }));

      const result = await preflightDocumentFileTransformPdf(new Uint8Array([1, 2, 3]));
      expect(result).toEqual({ ok: true, pageCount: 5 });
      expect(Object.keys(result)).toEqual(['ok', 'pageCount']);
      expect(destroy).toHaveBeenCalledTimes(1);
    });

    it('wendet kein OCR-Zwölf-Seiten-Limit an', async () => {
      setPdfDocumentLoaderForTests(async () => ({
        pdf: { numPages: 40, destroy: async () => undefined },
        pageCount: 40,
      }));

      await expect(preflightDocumentFileTransformPdf(new Uint8Array([9]))).resolves.toEqual({
        ok: true,
        pageCount: 40,
      });
    });
  });

  describe('Fall C–D: bekannte PDF-Dateifehler', () => {
    it('gibt password_required unverändert zurück', async () => {
      const error: PdfDocumentError = {
        code: 'password_required',
        message: 'Die PDF ist passwortgeschützt.',
      };
      setPdfDocumentLoaderForTests(async () => {
        throw error;
      });

      await expect(preflightDocumentFileTransformPdf(new Uint8Array([1]))).resolves.toEqual({
        ok: false,
        errorCode: 'password_required',
      });
    });

    it('gibt pdf_corrupt unverändert zurück', async () => {
      const error: PdfDocumentError = {
        code: 'pdf_corrupt',
        message: 'Die PDF konnte nicht gelesen werden.',
      };
      setPdfDocumentLoaderForTests(async () => {
        throw error;
      });

      await expect(preflightDocumentFileTransformPdf(new Uint8Array([1]))).resolves.toEqual({
        ok: false,
        errorCode: 'pdf_corrupt',
      });
    });
  });

  describe('Fall E: unerwartete Fehler', () => {
    it('wirft unerwartete Fehler weiter und maskiert sie nicht', async () => {
      setPdfDocumentLoaderForTests(async () => {
        throw new Error('unexpected_loader_failure');
      });

      await expect(preflightDocumentFileTransformPdf(new Uint8Array([1]))).rejects.toThrow(
        'unexpected_loader_failure',
      );
    });

    it('wirft render_failed weiter (kein Preflight-Dateifehler)', async () => {
      const error: PdfDocumentError = {
        code: 'render_failed',
        message: 'PDF-Seite konnte nicht gerendert werden.',
      };
      setPdfDocumentLoaderForTests(async () => {
        throw error;
      });

      await expect(preflightDocumentFileTransformPdf(new Uint8Array([1]))).rejects.toEqual(error);
    });
  });

  describe('Fall F: Ressourcenfreigabe über getPdfPageCount', () => {
    it('nutzt getPdfPageCount (bestehende destroy-Semantik)', async () => {
      const spy = vi.spyOn(pdfDocumentService, 'getPdfPageCount').mockResolvedValue(3);
      const result = await preflightDocumentFileTransformPdf(new Uint8Array([4, 5]));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ok: true, pageCount: 3 });
    });
  });

  describe('Fall H: Determinismus bei gleichem Mock', () => {
    it('liefert bei gleichen Bytes und gleichem Loader dasselbe Result', async () => {
      setPdfDocumentLoaderForTests(async () => ({
        pdf: { numPages: 2, destroy: async () => undefined },
        pageCount: 2,
      }));
      const bytes = new Uint8Array([7, 8]);
      const first = await preflightDocumentFileTransformPdf(bytes);
      const second = await preflightDocumentFileTransformPdf(bytes);
      expect(first).toEqual(second);
    });
  });
});
