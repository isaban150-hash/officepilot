import type {
  UiSessionEntityType,
  UiSessionWorkspaceType,
} from '../../types/uiSessionSnapshot';

export type UiSessionRouteContext = {
  entityType: UiSessionEntityType;
  entityId: string | null;
  workspaceType: UiSessionWorkspaceType;
  selectedInvoiceId: string | null;
  selectedCustomerId: string | null;
  selectedDocumentId: string | null;
  isTrivialRoute: boolean;
  isAllowedAppRoute: boolean;
};

function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function resolveUiSessionRouteContext(
  pathname: string,
  search = '',
): UiSessionRouteContext {
  const path = pathname || '/';
  const trivial = path === '/' || path === '/start';
  const base: UiSessionRouteContext = {
    entityType: 'none',
    entityId: null,
    workspaceType: trivial ? 'dashboard' : 'other',
    selectedInvoiceId: null,
    selectedCustomerId: null,
    selectedDocumentId: null,
    isTrivialRoute: trivial,
    isAllowedAppRoute: true,
  };

  if (
    path.startsWith('/login') ||
    path.startsWith('/register') ||
    path.startsWith('/reset-password') ||
    path.startsWith('/forgot-password') ||
    path.startsWith('/waiting-approval') ||
    path.startsWith('/access-blocked') ||
    path.startsWith('/license-expired')
  ) {
    return { ...base, isAllowedAppRoute: false, workspaceType: 'none' };
  }

  const ablage = path.match(/^\/ablage\/([^/]+)\/?$/);
  if (ablage) {
    return {
      ...base,
      entityType: 'inbox_item',
      entityId: decodeParam(ablage[1]!),
      workspaceType: 'document_review',
      isTrivialRoute: false,
    };
  }

  const dokument = path.match(/^\/dokumente\/([^/]+)\/?$/);
  if (
    dokument &&
    !['upload', 'hinzufuegen', 'neu'].includes(dokument[1]!)
  ) {
    const id = decodeParam(dokument[1]!);
    return {
      ...base,
      entityType: 'document',
      entityId: id,
      workspaceType: 'archive',
      selectedDocumentId: id,
      isTrivialRoute: false,
    };
  }

  const invoiceDetail = path.match(/^\/vorgaenge\/([^/]+)\/rechnungen\/([^/]+)\/?$/);
  if (invoiceDetail) {
    return {
      ...base,
      entityType: 'invoice',
      entityId: decodeParam(invoiceDetail[1]!),
      workspaceType: 'invoice',
      selectedInvoiceId: decodeParam(invoiceDetail[2]!),
      isTrivialRoute: false,
    };
  }

  const rechnung = path.match(/^\/vorgaenge\/([^/]+)\/rechnung\/?$/);
  if (rechnung) {
    return {
      ...base,
      entityType: 'vorgang',
      entityId: decodeParam(rechnung[1]!),
      workspaceType: 'invoice',
      isTrivialRoute: false,
    };
  }

  const vorgang = path.match(/^\/vorgaenge\/([^/]+)\/?$/);
  if (vorgang) {
    return {
      ...base,
      entityType: 'vorgang',
      entityId: decodeParam(vorgang[1]!),
      workspaceType: 'vorgang',
      isTrivialRoute: false,
    };
  }

  const kunde = path.match(/^\/kunden\/([^/]+)\/?$/);
  if (kunde) {
    const name = decodeParam(kunde[1]!);
    return {
      ...base,
      entityType: 'customer',
      entityId: name,
      workspaceType: 'customer',
      selectedCustomerId: name,
      isTrivialRoute: false,
    };
  }

  const expense = path.match(/^\/ausgaben\/([^/]+)\/?$/);
  if (expense && !['offen', 'neu'].includes(expense[1]!)) {
    return {
      ...base,
      entityType: 'expense',
      entityId: decodeParam(expense[1]!),
      workspaceType: 'other',
      isTrivialRoute: false,
    };
  }

  if (path.startsWith('/dokumente')) {
    return { ...base, workspaceType: 'archive', isTrivialRoute: false };
  }
  if (path.startsWith('/suche')) {
    return { ...base, workspaceType: 'search', isTrivialRoute: false };
  }
  if (path.startsWith('/ablage')) {
    return { ...base, workspaceType: 'document_review', isTrivialRoute: false };
  }

  void search;
  return base;
}

/**
 * GLOBAL-WORKSPACE-CONTINUITY-01B — welche Suchparameter zur **Identität** eines
 * Arbeitsplatzes gehören.
 *
 * Nur diese beiden benennen, *woran* gearbeitet wird: `type` unterscheidet
 * Rechnung, Abschlag und Schlussrechnung desselben Vorgangs (es steckt im
 * Entwurfs-Locator), `draft` benennt einen konkreten Upload-Entwurf.
 *
 * Alles andere — `vtab`, `step`, `from`, `auto` — ist Navigationszustand
 * *innerhalb* desselben Arbeitsplatzes. Würde es in den Schlüssel eingehen,
 * zerfiele eine Vorgangsseite in vier getrennte Arbeitsstände, und ein
 * Tabwechsel liesse die Scrollposition des Nachbartabs auferstehen.
 */
export const UI_SESSION_IDENTITY_SEARCH_PARAMS = ['type', 'draft'] as const;

/**
 * Der stabile Schlüssel eines Arbeitsplatzes: Pfad plus identitätsstiftende
 * Suchparameter in fester Reihenfolge.
 */
export function buildUiSessionRouteKey(pathname: string, search = ''): string {
  const path = pathname || '/';
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  } catch {
    return path;
  }
  const identity = UI_SESSION_IDENTITY_SEARCH_PARAMS.map((name) => {
    const value = params.get(name);
    return value ? `${name}=${value}` : null;
  }).filter((entry): entry is string => entry !== null);
  return identity.length > 0 ? `${path}?${identity.join('&')}` : path;
}

export function routesMatch(
  a: { pathname: string; search: string },
  b: { pathname: string; search: string },
): boolean {
  return (
    buildUiSessionRouteKey(a.pathname, a.search) ===
    buildUiSessionRouteKey(b.pathname, b.search)
  );
}
