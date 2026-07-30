import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from './i18n';
import { deStorageRecommendation } from './i18n/locales/de/storageRecommendation';
import { trStorageRecommendation } from './i18n/locales/tr/storageRecommendation';
import { bgStorageRecommendation } from './i18n/locales/bg/storageRecommendation';
import {
  buildStorageRecommendation,
  findDuplicateByPayloadBytes,
  resetEvidenceCounterForTests,
  TAX_DISCLAIMER_KEY,
} from './services/storageRecommendationService';
import {
  confirmPendingDocumentIntake,
  processDocumentFileForPreview,
} from './services/pendingDocumentIntakeService';
import {
  getDocumentFileRefStoreSnapshot,
  resetDocumentFileStoreForTests,
} from './services/documentFileStoreService';
import { getInboxStoreSnapshot, hydrateInboxStore } from './services/inboxService';
import { computeBufferContentHash } from './services/documentFileHashService';
import { setPdfTextExtractorForTests } from './services/uploadTextExtractionService';
import { resetTestStores } from './test/resetStores';
import {
  hasDocumentBlob,
  resetDocumentBlobDatabaseForTests,
} from './services/storage/documentBlobIndexedDbService';
import type { CachedDocumentFilePayload } from './services/cachedDocumentFileService';
import type { DocumentTextExtractionResult } from './services/ocrDocumentService';
import { hydrateVorgangStore } from './services/vorgangService';
import { createTestVorgang } from './test/fixtures';
import type { InboxItem } from './types/models';

function createPayload(content: string | Uint8Array, fileName: string, mimeType = 'application/pdf'): CachedDocumentFilePayload {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return { fileName, mimeType, fileSize: bytes.length, bytes };
}

function createExtraction(
  recognizedText: string,
  confidence: DocumentTextExtractionResult['confidence'] = 'high',
): DocumentTextExtractionResult {
  return {
    recognizedText,
    displayText: recognizedText,
    confidence,
    sourceType: 'pdf',
    extractionMethod: 'pdf_direct',
  };
}

function seedInboxWithHash(contentHash: string, id = 'inbox-dup'): InboxItem {
  return {
    id,
    title: 'Bestehende Mahnung',
    status: 'neu',
    priority: 'kritisch',
    kind: 'mahnung',
    digitalFolder: { id: 'dig-1', name: 'Mahnungen', path: '/Eingang/Mahnungen/' },
    paperFiling: { folderId: 'folder-1', register: 'A', label: 'Mahnungen' },
    recognizedData: { text: 'Alt' },
    createdAt: '2026-07-01T10:00:00.000Z',
    updatedAt: '2026-07-01T10:00:00.000Z',
    sourceFileHash: contentHash,
  };
}

