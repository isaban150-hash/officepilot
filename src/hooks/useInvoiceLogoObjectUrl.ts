/**
 * BRANDING-01F-3 — das **historische** Logo eines Dokuments für die Anzeige.
 *
 * Bewusst ein eigener Hook neben `useCompanyLogoObjectUrl`: Jener beantwortet
 * „welches Logo hat der Betrieb heute?" und kennt dafür den Legacy-Rückfall der
 * Firmendatenseite. Hier gilt das Gegenteil — eine Rechnung zeigt genau das
 * Logo, das zu ihr gehört, oder gar keines. Beide Fragen in einen Hook zu
 * pressen hiesse, die Fallback-Regel der Firmendaten versehentlich in
 * historische Dokumente zu tragen.
 *
 * Der Hook wählt nichts aus; die Auswahl trifft `selectHistoricalInvoiceLogo`.
 * Er beschafft nur, was ihm übergeben wird, über den bestehenden Resolver —
 * kein zweiter Cache, keine Pfadlogik, keine signierte URL.
 */
import { useEffect, useState } from 'react';
import type { HistoricalInvoiceLogoSource } from '../types/branding';
import { resolveBrandingAsset } from '../services/branding/brandingAssetResolver';

export interface InvoiceLogoState {
  /** Anzeigbare Quelle: Object-URL, Data-URL — oder nichts. */
  url: string | undefined;
  status: 'idle' | 'loading' | 'ready' | 'missing';
}

const EMPTY: InvoiceLogoState = { url: undefined, status: 'idle' };

export function useInvoiceLogoObjectUrl(
  source: HistoricalInvoiceLogoSource,
  workspaceId: string | undefined,
): InvoiceLogoState {
  const kind = source.kind;
  const assetId = source.kind === 'asset' ? source.reference.assetId : undefined;
  const mimeType = source.kind === 'asset' ? source.reference.mimeType : undefined;
  const dataUrl = source.kind === 'legacy_data_url' ? source.dataUrl : undefined;

  const [state, setState] = useState<InvoiceLogoState>(() =>
    kind === 'asset' ? { url: undefined, status: 'loading' } : EMPTY,
  );

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | undefined;

    void (async () => {
      if (kind === 'none') {
        if (!cancelled) setState({ url: undefined, status: 'missing' });
        return;
      }

      if (kind === 'legacy_data_url') {
        // Bereits eine gültige Quelle — nichts zu erzeugen, nichts freizugeben.
        if (!cancelled) setState({ url: dataUrl, status: dataUrl ? 'ready' : 'missing' });
        return;
      }

      if (!assetId || !mimeType || !workspaceId) {
        if (!cancelled) setState({ url: undefined, status: 'missing' });
        return;
      }

      setState({ url: undefined, status: 'loading' });

      let resolved;
      try {
        resolved = await resolveBrandingAsset(workspaceId, { assetId, mimeType });
      } catch {
        // Kein Ersatzlogo — weder Legacy noch das heutige Firmenlogo.
        if (!cancelled) setState({ url: undefined, status: 'missing' });
        return;
      }
      if (cancelled) return;

      if (!resolved.ok) {
        setState({ url: undefined, status: 'missing' });
        return;
      }

      createdUrl = URL.createObjectURL(resolved.blob);
      setState({ url: createdUrl, status: 'ready' });
    })();

    return () => {
      cancelled = true;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [kind, assetId, mimeType, dataUrl, workspaceId]);

  return state;
}
