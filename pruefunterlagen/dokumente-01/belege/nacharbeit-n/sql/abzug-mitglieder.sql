-- nur lesend, zurückgerollt: Was liefert pull_workspace_sync_state unter "members" für Inhaber und Mitglied?
-- Ausgabe ohne Kennungen: nur Anzahl, Rollen und ob das eigene Konto enthalten ist.
\pset pager off
\o /dev/null
begin;
create temp table t_ws on commit drop as
  select m.workspace_id as id from public.workspace_members m join auth.users u on u.id = m.user_id
  where u.email ~ '^dok01-inhaber-[0-9a-z]+@example\.invalid$' and m.role = 'owner' and m.status = 'active';
create temp table t_konten on commit drop as
  select u.id, case when u.email ~ '^dok01-inhaber-' then 'inhaber' else 'mitglied' end as rolle
  from auth.users u where u.email ~ '^dok01-(inhaber|mitglied)-[0-9a-z]+@example\.invalid$';
grant select on t_ws, t_konten to authenticated;
create temp table t_ergebnis (rolle text, anzahl int, rollen text, eigenes_enthalten boolean) on commit drop;
grant insert, select on t_ergebnis to authenticated;

do $d$
declare v record; j jsonb;
begin
  for v in select * from t_konten loop
    perform set_config('request.jwt.claims', json_build_object('sub', v.id::text, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    j := public.pull_workspace_sync_state((select id from t_ws));
    insert into t_ergebnis values (
      v.rolle,
      jsonb_array_length(coalesce(j->'members', '[]'::jsonb)),
      (select string_agg(e->>'role' || '/' || (e->>'status'), ', ' order by e->>'role') from jsonb_array_elements(coalesce(j->'members', '[]'::jsonb)) e),
      exists (select 1 from jsonb_array_elements(coalesce(j->'members', '[]'::jsonb)) e where e->>'user_id' = v.id::text)
    );
    execute 'reset role';
  end loop;
end;
$d$;
\o
select * from t_ergebnis order by rolle;
rollback;