describe('STORAGE-RECOMMENDATION-02 rule engine', () => {
  afterEach(() => {
    setPdfTextExtractorForTests(null);
    vi.restoreAllMocks();
    resetEvidenceCounterForTests();
    resetTestStores();
    resetDocumentFileStoreForTests();
    hydrateVorgangStore([]);
    void resetDocumentBlobDatabaseForTests();
  });

  it('Mahnung → archive_required', async () => {
    const text = 'Mahnung Zahlungsaufforderung Inkasso';
    const rec = await buildStorageRecommendation({
      cachedFile: createPayload(text, 'mahnung.pdf'),
      recognizedText: text,
      extraction: createExtraction(text),
    });
    expect(rec.level).toBe('archive_required');
    expect(rec.reasonKeys).toContain('storageRecommendation.reason.kind.mahnung');
  });

  it('Rechnung → archive_recommended', async () => {
    const text = 'Eingangsrechnung Rechnungsnummer RE-2026-100 Materialrechnung';
    const rec = await buildStorageRecommendation({
      cachedFile: createPayload(text, 'rechnung.pdf'),
      recognizedText: text,
      extraction: createExtraction(text),
    });
    expect(rec.level).toBe('archive_recommended');
  });

  it('Tankbeleg → archive_recommended', async () => {
    const text = 'Tankstelle Shell\nTankbeleg\nLiter 45,2\nBetrag: 78,90 EUR';
    const rec = await buildStorageRecommendation({
      cachedFile: createPayload(text, 'tank.jpg', 'image/jpeg'),
      recognizedText: text,
      extraction: createExtraction(text),
    });
    expect(rec.level).toBe('archive_recommended');
  });

  it('Freistellungsbescheinigung → archive_required mit Disclaimer', async () => {
    const text = 'Freistellungsbescheinigung nach §48b ESTG';
    const rec = await buildStorageRecommendation({
      cachedFile: createPayload(text, 'freistellung.pdf'),
      recognizedText: text,
      extraction: createExtraction(text),
    });
    expect(rec.level).toBe('archive_required');
    expect(rec.disclaimerKey).toBe(TAX_DISCLAIMER_KEY);
  });

  it('Auftrag ohne Kunde → review_required', async () => {
    const text = 'Auftrag Auftragsnummer AU-2026-200 Leistung Sanitärinstallation';
    const rec = await buildStorageRecommendation({
      cachedFile: createPayload(text, 'auftrag.pdf'),
      recognizedText: text,
      extraction: createExtraction(text),
    });
    expect(rec.level).toBe('review_required');
    expect(rec.reasonKeys).toContain('storageRecommendation.reason.missingCustomer');
  });

  it('Auftrag mit Kunde → archive_recommended', async () => {
    const text = 'Auftrag\nKunde: Müller Sanitär GmbH\nAuftragsnummer: AU-2026-201';
    const rec = await buildStorageRecommendation({
      cachedFile: createPayload(text, 'auftrag-kunde.pdf'),
      recognizedText: text,
      extraction: createExtraction(text),
    });
    expect(rec.level).toBe('archive_recommended');
  });

  it('Baustellenfoto ohne Vorgang → temporary_only', async () => {
    const text = 'Baustellenfoto Rohbau Phase 2';
    const rec = await buildStorageRecommendation({
      cachedFile: createPayload(text, 'foto.jpg', 'image/jpeg'),
      recognizedText: text,
      extraction: createExtraction(text),
    });
    expect(rec.level).toBe('temporary_only');
  });

  it('Baustellenfoto mit Vorgang → archive_recommended', async () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'vorgang-neubau',
        title: 'Neubau Müller',
        customer: 'Müller GmbH',
        baustelle: 'Hauptstraße 5',
      }),
    ]);
    const text = 'Baustellenfoto\nVorgang: Neubau Müller\nKunde: Müller GmbH\nBaustelle: Hauptstraße 5';
    const rec = await buildStorageRecommendation({
      cachedFile: createPayload(text, 'baustelle.jpg', 'image/jpeg'),
      recognizedText: text,
      extraction: createExtraction(text),
    });
    expect(rec.level).toBe('archive_recommended');
  });

  it('Werbung → discard_recommended', async () => {
    const text = 'Sommer-Sale Prospekt Werbung Newsletter';
    const rec = await buildStorageRecommendation({
      cachedFile: createPayload(text, 'werbung.pdf'),
      recognizedText: text,
      extraction: createExtraction(text),
      kindHint: 'werbung',
    });
    expect(rec.level).toBe('discard_recommended');
  });

  it('unbekanntes Dokument → review_required', async () => {
    const text = 'Notiz xyz';
    const rec = await buildStorageRecommendation({
      cachedFile: createPayload(text, 'unbekannt.pdf'),
      recognizedText: text,
      extraction: createExtraction(text, 'low'),
    });
    expect(rec.level).toBe('review_required');
  });

  it('niedrige OCR-Qualität überschreibt archive_required zu review_required', async () => {
    const text = 'Zahlungsaufforderung Mahnung Inkasso';
    const rec = await buildStorageRecommendation({
      cachedFile: createPayload(text, 'mahnung-low-ocr.pdf'),
      recognizedText: text,
      extraction: createExtraction(text, 'low'),
    });
    expect(rec.level).toBe('review_required');
    expect(rec.reasonKeys).toContain('storageRecommendation.reason.lowOcrQuality');
  });

  it('Content-Hash-Match → duplicate_detected', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.4\nDUPLICATE-TEST\n%%EOF');
    const hash = await computeBufferContentHash(bytes);
    hydrateInboxStore([seedInboxWithHash(hash)]);

    const rec = await buildStorageRecommendation({
      cachedFile: createPayload(bytes, 'duplicate.pdf'),
      recognizedText: 'Beliebiger Text',
      extraction: createExtraction('Beliebiger Text'),
    });
    expect(rec.level).toBe('duplicate_detected');
    expect(rec.duplicateMatch?.id).toBe('inbox-dup');
    expect(rec.duplicateMatch?.type).toBe('inbox');
    expect(rec.reasonKeys).toContain('storageRecommendation.reason.duplicateInInbox');
  });

  it('Dublettenprüfung schreibt nichts in IndexedDB', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.4\nNO-INDEXEDDB\n%%EOF');
    const hash = await computeBufferContentHash(bytes);
    hydrateInboxStore([seedInboxWithHash(hash, 'inbox-no-idb')]);

    await findDuplicateByPayloadBytes(bytes);
    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(0);
    expect(await hasDocumentBlob('any')).toBe(false);
  });

  it('Empfehlung speichert niemals automatisch', async () => {
    const text = 'Rechnung Betrag: 100,00 EUR';
    await buildStorageRecommendation({
      cachedFile: createPayload(text, 'auto-save.pdf'),
      recognizedText: text,
      extraction: createExtraction(text),
    });
    expect(getInboxStoreSnapshot()).toHaveLength(0);
    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(0);
  });

  it('Ordner stammt aus bestehendem Katalog', async () => {
    const text = 'Eingangsrechnung Materialrechnung Rechnungsnummer RE-1';
    const rec = await buildStorageRecommendation({
      cachedFile: createPayload(text, 'rechnung-folder.pdf'),
      recognizedText: text,
      extraction: createExtraction(text),
    });
    expect(rec.recommendedFolder?.path).toContain('Steuerberater');
    expect(rec.recommendedFolder?.path).toContain('Eingangsrechnungen');
  });

  it('verwendet keine Mock-/Default-Werte als Evidence', async () => {
    const text = 'Mahnung Zahlungsaufforderung sofort';
    const rec = await buildStorageRecommendation({
      cachedFile: createPayload(text, 'evidence.pdf'),
      recognizedText: text,
      extraction: createExtraction(text),
    });
    const fieldKeys = rec.evidenceRefs.map((ref) => ref.fieldKey).filter(Boolean);
    expect(fieldKeys).not.toContain('Betrag');
    expect(rec.evidenceRefs.some((ref) => ref.source === 'rules')).toBe(true);
  });

  it('Upload und Scan liefern dieselbe Empfehlung', async () => {
    setPdfTextExtractorForTests(() => 'Rechnung Betrag: 200,00 EUR Summe gesamt');
    const payload = createPayload('%PDF-1.4\nshared\n%%EOF', 'shared.pdf');
    const file = new File([payload.bytes], payload.fileName, { type: payload.mimeType });

    const uploadPreview = await processDocumentFileForPreview(file, { selectedKind: undefined });
    const scanPreview = await processDocumentFileForPreview(file, { selectedKind: undefined });

    expect(uploadPreview.success).toBe(true);
    expect(scanPreview.success).toBe(true);
    if (!uploadPreview.success || !scanPreview.success) return;

    expect(uploadPreview.pending.storageRecommendation.level).toBe(
      scanPreview.pending.storageRecommendation.level,
    );
    expect(uploadPreview.pending.storageRecommendation.reasonKeys).toEqual(
      scanPreview.pending.storageRecommendation.reasonKeys,
    );
  });

  it('Confirm-Flow bleibt unverändert und persistiert erst nach Bestätigung', async () => {
    setPdfTextExtractorForTests(() => 'Rechnung Betrag: 99,00 EUR');
    const payload = createPayload('%PDF-1.4\nconfirm-flow\n%%EOF', 'confirm.pdf');
    const preview = await processDocumentFileForPreview(
      new File([payload.bytes], payload.fileName, { type: payload.mimeType }),
    );
    expect(preview.success).toBe(true);
    if (!preview.success) return;
    expect(getInboxStoreSnapshot()).toHaveLength(0);

    const result = await confirmPendingDocumentIntake(preview.pending, {
      importSource: 'upload',
      userDecision: 'save_permanently',
    });
    expect(result.success).toBe(true);
    if (!result.success || result.duplicate) return;
    expect(getInboxStoreSnapshot()).toHaveLength(1);
  });
});

describe('STORAGE-RECOMMENDATION-02 i18n DE/TR/BG', () => {
  const requiredKeys = Object.keys(deStorageRecommendation);

  it('DE keys sind in TR und BG vorhanden', () => {
    for (const key of requiredKeys) {
      expect(trStorageRecommendation[key as keyof typeof trStorageRecommendation]).toBeTruthy();
      expect(bgStorageRecommendation[key as keyof typeof bgStorageRecommendation]).toBeTruthy();
    }
  });

  it('Kern-Keys sind übersetzbar', () => {
    expect(t('storageRecommendation.level.archive_required', 'de')).toContain('empfohlen');
    expect(t('storageRecommendation.disclaimer.notLegalAdvice', 'tr')).toContain('OfficePilot');
    expect(t('storageRecommendation.action.useExisting', 'bg')).toContain('файл');
  });
});
