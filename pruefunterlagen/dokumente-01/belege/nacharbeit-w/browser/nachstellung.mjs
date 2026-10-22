// DOKUMENTE-01 Nacharbeit — Nachstellung der zwei WEISS-Browserbefunde auf der Prüf-App 5232.
//   A  Vorschau/Vorschaubild der WEISS-Archivkopie: frisches Edge-Profil als DOK01-Inhaber, „Erneut erstellen",
//      danach die Schritte des Vorschau-Orchestrators einzeln (ohne Speichern) bis zum ersten Fehler.
//   B  Rollenwechsel im selben Profil: normale Abmeldung des Inhabers, Anmeldung des Mitglieds; welche
//      Schreibversuche entstehen (Entitätsart), was zeigt das Archiv, was die Synchronisationsseite.
// Server bleibt unverändert: jeder schreibende Aufruf an 127.0.0.1:54321 wird im Browser abgefangen und nur
// protokolliert; /auth/v1/logout wird lokal mit 204 beantwortet (keine globale Abmeldung von WEISS-Sitzungen).
// Sitzungen per GoTrue-Admin-Magic-Link nur im Speicher; Kennwörter bleiben unverändert. Am Ende werden die
// beiden eigenen Sitzungen mit scope=local widerrufen und das Profil gelöscht. Ausgabe ohne Token und Kennungen.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('C:/Users/Lenovo-ThinkPad-E590/Desktop/officepilot/package.json');
const { chromium } = require('playwright-core');

const HIER = 'C:/Users/LENOVO~1/AppData/Local/Temp/claude/c--Users-Lenovo-ThinkPad-E590-Desktop-officepilot/70985f23-7ee9-4472-b575-58bf41c8864b/scratchpad/dok01/w';
const KEYS = JSON.parse(fs.readFileSync(path.join(HIER, '../ab/keys.json'), 'utf8'));
const API = 'http://127.0.0.1:54321';
const APP = 'http://localhost:5232';
const DOC_KOPIE = 'doc-65fa2410-6346-450e-8713-83abe657cbd3';
const DOC_ORIG = 'doc-94d044af-9a7c-4ce7-a288-82749fe751ee';
const SITZUNGSSCHLUESSEL = 'sb-127-auth-token';
const BILDER = path.join(HIER, 'bilder');
fs.mkdirSync(BILDER, { recursive: true });

const jwtTeil = (t) => { try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8')); } catch { return {}; } };
for (const [name, rolle] of [['anon', 'anon'], ['service', 'service_role']]) {
  const p = jwtTeil(KEYS[name]);
  if (p.iss !== 'supabase-demo' || p.role !== rolle || p.ref) throw new Error(`kein lokaler Demo-Schlüssel: ${name}`);
}
const admin = { apikey: KEYS.service, Authorization: `Bearer ${KEYS.service}`, 'Content-Type': 'application/json' };
const maske = (s) => String(s ?? '').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (u) => `${u.slice(0, 8)}…`);

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
  const r = await fetch(`${API}/auth/v1/logout?scope=local`, {
    method: 'POST', headers: { apikey: KEYS.anon, Authorization: `Bearer ${s.access_token}` },
  });
  return r.status;
}

const ergebnis = { start: new Date().toISOString(), phasen: {}, blockiert: [], konsole: [] };
let phase = 'start';
let letzterAbzug = 0;
let abzuege = 0;

const inhaber = await konto(/^dok01-inhaber-[0-9a-z]+@example\.invalid$/);
const mitglied = await konto(/^dok01-mitglied-[0-9a-z]+@example\.invalid$/);
const sInhaber = await sitzung(inhaber.email);

