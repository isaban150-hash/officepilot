// DOKUMENTE-01 N1/N2 — gezielte Browserprüfung auf der Prüf-App 5232 (frisches Edge-Profil, Edge-Kanal).
//   A  Inhaber anmelden: Archiv, Vorschau, „Papieroriginal abgeheftet" (Versand blockiert → ungesendet).
//   B  N2 Desktop: „Weiterarbeiten" sichtbar, Benutzermenü öffnen, „Abmelden" mit echtem Klick.
//   C  Mitglied im selben Profil: keine fremden Dokumente (Liste, Detail), Dateien, Vorschauen, Aufträge,
//      Papierregister-Versand; Inhaberbestand unverändert. „Fremd" bestimmt der Server (lesender Abzug
//      mit der Mitgliedssitzung), nicht die App.
//   D  Inhaber erneut: eigene Dokumente, Haken und ungesendete Aktion erhalten; Vorschau lädt.
//   D2 N2 Telefonbreite: dieselbe Prüfung bei 390 px.
//   E  Rollenwechsel des Mitglieds, nur im Browser nachgestellt (Antworten von ensure/pull umgeschrieben,
//      Server unverändert): Admin → Mitglied → entfernt → wieder Mitglied.
// Server bleibt unverändert: jeder schreibende Aufruf an 127.0.0.1:54321 wird abgefangen und nur protokolliert;
// /auth/v1/logout wird lokal mit 204 beantwortet. Sitzungen per GoTrue-Admin-Magic-Link nur im Speicher, am
// Ende mit scope=local widerrufen; Profil wird gelöscht. Ausgabe ohne Token, Kennungen, E-Mails und Titel.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('C:/Users/Lenovo-ThinkPad-E590/Desktop/officepilot/package.json');
const { chromium } = require('playwright-core');

const HIER = 'C:/Users/LENOVO~1/AppData/Local/Temp/claude/c--Users-Lenovo-ThinkPad-E590-Desktop-officepilot/70985f23-7ee9-4472-b575-58bf41c8864b/scratchpad/dok01/n';
const KEYS = JSON.parse(fs.readFileSync(path.join(HIER, '../ab/keys.json'), 'utf8'));
const API = 'http://127.0.0.1:54321';
const APP = 'http://localhost:5232';
const SITZUNGSSCHLUESSEL = 'sb-127-auth-token';
const BILDER = path.join(HIER, 'bilder');
const AUSGABE = process.argv[2] ?? path.join(HIER, 'abnahme-n-ergebnis.json');
fs.mkdirSync(BILDER, { recursive: true });

const jwtTeil = (t) => { try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8')); } catch { return {}; } };
for (const [name, rolle] of [['anon', 'anon'], ['service', 'service_role']]) {
  const p = jwtTeil(KEYS[name]);
  if (p.iss !== 'supabase-demo' || p.role !== rolle || p.ref) throw new Error(`kein lokaler Demo-Schlüssel: ${name}`);
}
const admin = { apikey: KEYS.service, Authorization: `Bearer ${KEYS.service}`, 'Content-Type': 'application/json' };
const maske = (s) => String(s ?? '').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (u) => `${u.slice(0, 8)}…`).replace(/[a-z0-9.+-]+@example\.invalid/gi, '…@example.invalid');

async function konto(muster) {
  const treffer = [];
  for (let seite = 1; seite <= 50; seite += 1) {
    const r = await fetch(`${API}/auth/v1/admin/users?page=${seite}&per_page=200`, { headers: admin });
    if (!r.ok) throw new Error(`Nutzerliste HTTP ${r.status}`);
    const nutzer = (await r.json()).users ?? [];
    treffer.push(...nutzer.filter((u) => muster.test(u.email ?? '')));
    if (nutzer.length < 200) break;
  }
  if (treffer.length !== 1) throw new Error(`${treffer.length} passende Konten für ${muster}`);
  return treffer[0];
}

