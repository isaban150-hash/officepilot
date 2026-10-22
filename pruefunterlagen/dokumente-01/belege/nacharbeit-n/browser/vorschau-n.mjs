// DOKUMENTE-01 N1 — Vorschau über den Kontowechsel (Prüf-App 5232, frisches Edge-Profil).
//   V1 Inhaber: für ein PDF-Archivdokument Vorschau und Vorschaubild mit den echten Orchestratoren erzeugen
//      (nur lokal; Vorschau-Bindungen werden nicht synchronisiert), Detail zeigt das Bild.
//   V2 Mitglied im selben Profil: diese Vorschau-Dateien sind weder im aktiven noch in einem Rückfallbereich
//      lesbar, keine Bindung, das Detail des Inhaberdokuments zeigt nichts.
//   V3 Inhaber erneut: Bindungen und Bytes sind da, das Detail zeigt das Vorschaubild wieder.
// Gleiche Schutzregeln wie abnahme-n.mjs: Schreibaufrufe an 127.0.0.1:54321 abgefangen, /auth/v1/logout lokal 204,
// Sitzungen per Magic-Link nur im Speicher, am Ende scope=local widerrufen, Profil gelöscht; Ausgabe ohne Kennungen.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('C:/Users/Lenovo-ThinkPad-E590/Desktop/officepilot/package.json');
const { chromium } = require('playwright-core');

const HIER = 'C:/Users/LENOVO~1/AppData/Local/Temp/claude/c--Users-Lenovo-ThinkPad-E590-Desktop-officepilot/70985f23-7ee9-4472-b575-58bf41c8864b/scratchpad/dok01/n';
const KEYS = JSON.parse(fs.readFileSync(path.join(HIER, '../ab/keys.json'), 'utf8'));
const API = 'http://127.0.0.1:54321';
const APP = 'http://localhost:5232';
const BILDER = path.join(HIER, 'bilder');
const AUSGABE = process.argv[2] ?? path.join(HIER, 'vorschau-n-ergebnis.json');
fs.mkdirSync(BILDER, { recursive: true });

const jwtTeil = (t) => { try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8')); } catch { return {}; } };
for (const [name, rolle] of [['anon', 'anon'], ['service', 'service_role']]) {
  const p = jwtTeil(KEYS[name]);
  if (p.iss !== 'supabase-demo' || p.role !== rolle || p.ref) throw new Error(`kein lokaler Demo-Schlüssel: ${name}`);
}
const admin = { apikey: KEYS.service, Authorization: `Bearer ${KEYS.service}`, 'Content-Type': 'application/json' };
const maske = (s) => String(s ?? '').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (u) => `${u.slice(0, 8)}…`).replace(/[a-z0-9.+-]+@example\.invalid/gi, '…@example.invalid');

async function konto(muster) {
  const r = await fetch(`${API}/auth/v1/admin/users?page=1&per_page=200`, { headers: admin });
  const t = ((await r.json()).users ?? []).filter((u) => muster.test(u.email ?? ''));
  if (t.length !== 1) throw new Error('Konto nicht eindeutig');
  return t[0];
}
const sitzungen = [];
async function sitzung(email) {
  const g = await (await fetch(`${API}/auth/v1/admin/generate_link`, { method: 'POST', headers: admin, body: JSON.stringify({ type: 'magiclink', email }) })).json();
  const s = await (await fetch(`${API}/auth/v1/verify`, { method: 'POST', headers: { apikey: KEYS.anon, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'magiclink', token_hash: g.hashed_token ?? g.properties?.hashed_token }) })).json();
  if (!s.access_token) throw new Error('keine Sitzung');
  if (!s.expires_at) s.expires_at = Math.floor(Date.now() / 1000) + Number(s.expires_in ?? 3600);
  sitzungen.push(s);
  return s;
}