const profil = path.join(HIER, 'profil-nachstellung');
fs.rmSync(profil, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(profil, { channel: 'msedge', headless: false, viewport: { width: 1360, height: 880 } });
const page = ctx.pages()[0] ?? (await ctx.newPage());

page.on('console', (m) => {
  const text = m.text();
  if (m.type() === 'error' || m.type() === 'warning' || /\[OfficePilot:/.test(text)) {
    ergebnis.konsole.push({ t: new Date().toISOString(), phase, typ: m.type(), text: maske(text).slice(0, 300) });
  }
});
page.on('pageerror', (e) => ergebnis.konsole.push({ t: new Date().toISOString(), phase, typ: 'pageerror', text: maske(String(e)).slice(0, 300) }));

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
    if (LESE_RPC.test(name) || name === 'ensure_personal_workspace') {
      if (name.startsWith('pull_')) { letzterAbzug = Date.now(); abzuege += 1; }
      return route.continue();
    }
    let typ = null; let kennung = null; let version = null; let geloescht = null;
    try {
      const b = JSON.parse(req.postData() ?? '{}');
      typ = b.p_entity_type ?? null;
      version = b.p_row_version ?? null;
      const pl = b.p_payload ?? {};
      kennung = pl.entry_id ?? pl.client_document_id ?? pl.binding_id ?? pl.client_file_ref_id ?? pl.client_inbox_id ?? pl.id ?? null;
      geloescht = pl.deleted ?? null;
    } catch { /* kein JSON */ }
    ergebnis.blockiert.push({ phase, art: 'rpc', rpc: name, typ, kennung: kennung ? maske(kennung).slice(0, 26) : null, version, geloescht });
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
async function anmelden(s) {
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [SITZUNGSSCHLUESSEL, JSON.stringify(s)]);
  abzuege = 0;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('user-menu').waitFor({ timeout: 60000 });
  return abzugRuhig();
}
async function bild(name) { await page.screenshot({ path: path.join(BILDER, `${name}.png`) }); }

async function ableitungen(docId) {
  await page.goto(`${APP}/dokumente/${docId}`, { waitUntil: 'domcontentloaded' });
  const panel = page.getByTestId(`document-derivative-recovery-status-${docId}`);
  const da = await panel.waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
  if (!da) return { panel: false };
  const zeilen = await page.locator('[data-testid^="document-derivative-recovery-problem-"]').evaluateAll((els) => els.map((e) => ({
    art: e.getAttribute('data-testid').replace('document-derivative-recovery-problem-', ''),
    status: e.getAttribute('data-status'),
    wiederholbar: e.getAttribute('data-can-retry'),
    text: e.innerText.replace(/\s+/g, ' ').slice(0, 160),
  })));
  return { panel: true, zeilen };
}

async function wiederholen(docId, art) {
  const knopf = page.getByTestId(`document-derivative-recovery-retry-${art}`);
  if (!(await knopf.count())) return { knopf: false };
  const vorher = ergebnis.konsole.length;
  await knopf.click();
  let label = '';
  for (let i = 0; i < 120; i += 1) {
    await warte(500);
    label = (await knopf.innerText().catch(() => '(weg)')).trim();
    if (label !== 'Wird erstellt…' && label !== 'Wird bereits ausgeführt') break;
  }
  await warte(1500);
  const panel = await ableitungen(docId).catch(() => null);
  return { knopf: true, label, konsoleNeu: ergebnis.konsole.slice(vorher).map((k) => k.text), panelDanach: panel };
}

// Schritte des Vorschau-Orchestrators (documentFilePdfPreviewEncodeOrchestrationService) einzeln, ohne Speichern.
async function diagnose(docId, intentName) {
  return page.evaluate(async ([id, intentName]) => {
    const r = {};
    const fehler = (e) => ({ ok: false, name: e?.name ?? typeof e, code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 200) });
    const ds = await import('/src/services/documentService.ts');
    const fst = await import('/src/services/documentFileStoreService.ts');
    const hs = await import('/src/services/documentFileHashService.ts');
    const enc = await import('/src/services/documentFilePdfPageJpegEncodeService.ts');
    const planS = await import('/src/services/documentFilePdfDerivativeEncodePlanService.ts');
    const ctxS = await import('/src/services/documentFileDerivativeRecoveryContextService.ts');
    const bindS = await import('/src/services/documentFileRepresentationBindingStoreService.ts');
    const natS = await import('/src/services/documentFileRepresentationBindingService.ts');
    const regS = await import('/src/services/documentFileRepresentationBindingRegistrationService.ts');
    const scope = await import('/src/services/storage/storageScopeService.ts');
    r.scope = scope.getActiveStorageScope().type;
    const doc = ds.getDocumentById(id);
    r.dokument = Boolean(doc);
    if (!doc) return r;
    const ref = fst.getDocumentFileRefById(doc.fileRefId);
    r.original = ref ? { storageType: ref.storageType, lifecycle: ref.lifecycleStatus, mime: ref.mimeType, groesse: ref.fileSize, cloudPfad: Boolean(ref.cloud?.storagePath) } : null;
    const tp = ctxS.getDocumentFileTransformPlanForDerivativeRetry(id);
    r.plan = tp ? tp.intents.map((i) => i.intent) : null;
    // Bindungsbestand: ist jede Bindung für den Registrierschritt gültig?
    const bestand = bindS.getDocumentFileRepresentationBindingStoreSnapshot();
    let ungueltig = 0; const ungueltigeArten = {};
    for (const b of bestand) {
      try { natS.toDocumentFileRepresentationBindingNaturalKey(b); } catch (e) { ungueltig += 1; const k = `${b?.kind}|${String(e?.message).slice(0, 60)}`; ungueltigeArten[k] = (ungueltigeArten[k] ?? 0) + 1; }
    }
    r.bindungen = { gesamt: bestand.length, ungueltig, ungueltigeArten, eigene: bestand.filter((b) => b.documentId === id).map((b) => b.kind) };
    try {
      const probe = regS.registerDocumentFileRepresentationBinding({ bindings: bestand, binding: { documentId: id, kind: intentName === 'create_preview' ? 'preview' : 'thumbnail', fileRefId: 'diagnose-probe' } });
      r.registrierprobe = { ok: true, ergebnis: probe.kind };
    } catch (e) { r.registrierprobe = fehler(e); }
    const intent = tp?.intents.find((i) => i.intent === intentName);
    if (!ref || !intent) return r;
    const ep = planS.planDocumentFilePdfDerivativeEncode({ transformIntent: intent, sourceMimeType: ref.mimeType });
    r.kodierplan = ep.kind;
    let bytes;
    try { bytes = await fst.getOriginalDocumentFileBytes(ref); r.bytes = { ok: Boolean(bytes), laenge: bytes?.byteLength ?? 0 }; } catch (e) { r.bytes = fehler(e); return r; }
    if (!bytes) return r;
    let jpeg;
    try {
      jpeg = await enc.encodeDocumentFilePdfPageToJpeg({ bytes, pageNumber: ep.pageNumber ?? 1, quality: ep.quality, maxEdge: ep.maxEdge });
      r.kodieren = { ok: true, laenge: jpeg.bytes.byteLength, breite: jpeg.width, hoehe: jpeg.height };
    } catch (e) { r.kodieren = fehler(e); return r; }
    let hash;
    try { hash = await hs.computeBufferContentHash(jpeg.bytes); r.hash = { ok: true }; } catch (e) { r.hash = fehler(e); return r; }
    const vorhanden = fst.getDocumentFileRefByHash(hash);
    r.gleicheDateiVorhanden = vorhanden ? { storageType: vorhanden.storageType, lifecycle: vorhanden.lifecycleStatus } : null;
    if (vorhanden) {
      try { r.vorhandeneBytesLokal = await fst.hasStoredOriginalDocumentFile(vorhanden, [{ type: 'guest' }]); } catch (e) { r.vorhandeneBytesLokal = fehler(e); }
    }
    let zeichen = 0;
    for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i); zeichen += k.length + (localStorage.getItem(k) ?? '').length; }
    r.localStorageZeichen = zeichen;
    return r;
  }, [docId, intentName]);
}

