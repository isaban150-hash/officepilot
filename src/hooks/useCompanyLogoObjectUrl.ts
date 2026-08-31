/**
 * BRANDING-01E-2 — das **gespeicherte** Firmenlogo beschaffen.
 *
 * Zwei Wege führen zu einem Logo, und sie sind nicht gleichrangig:
 *
 *   1. `branding.logo` — die neue, unveränderliche Asset-Referenz
 *   2. `logoDataUrl`   — der Legacy-Weg, rein lokal
 *
 * Der Hook kapselt genau diese Reihenfolge und den Lebenszyklus der erzeugten
 * Object-URL. Die noch **nicht gespeicherte** Dateiauswahl gehört bewusst nicht
 * hierher: Sie ist Formularzustand, kein gespeichertes Logo.
 *
 * Zum Fallback bei Resolver-Fehlern: Er gilt **nur** für die Firmendaten. Dort
 * konkurrieren zwei Darstellungen desselben heutigen Logos, und die ältere zu
 * zeigen ist besser als eine leere Fläche. In einer historischen Rechnung wäre
 * genau das eine stille Fälschung — dort bleibt die strenge Regel aus
 * `brandingAssetResolver` gültig (D-023).
 */
import { useEffect, useState } from 'react';
import type { LogoAssetReference } from '../types/branding';
import { resolveBrandingAsset } from '../services/branding/brandingAssetResolver';

export type CompanyLogoStatus = 'idle' | 'loading' | 'ready' | 'missing';

/** Woher das angezeigte Logo stammt — für Anzeige und Tests gleichermaßen. */
export type CompanyLogoSource = 'branding_asset' | 'legacy' | 'none';

export interface CompanyLogoState {
  status: CompanyLogoStatus;
  url: string | undefined;
  source: CompanyLogoSource;
  /**
   * `true`, wenn eine Asset-Referenz vorlag, aber nicht aufgelöst werden konnte
   * und deshalb das Legacy-Logo einspringt. Die Seite macht das sichtbar, statt
   * still zu tauschen.
   */
  fallbackUsed: boolean;
}

export interface CompanyLogoInput {
  workspaceId: string | undefined;
  logo: LogoAssetReference | undefined;
  logoDataUrl: string | undefined;
}

const EMPTY: CompanyLogoState = {
  status: 'idle',
  url: undefined,
  source: 'none',
  fallbackUsed: false,
};

function legacyState(logoDataUrl: string | undefined, fallbackUsed: boolean): CompanyLogoState {
  if (!logoDataUrl) {
    return { status: 'missing', url: undefined, source: 'none', fallbackUsed };
  }
  // Eine Data-URL ist bereits eine gültige Quelle — nichts zu erzeugen, nichts freizugeben.
  return { status: 'ready', url: logoDataUrl, source: 'legacy', fallbackUsed };
}

export function useCompanyLogoObjectUrl(input: CompanyLogoInput): CompanyLogoState {
  const { workspaceId, logo, logoDataUrl } = input;
  const assetId = logo?.assetId;
  const mimeType = logo?.mimeType;

  const [state, setState] = useState<CompanyLogoState>(() =>
    assetId ? { ...EMPTY, status: 'loading' } : legacyState(logoDataUrl, false),
  );

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | undefined;

    void (async () => {
      if (!assetId || !mimeType) {
        if (!cancelled) setState(legacyState(logoDataUrl, false));
        return;
      }

      if (!workspaceId) {
        /*
         * Ohne Workspace ist die Referenz nicht auflösbar — aber sie ist auch
         * nicht kaputt. Der Legacy-Weg springt ein; als Fehlschlag gilt das
         * trotzdem, damit die Seite es benennen kann.
         */
        if (!cancelled) setState(legacyState(logoDataUrl, true));
        return;
      }

      setState({ ...EMPTY, status: 'loading' });

      let resolved;
      try {
        resolved = await resolveBrandingAsset(workspaceId, { assetId, mimeType });
      } catch {
        if (!cancelled) setState(legacyState(logoDataUrl, true));
        return;
      }
      if (cancelled) return;

      if (!resolved.ok) {
        setState(legacyState(logoDataUrl, true));
        return;
      }

      createdUrl = URL.createObjectURL(resolved.blob);
      setState({
        status: 'ready',
        url: createdUrl,
        source: 'branding_asset',
        fallbackUsed: false,
      });
    })();

    return () => {
      cancelled = true;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
    // Ein Wechsel der `assetId` ist zugleich der Cache-Wechsel: Assets sind
    // unveränderlich, eine neue Kennung bedeutet ein anderes Bild.
  }, [workspaceId, assetId, mimeType, logoDataUrl]);

  return state;
}
