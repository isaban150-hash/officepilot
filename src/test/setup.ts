import './supabaseMockSetup';
import './adminAccessTestBridge';
import { resetAuthForTests } from './authFixtures';
import { beforeEach } from 'vitest';
import { resetTestStores } from './resetStores';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetTestStores();
  resetAuthForTests();
});