// Die echten Orchestratoren mit einem regulären Plan (Vorschau + Vorschaubild, wie beim Import), danach die
// Schritte einzeln — jetzt mit Speichern (nur lokal im Wegwerfprofil; Vorschauen werden nie synchronisiert).
async function orchestrieren(docId) {
  return page.evaluate(async (id) => {
    const r = {};
    const fehler = (e) => ({ ok: false, name: e?.name ?? typeof e, code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 200) });
    const plan = {
      policyId: 'diagnose', mediaProfile: 'pdf_document', hints: {},
      intents: [
        { targetKind: 'thumbnail', intent: 'create_thumbnail', executionIntent: 'preferred' },
        { targetKind: 'preview', intent: 'create_preview', executionIntent: 'preferred' },
      ],
    };
    const th = await import('/src/services/documentFilePdfThumbnailEncodeOrchestrationService.ts');
    const pv = await import('/src/services/documentFilePdfPreviewEncodeOrchestrationService.ts');
    try { r.vorschaubild = await th.orchestratePdfThumbnailEncodeAfterImport({ documentId: id, transformPlan: plan }); } catch (e) { r.vorschaubild = fehler(e); }
    try { r.vorschau = await pv.orchestratePdfPreviewEncodeAfterImport({ documentId: id, transformPlan: plan }); } catch (e) { r.vorschau = fehler(e); }
    for (const k of ['vorschaubild', 'vorschau']) {
      if (r[k]?.previewFileRefId) r[k] = { ...r[k], previewFileRefId: '(gesetzt)' };
      if (r[k]?.thumbnailFileRefId) r[k] = { ...r[k], thumbnailFileRefId: '(gesetzt)' };
    }
    // Einzelschritte bis einschließlich Speichern, um bei einem Fehler die Stelle zu zeigen.
    const ds = await import('/src/services/documentService.ts');
    const fst = await import('/src/services/documentFileStoreService.ts');
    const hs = await import('/src/services/documentFileHashService.ts');
    const enc = await import('/src/services/documentFilePdfPageJpegEncodeService.ts');
    const planS = await import('/src/services/documentFilePdfDerivativeEncodePlanService.ts');
    const doc = ds.getDocumentById(id);
    const ref = doc ? fst.getDocumentFileRefById(doc.fileRefId) : null;
    r.original = ref ? { storageType: ref.storageType, lifecycle: ref.lifecycleStatus } : null;
    if (!ref) return r;
    const ep = planS.planDocumentFilePdfDerivativeEncode({ transformIntent: plan.intents[1], sourceMimeType: ref.mimeType });
    r.kodierplan = { art: ep.kind, seite: ep.pageNumber ?? null, kante: ep.maxEdge ?? null };
    let bytes; let jpeg; let hash;
    try { bytes = await fst.getOriginalDocumentFileBytes(ref); r.s1_bytes = { ok: Boolean(bytes), laenge: bytes?.byteLength ?? 0 }; } catch (e) { r.s1_bytes = fehler(e); return r; }
    try { jpeg = await enc.encodeDocumentFilePdfPageToJpeg({ bytes, pageNumber: ep.pageNumber ?? 1, quality: ep.quality, maxEdge: ep.maxEdge }); r.s2_kodieren = { ok: true, laenge: jpeg.bytes.byteLength }; } catch (e) { r.s2_kodieren = fehler(e); return r; }
    try { hash = await hs.computeBufferContentHash(jpeg.bytes); } catch (e) { r.s3_hash = fehler(e); return r; }
    const vorhanden = fst.getDocumentFileRefByHash(hash);
    r.s3_gleicheDatei = vorhanden ? { storageType: vorhanden.storageType, lifecycle: vorhanden.lifecycleStatus } : null;
    try {
      const st = await fst.storeDocumentFileFromCachedPayload({ fileName: 'diagnose.preview.jpg', mimeType: jpeg.mimeType, fileSize: jpeg.bytes.byteLength, bytes: jpeg.bytes }, { lifecycleIntent: 'committed' });
      r.s4_speichern = { ok: true, neu: st.created, lifecycle: st.fileRef.lifecycleStatus };
    } catch (e) { r.s4_speichern = fehler(e); }
    return r;
  }, docId);
}

