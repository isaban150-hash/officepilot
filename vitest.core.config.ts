import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import {
  CORE_DEFAULT_TEST_FILES,
  CORE_UNIT_TEST_FILES,
} from './src/test/vitestCoreTestFiles';

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react()],
        test: {
          name: 'core-unit',
          environment: 'node',
          include: [...CORE_UNIT_TEST_FILES],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'core-default',
          environment: 'happy-dom',
          setupFiles: ['./src/test/setup.ts'],
          include: [...CORE_DEFAULT_TEST_FILES],
        },
      },
    ],
  },
});
