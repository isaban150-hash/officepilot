import { beforeEach } from 'vitest';
import { resetTestStores } from './resetStores';

beforeEach(() => {
  localStorage.clear();
  resetTestStores();
});
