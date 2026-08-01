import { beforeEach } from 'vitest';
import { clearDocumentBlobStoreForTests } from '../services/storage/documentBlobIndexedDbService';

/**
 * Register in suites that write real document blobs to IndexedDB.
 * Global setup no longer wipes the blob DB on every test.
 */
export function useDocumentBlobDatabaseReset(): void {
  beforeEach(async () => {
    await clearDocumentBlobStoreForTests();
  });
}