async function sitzung(email) {
  const g = await fetch(`${API}/auth/v1/admin/generate_link`, { method: 'POST', headers: admin, body: JSON.stringify({ type: 'magiclink', email }) });
  if (!g.ok) throw new Error(`generate_link HTTP ${g.status}`);
  const gj = await g.json();
  const tokenHash = gj.hashed_token ?? gj.properties?.hashed_token;
  if (!tokenHash) throw new Error('generate_link ohne hashed_token');
  const v = await fetch(`${API}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: KEYS.anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: tokenHash }),
  });
  if (!v.ok) throw new Error(`verify HTTP ${v.status}`);
  const s = await v.json();
  if (!s.access_token || !s.refresh_token) throw new Error('verify ohne Sitzung');
  if (!s.expires_at) s.expires_at = Math.floor(Date.now() / 1000) + Number(s.expires_in ?? 3600);
  return s;
}

async function widerrufen(s) {
  if (!s) return null;
  const r = await fetch(`${API}/auth/v1/logout?scope=local`, {
    method: 'POST', headers: { apikey: KEYS.anon, Authorization: `Bearer ${s.access_token}` },
  });
  return r.status;
}

/** Lesender Abzug mit der Mitgliedssitzung: welche Dokumente gibt der Server diesem Konto? */
async function serverDokumente(s, workspaceId) {
  const kopf = { apikey: KEYS.anon, Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/json' };
  const ids = new Set();
  const a = await fetch(`${API}/rest/v1/rpc/pull_workspace_intake_state`, { method: 'POST', headers: kopf, body: JSON.stringify({ p_workspace_id: workspaceId }) });
  const aj = a.ok ? await a.json() : null;
  for (const row of aj?.archived_documents ?? []) if (row.client_document_id && !row.deleted) ids.add(row.client_document_id);
  const b = await fetch(`${API}/rest/v1/rpc/pull_workspace_documents`, { method: 'POST', headers: kopf, body: JSON.stringify({ p_workspace_id: workspaceId, p_since: null }) });
  const bj = b.ok ? await b.json() : null;
  for (const row of Array.isArray(bj) ? bj : []) {
    const id = row.client_document_id ?? row.document_id ?? null;
    if (id && !row.deleted) ids.add(id);
  }
  return { ids, intakeHttp: a.status, dokumenteHttp: b.status };
}

const ergebnis = { start: new Date().toISOString(), phasen: {}, pruefungen: [], blockiert: [], konsole: [] };
const blockiertRoh = [];
let phase = 'start';
let letzterAbzug = 0;
let abzuege = 0;
/** Nachstellung einer Rollenänderung: nur die Antworten im Browser, nie der Server. */
let umschreibung = null;
let umgeschrieben = 0;

function pruef(name, ok, detail = undefined) {
  ergebnis.pruefungen.push({ phase, name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? 'OK  ' : 'FEHL'} [${phase}] ${name}${detail === undefined ? '' : ` — ${maske(JSON.stringify(detail)).slice(0, 200)}`}`);
}

const inhaber = await konto(/^dok01-inhaber-[0-9a-z]+@example\.invalid$/);
const mitglied = await konto(/^dok01-mitglied-[0-9a-z]+@example\.invalid$/);
let sInhaber = null;
let sMitglied = null;
const sitzungen = [];
async function neueSitzung(email) { const s = await sitzung(email); sitzungen.push(s); return s; }

const profil = path.join(HIER, 'profil-abnahme-n');
fs.rmSync(profil, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(profil, { channel: 'msedge', headless: false, viewport: { width: 1360, height: 880 } });
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.setDefaultNavigationTimeout(120000);
page.setDefaultTimeout(60000);
await ctx.addInitScript(() => {
  window.addEventListener('pageshow', (e) => { window.__n1AusSeitenCache = Boolean(e.persisted); });
});

page.on('console', (m) => {
  const text = m.text();
  if (m.type() === 'error' || /\[OfficePilot:/.test(text)) {
    ergebnis.konsole.push({ t: new Date().toISOString(), phase, typ: m.type(), text: maske(text).slice(0, 240) });
  }
});
page.on('pageerror', (e) => ergebnis.konsole.push({ t: new Date().toISOString(), phase, typ: 'pageerror', text: maske(String(e)).slice(0, 240) }));

const LESE_RPC = /^(pull_|get_|list_|is_|can_|has_|check_|count_|search_|resolve_)/;
await ctx.route('**/*', async (route) => {
  const req = route.request();
  const u = new URL(req.url());
  if (u.host !== '127.0.0.1:54321') return route.continue();
  const m = req.method();
  const p = u.pathname;
  if (p === '/auth/v1/logout') {
    ergebnis.blockiert.push({ phase, art: 'auth-logout', scope: u.searchParams.get('scope') ?? '(standard)' });
    return route.fulfill({ status: 204, body: '' });
  }
  if (p.startsWith('/auth/v1/')) return route.continue();
  if (p.startsWith('/rest/v1/rpc/')) {
    const name = p.slice('/rest/v1/rpc/'.length);
    if (umschreibung && (name === 'pull_workspace_sync_state' || name === 'ensure_personal_workspace')) {
      const resp = await route.fetch();
      let json = await resp.json().catch(() => null);
      const fix = (zeile) => (zeile && zeile.user_id === umschreibung.userId
        ? { ...zeile, ...(umschreibung.role ? { role: umschreibung.role } : {}), ...(umschreibung.status && name === 'pull_workspace_sync_state' ? { status: umschreibung.status } : {}) }
        : zeile);
      if (json && name === 'pull_workspace_sync_state' && Array.isArray(json.members)) json = { ...json, members: json.members.map(fix) };
      if (json && name === 'ensure_personal_workspace' && json.member) json = { ...json, member: fix(json.member) };
      umgeschrieben += 1;
      if (name.startsWith('pull_')) { letzterAbzug = Date.now(); abzuege += 1; }
      return route.fulfill({ response: resp, json });
    }
    if (LESE_RPC.test(name) || name === 'ensure_personal_workspace') {
      if (name.startsWith('pull_')) { letzterAbzug = Date.now(); abzuege += 1; }
      return route.continue();
    }
    let typ = null; let kennung = null;
    try {
      const b = JSON.parse(req.postData() ?? '{}');
      typ = b.p_entity_type ?? null;
      const pl = b.p_payload ?? {};
      kennung = pl.entry_id ?? pl.client_entry_id ?? pl.client_document_id ?? pl.binding_id ?? pl.client_file_ref_id ?? pl.client_inbox_id ?? pl.id ?? b.p_client_document_id ?? null;
    } catch { /* kein JSON */ }
    blockiertRoh.push({ phase, rpc: name, typ, kennung: kennung ? String(kennung) : null, roh: (req.postData() ?? '').slice(0, 4000) });
    ergebnis.blockiert.push({ phase, art: 'rpc', rpc: name, typ, kennung: kennung ? maske(kennung).slice(0, 26) : null });
    return route.abort('failed');
  }
  if (m === 'GET' || m === 'HEAD') return route.continue();
  ergebnis.blockiert.push({ phase, art: 'http', methode: m, pfad: maske(p).slice(0, 80) });
  return route.abort('failed');
});

const warte = (ms) => new Promise((r) => setTimeout(r, ms));
async function abzugRuhig(maxMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (abzuege > 0 && Date.now() - letzterAbzug > 6000) return true;
    await warte(500);
  }
  return false;
}
async function anmelden(s, warteAuf = 'user-menu') {
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [SITZUNGSSCHLUESSEL, JSON.stringify(s)]);
  abzuege = 0;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId(warteAuf).waitFor({ timeout: 90000 });
  return abzugRuhig();
}
async function neuLaden(warteAuf = 'user-menu') {
  abzuege = 0;
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId(warteAuf).waitFor({ timeout: 90000 });
  return abzugRuhig();
}
async function bild(name) { await page.screenshot({ path: path.join(BILDER, `${name}.png`) }).catch(() => {}); }
/** In-App-Navigation ohne Neuladen (React Router hört auf popstate). */
async function geheZu(pfad, ms = 2500) {
  await page.evaluate((p) => { window.history.pushState({}, '', p); window.dispatchEvent(new PopStateEvent('popstate', { state: {} })); }, pfad);
  await warte(ms);
}

