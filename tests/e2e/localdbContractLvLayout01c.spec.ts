/**
 * INBOX-CONTRACT-REALDEVICE-LAYOUT-01C — Vertragszusammenfassung, Zeile
 * „Leistungsverzeichnis / N Positionen".
 *
 * Realbefund (iPhone): Label und Wert liefen zu „Leistungsverzeichnis11 Positionen"
 * zusammen; bei größerer Schrift überlagerten sich die Boxen.
 *
 * Kontrollfall: DOC-00036 (Werkvertrag mit Leistungsverzeichnis, drei
 * Positionen) über den echten Upload-Weg gegen die lokale Supabase-Instanz.
 * Geprüft wird die Geometrie, nicht nur der Text: Wert unterhalb des Labels,
 * keine Überlappung, kein horizontaler Überlauf — auch bei 390/360 px Breite
 * und bei erhöhter Textskalierung (Root-Schriftgröße 24 px).
 */
import { expect, test, type Page } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';
import { loadTestWorldOperatorCompany } from './support/localTestWorldCompany';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';
const DOC_00036_PDF = 'test-world/documents/DOC-00036/source.pdf';

let user: LocalDbUser;
const company = loadTestWorldOperatorCompany();

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  user = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'lv-layout' });
});
test.afterAll(async () => {
  if (user) await removeLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, userId: user.id });
});

async function loginAndSetup(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('login-email').fill(user.email);
  await page.getByTestId('login-password').fill(user.password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-page')).toBeHidden({ timeout: 30_000 });
  const landed = await Promise.race([
    page.getByTestId('app-shell').waitFor({ timeout: 30_000 }).then(() => 'shell' as const),
    page.getByTestId('workspace-setup-continue').waitFor({ timeout: 30_000 }).then(() => 'continue' as const),
    page.getByTestId('setup-companyName').waitFor({ timeout: 30_000 }).then(() => 'wizard' as const),
  ]);
  if (landed === 'shell') return;
  if (landed === 'continue') await page.getByTestId('workspace-setup-continue').click();
  await page.getByTestId('setup-companyName').fill(company.companyName);
  await page.getByTestId('setup-contactPerson').fill('Layout Test');
  await page.getByTestId('setup-street').fill(company.street);
  await page.getByTestId('setup-zip').fill(company.zip);
  await page.getByTestId('setup-city').fill(company.city);
  await page.getByTestId('setup-email').fill(company.email);
  await page.getByTestId('setup-next').click();
  await page.getByTestId('setup-taxNumber').fill(company.taxNumber);
  if (company.vatId) await page.getByTestId('setup-vatId').fill(company.vatId);
  await page.getByTestId('setup-next').click();
  await page.getByTestId('setup-iban').fill(company.iban);
  await page.getByTestId('setup-next').click();
  await page.getByTestId('setup-next').click();
  await page.getByTestId('setup-next').click();
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1500);
}

/** Echter Upload-Weg bis zur analysierten Ablage-Detailseite (wie DOC-00001-Helfer, hier DOC-00036). */
async function uploadDoc00036ToAnalyzedDetail(page: Page): Promise<void> {
  await page.goto('/dokumente/upload', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('document-upload-page')).toBeVisible();
  await page.getByTestId('document-upload-input').setInputFiles(DOC_00036_PDF);
  await expect(page.getByTestId('ocr-preview-panel')).toBeVisible();
  await expect(page.getByTestId('ocr-confirm-error')).toHaveCount(0);
  await expect(page.getByTestId('ocr-storage-decision-actions')).toBeVisible();
  await expect(page.getByTestId('storage-decision-save-permanently')).toBeVisible();
  await page.getByTestId('storage-decision-save-permanently').click();
  await expect(page.getByTestId('ablage-detail-page')).toBeVisible();
  await expect(page.getByTestId('eingang-detail-analysis-error')).toHaveCount(0);
  await expect(page.getByTestId('eingang-detail-analysis-loading')).toHaveCount(0);
  await expect(page.getByTestId('eingang-detail-analysis-pending')).toHaveCount(0);
  await expect(page.getByTestId('eingang-assist-flow')).toBeVisible();
}

