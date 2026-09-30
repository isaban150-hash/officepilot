/**
 * FINANZ-CORE-DURABILITY-01D — Steuerberater-Monatsmappe (lokale Supabase).
 *
 *  J/A/D/G  Owner: Rechnung finalisieren, Ausgabe buchen + Zahlung -> Sync ->
 *           Steuerberater -> Monat -> Export: ZIP mit Uebersicht.csv (beide
 *           Kategorien), Zahlungen.csv (Ausgabenzahlung), Rechnungs-PDF,
 *           fehlendes Original der Ausgabe gekennzeichnet.
 *  K        Geraet 2 (zweiter Browser-Kontext) exportiert denselben fachlichen Bestand.
 *  I        Member: serverseitige Freigabe verweigert (RPC), Owner erlaubt.
 *  L/M      Demo-Ausgaben nicht enthalten; leerer Monat sauber gemeldet.
 *  01D2     Rechnung versenden -> stornieren (Korrektur) -> Sync -> Export: Original mit
 *           Status storniert + eigener Rechnungsstorno-Beleg, Korrektur-PDF unter
 *           Stornos_Korrekturen (Same-month im Browser; Cross-month per Unit-Test).
 *  02B      Export nur noch ueber 06C: kontieren -> Monat abschliessen -> Paket
 *           (buchungen.csv, zahlungen.csv, offene Posten, manifest.json, pruefbericht.txt).
 *           Nach dem Storno: wieder oeffnen, begruenden, Revision 2, erneut exportieren;
 *           Original + Storno = 0 ist der Regressionstest fuer die Storno-ID-Kollision.
 */
import JSZip from 'jszip';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';
import { loadTestWorldOperatorCompany } from './support/localTestWorldCompany';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const ANON_KEY = process.env.E2E_LOCALDB_ANON_KEY ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';

let owner: LocalDbUser;
let member: LocalDbUser;
const company = loadTestWorldOperatorCompany();
const admin = () => createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  owner = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'mm-owner' });
  member = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'mm-member' });
});
test.afterAll(async () => {
  for (const user of [owner, member]) {
    if (user) await removeLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, userId: user.id });
  }
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
  await page.getByTestId('setup-contactPerson').fill('Monatsmappe Test');
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
  await page.waitForTimeout(800);
}

async function workspaceIdOf(userId: string): Promise<string> {
  const { data } = await admin().from('workspace_members').select('workspace_id,role').eq('user_id', userId).eq('role', 'owner').limit(1);
  const id = data?.[0]?.workspace_id as string | undefined;
  if (!id) throw new Error('Workspace nicht gefunden');
  return id;
}

