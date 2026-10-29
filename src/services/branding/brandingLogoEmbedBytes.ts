/**
 * EINRICHTUNG-01 (EIN-11, S-14) — die einbettbaren Bildbytes des Firmenlogos
 * aus **eingefrorenen** Firmendaten, für PDFs ausserhalb des Rechnungswegs.
 *
 * Bisher las das Brief-PDF nur `logoDataUrl`. Ein Logo, das über die
 * Design-Seite hochgeladen wurde, liegt aber als Asset-Referenz in
 * `branding.logo`, und `logoDataUrl` ist dann leer — der Brief kam ohne Logo.
 *
 * Die Auswahl ist dieselbe wie bei Rechnung und Quittung
 * ({@link selectHistoricalInvoiceLogo}): eine gültige Asset-Referenz ist die
 * historische Wahrheit; lässt sie sich nicht laden, gibt es **kein** Logo —
 * keinen Rückfall auf das Alt-Bild und erst recht keinen auf heutige
 * Firmendaten. Ohne Referenz greift das eingebettete Alt-Bild.
 *
 * Bewusst ein eigener Baustein: Rechnungs-PDF und Auszahlungsquittung behalten
 * ihre erprobten, abgenommenen Wege unverändert.
 */
import { selectHistoricalInvoiceLogo } from '../invoice/invoiceHistoricalLogo';
import { resolveBrandingAsset } from './brandingAssetResolver';
import { encodeDocumentFileRasterToJpeg } from '../documentFileRasterEncodeService';
import { getSyncClient } from '../sync/syncClientService';
import type { CompanyProfile } from '../../types/models';

/** Was `pdf-lib` unmittelbar einbetten kann. */
export interface EmbeddableLogoBytes {
  bytes: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg';
}

function decodeBase64(base64: string): Uint8Array | null {
  try {
    const binaer = atob(base64);
    const bytes = new Uint8Array(binaer.length);
    for (let i = 0; i < binaer.length; i += 1) bytes[i] = binaer.charCodeAt(i);
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

/** Nur Base64-PNG/JPEG/WebP — kein SVG, keine entfernte URL. */
function parseLegacyLogo(dataUrl: string): { bytes: Uint8Array; mimeType: string } | null {
  const treffer = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl.trim());
  if (!treffer) return null;
  const bytes = decodeBase64(treffer[2].replace(/\s+/g, ''));
  return bytes ? { bytes, mimeType: treffer[1] } : null;
}

/** WebP kann `pdf-lib` nicht einbetten — temporär nach JPEG, wie im Rechnungs-PDF. */
async function toEmbeddable(bytes: Uint8Array, mimeType: string): Promise<EmbeddableLogoBytes | null> {
  if (mimeType === 'image/png' || mimeType === 'image/jpeg') return { bytes, mimeType };
  if (mimeType !== 'image/webp') return null;
  try {
    const encoded = await encodeDocumentFileRasterToJpeg({ bytes, sourceMimeType: 'image/webp' });
    return { bytes: encoded.bytes, mimeType: 'image/jpeg' };
  } catch {
    return null;
  }
}

/**
 * Das Logo der eingefrorenen Firmendaten oder `null`. Scheitert das Laden,
 * entsteht das Dokument ohne Logo; ein Fehler wird nie nach aussen geworfen.
 */
export async function loadCompanySnapshotLogoBytes(
  company: CompanyProfile | null | undefined,
): Promise<EmbeddableLogoBytes | null> {
  if (!company) return null;
  const quelle = selectHistoricalInvoiceLogo({ companySnapshot: company, brandingSnapshot: undefined });
  if (quelle.kind === 'none') return null;
  if (quelle.kind === 'legacy_data_url') {
    const geparst = parseLegacyLogo(quelle.dataUrl);
    return geparst ? toEmbeddable(geparst.bytes, geparst.mimeType) : null;
  }
  try {
    const workspaceId = getSyncClient().serverWorkspaceId;
    if (!workspaceId) return null;
    const aufgeloest = await resolveBrandingAsset(workspaceId, quelle.reference);
    if (!aufgeloest.ok) return null;
    const buffer = await aufgeloest.blob.arrayBuffer();
    return toEmbeddable(new Uint8Array(buffer), quelle.reference.mimeType);
  } catch {
    return null;
  }
}