interface LvGeometry {
  label: { x: number; y: number; w: number; h: number; text: string };
  value: { x: number; y: number; w: number; h: number; text: string };
  display: string;
  lines: string[];
  overflow: number;
  summaryOverflow: number;
}

async function measureLv(page: Page): Promise<LvGeometry> {
  const lv = page.getByTestId('contract-workspace-summary-lv');
  await lv.scrollIntoViewIfNeeded();
  return lv.evaluate((el) => {
    const rect = (node: Element | null) => {
      const b = node!.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height, text: (node!.textContent ?? '').trim() };
    };
    const summary = el.closest('[data-testid="contract-workspace-summary"]') ?? el;
    return {
      label: rect(el.querySelector('.contract-workspace-summary__metric-label')),
      value: rect(el.querySelector('.contract-workspace-summary__metric-value')),
      display: getComputedStyle(el).display,
      lines: (el as HTMLElement).innerText.split('\n').map((line) => line.trim()).filter(Boolean),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      summaryOverflow: summary.scrollWidth - summary.clientWidth,
    };
  });
}

/** Screenshots landen im Testergebnis; optional (Sichtprüfung) in einem eigenen Ordner. */
function shotPath(info: { project: { name: string }; outputPath: (name: string) => string }, name: string): string {
  const dir = process.env.E2E_LV_SHOT_DIR;
  return dir ? `${dir}/${info.project.name}-${name}` : info.outputPath(name);
}

function expectSeparated(geometry: LvGeometry, label: string): void {
  const { label: l, value: v } = geometry;
  expect(l.text, `${label}: Label`).toBe('Leistungsverzeichnis');
  expect(v.text, `${label}: Wert`).toMatch(/^\d+ Positionen$/);
  // Wert ist ein eigener Layoutbereich unterhalb des Labels — keine Überlappung.
  expect(v.y, `${label}: Wert liegt nicht unter dem Label (Wert y=${v.y}, Label unten=${l.y + l.h})`).toBeGreaterThanOrEqual(l.y + l.h - 1);
  const overlapX = Math.min(l.x + l.w, v.x + v.w) - Math.max(l.x, v.x);
  const overlapY = Math.min(l.y + l.h, v.y + v.h) - Math.max(l.y, v.y);
  expect(overlapX > 1 && overlapY > 1, `${label}: Boxen überlappen (x ${overlapX}, y ${overlapY})`).toBe(false);
  // Zwei eigene Zeilen — keine Verkettung „Leistungsverzeichnis3 Positionen".
  expect(geometry.lines[0], `${label}: erste Zeile`).toBe('Leistungsverzeichnis');
  expect(geometry.lines[1], `${label}: zweite Zeile`).toMatch(/^\d+ Positionen$/);
  expect(geometry.overflow, `${label}: horizontaler Seitenüberlauf`).toBeLessThanOrEqual(1);
  expect(geometry.summaryOverflow, `${label}: Überlauf in der Vertragszusammenfassung`).toBeLessThanOrEqual(1);
}

test.describe('INBOX-CONTRACT-REALDEVICE-LAYOUT-01C — Leistungsverzeichnis-Zeile', () => {
  test('Label und Positionsanzahl sind visuell getrennt — normal und bei erhöhter Textskalierung', async ({ page }, info) => {
    test.setTimeout(240_000);
    await loginAndSetup(page);
    await uploadDoc00036ToAnalyzedDetail(page);

    const lv = page.getByTestId('contract-workspace-summary-lv');
    await expect(lv).toBeVisible({ timeout: 30_000 });
    await expect(lv).toContainText('Positionen');

    const normal = await measureLv(page);
    await lv.screenshot({ path: shotPath(info, 'lv-normal.png') });
    expectSeparated(normal, `${info.project.name} normal`);

    // Erhöhte Textskalierung (Safari „Größerer Text" / Systemschrift): Root-Schrift 24 px.
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '24px';
    });
    await page.waitForTimeout(300);
    const scaled = await measureLv(page);
    await lv.screenshot({ path: shotPath(info, 'lv-scaled.png') });
    expectSeparated(scaled, `${info.project.name} skaliert 24px`);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '';
    });
  });
});
