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
  await page.getByLabel('Lieferant').fill('Baustoff Nord GmbH');
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

interface ExportedPackage { paths: string[]; uebersicht: string; zahlungen: string; manifest: Record<string, unknown>; zip: JSZip }
async function exportMonth(page: Page, monthKey: string): Promise<ExportedPackage> {
  await page.goto('/steuerberater', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('steuerberater-page')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('steuerberater-month-input').selectOption(monthKey);
  await page.getByTestId('steuerberater-prepare-folder').click();
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByTestId('steuerberater-export-button').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`OfficePilot_Steuerberater_${monthKey}.zip`);
  await expect(page.getByTestId('steuerberater-export-result')).toBeVisible({ timeout: 30_000 });
  const path = await download.path();
  const bytes = await (await import('node:fs/promises')).readFile(path!);
  const zip = await JSZip.loadAsync(bytes);
  const paths = Object.keys(zip.files).filter((p) => !zip.files[p].dir).sort();
  return {
    paths,
    zip,
    uebersicht: await zip.file(`${monthKey}/Uebersicht.csv`)!.async('string'),
    zahlungen: await zip.file(`${monthKey}/Zahlungen.csv`)!.async('string'),
    manifest: JSON.parse(await zip.file(`${monthKey}/Manifest.json`)!.async('string')),
  };
}

/** Fachlicher Bestand ohne Zeitstempel: sortierte CSV-Zeilen. */
function businessRows(csv: string): string[] {
  return csv.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean).slice(1).sort();
}

async function openSecondDevice(browser: Browser, user: LocalDbUser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, user, false);
  return { context, page };
}

test.describe('FINANZ-CORE-DURABILITY-01D (lokal)', () => {
  test('Owner exportiert Monatsmappe; Geraet 2 exportiert denselben Bestand; Member ohne Freigabe; leerer Monat', async ({ page, browser }) => {
    test.setTimeout(420_000);
    await login(page, owner, true);
    const wsId = await workspaceIdOf(owner.id);

    /* M — leerer Monat, sauber gemeldet, kein Download */
    await page.goto('/steuerberater', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('steuerberater-month-input').selectOption('2025-01');
    await page.getByTestId('steuerberater-prepare-folder').click();
    await page.getByTestId('steuerberater-export-button').click();
    await expect(page.getByTestId('steuerberater-export-empty')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('steuerberater-export-result')).toHaveCount(0);

    /* Daten: Rechnung (heute = 2026-09), Ausgabe + Zahlung */
    const invoiceId = await createFinalizedInvoice(page);
    const expenseId = await createExpenseWithPayment(page);
    await runSync(page);

    /* J/A/D/G — Export auf Geraet 1 */
    const pkg1 = await exportMonth(page, '2026-09');
    expect(pkg1.paths).toContain('2026-09/Uebersicht.csv');
    expect(pkg1.paths).toContain('2026-09/Zahlungen.csv');
    expect(pkg1.paths).toContain('2026-09/Manifest.json');
    expect(pkg1.paths).toContain('2026-09/Fehlende_Dokumente.txt');
    const invoicePdfPath = pkg1.paths.find((p) => p.startsWith('2026-09/Ausgangsrechnungen/') && p.endsWith('.pdf'));
    expect(invoicePdfPath, 'Rechnungs-PDF fehlt').toBeTruthy();
    const pdfHead = await pkg1.zip.file(invoicePdfPath!)!.async('uint8array');
    expect(String.fromCharCode(...pdfHead.slice(0, 5))).toBe('%PDF-');

    const rows1 = businessRows(pkg1.uebersicht);
    expect(rows1.some((r) => r.startsWith(`Ausgangsrechnung;${invoiceId};`))).toBe(true);
    const expenseRow = rows1.find((r) => r.startsWith(`Eingangsbeleg;${expenseId};`))!;
    expect(expenseRow).toBeTruthy();
    expect(expenseRow).toContain(';Baustoff Nord GmbH;');
    expect(expenseRow).toContain(';bezahlt;60,00;nein;');
    expect(rows1.some((r) => /;exp-\d{3};/.test(r))).toBe(false); // L — Demo-Ausgaben nie
    const pay1 = businessRows(pkg1.zahlungen);
    expect(pay1.some((r) => r.startsWith(`Eingangsbeleg;${expenseId};`) && r.includes(';2026-09-20;60,00;'))).toBe(true);
    expect((pkg1.manifest.fehlendeDokumente as Array<{ id: string }>).map((e) => e.id)).toEqual([expenseId]);
    await expect(page.getByTestId('steuerberater-export-missing-documents')).toBeVisible();

    /* K — Geraet 2 */
    const device2 = await openSecondDevice(browser, owner);
    try {
      const pkg2 = await exportMonth(device2.page, '2026-09');
      expect(businessRows(pkg2.uebersicht)).toEqual(rows1);
      expect(businessRows(pkg2.zahlungen)).toEqual(pay1);
      expect(pkg2.paths).toEqual(pkg1.paths);
    } finally {
      await device2.context.close();
    }

    /* 01D2 — Storno/Korrektur ueber den echten UI-Pfad */
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
    const pkg3 = await exportMonth(page, '2026-09');
    const rows3 = businessRows(pkg3.uebersicht);
    const original = rows3.find((r) => r.startsWith(`Ausgangsrechnung;${invoiceId};`))!;
    expect(original).toContain(';storniert;storniert;0,00;ja;Ausgangsrechnungen/');
    const storno = rows3.find((r) => r.startsWith(`Rechnungsstorno;${invoiceId};`))!;
    expect(storno, 'Rechnungsstorno-Zeile fehlt').toBeTruthy();
    expect(storno).toContain(';-100,00;-19,00;-119,00;storno;storniert;0,00;ja;Stornos_Korrekturen/Korrektur_zu_');
    const correctionPdf = pkg3.paths.find((p) => p.startsWith('2026-09/Stornos_Korrekturen/Korrektur_zu_') && p.endsWith('.pdf'));
    expect(correctionPdf, 'Korrektur-PDF fehlt').toBeTruthy();
    const corrHead = await pkg3.zip.file(correctionPdf!)!.async('uint8array');
    expect(String.fromCharCode(...corrHead.slice(0, 5))).toBe('%PDF-');
    expect((pkg3.manifest.counts as Record<string, number>).stornos).toBe(1);
    // Summe Original + Storno = 0 (keine Doppelzaehlung)
    const brutto = (row: string) => Number(row.split(';')[7].replace(',', '.'));
    expect(brutto(original) + brutto(storno)).toBe(0);

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
