/**
 * TEST-INFRA-GOLD-SCHUTZ-01 — der sichere Gesamtlauf: `npm run test:safe`.
 *
 * Dieselben zwei Projekte wie `vitest.config.ts`, mit drei zusätzlichen Sicherungen:
 *  1. Tests mit nicht abgeschaltetem Schreib-Seiteneffekt werden in KEINEM Projekt eingesammelt
 *     (`UNGATED_WRITING_TEST_FILES`). Ein `--exclude` auf der Kommandozeile wirkt bei dieser
 *     Projektkonfiguration nicht; deshalb steht der Ausschluss hier in jedem Projekt.
 *  2. Die Schreibfreigabe der Gold-Berichte ist hart aus — auch wenn die Shell
 *     `GOLD_WRITE_REPORT=1` gesetzt hat. Der Gold-Test läuft und prüft weiter fachlich.
 *  3. Der Schutz-Setup vergleicht die Prüfsummen der geschützten Artefakte vor und nach dem Lauf.
 *
 * Eingesammelte Dateien nachweisen: `npm run test:safe:list`.
 */
import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';
import { UNIT_TEST_FILES } from './src/test/vitestUnitTestFiles';
import { UNGATED_WRITING_TEST_FILES } from './src/test/protectedArtifacts';
import { GOLD_WRITE_REPORT_ENV } from './src/testWorld/goldReportWriteGate';

// Die Schreibfreigabe gilt im sicheren Lauf nie, auch nicht aus der Shell (Hauptprozess und Worker).
delete process.env[GOLD_WRITE_REPORT_ENV];

const unitIncludes = [...UNIT_TEST_FILES];
const writingTests = [...UNGATED_WRITING_TEST_FILES];
const schutzSetup = ['./src/test/protectedArtifactsGlobalSetup.ts'];
const ohneSchreibfreigabe = { [GOLD_WRITE_REPORT_ENV]: '' };

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react()],
        test: {
          name: 'unit',
          environment: 'node',
          include: unitIncludes,
          exclude: [...configDefaults.exclude, ...writingTests],
          env: ohneSchreibfreigabe,
          globalSetup: schutzSetup,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'default',
          environment: 'happy-dom',
          setupFiles: ['./src/test/setup.ts'],
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: [...configDefaults.exclude, ...unitIncludes, ...writingTests],
          env: ohneSchreibfreigabe,
          globalSetup: schutzSetup,
        },
      },
    ],
  },
});
