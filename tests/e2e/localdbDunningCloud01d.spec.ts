/**
 * CLOUD-DURABILITY-CORE-01D — Mahndokumentation auf zwei Geräten (lokale Supabase).
 *
 * Bewusst über den **freien Weg**: eine manuelle Rechnung ohne Auftrag. Sie ist
 * der Fall, der bisher am leichtesten verloren ging (`vorgangId === null`), und
 * zugleich der Beweis, dass der Nachweis keinen Auftrag braucht.
 *
 *  A  Gerät 1 erstellt die Rechnung, markiert sie als versendet und
 *     dokumentiert eine Zahlungserinnerung -> Sync -> Gerät 2 sieht denselben
 *     Nachweis in der Historie, mit derselben Mahnstufe.
 *  B  Gerät 2 dokumentiert **dieselbe** Übergabe, bevor es davon weiss ->
 *     Sync -> in der Cloud bleibt genau ein Nachweis, auf beiden Geräten
 *     ebenfalls, ohne liegengebliebenen Sendeauftrag.
 *  C  Neustart: Die Historie und die Mahnstufe bleiben.
 *
 * Echt über die Oberfläche laufen: Rechnungsanlage ohne Auftrag, Freigabe,
 * Versand festhalten, beide Synchronisationen, die Serverentdopplung und die
 * Anzeige des Mahnstands am Beleg.
 *
 * **Nicht** über die Oberfläche erzeugt wird der Nachweis selbst: Er entsteht
 * im Kommunikationsbereich erst, nachdem dort ein Mahn-Entwurf erzeugt wurde
 * (`DunningDocumentationPanel` hängt an `result.intent`). Der lokale
 * Vorzustand wird deshalb in den Speicher geschrieben — genau in der Form, die
 * `documentDunningDelivery` erzeugt und die ein Bestandsgerät vor 01D trägt:
 * ohne Sync-Meta und ohne Sendeauftrag. Alles danach ist echt.
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';
import { loadTestWorldOperatorCompany } from './support/localTestWorldCompany';
import { fillVerified } from './support/verifiedInput';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';

let owner: LocalDbUser;
const company = loadTestWorldOperatorCompany();
const admin = () =>
  createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  owner = await provisionLocalDbUser({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_ROLE_KEY,
    label: 'dunning-owner',
  });
});
test.afterAll(async () => {
  if (owner) await removeLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, userId: owner.id });
});

async function login(page: Page, user: LocalDbUser, setup: boolean): Promise<void> {
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
  if (!setup) throw new Error(`Unerwarteter Einrichtungsschritt fuer ${user.email}: ${landed}`);
  if (landed === 'continue') await page.getByTestId('workspace-setup-continue').click();
  await page.getByTestId('setup-companyName').fill(company.companyName);
  await page.getByTestId('setup-contactPerson').fill('Mahnung Test');
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

async function runSync(page: Page): Promise<void> {
  await page.goto('/synchronisation', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('sync-page')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('sync-run-button').click();
  await expect(page.getByTestId('sync-run-button')).toBeEnabled({ timeout: 60_000 });
  await page.waitForTimeout(1200);
}

interface LocalDunningDoc {
  id: string;
  invoiceId: string;
  vorgangId: string | null;
  invoiceNumber: string;
  kind: string;
  documentedAt: string;
  deliveryMethod: string;
  syncVersion?: number;
}

async function readState(page: Page): Promise<Record<string, unknown>> {
  const raw = await page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)!;
      if (key.startsWith('officepilot-state:workspace:')) return localStorage.getItem(key);
    }
    return null;
  });
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function localDunningDocs(page: Page): Promise<LocalDunningDoc[]> {
  const state = await readState(page);
  return ((state.dunningDocumentations as Array<Record<string, any>>) ?? []).map((doc) => ({
    id: doc.id,
    invoiceId: doc.invoiceId,
    vorgangId: doc.vorgangId ?? null,
    invoiceNumber: doc.invoiceNumber,
    kind: doc.kind,
    documentedAt: doc.documentedAt,
    deliveryMethod: doc.deliveryMethod,
    syncVersion: doc.sync?.version,
  }));
}

async function openDunningOutbox(page: Page): Promise<Array<Record<string, unknown>>> {
  const state = await readState(page);
  return ((state.syncOutbox as Array<Record<string, any>>) ?? []).filter(
    (entry) => entry.entityType === 'dunning_documentation' && entry.status !== 'completed',
  );
}

async function cloudDunningDocs(wsId: string) {
  const { data } = await admin()
    .from('workspace_invoice_dunning_documentations')
    .select('client_documentation_id,client_invoice_id,client_vorgang_id,kind,documented_at,delivery_method,row_version,payload')
    .eq('workspace_id', wsId);
  return data ?? [];
}

async function workspaceIdOf(userId: string): Promise<string> {
  const { data } = await admin()
    .from('workspace_members')
    .select('workspace_id,role')
    .eq('user_id', userId)
    .eq('role', 'owner')
    .limit(1);
  const id = data?.[0]?.workspace_id as string | undefined;
  if (!id) throw new Error('Workspace nicht gefunden');
  return id;
}

async function openSecondDevice(browser: Browser, user: LocalDbUser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, user, false);
  return { context, page };
}

/** Rechnung ohne Auftrag über den vorhandenen Weg „Neue Rechnung". */
async function createFreeInvoice(page: Page, customerName: string): Promise<string> {
  await page.goto('/rechnungen/offen', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('overview-new-invoice')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('overview-new-invoice').click();
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('1/4');

  await page.getByTestId('customer-decision-new').locator('input').check();
  await fillVerified(page.getByTestId('manual-invoice-customer-name'), customerName);
  await fillVerified(page.getByTestId('customer-decision-street'), 'Hauptstraße 12');
  await fillVerified(page.getByTestId('customer-decision-zip'), '45356');
  await fillVerified(page.getByTestId('customer-decision-city'), 'Essen');
  await page.getByTestId('manual-invoice-next').click();
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('2/4');

  await fillVerified(page.getByTestId('manual-position-description'), 'Wartung Heizungsanlage');
  await fillVerified(page.getByTestId('manual-position-quantity'), '1', { expectAfterBlur: '1' });
  await fillVerified(page.getByTestId('manual-position-unit-price'), '250', { expectAfterBlur: '250' });
  await page.getByTestId('manual-position-commit').click();
  await expect(page.getByTestId('manual-positions-list').locator('li')).toHaveCount(1);

  await page.getByTestId('manual-invoice-next').click();
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('3/4');
  await fillVerified(page.getByTestId('invoice-edit-service-from'), '2026-09-01');
  await fillVerified(page.getByTestId('invoice-edit-service-to'), '2026-09-05');
  await page.getByTestId('manual-invoice-next').click();
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('4/4');

  await page.getByTestId('invoice-approve').click();
  await expect(page.getByTestId('invoice-detail-page')).toBeVisible({ timeout: 60_000 });
  return new URL(page.url()).pathname.split('/').pop()!;
}

/** Versand festhalten — erst danach ist eine Rechnung fachlich mahnbar. */
async function markInvoiceSent(page: Page): Promise<void> {
  const mark = page.getByTestId('invoice-sent-mark');
  if (!(await mark.count())) {
    const showMore = page.getByTestId('invoice-detail-show-more');
    if (await showMore.count()) await showMore.getByRole('button').first().click();
  }
  await expect(page.getByTestId('invoice-sent-mark')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('invoice-sent-mark').click();
  await expect(page.getByTestId('invoice-sent-form')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('invoice-sent-continue').click();
  await expect(page.getByTestId('invoice-sent-confirm')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('invoice-sent-confirm-submit').click();
  await expect(page.getByTestId('invoice-sent-status')).toBeVisible({ timeout: 20_000 });
}

/**
 * Der lokale Vorzustand eines Geräts: ein Mahnnachweis ohne Sync-Meta und ohne
 * Sendeauftrag — die Form, die `documentDunningDelivery` erzeugt.
 */
async function seedDocumentation(
  target: Page,
  documentationId: string,
  invoiceId: string,
  invoiceNumber: string,
  documentedAt: string,
  createdAt: string,
): Promise<void> {
  await target.evaluate(
    ({ id, invoice, number, docAt, created }) => {
      for (let i = 0; i < localStorage.length; i += 1) {
        const storageKey = localStorage.key(i)!;
        if (!storageKey.startsWith('officepilot-state:workspace:')) continue;
        const state = JSON.parse(localStorage.getItem(storageKey)!);
        state.dunningDocumentations = [
          ...(state.dunningDocumentations ?? []),
          {
            id,
            vorgangId: null,
            invoiceId: invoice,
            invoiceNumber: number,
            kind: 'payment_reminder',
            documentedAt: docAt,
            deliveryMethod: 'email',
            createdAt: created,
          },
        ];
        localStorage.setItem(storageKey, JSON.stringify(state));
        return;
      }
    },
    { id: documentationId, invoice: invoiceId, number: invoiceNumber, docAt: documentedAt, created: createdAt },
  );
  await target.reload({ waitUntil: 'domcontentloaded' });
  await expect(target.getByTestId('app-shell')).toBeVisible({ timeout: 60_000 });
  await target.waitForTimeout(1500);
}

test.describe('CLOUD-DURABILITY-CORE-01D (lokal)', () => {
  test('A–C: Mahnnachweis erreicht das zweite Gerät und bleibt einer', async ({ page, browser }) => {
    test.setTimeout(900_000);
    await login(page, owner, true);
    const wsId = await workspaceIdOf(owner.id);

    /* ---------------- Vorbereitung: freie Rechnung, als versendet festgehalten ---------------- */
    const invoiceId = await createFreeInvoice(page, 'Mahnung Kunde GmbH');
    await markInvoiceSent(page);
    // Die Rechnungsnummer noch auf der Belegseite lesen — der Sync verlaesst sie.
    const invoiceNumber = await page
      .getByTestId('invoice-detail-header')
      .textContent()
      .then((value) => value?.match(/\d{4}-\d{4}/)?.[0] ?? '');
    expect(invoiceNumber, 'keine Rechnungsnummer gefunden').toMatch(/\d{4}-\d{4}/);

    await runSync(page);


    const device2 = await openSecondDevice(browser, owner);
    try {
      /* ---------------- Fall A: Nachweis von Gerät 1 erreicht Gerät 2 ---------------- */
      const documentedAt = '2026-09-18';
      await seedDocumentation(page, 'dun-device-a', invoiceId, invoiceNumber, documentedAt, '2026-09-18T09:00:00.000Z');

      const local1 = await localDunningDocs(page);
      expect(local1).toHaveLength(1);
      expect(local1[0].vorgangId).toBeNull();
      /*
       * Die Serverversion wird hier bewusst **nicht** geprüft: Der Neustart nach
       * dem Setzen des Vorzustands fährt den Betrieb neu hoch, und dabei holt der
       * Backfill den Altbestand bereits in die Cloud. Genau das ist die Zusage
       * dieses Blocks — dass sie greift, zeigt die folgende Cloud-Prüfung.
       */

      await runSync(page);
      const cloud1 = await cloudDunningDocs(wsId);
      expect(cloud1, 'Nachweis fehlt in der Cloud').toHaveLength(1);
      expect(cloud1[0].client_documentation_id).toBe('dun-device-a');
      expect(cloud1[0].client_vorgang_id).toBeNull();
      expect(cloud1[0].client_invoice_id).toBe(invoiceId);
      expect((cloud1[0].payload as Record<string, unknown>).invoiceNumber).toBe(invoiceNumber);
      expect(await openDunningOutbox(page)).toEqual([]);

      await runSync(device2.page);
      const local2 = await localDunningDocs(device2.page);
      expect(local2.map((doc) => doc.id)).toEqual(['dun-device-a']);
      expect(local2[0].invoiceNumber).toBe(invoiceNumber);
      expect(local2[0].documentedAt).toBe(documentedAt);

      // Der dokumentierte Mahnstand steht sichtbar am Beleg.
      await device2.page.goto(`/rechnungen/${invoiceId}`, { waitUntil: 'domcontentloaded' });
      await expect(device2.page.getByTestId('invoice-detail-page')).toBeVisible({ timeout: 30_000 });
      await expect(device2.page.getByTestId('invoice-dunning-status')).toBeVisible({ timeout: 20_000 });
      await expect(device2.page.getByTestId('invoice-dunning-status')).not.toContainText('dun-device-a');

      /* ---------------- Fall B: beide Geräte halten dieselbe Übergabe fest ---------------- */
      /*
       * Gerät 2 hat denselben Nachweis unabhängig erzeugt — andere Kennung,
       * gleiche fachliche Identität (Rechnung, kein Auftrag, Art, Datum, Weg).
       */
      await seedDocumentation(
        device2.page,
        'dun-device-b',
        invoiceId,
        invoiceNumber,
        documentedAt,
        '2026-09-18T09:00:05.000Z',
      );
      await runSync(device2.page);

      expect(await cloudDunningDocs(wsId)).toHaveLength(1);
      const after2 = await localDunningDocs(device2.page);
      expect(after2).toHaveLength(1);
      expect(after2[0].id).toBe('dun-device-a');
      expect(await openDunningOutbox(device2.page)).toEqual([]);

      await runSync(page);
      expect(await localDunningDocs(page)).toHaveLength(1);
      expect(await openDunningOutbox(page)).toEqual([]);

      /* ---------------- Fall C: Neustart ---------------- */
      await device2.page.reload({ waitUntil: 'domcontentloaded' });
      await expect(device2.page.getByTestId('app-shell')).toBeVisible({ timeout: 60_000 });
      await device2.page.waitForTimeout(1500);
      const afterReload = await localDunningDocs(device2.page);
      expect(afterReload).toHaveLength(1);
      expect(afterReload[0].invoiceNumber).toBe(invoiceNumber);
      expect(afterReload[0].documentedAt).toBe(documentedAt);

      await device2.page.goto(`/rechnungen/${invoiceId}`, { waitUntil: 'domcontentloaded' });
      await expect(device2.page.getByTestId('invoice-dunning-status')).toBeVisible({ timeout: 30_000 });
      const overflow = await device2.page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);

      expect(await cloudDunningDocs(wsId)).toHaveLength(1);
    } finally {
      await device2.context.close();
    }
  });
});
