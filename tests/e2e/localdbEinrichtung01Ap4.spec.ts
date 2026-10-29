/**
 * EINRICHTUNG-01 (AP3/AP4) — E-Nachweise von SCHWARZ gegen die LOKALE Supabase (Katalog V3, Prüfweg E):
 *
 *  K-06  Kontoseite bei 360, 390 und 1280 px: kein horizontales Scrollen, Bedienflächen mindestens 44 px, Aufnahmen
 *  M     drei Konten: Inhaber lädt ein → Eingeladene (wartend, ohne Lizenz) meldet sich an und nimmt an → Rechte als
 *        Mitglied → Inhaber stuft auf Admin → Rechte als Admin → Inhaber entfernt sie während der Sitzung → nächster
 *        Serveraufruf: Zugang entzogen, Hinweis; ein drittes Konto öffnet eine fremde Einladung → abgewiesen (M-04.1)
 *
 * Synthetische Konten über die GoTrue-Admin-API (Kennwort je Lauf, nur im Speicher); sie werden am Ende entfernt.
 * Aufnahmen: pruefunterlagen/einrichtung-01/belege/ap4/e2e/.
 */
import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { provisionLocalDbUser, removeLocalDbUser, type LocalDbUser } from './support/localDbUser';
import { loadTestWorldOperatorCompany } from './support/localTestWorldCompany';

const SUPABASE_URL = process.env.E2E_LOCALDB_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.E2E_LOCALDB_SERVICE_ROLE_KEY ?? '';
const BELEGE = 'pruefunterlagen/einrichtung-01/belege/ap4/e2e';
const company = loadTestWorldOperatorCompany();

let owner: LocalDbUser;
let eingeladen: LocalDbUser;
let fremd: LocalDbUser;

const adminHeaders = () => ({ apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' });

/** Ein wartendes Konto ohne Lizenz, aber mit Zustimmung zur geltenden Fassung (so kommt es von der Registrierung). */
async function wartendesKonto(label: string): Promise<LocalDbUser> {
  const email = `e2e-${label}-${Date.now().toString(36)}@example.invalid`;
  const password = `Pw-${randomBytes(12).toString('base64url')}`;
  const created = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { firstName: 'E2E', lastName: label } }),
  });
  if (!created.ok) throw new Error(`Testnutzer ${label} nicht angelegt (${created.status})`);
  const user = (await created.json()) as { id: string };
  const consent = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`, {
    method: 'PATCH',
    headers: { ...adminHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({
      accepted_terms_version: '1.0-draft',
      accepted_privacy_version: '1.0-draft',
      accepted_license_version: '1.0-draft',
      legal_accepted_at: new Date().toISOString(),
    }),
  });
  if (!consent.ok) throw new Error(`Zustimmung für ${label} nicht gesetzt (${consent.status})`);
  return { id: user.id, email, password };
}

test.beforeAll(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('E2E_LOCALDB_* fehlen (nur lokal).');
  owner = await provisionLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, label: 'ein01-owner' });
  eingeladen = await wartendesKonto('ein01-eingeladen');
  fremd = await wartendesKonto('ein01-fremd');
});

/**
 * Aufräumen nur für die IDs dieses Laufs: Betriebe des Inhabers samt aller Zeilen mit `workspace_id` (die Prüfspur ist
 * unveränderlich; der Trigger wird dafür nur in dieser einen Anweisungsfolge ausgesetzt), danach die Konten. Lokal über
 * den Datenbank-Container, wie die SQL-Treiber.
 */
function betriebeEntfernen(ids: string[]): void {
  const liste = ids.map((id) => `'${id}'`).join(', ');
  const sql = `