const ergebnis = { start: new Date().toISOString(), pruefungen: [], blockiert: 0 };
let phase = 'start';
function pruef(name, ok, detail = undefined) {
  ergebnis.pruefungen.push({ phase, name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? 'OK  ' : 'FEHL'} [${phase}] ${name}${detail === undefined ? '' : ` — ${maske(JSON.stringify(detail)).slice(0, 200)}`}`);
}

const inhaber = await konto(/^dok01-inhaber-[0-9a-z]+@example\.invalid$/);
const mitglied = await konto(/^dok01-mitglied-[0-9a-z]+@example\.invalid$/);
const profil = path.join(HIER, 'profil-vorschau-n');
fs.rmSync(profil, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(profil, { channel: 'msedge', headless: false, viewport: { width: 1360, height: 880 } });
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.setDefaultNavigationTimeout(120000);
page.setDefaultTimeout(60000);
let abzuege = 0; let letzterAbzug = 0;
ergebnis.antworten4xx = {};
page.on('response', (r) => {
  const u = new URL(r.url());
  if (u.host !== '127.0.0.1:54321' || r.status() < 400) return;
  const k = phase + ' | ' + r.status() + ' | ' + (u.pathname.startsWith('/rest/v1/rpc/') ? u.pathname.slice(13) : u.pathname.replace(/[0-9a-f-]{36}/gi, '…'));
  ergebnis.antworten4xx[k] = (ergebnis.antworten4xx[k] ?? 0) + 1;
});
await ctx.route('**/*', async (route) => {
  const req = route.request(); const u = new URL(req.url());
  if (u.host !== '127.0.0.1:54321') return route.continue();
  if (u.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, body: '' });
  if (u.pathname.startsWith('/auth/v1/')) return route.continue();
  if (u.pathname.startsWith('/rest/v1/rpc/')) {
    const n = u.pathname.slice(13);
    if (/^(pull_|get_|list_|is_|can_|has_|check_|count_|search_|resolve_)/.test(n) || n === 'ensure_personal_workspace') {
      if (n.startsWith('pull_')) { abzuege += 1; letzterAbzug = Date.now(); }
      return route.continue();
    }
    ergebnis.blockiert += 1;
    return route.abort('failed');
  }
  if (req.method() === 'GET' || req.method() === 'HEAD') return route.continue();
  ergebnis.blockiert += 1;
  return route.abort('failed');
});
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
async function anmelden(s) {
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((v) => localStorage.setItem('sb-127-auth-token', v), JSON.stringify(s));
  abzuege = 0;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('user-menu').waitFor({ timeout: 90000 });
  const start = Date.now();
  while (Date.now() - start < 90000) { if (abzuege > 0 && Date.now() - letzterAbzug > 6000) break; await warte(500); }
}
async function abmelden() {
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('user-menu').waitFor({ timeout: 90000 });
  await page.getByRole('button', { name: 'Benutzermenü' }).click();
  await page.getByTestId('logout-button').click({ timeout: 10000 });
  await page.getByTestId('login-page').waitFor({ timeout: 30000 });
}
async function geheZu(pfad, ms) {
  await page.evaluate((p) => { window.history.pushState({}, '', p); window.dispatchEvent(new PopStateEvent('popstate', { state: {} })); }, pfad);
  await warte(ms);
}
async function bilderImDetail(docId) {
  await geheZu(`/dokumente/${docId}`, 7000);
  return page.evaluate(() => ({
    seite: Boolean(document.querySelector('[data-testid="document-detail-page"]')),
    bilder: [...document.querySelectorAll('img')].filter((i) => i.src.startsWith('blob:') && i.naturalWidth > 0).length,
  }));
}

try {
  phase = 'V1-inhaber';
  await anmelden(await sitzung(inhaber.email));
  await warte(6000);
  // PDF-Archivdokument mit lokal lesbarem Original wählen und Vorschau + Vorschaubild erzeugen.
  const v1 = await page.evaluate(async () => {
    const ds = await import('/src/services/documentService.ts');
    const fst = await import('/src/services/documentFileStoreService.ts');
    const bind = await import('/src/services/documentFileRepresentationBindingStoreService.ts');
    const th = await import('/src/services/documentFilePdfThumbnailEncodeOrchestrationService.ts');
    const pv = await import('/src/services/documentFilePdfPreviewEncodeOrchestrationService.ts');
    const plan = { policyId: 'pruefung-n1', mediaProfile: 'pdf_document', hints: {}, intents: [
      { targetKind: 'thumbnail', intent: 'create_thumbnail', executionIntent: 'preferred' },
      { targetKind: 'preview', intent: 'create_preview', executionIntent: 'preferred' },
    ] };
    for (const doc of ds.getDocumentStoreSnapshot()) {
      const ref = doc.fileRefId ? fst.getDocumentFileRefById(doc.fileRefId) : null;
      if (!ref || ref.mimeType !== 'application/pdf') continue;
      let bytes = null;
      try { bytes = await fst.getOriginalDocumentFileBytes(ref); } catch { bytes = null; }
      if (!bytes) continue;
      const a = await th.orchestratePdfThumbnailEncodeAfterImport({ documentId: doc.id, transformPlan: plan }).catch((e) => ({ fehler: String(e?.message ?? e) }));
      const b = await pv.orchestratePdfPreviewEncodeAfterImport({ documentId: doc.id, transformPlan: plan }).catch((e) => ({ fehler: String(e?.message ?? e) }));
      const eigene = bind.getDocumentFileRepresentationBindingStoreSnapshot().filter((x) => x.documentId === doc.id && (x.kind === 'preview' || x.kind === 'thumbnail'));
      return { docId: doc.id, vorschaubild: a?.status ?? a?.kind ?? (a?.fehler ? 'fehler' : 'unbekannt'), vorschau: b?.status ?? b?.kind ?? (b?.fehler ? 'fehler' : 'unbekannt'), bindungen: eigene.map((x) => ({ kind: x.kind, fileRefId: x.fileRefId })) };
    }
    return null;
  });
  pruef('PDF mit lokalem Original gefunden und Vorschau erzeugt', Boolean(v1 && v1.bindungen.length > 0), v1 ? { vorschaubild: v1.vorschaubild, vorschau: v1.vorschau, bindungen: v1.bindungen.map((b) => b.kind) } : null);
  if (!v1 || v1.bindungen.length === 0) throw new Error('keine Vorschau erzeugt');
  const vorschauFiles = v1.bindungen.map((b) => b.fileRefId);
  const d1 = await bilderImDetail(v1.docId);
  pruef('Detail zeigt Vorschaubild', d1.seite && d1.bilder > 0, d1);
  await page.screenshot({ path: path.join(BILDER, 'v1-inhaber-vorschau.png') });
  await abmelden();

  phase = 'V2-mitglied';
  await anmelden(await sitzung(mitglied.email));
  await warte(8000);
  const v2 = await page.evaluate(async ([docId, ids]) => {
    const idb = await import('/src/services/storage/documentBlobIndexedDbService.ts');
    const fst = await import('/src/services/documentFileStoreService.ts');
    const scope = await import('/src/services/storage/storageScopeService.ts');
    const bind = await import('/src/services/documentFileRepresentationBindingStoreService.ts');
    const aktiv = scope.getActiveStorageScope();
    const quellen = [aktiv, ...fst.buildBlobFallbackScopes(aktiv, undefined)];
    let lesbar = 0;
    for (const id of ids) for (const q of quellen) { if (await idb.readDocumentBlob(id, q).catch(() => null)) { lesbar += 1; break; } }
    return {
      access: scope.getActiveStorageAccount()?.access ?? null,
      lesbar,
      quellen: quellen.length,
      bindungen: bind.getDocumentFileRepresentationBindingStoreSnapshot().filter((x) => x.documentId === docId).length,
      refs: ids.filter((id) => fst.getDocumentFileRefById(id)).length,
    };
  }, [v1.docId, vorschauFiles]);
  pruef('Mitglied: Mitgliedssicht', v2.access === 'member', { access: v2.access });
  pruef('Mitglied: Vorschau-Dateien des Inhabers nicht lesbar', v2.lesbar === 0, { lesbar: v2.lesbar, quellen: v2.quellen });
  pruef('Mitglied: keine Vorschau-Bindung, keine Dateireferenz', v2.bindungen === 0 && v2.refs === 0, { bindungen: v2.bindungen, refs: v2.refs });
  const d2 = await bilderImDetail(v1.docId);
  pruef('Mitglied: Detail des Inhaberdokuments zeigt nichts', !d2.seite && d2.bilder === 0, d2);
  await abmelden();

  phase = 'V3-inhaber-erneut';
  await anmelden(await sitzung(inhaber.email));
  await warte(6000);
  const v3 = await page.evaluate(async ([docId, ids]) => {
    const idb = await import('/src/services/storage/documentBlobIndexedDbService.ts');
    const bind = await import('/src/services/documentFileRepresentationBindingStoreService.ts');
    let lesbar = 0;
    for (const id of ids) if (await idb.readDocumentBlob(id).catch(() => null)) lesbar += 1;
    return { lesbar, bindungen: bind.getDocumentFileRepresentationBindingStoreSnapshot().filter((x) => x.documentId === docId && (x.kind === 'preview' || x.kind === 'thumbnail')).length };
  }, [v1.docId, vorschauFiles]);
  pruef('Inhaber: eigene Vorschau-Bindungen und Bytes erhalten', v3.bindungen === v1.bindungen.length && v3.lesbar === vorschauFiles.length, v3);
  const d3 = await bilderImDetail(v1.docId);
  pruef('Inhaber: Detail zeigt Vorschaubild wieder', d3.seite && d3.bilder > 0, d3);
  await page.screenshot({ path: path.join(BILDER, 'v3-inhaber-vorschau-erneut.png') });
} catch (e) {
  ergebnis.abbruch = maske(String(e?.stack ?? e)).slice(0, 600);
  console.log(`ABBRUCH in ${phase}: ${ergebnis.abbruch.slice(0, 300)}`);
} finally {
  await ctx.close().catch(() => {});
  ergebnis.widerruf = [];
  for (const s of sitzungen) {
    const r = await fetch(`${API}/auth/v1/logout?scope=local`, { method: 'POST', headers: { apikey: KEYS.anon, Authorization: `Bearer ${s.access_token}` } });
    ergebnis.widerruf.push(r.status);
  }
  fs.rmSync(profil, { recursive: true, force: true });
  ergebnis.profilGeloescht = !fs.existsSync(profil);
  ergebnis.ende = new Date().toISOString();
  const rot = ergebnis.pruefungen.filter((p) => !p.ok).length;
  ergebnis.summe = { pruefungen: ergebnis.pruefungen.length, ok: ergebnis.pruefungen.length - rot, rot };
  fs.writeFileSync(AUSGABE, maske(JSON.stringify(ergebnis, null, 2)));
  console.log(JSON.stringify({ abbruch: Boolean(ergebnis.abbruch), ...ergebnis.summe, blockiert: ergebnis.blockiert, widerruf: ergebnis.widerruf, profilGeloescht: ergebnis.profilGeloescht }));
}