/** Lokaler Bestand im Browser: Kontobereiche, aktive Sicht, Warteschlange, Dokumente — Kennungen bleiben im Speicher. */
async function lokal(ownerUid, memberUid) {
  return page.evaluate(async ([inhaberUid, mitgliedUid]) => {
    const scope = await import('/src/services/storage/storageScopeService.ts');
    const ds = await import('/src/services/documentService.ts');
    const ob = await import('/src/services/sync/syncOutboxService.ts');
    const mem = await import('/src/services/officePilotMemoryService.ts');
    const bind = await import('/src/services/documentFileRepresentationBindingStoreService.ts');
    const ws = await import('/src/services/workspace/workspaceStore.ts');
    const konto = scope.getActiveStorageAccount();
    const sha = async (text) => {
      if (text === null) return null;
      const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    };
    const bereiche = [];
    const hashes = {};
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      const m = k.match(/^officepilot-state:workspace:([^:]+)(?::account:([^:]+):(full|member))?$/);
      if (!m) continue;
      const wer = !m[2] ? 'altbestand' : m[2] === inhaberUid ? `inhaber:${m[3]}` : m[2] === mitgliedUid ? `mitglied:${m[3]}` : `anderes:${m[3]}`;
      bereiche.push(wer);
      hashes[wer] = await sha(localStorage.getItem(k));
    }
    const docs = ds.getDocumentStoreSnapshot().filter((d) => d.sync?.deleted !== true);
    return {
      scopeTyp: scope.getActiveStorageScope().type,
      konto: konto ? { wer: konto.userId === inhaberUid ? 'inhaber' : konto.userId === mitgliedUid ? 'mitglied' : 'anderes', access: konto.access } : null,
      bereiche: bereiche.sort(),
      hashes,
      workspaceId: ws.getWorkspaceStoreSnapshot()?.id ?? null,
      dokumente: docs.map((d) => ({ id: d.id, titel: d.title, fileRefId: d.fileRefId ?? null })),
      auftraege: ob.getSyncOutboxSnapshot().map((e) => ({ typ: e.entityType, id: e.entityId, status: e.status })),
      papier: mem.getPaperRegisterEntries().map((e) => ({ id: e.id, documentId: e.documentId, abgeheftet: e.physicalFiled === true })),
      bindungen: bind.getDocumentFileRepresentationBindingStoreSnapshot().map((b) => ({ documentId: b.documentId, kind: b.kind, fileRefId: b.fileRefId })),
    };
  }, [ownerUid, memberUid]);
}

