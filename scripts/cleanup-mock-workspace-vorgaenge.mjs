/**
 * MANUAL cloud cleanup for demo seed vorgänge (v-001, v-002, v-003).
 *
 * NOT run by the app on login or bootstrap.
 *
 * Usage (from repo root):
 *   node scripts/cleanup-mock-workspace-vorgaenge.mjs
 *
 * Required env:
 *   VITE_SUPABASE_URL or SUPABASE_URL
 *   VITE_SUPABASE_ANON_KEY or SUPABASE_ANON_KEY
 *   CLEANUP_EMAIL
 *   CLEANUP_PASSWORD
 *   CLEANUP_WORKSPACE_ID
 *
 * Optional:
 *   CLEANUP_FORCE_MISSING=1  — also tombstone IDs absent from pull
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const MOCK_IDS = ['v-001', 'v-002', 'v-003'];

function loadEnvLocal() {
  const path = resolve(process.cwd(), '.env.local');
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (process.env[key]) continue;
    process.env[key] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

loadEnvLocal();

const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const email = process.env.CLEANUP_EMAIL;
const password = process.env.CLEANUP_PASSWORD;
const workspaceId = process.env.CLEANUP_WORKSPACE_ID;
const forceMissing = process.env.CLEANUP_FORCE_MISSING === '1';

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
}

if (!url || !key) fail('Missing SUPABASE_URL / SUPABASE_ANON_KEY (or VITE_*)');
if (!email || !password) fail('Missing CLEANUP_EMAIL / CLEANUP_PASSWORD');
if (!workspaceId) fail('Missing CLEANUP_WORKSPACE_ID');

const client = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: authData, error: authError } = await client.auth.signInWithPassword({
  email,
  password,
});
if (authError || !authData.session) {
  fail(authError?.message || 'Login failed');
}

const { data: pull, error: pullError } = await client.rpc('pull_workspace_sync_state', {
  p_workspace_id: workspaceId,
});
if (pullError) fail(`pull_workspace_sync_state: ${pullError.message}`);

const rows = Array.isArray(pull?.vorgaenge) ? pull.vorgaenge : [];
const byId = new Map(rows.map((row) => [row.vorgang_id, row]));

const alreadyDeleted = [];
const active = [];
for (const id of MOCK_IDS) {
  const row = byId.get(id);
  if (!row) continue;
  if (row.deleted) alreadyDeleted.push(id);
  else active.push(id);
}

const toTombstone = forceMissing
  ? MOCK_IDS.filter((id) => !alreadyDeleted.includes(id))
  : active;

const tombstoned = [];
const errors = [];

for (const vorgangId of toTombstone) {
  const existing = byId.get(vorgangId);
  const payload = {
    vorgang_id: vorgangId,
    id: vorgangId,
    deleted: true,
    payload: {
      id: vorgangId,
      title: existing?.payload?.title || vorgangId,
      customer: existing?.payload?.customer || '',
      baustelle: existing?.payload?.baustelle || '',
      status: existing?.payload?.status || 'eingegangen',
      materialSource: existing?.payload?.materialSource || 'unclear',
      orderPositions: existing?.payload?.orderPositions || [],
    },
  };
  const { error } = await client.rpc('upsert_workspace_sync_entity', {
    p_workspace_id: workspaceId,
    p_entity_type: 'vorgang',
    p_payload: payload,
    p_row_version: existing ? Number(existing.row_version) : 0,
  });
  if (error) {
    errors.push({ vorgangId, message: error.message });
  } else {
    tombstoned.push(vorgangId);
  }
}

console.log(
  JSON.stringify(
    {
      ok: errors.length === 0,
      workspaceId,
      mockIds: MOCK_IDS,
      activeBefore: active,
      alreadyDeleted,
      tombstoned,
      errors,
      note: 'Manual cleanup only — not invoked by app login/bootstrap.',
    },
    null,
    2,
  ),
);

await client.auth.signOut();
process.exit(errors.length === 0 ? 0 : 1);