try {
  // ---------------------------------------------------------------- A: Inhaber
  phase = 'inhaber';
  ergebnis.phasen.inhaberAnmeldung = { abzugRuhig: await anmelden(sInhaber), abzuege };
  await bild('a1-inhaber-angemeldet');
  if (!process.argv.includes('--nur-b')) {
    ergebnis.phasen.kopieVorher = await ableitungen(DOC_KOPIE);
    await bild('a2-kopie-ableitungen-vorher');
    const konsoleVorher = ergebnis.konsole.length;
    ergebnis.phasen.kopieOrchestrierung = await orchestrieren(DOC_KOPIE);
    ergebnis.phasen.kopieOrchestrierungKonsole = ergebnis.konsole.slice(konsoleVorher).map((k) => k.text);
    const konsoleVorher2 = ergebnis.konsole.length;
    ergebnis.phasen.originalOrchestrierung = await orchestrieren(DOC_ORIG);
    ergebnis.phasen.originalOrchestrierungKonsole = ergebnis.konsole.slice(konsoleVorher2).map((k) => k.text);
    ergebnis.phasen.kopieNachher = await ableitungen(DOC_KOPIE);
    await page.goto(`${APP}/dokumente/${DOC_KOPIE}`, { waitUntil: 'domcontentloaded' });
    await warte(5000);
    ergebnis.phasen.kopieDetailBilder = await page.evaluate(() =>
      [...document.querySelectorAll('img')].filter((i) => i.src.startsWith('blob:') && i.naturalWidth > 0).length);
    await bild('a3-kopie-nach-orchestrierung');
  }
  if (process.argv.includes('--nur-a')) throw Object.assign(new Error('nur Teil A'), { nurA: true });
  // Was der Inhaber lokal sieht (Vergleich für Teil B).
  await page.goto(`${APP}/dokumente`, { waitUntil: 'domcontentloaded' });
  await warte(4000);
  ergebnis.phasen.inhaberArchiv = await page.evaluate(() => {
    const text = document.body.innerText;
    const kennzeichen = ['Holzhandel', 'Baustoffe', 'DOK01 Rechnung 17', 'WEISS DOK01 Archiv-Testrechnung', 'Quittung'];
    return Object.fromEntries(kennzeichen.map((k) => [k, (text.match(new RegExp(k, 'g')) ?? []).length]));
  });
  await bild('a5-inhaber-archiv');

  // ---------------------------------------------------------------- B: Rollenwechsel
  phase = 'abmeldung';
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('user-menu').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Benutzermenü' }).click();
  // Die Karte „Weiterarbeiten" überdeckt den aufgeklappten Menüeintrag (auch ein erzwungener Klick trifft die Karte);
  // deshalb das Klickereignis direkt am Eintrag — derselbe Abmeldeweg der App.
  await page.getByTestId('logout-button').dispatchEvent('click');
  await page.getByTestId('login-page').waitFor({ timeout: 30000 });
  ergebnis.phasen.nachAbmeldung = await page.evaluate(() => {
    let betriebsBestaende = 0; let sitzung = false;
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (/^officetakt:workspace:/.test(k) || /:workspace:/.test(k)) betriebsBestaende += 1;
      if (/^sb-.*-auth-token$/.test(k)) sitzung = true;
    }
    return { lokaleBetriebsBestaende: betriebsBestaende, sitzungImSpeicher: sitzung };
  });
  await bild('b1-nach-abmeldung');

  phase = 'mitglied';
  const sMitglied = await sitzung(mitglied.email);
  ergebnis._mitgliedSitzung = true;
  try {
    ergebnis.phasen.mitgliedAnmeldung = { abzugRuhig: await anmelden(sMitglied), abzuege };
    await warte(20000); // Nachlauf: Altbestand-Abgleich und Warteschlange
    await bild('b2-mitglied-angemeldet');
    await page.goto(`${APP}/dokumente`, { waitUntil: 'domcontentloaded' });
    await warte(4000);
    ergebnis.phasen.mitgliedArchiv = await page.evaluate(() => {
      const text = document.body.innerText;
      const kennzeichen = ['Holzhandel', 'Baustoffe', 'DOK01 Rechnung 17', 'WEISS DOK01 Archiv-Testrechnung', 'Quittung'];
      return Object.fromEntries(kennzeichen.map((k) => [k, (text.match(new RegExp(k, 'g')) ?? []).length]));
    });
    await bild('b3-mitglied-archiv');
    await page.goto(`${APP}/synchronisation`, { waitUntil: 'domcontentloaded' });
    await warte(4000);
    ergebnis.phasen.mitgliedSync = await page.evaluate(() => document.querySelector('main')?.innerText.replace(/\s+/g, ' ').slice(0, 900) ?? '');
    await bild('b4-mitglied-sync');
  } finally {
    ergebnis.phasen.widerrufMitglied = await widerrufen(sMitglied);
  }
} catch (e) {
  if (!e?.nurA) {
    ergebnis.abbruch = maske(String(e?.stack ?? e)).slice(0, 600);
    await bild('zz-abbruch').catch(() => {});
  }
} finally {
  await ctx.close().catch(() => {});
  ergebnis.phasen.widerrufInhaber = await widerrufen(sInhaber);
  fs.rmSync(profil, { recursive: true, force: true });
  ergebnis.profilGeloescht = !fs.existsSync(profil);
  ergebnis.ende = new Date().toISOString();
  fs.writeFileSync(path.join(HIER, 'nachstellung-ergebnis.json'), JSON.stringify(ergebnis, null, 2));
  console.log(JSON.stringify({ abbruch: ergebnis.abbruch ?? null, blockiert: ergebnis.blockiert.length, konsole: ergebnis.konsole.length, profilGeloescht: ergebnis.profilGeloescht }));
}