async function blobsLesbar(fileRefIds) {
  return page.evaluate(async (ids) => {
    const idb = await import('/src/services/storage/documentBlobIndexedDbService.ts');
    const fst = await import('/src/services/documentFileStoreService.ts');
    const scope = await import('/src/services/storage/storageScopeService.ts');
    const aktiv = scope.getActiveStorageScope();
    const quellen = [aktiv, ...fst.buildBlobFallbackScopes(aktiv, undefined)];
    let lesbar = 0;
    for (const id of ids) {
      for (const q of quellen) {
        const r = await idb.readDocumentBlob(id, q).catch(() => null);
        if (r) { lesbar += 1; break; }
      }
    }
    return { geprueft: ids.length, lesbar, quellen: quellen.length };
  }, fileRefIds);
}

async function briefFelder() {
  return page.evaluate(() => ({
    pfad: location.pathname,
    betreff: document.querySelector('[data-testid="letter-subject"]')?.value ?? null,
    text: document.querySelector('[data-testid="letter-body"]')?.value ?? '',
  }));
}

async function vorschauBilder(docId) {
  await geheZu(`/dokumente/${docId}`, 7000);
  return page.evaluate(() => [...document.querySelectorAll('img')].filter((i) => i.src.startsWith('blob:') && i.naturalWidth > 0).length);
}