async function createFinalizedInvoice(page: Page): Promise<string> {
  await page.goto('/rechnungen/neu', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('1/4', { timeout: 30_000 });
  await page.getByTestId('customer-decision-new').locator('input').check();
  await page.getByTestId('manual-invoice-customer-name').fill('Kunde Monatsmappe GmbH');
  await page.getByTestId('customer-decision-street').fill('Hauptstraße 12');
  await page.getByTestId('customer-decision-zip').fill('45356');
  await page.getByTestId('customer-decision-city').fill('Essen');
  await page.getByTestId('manual-invoice-next').click();
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('2/4');
  await page.getByTestId('manual-position-description').fill('Leistung Monatsmappe');
  await page.getByTestId('manual-position-quantity').fill('1');
  await page.getByTestId('manual-position-unit-price').fill('100');
  await page.getByTestId('manual-position-commit').click();
  await page.getByTestId('manual-invoice-next').click();
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('3/4');
  await page.getByTestId('invoice-edit-service-from').fill('2026-09-01');
  await page.getByTestId('invoice-edit-service-to').fill('2026-09-05');
  await page.getByTestId('manual-invoice-next').click();
  await expect(page.getByTestId('manual-invoice-progress')).toHaveText('4/4');
  const button = page.getByTestId('invoice-approve');
  await button.scrollIntoViewIfNeeded();
  await button.click();
  await page.waitForURL(/\/rechnungen\/inv-[^/]+$/, { timeout: 30_000 });
  await page.waitForTimeout(800);
  return new URL(page.url()).pathname.split('/').pop()!;
}

async function createExpenseWithPayment(page: Page): Promise<string> {
  await page.goto('/ausgaben/neu', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Titel').fill('Schrauben September');
  // Eindeutig: auch das Steuerstatus-Feld nennt „Lieferant“ in seiner Beschriftung.
  await page.getByRole('textbox', { name: 'Lieferant', exact: true }).fill('Baustoff Nord GmbH');
  await page.getByLabel('Rechnungsnummer').fill(`L-${Date.now()}`);
  await page.getByLabel('Rechnungsdatum').fill('2026-09-03');
  await page.getByLabel('Bruttobetrag').fill('60');
  await page.getByRole('button', { name: 'Ausgabe speichern' }).click();
  await page.waitForURL(/\/ausgaben\/exp-/, { timeout: 30_000 });
  const expenseId = new URL(page.url()).pathname.split('/').pop()!;
  await page.getByRole('button', { name: 'Zahlung erfassen' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Zahlungsdatum').fill('2026-09-20');
  await dialog.getByLabel('Betrag').fill('60');
  await dialog.getByRole('button', { name: 'Zahlung speichern' }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  return expenseId;
}

/*
 * 02B — der Export laeuft ausschliesslich ueber den 06C-Weg: kontieren,
 * Monat abschliessen, Paket erstellen. Kein Test-Hack, nur die echte Oberflaeche.
 */
interface ExportedPackage {
  fileName: string;
  paths: string[];
  buchungen: string;
  zahlungen: string;
  offenePosten: string;
  pruefbericht: string;
  manifest: Record<string, unknown>;
  zip: JSZip;
}

/** Kontiert einen Beleg ueber die echte Kontierungsflaeche (06A) und bestaetigt ihn. */
async function kontieren(page: Page, route: string, prefix: 'invoice' | 'ausgabe', account: string, label: string): Promise<void> {
  await page.goto(route, { waitUntil: 'domcontentloaded' });
  const panel = page.getByTestId(`${prefix}-accounting`);
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await panel.scrollIntoViewIfNeeded();
  const start = page.getByTestId(`${prefix}-accounting-start`);
  if (await start.count()) await start.click();
  await page.getByTestId(`${prefix}-accounting-edit`).click();
  await page.getByTestId(`${prefix}-accounting-input-account`).fill(account);
  await page.getByTestId(`${prefix}-accounting-input-label`).fill(label);
  await page.getByTestId(`${prefix}-accounting-save`).click();
  await page.getByTestId(`${prefix}-accounting-confirm`).click();
  await expect(page.getByTestId(`${prefix}-accounting-status`)).toContainText('Bestätigt');
}

async function openMonth(page: Page, monthKey: string): Promise<void> {
  await page.goto('/steuerberater', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('steuerberater-page')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('steuerberater-month-input').selectOption(monthKey);
  // Der alte Monatsmappen-Export existiert nicht mehr — in keinem Schritt.
  await expect(page.getByTestId('steuerberater-export-button')).toHaveCount(0);
}

async function closeMonth(page: Page, monthKey: string): Promise<void> {
  await openMonth(page, monthKey);
  await page.getByTestId('accounting-period-close').click();
  await page.getByTestId('accounting-period-close-confirm').click();
  await expect(page.getByTestId('accounting-period-state')).toHaveText('Abgeschlossen', { timeout: 20_000 });
}

async function exportPackage(page: Page, monthKey: string, revision: number): Promise<ExportedPackage> {
  await openMonth(page, monthKey);
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByTestId('accounting-export-package').click();
  const download = await downloadPromise;
  const fileName = download.suggestedFilename();
  expect(fileName).toBe(`Steuerberater_${monthKey}_Revision-${revision}.zip`);
  const bytes = await (await import('node:fs/promises')).readFile((await download.path())!);
  const zip = await JSZip.loadAsync(bytes);
  const root = `Steuerberater_${monthKey}_Revision-${revision}`;
  const paths = Object.keys(zip.files).filter((p) => !zip.files[p].dir).sort();
  const read = (path: string) => zip.file(`${root}/${path}`)!.async('string');
  return {
    fileName,
    paths,
    zip,
    buchungen: await read('01_Buchungsdaten/buchungen.csv'),
    zahlungen: await read('01_Buchungsdaten/zahlungen.csv'),
    offenePosten: await read('01_Buchungsdaten/offene_posten_monatsende.csv'),
    pruefbericht: await read('00_Abschluss/pruefbericht.txt'),
    manifest: JSON.parse(await read('00_Abschluss/manifest.json')),
  };
}

/** Fachlicher Bestand ohne Zeitstempel: sortierte CSV-Zeilen ohne Kopf- und Summenzeile. */
function businessRows(csv: string): string[] {
  return csv.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean).slice(1).filter((row) => !row.startsWith('Summe;')).sort();
}

async function openSecondDevice(browser: Browser, user: LocalDbUser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, user, false);
  return { context, page };
}

test.describe('FINANZ-CORE-DURABILITY-01D / 02B (lokal)', () => {
  test('06C: Owner schliesst ab und exportiert; Geraet 2 exportiert denselben Bestand; Storno netto 0; Member ohne Freigabe; leerer Monat', async ({ page, browser }) => {
    test.setTimeout(480_000);
    await login(page, owner, true);
    const wsId = await workspaceIdOf(owner.id);

    /* M — leerer, nicht abgeschlossener Monat: kein Exportknopf, der Grund steht da */
    await openMonth(page, '2025-01');
    await expect(page.getByTestId('accounting-export-blocker-not_closed')).toBeVisible();
    await expect(page.getByTestId('accounting-export-package')).toHaveCount(0);
    await expect(page.getByTestId('steuerberater-handover-bank')).toHaveText('Noch nicht verfügbar');

    /* Daten: Rechnung (heute = 2026-09), Ausgabe + Zahlung */
    const invoiceId = await createFinalizedInvoice(page);
    const expenseId = await createExpenseWithPayment(page);

    /* 06A — beide Belege kontieren und bestaetigen */
    await kontieren(page, `/rechnungen/${invoiceId}`, 'invoice', '8400', 'Erlöse 19 %');
    await kontieren(page, `/ausgaben/${expenseId}`, 'ausgabe', '4930', 'Bürobedarf');

    /* 06B — ohne Abschluss kein Paket; nach dem Abschluss genau der 06C-Weg */
    await openMonth(page, '2026-09');
    await expect(page.getByTestId('accounting-export-blocker-not_closed')).toBeVisible();
    await closeMonth(page, '2026-09');
    await runSync(page);

    /* J/A/D/G — Paket auf Geraet 1 */
    await openMonth(page, '2026-09');
    // Fehlender Originalbeleg der Ausgabe: Paket moeglich, aber nicht „vollstaendig“.
    await expect(page.getByTestId('steuerberater-handover')).toHaveAttribute('data-state', 'missing_proofs');
    const pkg1 = await exportPackage(page, '2026-09', 1);
    const root1 = 'Steuerberater_2026-09_Revision-1';
    for (const file of ['01_Buchungsdaten/buchungen.csv', '01_Buchungsdaten/zahlungen.csv', '01_Buchungsdaten/offene_posten_monatsende.csv', '00_Abschluss/manifest.json', '00_Abschluss/pruefbericht.txt']) {
      expect(pkg1.paths).toContain(`${root1}/${file}`);
    }
    const invoicePdfPath = pkg1.paths.find((p) => p.startsWith(`${root1}/02_Ausgangsrechnungen/`) && p.endsWith('.pdf'));
    expect(invoicePdfPath, 'Rechnungs-PDF fehlt').toBeTruthy();
    const pdfHead = await pkg1.zip.file(invoicePdfPath!)!.async('uint8array');
    expect(String.fromCharCode(...pdfHead.slice(0, 5))).toBe('%PDF-');

    const rows1 = businessRows(pkg1.buchungen);
    expect(rows1.some((r) => r.startsWith(`Ausgangsrechnung;${invoiceId};`))).toBe(true);
    const expenseRow = rows1.find((r) => r.startsWith(`Eingangsbeleg;${expenseId};`))!;
    expect(expenseRow).toBeTruthy();
    expect(expenseRow).toContain(';Baustoff Nord GmbH;');
    // Zahlungsstatus zum Monatsende: am 20.09. voll bezahlt.
    expect(expenseRow).toMatch(/;Bezahlt;0,00$/);
    expect(rows1.some((r) => /;exp-\d{3};/.test(r))).toBe(false); // L — Demo-Ausgaben nie
    const pay1 = businessRows(pkg1.zahlungen);
    expect(pay1.some((r) => r.startsWith(`Eingangsbeleg;${expenseId};`) && r.includes(';2026-09-20;60,00;'))).toBe(true);
    // Die unbezahlte Rechnung ist zum Monatsende ein offener Posten.
    expect(businessRows(pkg1.offenePosten).some((r) => r.startsWith(`Forderung;${invoiceId};`))).toBe(true);
    expect((pkg1.manifest.fehlendeNachweise as Array<{ id: string }>).map((e) => e.id)).toContain(expenseId);
    expect(pkg1.manifest.uebergabestatus).toMatchObject({ vollstaendig: false, bankabgleich: 'nicht_verfuegbar' });
    expect(pkg1.pruefbericht).toContain('Originalbeleg fehlt');
    expect(pkg1.pruefbericht).toContain('Bankabgleich: noch nicht verfügbar');

    /* K — Geraet 2 exportiert denselben fachlichen Bestand (Abschluss und Kontierung aus der Cloud) */
    const device2 = await openSecondDevice(browser, owner);
    try {
      const pkg2 = await exportPackage(device2.page, '2026-09', 1);
      expect(businessRows(pkg2.buchungen)).toEqual(rows1);
      expect(businessRows(pkg2.zahlungen)).toEqual(pay1);
      expect(pkg2.paths).toEqual(pkg1.paths);
    } finally {
      await device2.context.close();
    }

    /* 01D2 / 02B-Block 1 — Storno im selben Monat: Original + Storno = 0 (Regressionstest) */
    await page.goto(`/rechnungen/${invoiceId}`, { waitUntil: 'domcontentloaded' });
    // extern als versendet markieren (kein E-Mail-Dienst noetig) -> Storno wird zur Korrektur
    await page.getByTestId('invoice-sent-mark').scrollIntoViewIfNeeded();
    await page.getByTestId('invoice-sent-mark').click();
    await expect(page.getByTestId('invoice-sent-form')).toBeVisible();
    await page.getByTestId('invoice-sent-date-input').fill('2026-09-05');
    await page.getByTestId('invoice-sent-via-input').selectOption('post');
    await page.getByTestId('invoice-sent-continue').click();
    await expect(page.getByTestId('invoice-sent-confirm')).toBeVisible();
    await page.getByTestId('invoice-sent-confirm-submit').click();
    await expect(page.getByTestId('invoice-sent-status')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1000);
    await page.getByTestId('invoice-cancel-action').scrollIntoViewIfNeeded();
    await page.getByTestId('invoice-cancel-action').click();
    await page.getByTestId('invoice-cancel-reason-input').fill('Falscher Betrag');
    await page.getByTestId('invoice-cancel-submit').click();
    await expect(page.getByTestId('invoice-cancel-dialog')).toHaveCount(0, { timeout: 45_000 });
    await runSync(page);

    // Der Storno aendert den abgeschlossenen Monat: bestehender Workflow — oeffnen, begruenden, neu abschliessen.
    await openMonth(page, '2026-09');
    await expect(page.getByTestId('steuerberater-handover')).toHaveAttribute('data-state', 'changed_after_close');
    await expect(page.getByTestId('accounting-export-blocker-changed_after_close')).toBeVisible();
    await page.getByTestId('accounting-period-reopen').click();
    const reopenDialog = page.getByTestId('accounting-period-reopen-dialog');
    await expect(reopenDialog).toBeVisible();
    await reopenDialog.locator('textarea, input[type="text"]').first().fill('Rechnung storniert (Falscher Betrag)');
    await page.getByTestId('accounting-period-reopen-confirm').click();
    await closeMonth(page, '2026-09');
    await expect(page.getByTestId('accounting-period-revision')).toContainText('2');
    await runSync(page);

    const pkg3 = await exportPackage(page, '2026-09', 2);
    const rows3 = businessRows(pkg3.buchungen);
    const original = rows3.find((r) => r.startsWith(`Ausgangsrechnung;${invoiceId};`))!;
    // Belegart im Buchungsexport: „Storno Ausgangsrechnung“.
    const storno = rows3.find((r) => r.startsWith(`Storno Ausgangsrechnung;${invoiceId};`))!;
    expect(original, 'Originalzeile fehlt').toBeTruthy();
    expect(storno, 'Rechnungsstorno-Zeile fehlt (Storno-ID-Kollision)').toBeTruthy();
    expect(original).toContain(';Storniert;ja;');
    expect(storno).toContain(`;${invoiceId}-Storno;`);
    // Summe Original + Storno = 0 (keine Doppelzaehlung, keine verschluckte Stornozeile)
    const brutto = (row: string) => Number(row.split(';')[7].replace('.', '').replace(',', '.'));
    expect(brutto(original)).toBeGreaterThan(0);
    expect(brutto(original) + brutto(storno)).toBe(0);
    const correctionPdf = pkg3.paths.find((p) => p.includes('/04_Stornos_Gutschriften/Korrektur_zu_') && p.endsWith('.pdf'));
    expect(correctionPdf, 'Korrektur-PDF fehlt').toBeTruthy();
    const corrHead = await pkg3.zip.file(correctionPdf!)!.async('uint8array');
    expect(String.fromCharCode(...corrHead.slice(0, 5))).toBe('%PDF-');
    // Die Kontrollsumme der Datei nimmt die stornierte Rechnung nicht mehr mit.
    const summe = pkg3.buchungen.replace(/^﻿/, '').split(/\r?\n/).find((row) => row.startsWith('Summe;'))!;
    const summeBrutto = Number(summe.split(';')[7].replace('.', '').replace(',', '.'));
    expect(summeBrutto).toBeCloseTo(60, 2); // nur noch die Ausgabe

    /* I — Member: serverseitige Freigabe verweigert; Owner erlaubt */
    const { error: memberErr } = await admin().from('workspace_members').insert({ workspace_id: wsId, user_id: member.id, role: 'member', status: 'active' });
    expect(memberErr).toBeNull();
    const memberClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    expect((await memberClient.auth.signInWithPassword({ email: member.email, password: member.password })).error).toBeNull();
    const memberGate = await memberClient.rpc('assert_workspace_finance_export', { p_workspace_id: wsId });
    expect(memberGate.error?.message).toContain('Kein Zugriff');
    const memberExpenses = await memberClient.rpc('pull_workspace_expenses', { p_workspace_id: wsId });
    expect(memberExpenses.error?.message).toContain('Kein Zugriff');
    await memberClient.auth.signOut();
    const ownerClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    expect((await ownerClient.auth.signInWithPassword({ email: owner.email, password: owner.password })).error).toBeNull();
    const ownerGate = await ownerClient.rpc('assert_workspace_finance_export', { p_workspace_id: wsId });
    expect(ownerGate.error).toBeNull();
    expect((ownerGate.data as { allowed: boolean }).allowed).toBe(true);
    await ownerClient.auth.signOut();
  });
});
