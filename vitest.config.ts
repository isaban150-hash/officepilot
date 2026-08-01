import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';
import { UNIT_TEST_FILES } from './src/test/vitestUnitTestFiles';

const unitIncludes = [...UNIT_TEST_FILES];

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react()],
        test: {
          name: 'unit',
          environment: 'node',
          include: unitIncludes,
          // No setupFiles: no fake-indexeddb, no resetTestStores, no auth reset.
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'default',
          environment: 'happy-dom',
          setupFiles: ['./src/test/setup.ts'],
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: [...configDefaults.exclude, ...unitIncludes],
        },
      },
    ],
  },
});