async function karteErzeugen(docId) {
  await page.goto(`${APP}/dokumente/${docId}`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('document-detail-page').waitFor({ timeout: 90000 }).catch(() => {});
  await warte(8000);
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('user-menu').waitFor({ timeout: 90000 });
  const sichtbar = await page.getByTestId('continue-working-card').waitFor({ timeout: 25000 }).then(() => true).catch(() => false);
  return sichtbar;
}

async function abmeldenUeberMenue(name) {
  await page.getByRole('button', { name: 'Benutzermenü' }).click();
  const knopf = page.getByTestId('logout-button');
  await knopf.waitFor({ timeout: 10000 });
  const messung = await page.evaluate(() => {
    const k = document.querySelector('[data-testid="logout-button"]');
    const r = k.getBoundingClientRect();
    const oben = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const karte = document.querySelector('[data-testid="continue-working-card"]');
    const kr = karte?.getBoundingClientRect();
    const ueberlappt = kr ? !(kr.right < r.left || kr.left > r.right || kr.bottom < r.top || kr.top > r.bottom) : false;
    return {
      karteSichtbar: Boolean(karte && kr && kr.width > 0 && kr.height > 0),
      karteUeberlapptEintrag: ueberlappt,
      obenAufEintrag: oben ? (k === oben || k.contains(oben)) : false,
      obenstesElement: oben ? `${oben.tagName.toLowerCase()}.${String(oben.className).trim().split(/\s+/).slice(0, 2).join('.')}` : null,
    };
  });
  await bild(`${name}-menue-offen`);
  let geklickt = true;
  try {
    await knopf.click({ timeout: 10000 }); // echter Klick mit Trefferprüfung — kein dispatchEvent
  } catch (e) {
    geklickt = false;
    messung.klickFehler = String(e?.message ?? e).split('\n')[0].slice(0, 200);
  }
  const abgemeldet = geklickt ? await page.getByTestId('login-page').waitFor({ timeout: 30000 }).then(() => true).catch(() => false) : false;
  await bild(`${name}-nach-abmeldung`);
  return { ...messung, geklickt, abgemeldet };
}

const kennungen = (phaseName) => blockiertRoh.filter((b) => b.phase === phaseName);
const zaehle = (liste, schluessel) => liste.reduce((acc, x) => { const k = schluessel(x); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});

try {
  // ------------------------------------------------------------------ A: Inhaber
  phase = 'A-inhaber';
  sInhaber = await neueSitzung(inhaber.email);
  ergebnis.phasen.A = { abzugRuhig: await anmelden(sInhaber) };
  await warte(8000);
  let a = await lokal(inhaber.id, mitglied.id);
  pruef('Inhaber in eigenem Kontobereich (volle Sicht)', a.konto?.wer === 'inhaber' && a.konto?.access === 'full', a.konto);
  pruef('kein gemeinsamer Betriebsbestand', !a.bereiche.includes('altbestand'), a.bereiche);
  const workspaceId = a.workspaceId;
  const inhaberDocIds = new Set(a.dokumente.map((d) => d.id));
  pruef('Inhaber sieht Dokumente', inhaberDocIds.size > 0, { anzahl: inhaberDocIds.size });

  // Vorschau eines Dokuments mit Vorschaubindung (falls vorhanden).
  const mitVorschau = a.bindungen.find((b) => b.kind === 'preview' && inhaberDocIds.has(b.documentId))?.documentId ?? null;
  if (mitVorschau) {
    const n = await vorschauBilder(mitVorschau);
    ergebnis.phasen.A.vorschauBilder = n;
    pruef('Vorschau lädt beim Inhaber', n > 0, { bilder: n });
  } else {
    ergebnis.phasen.A.vorschauBilder = null;
  }

  // Ungesendete Aktion: „Papieroriginal abgeheftet" an einem noch nicht abgehefteten Dokument.
  let abgeheftetDoc = null;
  for (const d of a.dokumente.slice(0, 25)) {
    await geheZu(`/dokumente/${d.id}`, 1800);
    if (await page.getByTestId('document-filing-mark-filed').count()) { abgeheftetDoc = d.id; break; }
  }
  pruef('Dokument mit Schaltfläche „abgeheftet" gefunden', Boolean(abgeheftetDoc));
  let papierEintragId = null;
  if (abgeheftetDoc) {
    await page.getByTestId('document-filing-mark-filed').click();
    await warte(6000);
    a = await lokal(inhaber.id, mitglied.id);
    const eintrag = a.papier.find((e) => e.documentId === abgeheftetDoc);
    papierEintragId = eintrag?.id ?? null;
    pruef('Haken gesetzt', eintrag?.abgeheftet === true);
    const offen = a.auftraege.filter((e) => e.typ === 'paper_register_entry' && e.id === papierEintragId && e.status !== 'completed');
    pruef('ungesendete Aktion in der Warteschlange', offen.length === 1, { status: offen.map((e) => e.status) });
    ergebnis.phasen.A.versandVersuchtUndBlockiert = kennungen('A-inhaber').filter((b) => b.typ === 'paper_register_entry' && (b.kennung === papierEintragId || b.roh.includes(papierEintragId))).length;
  }
  const PRUEFBETREFF = 'N1-Prüfbrief Inhaber';
  const PRUEFTEXT = 'Vertraulicher Inhabertext N1';
  await page.evaluate(async ([betreff, text]) => {
    const bridge = await import('/src/services/document/documentReplyBridgeService.ts');
    const zustand = bridge.createLetterDraftPrefillLocationState({ subject: betreff, body: text, recipient: { name: 'Prüfempfänger' } });
    const idx = (window.history.state?.idx ?? 0) + 1;
    window.history.pushState({ usr: zustand, key: 'n1pruef', idx }, '', '/schreiben/neu');
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
  }, [PRUEFBETREFF, PRUEFTEXT]);
  await page.getByTestId('letter-subject').waitFor({ timeout: 30000 }).catch(() => {});
  await warte(1500);
  const briefInhaber = await briefFelder();
  pruef('Gegenprobe: Editor übernimmt die eigene Vorbelegung', briefInhaber.betreff === PRUEFBETREFF && briefInhaber.text.includes(PRUEFTEXT), { betreffGleich: briefInhaber.betreff === PRUEFBETREFF });
  await bild('a-inhaber-briefvorbelegung');
  await geheZu('/', 2000);
  await bild('a-inhaber');
  const inhaberHashVorher = a.hashes['inhaber:full'];
  const inhaberAuftraege = a.auftraege.filter((e) => e.status !== 'completed').map((e) => `${e.typ}:${e.id}`).sort();
  const inhaberFileRefs = a.dokumente.map((d) => d.fileRefId).filter(Boolean);
  ergebnis.phasen.A.dokumente = inhaberDocIds.size;
  ergebnis.phasen.A.offeneAuftraege = zaehle(a.auftraege.filter((e) => e.status !== 'completed'), (e) => e.typ);
  ergebnis.phasen.A.bereiche = a.bereiche;

  // ------------------------------------------------------------------ B: N2 Desktop
  phase = 'B-n2-desktop';
  const karteB = await karteErzeugen(abgeheftetDoc ?? a.dokumente[0].id);
  pruef('Karte „Weiterarbeiten" sichtbar', karteB);
  const abmB = await abmeldenUeberMenue('b-desktop');
  ergebnis.phasen.B = abmB;
  pruef('Menüeintrag „Abmelden" liegt oben (nicht verdeckt)', abmB.obenAufEintrag, { oben: abmB.obenstesElement, ueberlappt: abmB.karteUeberlapptEintrag });
  pruef('echter Klick auf „Abmelden" meldet ab', abmB.geklickt && abmB.abgemeldet, abmB.klickFehler ?? null);
  // Vergleichsstand des Inhabers erst nach seiner Abmeldung: bis dahin schreibt seine Sitzung legitim fort.
  const inhaberHashNachAbmeldung = (await lokal(inhaber.id, mitglied.id)).hashes['inhaber:full'];
  ergebnis.phasen.B.inhaberBestandVorhanden = Boolean(inhaberHashNachAbmeldung);

  // ------------------------------------------------------------------ C: Mitglied im selben Profil
  phase = 'C-mitglied';
  sMitglied = await neueSitzung(mitglied.email);
  ergebnis.phasen.C = { abzugRuhig: await anmelden(sMitglied) };
  await warte(20000); // Nachlauf: Altbestand-Abgleich, Warteschlange
  const c = await lokal(inhaber.id, mitglied.id);
  const server = await serverDokumente(sMitglied, workspaceId);
  const fremd = [...inhaberDocIds].filter((id) => !server.ids.has(id));
  ergebnis.phasen.C.server = { intakeHttp: server.intakeHttp, dokumenteHttp: server.dokumenteHttp, mitgliedSichtbar: server.ids.size, fremdeDokumente: fremd.length };
  pruef('Mitglied in eigenem Kontobereich (Mitgliedssicht)', c.konto?.wer === 'mitglied' && c.konto?.access === 'member', c.konto);
  pruef('Server kennt fremde Dokumente (Prüfung aussagekräftig)', fremd.length > 0, { fremd: fremd.length });
  pruef('keine fremden Dokumente im Bestand', c.dokumente.filter((d) => fremd.includes(d.id)).length === 0, { imBestand: c.dokumente.length });
  await geheZu('/dokumente', 5000);
  const kartenFremd = await page.evaluate((ids) => ids.filter((id) => document.querySelector(`[data-testid="document-summary-list-${id}"]`)).length, fremd);
  pruef('keine fremden Dokumente im Archiv', kartenFremd === 0, { karten: kartenFremd });
  await bild('c-mitglied-archiv');
  const fremdTitel = a.dokumente.filter((d) => fremd.includes(d.id)).map((d) => d.titel).filter((t) => t && t.length > 6);
  const titelImText = await page.evaluate((titel) => titel.filter((t) => document.body.innerText.includes(t)).length, fremdTitel);
  pruef('keine fremden Titel im Archivtext', titelImText === 0, { titel: fremdTitel.length, gefunden: titelImText });
  if (fremd[0]) {
    await geheZu(`/dokumente/${fremd[0]}`, 4000);
    const detail = await page.evaluate((t) => ({ seite: Boolean(document.querySelector('[data-testid="document-detail-page"]')), titel: t ? document.body.innerText.includes(t) : false }), a.dokumente.find((d) => d.id === fremd[0])?.titel ?? null);
    pruef('Dokumentdetail eines fremden Dokuments zeigt nichts', !detail.seite && !detail.titel, detail);
    await bild('c-mitglied-fremdes-detail');
  }
  const fremdeFiles = a.dokumente.filter((d) => fremd.includes(d.id)).map((d) => d.fileRefId).filter(Boolean);
  const blobs = await blobsLesbar(fremdeFiles);
  pruef('fremde Dateien nicht lesbar (aktiver Bereich und Rückfallbereiche)', blobs.lesbar === 0, blobs);
  pruef('keine fremden Vorschau-Bindungen', c.bindungen.filter((b) => fremd.includes(b.documentId)).length === 0, { bindungen: c.bindungen.length });
  const fremdePapier = c.papier.filter((e) => fremd.includes(e.documentId));
  pruef('keine fremden Papierregister-Einträge', fremdePapier.length === 0, { eintraege: c.papier.length });
  const fremdeAuftraege = c.auftraege.filter((e) => inhaberAuftraege.includes(`${e.typ}:${e.id}`) || fremd.some((id) => e.id.includes(id)));
  pruef('keine fremden Aufträge in der Warteschlange', fremdeAuftraege.length === 0, { auftraege: c.auftraege.length });
  const versucheC = kennungen('C-mitglied');
  const fremdeVersuche = versucheC.filter((b) => (b.kennung && fremd.some((id) => b.kennung.includes(id))) || fremd.some((id) => b.roh.includes(id)));
  pruef('kein Versand fremder Daten (auch kein Papierregister-Abgleich)', fremdeVersuche.length === 0, { versuche: versucheC.length, nachTyp: zaehle(versucheC, (b) => b.typ ?? b.rpc) });
  pruef('Inhaberbestand seit seiner Abmeldung unverändert', Boolean(inhaberHashNachAbmeldung) && c.hashes['inhaber:full'] === inhaberHashNachAbmeldung);
  pruef('kein gemeinsamer Betriebsbestand', !c.bereiche.includes('altbestand'), c.bereiche);
  ergebnis.phasen.C.bereiche = c.bereiche;
  ergebnis.phasen.C.versucheNachTyp = zaehle(versucheC, (b) => b.typ ?? b.rpc);

  phase = 'C3-mitglied-zurueck';
  const zurueck = [];
  for (let schritt = 1; schritt <= 30; schritt += 1) {
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
    const sofort = await page.evaluate((titel) => ({
      pfad: location.pathname,
      ausSeitenCache: Boolean(window.__n1AusSeitenCache),
      fremdeTitel: titel.filter((t) => document.body.innerText.includes(t)).length,
    }), fremdTitel).catch(() => ({ pfad: null, ausSeitenCache: null, fremdeTitel: null }));
    await warte(3000);
    const spaeter = await page.evaluate((titel) => ({
      pfad: location.pathname,
      fremdeTitel: titel.filter((t) => document.body.innerText.includes(t)).length,
      briefBetreff: document.querySelector('[data-testid="letter-subject"]')?.value ?? null,
      briefText: document.querySelector('[data-testid="letter-body"]')?.value ?? '',
    }), fremdTitel).catch(() => ({ pfad: null, fremdeTitel: null, briefBetreff: null, briefText: '' }));
    zurueck.push({ schritt, pfad: maske(spaeter.pfad ?? sofort.pfad ?? ''), ausSeitenCache: sofort.ausSeitenCache, fremdeTitelSofort: sofort.fremdeTitel, fremdeTitelNach3s: spaeter.fremdeTitel, fremderBrief: spaeter.briefBetreff === PRUEFBETREFF || (spaeter.briefText ?? '').includes(PRUEFTEXT) });
    if ((spaeter.pfad ?? '') === '/schreiben/neu') break;
  }
  ergebnis.phasen.C3 = { schritte: zurueck };
  const amBrief = zurueck.find((s) => s.pfad === '/schreiben/neu');
  pruef('„Zurück“ erreicht den Verlaufseintrag des Inhabers', Boolean(amBrief), { schritte: zurueck.length });
  pruef('„Zurück“ nach dem Kontowechsel: keine fremde Briefvorbelegung', Boolean(amBrief) && !amBrief.fremderBrief);
  pruef('„Zurück“ nach dem Kontowechsel: nirgends fremde Dokumenttitel', zurueck.every((s) => !s.fremdeTitelSofort && !s.fremdeTitelNach3s), { ausSeitenCache: zurueck.filter((s) => s.ausSeitenCache).length });
  await bild('c3-mitglied-zurueck-brief');
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('user-menu').waitFor({ timeout: 90000 });

  phase = 'C2-mitglied-abmelden';
  await neuLaden();
  const abmC = await abmeldenUeberMenue('c2-mitglied');
  pruef('Mitglied meldet sich über das Menü ab', abmC.geklickt && abmC.abgemeldet, abmC.klickFehler ?? null);

  // ------------------------------------------------------------------ D: Inhaber erneut
  phase = 'D-inhaber-erneut';
  sInhaber = await neueSitzung(inhaber.email);
  ergebnis.phasen.D = { abzugRuhig: await anmelden(sInhaber) };
  await warte(8000);
  const d = await lokal(inhaber.id, mitglied.id);
  pruef('Inhaber wieder im eigenen Kontobereich', d.konto?.wer === 'inhaber' && d.konto?.access === 'full', d.konto);
  const fehlend = [...inhaberDocIds].filter((id) => !d.dokumente.some((x) => x.id === id));
  pruef('eigene Dokumente vollständig', fehlend.length === 0, { fehlend: fehlend.length, anzahl: d.dokumente.length });
  if (papierEintragId) {
    pruef('Haken erhalten', d.papier.find((e) => e.id === papierEintragId)?.abgeheftet === true);
    const offen = d.auftraege.filter((e) => e.typ === 'paper_register_entry' && e.id === papierEintragId && e.status !== 'completed');
    pruef('ungesendete Aktion erhalten', offen.length === 1, { status: offen.map((e) => e.status) });
    const versuche = blockiertRoh.filter((b) => b.kennung === papierEintragId || b.roh.includes(papierEintragId));
    // Phasen A, B, D, D2 sind Inhabersitzungen; C und E gehören dem Mitglied.
    pruef('Aktion nie unter dem Mitgliedskonto versucht', versuche.every((x) => !x.phase.startsWith('C') && !x.phase.startsWith('E')), zaehle(versuche, (x) => x.phase));
  }
  const offenD = d.auftraege.filter((e) => e.status !== 'completed').map((e) => `${e.typ}:${e.id}`);
  pruef('alle ungesendeten Aufträge aus A noch offen', inhaberAuftraege.every((k) => offenD.includes(k)), { a: inhaberAuftraege.length, d: offenD.length });
  if (mitVorschau) {
    const n = await vorschauBilder(mitVorschau);
    pruef('Vorschau lädt nach erneuter Anmeldung', n > 0, { bilder: n });
  }
  await bild('d-inhaber-erneut');

  // ------------------------------------------------------------------ D2: N2 Telefonbreite
  phase = 'D2-n2-telefon';
  await page.setViewportSize({ width: 390, height: 844 });
  const karteD2 = await karteErzeugen(abgeheftetDoc ?? d.dokumente[0].id);
  pruef('Karte „Weiterarbeiten" sichtbar (390 px)', karteD2);
  const abmD2 = await abmeldenUeberMenue('d2-telefon');
  ergebnis.phasen.D2 = abmD2;
  pruef('Menüeintrag „Abmelden" liegt oben (390 px)', abmD2.obenAufEintrag, { oben: abmD2.obenstesElement, ueberlappt: abmD2.karteUeberlapptEintrag });
  pruef('echter Klick auf „Abmelden" meldet ab (390 px)', abmD2.geklickt && abmD2.abgemeldet, abmD2.klickFehler ?? null);
  const inhaberHashEnde = (await lokal(inhaber.id, mitglied.id)).hashes['inhaber:full'];
  await page.setViewportSize({ width: 1360, height: 880 });

  // ------------------------------------------------------------------ E: Rollenwechsel (nur im Browser nachgestellt)
  phase = 'E1-mitglied-als-admin';
  umschreibung = { userId: mitglied.id, role: 'admin' };
  sMitglied = await neueSitzung(mitglied.email);
  ergebnis.phasen.E1 = { abzugRuhig: await anmelden(sMitglied) };
  await warte(6000);
  const e1 = await lokal(inhaber.id, mitglied.id);
  pruef('Rolle admin → volle Sicht im eigenen Kontobereich', e1.konto?.wer === 'mitglied' && e1.konto?.access === 'full', e1.konto);
  const e1Hash = e1.hashes['mitglied:full'];

  phase = 'E2-wieder-mitglied';
  umschreibung = null;
  ergebnis.phasen.E2 = { abzugRuhig: await neuLaden() };
  await warte(6000);
  const e2 = await lokal(inhaber.id, mitglied.id);
  pruef('nach Rollenentzug Mitgliedssicht', e2.konto?.wer === 'mitglied' && e2.konto?.access === 'member', e2.konto);
  pruef('Admin-Bestand ruht unverändert', e2.hashes['mitglied:full'] !== undefined && e2.hashes['mitglied:full'] === e1Hash);
  pruef('nach Rollenentzug nichts Fremdes im Bestand', e2.dokumente.filter((x) => fremd.includes(x.id)).length === 0);
  pruef('Inhaberbestand weiter unverändert', Boolean(inhaberHashEnde) && e2.hashes['inhaber:full'] === inhaberHashEnde);

  phase = 'E3-entfernt';
  umschreibung = { userId: mitglied.id, status: 'removed' };
  ergebnis.phasen.E3 = { abzugRuhig: await neuLaden('workspace-restore-failure').catch(() => false) };
  const gesperrt = await page.getByTestId('workspace-restore-failure').isVisible().catch(() => false);
  const e3 = await lokal(inhaber.id, mitglied.id);
  pruef('entfernte Mitgliedschaft: App gesperrt', gesperrt);
  pruef('entfernte Mitgliedschaft: kein Betriebsbereich aktiv', e3.scopeTyp !== 'workspace' && e3.konto === null, { scope: e3.scopeTyp });
  pruef('entfernte Mitgliedschaft: kein Versand', kennungen('E3-entfernt').length === 0, { versuche: kennungen('E3-entfernt').length });
  pruef('entfernte Mitgliedschaft: Bestände unverändert', e3.hashes['mitglied:member'] === e2.hashes['mitglied:member'] && e3.hashes['mitglied:full'] === e1Hash && e3.hashes['inhaber:full'] === inhaberHashEnde);
  await bild('e3-entfernt');

  phase = 'E4-wieder-zugelassen';
  umschreibung = null;
  ergebnis.phasen.E4 = { abzugRuhig: await neuLaden() };
  const e4 = await lokal(inhaber.id, mitglied.id);
  pruef('nach erneuter Zulassung wieder Mitgliedssicht', e4.konto?.wer === 'mitglied' && e4.konto?.access === 'member', e4.konto);
  ergebnis.phasen.E = { umgeschrieben, bereicheEnde: e4.bereiche };

  phase = 'Z-gesamt';
  const mitgliedsVersuche = blockiertRoh.filter((x) => x.phase.startsWith('C') || x.phase.startsWith('E'));
  const fremdInMitgliedsVersuchen = mitgliedsVersuche.filter((x) => (papierEintragId && (x.kennung === papierEintragId || x.roh.includes(papierEintragId))) || fremd.some((id) => x.roh.includes(id)));
  pruef('über alle Mitgliedsphasen: kein Versand von Inhaberdaten', fremdInMitgliedsVersuchen.length === 0, { versucheMitglied: mitgliedsVersuche.length, nachTyp: zaehle(mitgliedsVersuche, (x) => x.typ ?? x.rpc) });
} catch (e) {
  ergebnis.abbruch = maske(String(e?.stack ?? e)).slice(0, 700);
  console.log(`ABBRUCH in ${phase}: ${ergebnis.abbruch.slice(0, 300)}`);
  await bild('zz-abbruch');
} finally {
  await ctx.close().catch(() => {});
  ergebnis.widerruf = [];
  for (const s of sitzungen) ergebnis.widerruf.push(await widerrufen(s));
  fs.rmSync(profil, { recursive: true, force: true });
  ergebnis.profilGeloescht = !fs.existsSync(profil);
  ergebnis.ende = new Date().toISOString();
  const rot = ergebnis.pruefungen.filter((p) => !p.ok);
  ergebnis.summe = { pruefungen: ergebnis.pruefungen.length, ok: ergebnis.pruefungen.length - rot.length, rot: rot.length, blockiert: ergebnis.blockiert.length };
  fs.writeFileSync(AUSGABE, maske(JSON.stringify(ergebnis, null, 2)));
  console.log(JSON.stringify({ abbruch: Boolean(ergebnis.abbruch), ...ergebnis.summe, widerruf: ergebnis.widerruf, profilGeloescht: ergebnis.profilGeloescht }));
}
