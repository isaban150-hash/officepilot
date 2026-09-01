/**
 * BRANDING-01F-3 — welches Logo gehört zu **dieser** Rechnung?
 *
 * Eine reine Funktion über den Rechnungssnapshot. Sie liest keine Firmendaten,
 * lädt nichts herunter, kennt keinen Speicherpfad und erzeugt keine URL. Sie
 * beantwortet nur eine fachliche Frage — und zwar an genau einer Stelle, damit
 * Bildschirmansicht, PDF und Validierung nicht drei verschiedene Antworten
 * geben.
 *
 * Über die Zeit sind drei Rechnungsgenerationen entstanden:
 *
 *   A  alte Rechnung — nur `companySnapshot.logoDataUrl`
 *   B  Übergangsrechnung aus 01E-2 — `companySnapshot.branding.logo`
 *   C  Rechnung ab 01F-1 — `brandingSnapshot.logo`
 *
 * Die Reihenfolge unten wählt die **Generation**, nicht eine Fehlerkette. Das
 * ist der wichtigste Punkt dieser Datei: Wenn eine strukturierte Referenz
 * vorliegt, ist genau sie die historische Wahrheit. Lässt sie sich später nicht
 * laden, wird **kein** Logo gezeigt — nicht das Legacy-Bild und erst recht nicht
 * das heutige Firmenlogo. Ein Dokument von damals mit einem anderen Logo wäre
 * eine stille Fälschung.
 *
 * Der Unterschied zwischen „strukturell ungültig" und „nicht ladbar" ist dabei
 * wesentlich: Eine Referenz ohne `assetId` oder mit unzulässigem Typ war nie
 * eine brauchbare Referenz — sie zählt als nicht vorhanden, und die ältere
 * Generation darf greifen. Eine **gültige** Referenz, die gerade nicht geladen
 * werden kann, bleibt dagegen verbindlich.
 */
import type { HistoricalInvoiceLogoSource, LogoAssetReference } from '../../types/branding';
import { isLogoMimeType } from '../branding/brandingSnapshotService';
import type { VorgangInvoice } from '../../types/models';

export type { HistoricalInvoiceLogoSource };

/** Nur vollständige, formal gültige Referenzen zählen als vorhanden. */
function toValidReference(value: unknown): LogoAssetReference | null {
  if (typeof value !== 'object' || value === null) return null;
  const { assetId, mimeType } = value as Record<string, unknown>;
  if (typeof assetId !== 'string' || assetId.trim().length === 0) return null;
  if (typeof mimeType !== 'string' || !isLogoMimeType(mimeType)) return null;
  return { assetId, mimeType };
}

/** Die Rechnungsfelder, aus denen die Auswahl entsteht — mehr braucht sie nicht. */
export type HistoricalInvoiceLogoInput = Pick<
  VorgangInvoice,
  'brandingSnapshot' | 'companySnapshot'
>;

export function selectHistoricalInvoiceLogo(
  invoice: HistoricalInvoiceLogoInput,
): HistoricalInvoiceLogoSource {
  const fromSnapshot = toValidReference(invoice.brandingSnapshot?.logo);
  if (fromSnapshot) return { kind: 'asset', reference: fromSnapshot };

  const fromCompanyBranding = toValidReference(invoice.companySnapshot?.branding?.logo);
  if (fromCompanyBranding) return { kind: 'asset', reference: fromCompanyBranding };

  const legacy = invoice.companySnapshot?.logoDataUrl;
  if (typeof legacy === 'string' && legacy.trim().length > 0) {
    return { kind: 'legacy_data_url', dataUrl: legacy };
  }

  return { kind: 'none' };
}