alter table public.workspace_member_events disable trigger einrichtung01_audit_immutable;
do $$
declare t record; w record; v_rest int; v_runde int;
begin
  for w in select id from public.workspaces where owner_user_id in (${liste}) loop
    v_rest := 1; v_runde := 0;
    while v_rest > 0 and v_runde < 8 loop
      v_rest := 0; v_runde := v_runde + 1;
      for t in select c.table_name from information_schema.columns c
               join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name and x.table_type = 'BASE TABLE'
               where c.table_schema = 'public' and c.column_name = 'workspace_id' loop
        begin
          execute format('delete from public.%I where workspace_id = %L', t.table_name, w.id);
        exception when foreign_key_violation then v_rest := v_rest + 1;
        end;
      end loop;
    end loop;
    delete from public.workspaces where id = w.id;
  end loop;
  delete from public.einrichtung_request_log where actor_user_id in (${liste});
  delete from public.workspace_invitation_attempts where user_id in (${liste});
  delete from public.workspace_members where user_id in (${liste});
end $$;
alter table public.workspace_member_events enable trigger einrichtung01_audit_immutable;`;
  const r = spawnSync('docker', ['exec', '-i', 'supabase_db_officepilot', 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`Aufräumen fehlgeschlagen: ${(r.stderr || '').slice(0, 300)}`);
}

test.afterAll(async () => {
  const ids = [owner, eingeladen, fremd].filter(Boolean).map((u) => u.id);
  if (ids.length > 0) betriebeEntfernen(ids);
  for (const user of [eingeladen, fremd, owner]) {
    if (user) await removeLocalDbUser({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, userId: user.id });
  }
});

async function anmelden(page: Page, user: LocalDbUser): Promise<void> {
  await page.getByTestId('login-email').fill(user.email);
  await page.getByTestId('login-password').fill(user.password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-page')).toBeHidden({ timeout: 30_000 });
}

async function inhaberBereit(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await anmelden(page, owner);
  const landed = await Promise.race([
    page.getByTestId('app-shell').waitFor({ timeout: 45_000 }).then(() => 'shell' as const),
    page.getByTestId('workspace-setup-continue').waitFor({ timeout: 45_000 }).then(() => 'continue' as const),
    page.getByTestId('setup-companyName').waitFor({ timeout: 45_000 }).then(() => 'wizard' as const),
  ]);
  if (landed === 'shell') return;
  if (landed === 'continue') await page.getByTestId('workspace-setup-continue').click();
  await page.getByTestId('setup-companyName').fill(company.companyName);
  await page.getByTestId('setup-contactPerson').fill('Einrichtung Test');
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
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
}

async function keinUeberlauf(page: Page, label: string): Promise<void> {
  const ueberlauf = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(ueberlauf, `horizontaler Überlauf: ${label}`).toBeLessThanOrEqual(1);
}

/** Alle sichtbaren Knöpfe und Eingaben in einem Bereich: mindestens 44 px hoch (Links im Fließtext ausgenommen). */
async function bedienflaechen(page: Page, bereich: string, label: string): Promise<void> {
  const zuKlein = await page.getByTestId(bereich).evaluate((wurzel) => {
    const elemente = Array.from(wurzel.querySelectorAll('button, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), select, textarea'));
    return elemente
      .filter((e) => (e as HTMLElement).offsetParent !== null)
      .map((e) => ({ id: e.getAttribute('data-testid') ?? e.tagName, h: Math.round(e.getBoundingClientRect().height) }))
      .filter((e) => e.h < 44);
  });
  expect(zuKlein, `Bedienflächen unter 44 px (${label})`).toEqual([]);
}

test.describe.serial('EINRICHTUNG-01 — E-Nachweise (lokal)', () => {
  test('K-06: Kontoseite bei 360, 390 und 1280 px', async ({ page }) => {
    test.setTimeout(240_000);
    await inhaberBereit(page);
    for (const breite of [360, 390, 1280]) {
      await page.setViewportSize({ width: breite, height: 800 });
      await page.goto('/einstellungen/konto', { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('settings-account-page')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('account-memberships')).toBeVisible({ timeout: 30_000 });
      await keinUeberlauf(page, `Konto ${breite} px`);
      await bedienflaechen(page, 'settings-account-page', `Konto ${breite} px`);
      await page.screenshot({ path: `${BELEGE}/k06-konto-${breite}.png`, fullPage: true });
    }
  });

  test('M: einladen → annehmen → Rechte als Mitglied → Admin → entfernen während der Sitzung; fremdes Konto abgewiesen', async ({ browser }) => {
    test.setTimeout(480_000);
    const ctxO = await browser.newContext();
    const pageO = await ctxO.newPage();
    await inhaberBereit(pageO);

    /* M-01: Einladung mit Link zum Kopieren (Mail lokal nicht erreichbar: „nicht gesendet“ ist zulässig) */
    await pageO.goto('/einstellungen/team', { waitUntil: 'domcontentloaded' });
    await expect(pageO.getByTestId('settings-team-page')).toBeVisible({ timeout: 30_000 });
    await expect(pageO.getByTestId('team-members')).toBeVisible({ timeout: 30_000 });
    await pageO.getByTestId('team-invite-email').fill(eingeladen.email);
    await pageO.getByTestId('team-invite-submit').click();
    await expect(pageO.getByTestId('team-invite-link')).toBeVisible({ timeout: 30_000 });
    const link = await pageO.getByTestId('team-invite-link').inputValue();
    expect(link).toMatch(/\/einladung\/[A-Za-z0-9_-]{30,}\?email=/);
    await pageO.screenshot({ path: `${BELEGE}/m01-einladung-erzeugt.png`, fullPage: true });

    /* Weg C: ohne Anmeldung → Anmelden mit vorbelegter Adresse → Annahme (wartendes Konto ohne Lizenz) */
    const ctxM = await browser.newContext();
    const pageM = await ctxM.newPage();
    // Diagnose: RPC-Aufrufe der Eingeladenen mit Status (ohne Inhalte, ohne Tokens).
    const rpcSpur: string[] = [];
    pageM.on('response', (antwort) => {
      const m = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(antwort.url());
      if (m) rpcSpur.push(`${new Date().toISOString().slice(11, 19)} ${m[1]} ${antwort.status()}`);
    });
    pageM.on('framenavigated', (frame) => {
      if (frame === pageM.mainFrame()) rpcSpur.push(`${new Date().toISOString().slice(11, 19)} NAVIGATION ${new URL(frame.url()).pathname}`);
    });
    const spurSichern = () => writeFileSync(`${BELEGE}/m-rpc-spur.txt`, `${rpcSpur.join('\n')}\n`);
    await pageM.goto(link, { waitUntil: 'domcontentloaded' });
    await expect(pageM.getByTestId('invitation-login-required')).toBeVisible({ timeout: 30_000 });
    await pageM.getByTestId('invitation-login').click();
    await expect(pageM.getByTestId('login-email')).toHaveValue(eingeladen.email, { timeout: 30_000 });
    await anmelden(pageM, eingeladen);
    await expect(pageM.getByTestId('invitation-preview')).toBeVisible({ timeout: 45_000 });
    await pageM.screenshot({ path: `${BELEGE}/m03-einladung-vorschau.png`, fullPage: true });
    await pageM.getByTestId('invitation-accept').click();
    await expect(pageM.getByTestId('app-shell')).toBeVisible({ timeout: 90_000 });
    await expect(pageM.getByTestId('workspace-change-notice')).toBeVisible({ timeout: 30_000 });

    /* Rechte als Mitglied (Vertrag 1.4): Firmendaten nur lesbar, Teamseite ohne Aktionen und ohne E-Mails */
    await pageM.goto('/einstellungen/firma', { waitUntil: 'domcontentloaded' });
    await expect(pageM.getByTestId('settings-company-readonly')).toBeVisible({ timeout: 45_000 });
    await expect(pageM.getByTestId('settings-company-save')).toHaveCount(0);
    await pageM.goto('/einstellungen/team', { waitUntil: 'domcontentloaded' });
    await expect(pageM.getByTestId('team-member-view')).toBeVisible({ timeout: 45_000 });
    await expect(pageM.locator('[data-testid^="team-action-"]')).toHaveCount(0);
    await expect(pageM.getByTestId('team-members')).not.toContainText('@example.invalid');
    await pageM.screenshot({ path: `${BELEGE}/m08-mitglied-teamseite.png`, fullPage: true });

    /* M-09: Inhaber stuft zum Admin; nach dem nächsten Laden gilt die neue Rolle */
    await pageO.reload({ waitUntil: 'domcontentloaded' });
    await expect(pageO.getByTestId(`team-action-make-admin-${eingeladen.id}`)).toBeVisible({ timeout: 45_000 });
    await pageO.getByTestId(`team-action-make-admin-${eingeladen.id}`).click();
    await pageO.getByTestId('team-confirm-role').click();
    await expect(pageO.getByTestId(`team-member-role-${eingeladen.id}`)).toContainText(/Admin/, { timeout: 30_000 });
    await pageM.goto('/einstellungen/firma', { waitUntil: 'domcontentloaded' });
    await expect(pageM.getByTestId('settings-company-save')).toBeVisible({ timeout: 45_000 });
    await expect(pageM.getByTestId('settings-company-readonly')).toHaveCount(0);

    /* M-10: Inhaber entfernt sie während der Sitzung; der nächste Serveraufruf (Fokus nach der Drossel) erkennt den Entzug */
    await pageO.getByTestId(`team-action-remove-${eingeladen.id}`).click();
    await pageO.getByTestId('team-confirm-remove').click();
    await expect(pageO.getByTestId(`team-member-${eingeladen.id}`)).toHaveCount(0, { timeout: 30_000 });
    // Ohne Neuladen: Die Seite der Eingeladenen läuft weiter; nach Ablauf der Drossel (20 s) fragt der Fokus den Server.
    await pageM.waitForTimeout(21_000);
    await pageM.evaluate(() => window.dispatchEvent(new Event('focus')));
    try {
      await expect(pageM.getByTestId('workspace-change-notice')).toBeVisible({ timeout: 60_000 });
    } finally {
      spurSichern();
    }
    await expect(pageM.getByTestId('workspace-change-notice')).toHaveAttribute('data-kind', 'revoked');
    await pageM.screenshot({ path: `${BELEGE}/m10-entzug-hinweis.png`, fullPage: true });

    /* M-04.1: drittes Konto öffnet eine Einladung an eine andere Adresse → abgewiesen, keine Annahme möglich */
    await pageO.goto('/einstellungen/team', { waitUntil: 'domcontentloaded' });
    await expect(pageO.getByTestId('team-members')).toBeVisible({ timeout: 30_000 });
    await pageO.getByTestId('team-invite-email').fill(`ziel-${Date.now().toString(36)}@example.invalid`);
    await pageO.getByTestId('team-invite-submit').click();
    await expect(pageO.getByTestId('team-invite-link')).toBeVisible({ timeout: 30_000 });
    const fremderLink = await pageO.getByTestId('team-invite-link').inputValue();
    const ctxX = await browser.newContext();
    const pageX = await ctxX.newPage();
    await pageX.goto('/', { waitUntil: 'domcontentloaded' });
    await anmelden(pageX, fremd);
    await pageX.goto(fremderLink, { waitUntil: 'domcontentloaded' });
    await expect(pageX.getByTestId('invitation-error')).toBeVisible({ timeout: 45_000 });
    await expect(pageX.getByTestId('invitation-accept')).toHaveCount(0);
    await pageX.screenshot({ path: `${BELEGE}/m04-fremdes-konto.png`, fullPage: true });

    await ctxX.close();
    await ctxM.close();
    await ctxO.close();
  });
});
