import { describe, expect, it } from 'vitest';
import { resolvePaperFiling } from './paperFolderService';

describe('paperFolderService', () => {
  it('Registerregel Finanzamt → Behörden / Finanzamt', () => {
    const result = resolvePaperFiling({ classifiedKind: 'finanzamt', issuer: 'Finanzamt München' });
    expect(result.skipPhysicalFiling).toBe(false);
    expect(result.rule?.folderId).toBe('paper-behoerden');
    expect(result.rule?.register).toBe('Finanzamt');
  });

  it('Registerregel BG BAU → Behörden / BG BAU', () => {
    const result = resolvePaperFiling({ classifiedKind: 'bg_bau', issuer: 'BG BAU' });
    expect(result.skipPhysicalFiling).toBe(false);
    expect(result.rule?.folderId).toBe('paper-behoerden');
    expect(result.rule?.register).toBe('BG BAU');
  });

  it('Registerregel Freistellung → Steuerberater / Freistellungsbescheinigungen', () => {
    const result = resolvePaperFiling({ classifiedKind: 'freistellungsbescheinigung' });
    expect(result.skipPhysicalFiling).toBe(false);
    expect(result.rule?.folderId).toBe('folder-4');
    expect(result.rule?.register).toBe('Freistellungsbescheinigungen');
  });

  it('Werbung erzeugt keinen Papierordner', () => {
    const result = resolvePaperFiling({
      classifiedKind: 'sonstiges',
      documentType: 'sonstiges',
      issuer: 'Werbung GmbH Newsletter',
      isAdvertisement: true,
    });
    expect(result.skipPhysicalFiling).toBe(true);
    expect(result.rule).toBeNull();
  });

  it('Eingangsrechnung → Eingangsrechnungen / aktuelles Jahr', () => {
    const result = resolvePaperFiling({ classifiedKind: 'eingangsrechnung', year: 2026 });
    expect(result.rule?.folderId).toBe('folder-1');
    expect(result.rule?.register).toBe('2026');
  });

  it('Ausgangsrechnung → Ausgangsrechnungen / aktuelles Jahr', () => {
    const result = resolvePaperFiling({ classifiedKind: 'ausgangsrechnung', year: 2026 });
    expect(result.rule?.folderId).toBe('folder-3');
    expect(result.rule?.register).toBe('2026');
  });
});
