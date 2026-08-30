/**
 * BRANDING-01D — lokaler Cache für Branding-Assets.
 *
 * Eine **eigene** kleine Datenbank, bewusst getrennt von den vorhandenen:
 * `officepilot-document-blobs` trägt Scope-Migration, Quarantäne und
 * Inventarisierung, `officepilot-upload-drafts` gehört zum Upload-Verlauf.
 * Branding braucht nichts davon. Einen Objektspeicher in eine dieser
 * Datenbanken zu hängen, würde deren Version erhöhen und damit ein
 * Migrationsrisiko für Dokumente erzeugen — für ein paar Logodateien.
 *
 * Das Repository macht es bereits so: jede Aufgabe ihre eigene Datenbank auf
 * Version 1. Diese hier ist die dritte.
 *
 * Kein Löschen in V1, keine Bereinigung, keine Inventarisierung. Ein Logo
 * wiegt Kilobytes, und ein gelöschter Cacheeintrag zu einem unveränderlichen
 * Asset brächte nichts ein.
 */
export const BRANDING_ASSET_DB_NAME = 'officepilot-branding-assets';
export const BRANDING_ASSET_DB_VERSION = 1;
export const BRANDING_ASSET_STORE_NAME = 'branding_assets';

/**
 * Abgelegt werden die rohen Bytes plus der MIME-Typ — nicht der `Blob` selbst.
 *
 * Grund ist die Testumgebung: `fake-indexeddb` unter happy-dom gibt einen
 * gespeicherten `Blob` als einfaches Objekt zurück, sodass Cache und Resolver
 * dort nicht prüfbar wären. Echte Browser können Blobs; die Ablage als
 * `ArrayBuffer` funktioniert aber überall gleich.
 *
 * Verlustfrei und ohne Umkodierung: dieselben Bytes, derselbe Typ. Kein
 * Base64, keine Zeichenkette, keine Kompression. Nach aussen bleibt der
 * Vertrag Blob-basiert — die Umwandlung geschieht ausschliesslich hier.
 */
interface BrandingAssetCacheEntry {
  /** `<workspaceId>/<assetId>` — der Workspace gehört in den Schlüssel. */
  key: string;
  bytes: ArrayBuffer;
  mimeType: string;
}

/**
 * Der Workspace ist Teil des Schlüssels, nicht nur die Kennung: Auf einem Gerät
 * können nacheinander verschiedene Workspaces angemeldet sein, und deren
 * Assets dürfen sich nicht vermischen.
 */
export function buildBrandingAssetCacheKey(workspaceId: string, assetId: string): string {
  return `${workspaceId}/${assetId}`;
}

function getIndexedDbFactory(): IDBFactory | null {
  return typeof indexedDB === 'undefined' ? null : indexedDB;
}

function openDatabase(): Promise<IDBDatabase | null> {
  const factory = getIndexedDbFactory();
  if (!factory) return Promise.resolve(null);

  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(BRANDING_ASSET_DB_NAME, BRANDING_ASSET_DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BRANDING_ASSET_STORE_NAME)) {
        db.createObjectStore(BRANDING_ASSET_STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    // Ein nicht verfügbarer Cache ist kein Fehler — dann wird eben geladen.
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

/** Liefert den gespeicherten Blob oder `null`. Ein eigenes `has` erübrigt sich. */
export async function getCachedBrandingAsset(
  workspaceId: string,
  assetId: string,
): Promise<Blob | null> {
  const db = await openDatabase();
  if (!db) return null;

  try {
    return await new Promise<Blob | null>((resolve) => {
      const transaction = db.transaction(BRANDING_ASSET_STORE_NAME, 'readonly');
      const request = transaction
        .objectStore(BRANDING_ASSET_STORE_NAME)
        .get(buildBrandingAssetCacheKey(workspaceId, assetId));
      request.onsuccess = () => {
        const entry = request.result as BrandingAssetCacheEntry | undefined;
        if (!entry || !(entry.bytes instanceof ArrayBuffer) || typeof entry.mimeType !== 'string') {
          resolve(null);
          return;
        }
        // Dieselben Bytes, derselbe Typ — der Aufrufer sieht wieder einen Blob.
        resolve(new Blob([entry.bytes], { type: entry.mimeType }));
      };
      request.onerror = () => resolve(null);
    });
  } finally {
    db.close();
  }
}

/**
 * Nimmt einen Blob entgegen und legt dessen Bytes ab. Die öffentliche
 * Schnittstelle bleibt damit Blob-basiert; die Ablageform ist eine reine
 * Innensache dieser Datei.
 */
export async function putCachedBrandingAsset(
  workspaceId: string,
  assetId: string,
  blob: Blob,
): Promise<boolean> {
  let bytes: ArrayBuffer;
  try {
    bytes = await blob.arrayBuffer();
  } catch {
    return false;
  }

  const db = await openDatabase();
  if (!db) return false;

  try {
    return await new Promise<boolean>((resolve) => {
      const transaction = db.transaction(BRANDING_ASSET_STORE_NAME, 'readwrite');
      const entry: BrandingAssetCacheEntry = {
        key: buildBrandingAssetCacheKey(workspaceId, assetId),
        bytes,
        mimeType: blob.type,
      };
      transaction.objectStore(BRANDING_ASSET_STORE_NAME).put(entry);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
    });
  } finally {
    db.close();
  }
}
