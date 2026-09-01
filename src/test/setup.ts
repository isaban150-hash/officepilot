import 'fake-indexeddb/auto';
import './supabaseMockSetup';
import './invoicePdfFontSetup';
import { resetAuthForTests } from './authFixtures';
import { beforeEach } from 'vitest';
import { resetTestStores } from './resetStores';
import { setActiveStorageScope } from '../services/storage/storageScopeService';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

beforeEach(() => {
  setActiveStorageScope({ type: 'guest' });
  localStorage.clear();
  sessionStorage.clear();
  resetTestStores();
  resetAuthForTests();
});
