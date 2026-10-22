// DOKUMENTE-01 — synthetische Zugänge für die WEISS-Abnahme bereitstellen (NUR lokal, NUR durch SCHWARZ bzw. den Nutzer).
//
//   node dok01-zugaenge.mjs --schluessel <datei mit {url, anon, service}>
//
// Je Konto (Inhaber, Mitglied) des Testbetriebs „DOK01 Testbetrieb GmbH" (dok01-…@example.invalid, aus AP6):
//   1. neues Zufallskennwort per GoTrue-Admin setzen (nur im Speicher),
//   2. Anmeldung mit diesem Kennwort prüfen und ensure_personal_workspace wie die App aufrufen (Rolle, Betrieb),
//   3. Zugangsdatei für WEISS schreiben: %TEMP%\officetakt-weiss-recheck\ZUGANG-DOK01\<rolle>.json.
// Ausgabe nur Rolle und Prüfergebnis — nie Kennwort, Token oder Kennungen. SCHWARZ liest die Zugangsdateien nie.
// Keine echten Konten: nur E-Mails nach dem Muster dok01-<rolle>-…@example.invalid, nur 127.0.0.1:54321.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const URL_LOKAL = 'http://127.0.0.1:54321';
const ZIEL = path.join(process.env.TEMP ?? '', 'officetakt-weiss-recheck', 'ZUGANG-DOK01');

function jwtTeil(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

const i = process.argv.indexOf('--schluessel');
if (i < 0 || !process.argv[i + 1]) throw new Error('--schluessel <datei> fehlt');
const k = JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'));
if (k.url && !/^http:\/\/(127\.0\.0\.1|localhost):54321$/.test(k.url)) throw new Error('Schlüsseldatei zeigt nicht auf die lokale Supabase');
const dienst = jwtTeil(k.service);
const anon = jwtTeil(k.anon);
if (dienst.iss !== 'supabase-demo' || dienst.role !== 'service_role' || dienst.ref) throw new Error('kein lokaler Demo-Dienstschlüssel');
if (anon.iss !== 'supabase-demo' || anon.role !== 'anon' || anon.ref) throw new Error('kein lokaler Demo-anon-Schlüssel');

const admin = { apikey: k.service, Authorization: `Bearer ${k.service}`, 'Content-Type': 'application/json' };

async function kontoFinden(rolle) {
  const muster = new RegExp(`^dok01-${rolle}-[0-9a-z]+@example\\.invalid$`);
  const treffer = [];
  for (let seite = 1; seite <= 50; seite += 1) {
    const r = await fetch(`${URL_LOKAL}/auth/v1/admin/users?page=${seite}&per_page=200`, { headers: admin });
    if (!r.ok) throw new Error(`Nutzerliste: HTTP ${r.status}`);
    const daten = await r.json();
    const nutzer = daten.users ?? [];
    treffer.push(...nutzer.filter((u) => muster.test(u.email ?? '')));
    if (nutzer.length < 200) break;
  }
  if (treffer.length !== 1) throw new Error(`${rolle}: ${treffer.length} passende synthetische Konten (erwartet genau 1)`);
  return treffer[0];
}

async function bereitstellen(rolle, erwarteteRolle) {
  const konto = await kontoFinden(rolle);
  const passwort = `Pw-${crypto.randomBytes(15).toString('base64url')}`;
  const setzen = await fetch(`${URL_LOKAL}/auth/v1/admin/users/${konto.id}`, {
    method: 'PUT',
    headers: admin,
    body: JSON.stringify({ password: passwort }),
  });
  if (!setzen.ok) throw new Error(`${rolle}: Kennwort setzen HTTP ${setzen.status}`);

  // Anmeldung wie die App: Kennwort-Token, danach ensure_personal_workspace.
  const token = await fetch(`${URL_LOKAL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: k.anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: konto.email, password: passwort }),
  });
  if (!token.ok) throw new Error(`${rolle}: Anmeldung HTTP ${token.status}`);
  const sitzung = await token.json();
  const betrieb = await fetch(`${URL_LOKAL}/rest/v1/rpc/ensure_personal_workspace`, {
    method: 'POST',
    headers: { apikey: k.anon, Authorization: `Bearer ${sitzung.access_token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!betrieb.ok) throw new Error(`${rolle}: ensure_personal_workspace HTTP ${betrieb.status}`);
  const b = await betrieb.json();
  const workspaceId = b?.workspace?.id ?? b?.workspace_id ?? null;
  const tatsaechlicheRolle = b?.member?.role ?? null;
  if (tatsaechlicheRolle !== erwarteteRolle) throw new Error(`${rolle}: Rolle ${tatsaechlicheRolle}, erwartet ${erwarteteRolle}`);

  fs.mkdirSync(ZIEL, { recursive: true });
  fs.writeFileSync(
    path.join(ZIEL, `${rolle}.json`),
    JSON.stringify({
      rolle: erwarteteRolle,
      email: konto.email,
      passwort,
      app: 'http://localhost:5232',
      betrieb: 'DOK01 Testbetrieb GmbH',
      hinweis: 'Synthetisches Konto, nur lokale Supabase 127.0.0.1:54321. Nur für WEISS. Kein Produktionszugang.',
      erstellt: new Date().toISOString(),
    }, null, 2),
  );
  return { rolle, workspaceId };
}

const inhaber = await bereitstellen('inhaber', 'owner');
const mitglied = await bereitstellen('mitglied', 'member');
const gleicherBetrieb = Boolean(inhaber.workspaceId) && inhaber.workspaceId === mitglied.workspaceId;
console.log('inhaber: Zugang geschrieben, Anmeldung geprüft, Rolle owner');
console.log(`mitglied: Zugang geschrieben, Anmeldung geprüft, Rolle member, im Betrieb des Inhabers: ${gleicherBetrieb ? 'ja' : 'NEIN'}`);
console.log(`Ablage: %TEMP%\\officetakt-weiss-recheck\\ZUGANG-DOK01\\ (inhaber.json, mitglied.json)`);
if (!gleicherBetrieb) process.exit(1);
