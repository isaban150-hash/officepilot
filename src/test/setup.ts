import 'fake-indexeddb/auto';
import './supabaseMockSetup';
import { resetAuthForTests } from './authFixtures';
import { beforeEach } from 'vitest';
import { resetTestStores } from './resetStores';
import { resetDocumentBlobDatabaseForTests } from '../services/storage/documentBlobIndexedDbService';
import { setActiveStorageScope } from '../services/storage/storageScopeService';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

beforeEach(async () => {
  setActiveStorageScope({ type: 'guest' });
  localStorage.clear();
  sessionStorage.clear();
  await resetDocumentBlobDatabaseForTests();
  resetTestStores();
  resetAuthForTests();
});
