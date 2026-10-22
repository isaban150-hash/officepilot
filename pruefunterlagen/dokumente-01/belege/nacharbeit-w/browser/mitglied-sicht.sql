-- nur lesend, in einer zurückgerollten Transaktion: Was liefert der Abzug dem DOK01-Mitglied?
\pset pager off
begin;
create temp table t_ws on commit drop as
  select m.workspace_id as id
  from public.workspace_members m join auth.users u on u.id = m.user_id
  where u.email ~ '^dok01-inhaber-[0-9a-z]+@example\.invalid$' and m.role = 'owner' and m.status = 'active';
create temp table t_mitglied on commit drop as
  select u.id from auth.users u where u.email ~ '^dok01-mitglied-[0-9a-z]+@example\.invalid$';
grant select on t_ws, t_mitglied to authenticated;

select set_config('request.jwt.claims', json_build_object('sub', (select id from t_mitglied)::text, 'role', 'authenticated')::text, true);
set local role authenticated;

with abzug as (select public.pull_workspace_sync_state((select id from t_ws)) as j)
select
  (select count(*) from jsonb_array_elements(coalesce(j->'paper_register_entries', '[]'::jsonb))) as papier_eintraege,
  (select count(*) from jsonb_array_elements(coalesce(j->'paper_register_entries', '[]'::jsonb)) e where (e->>'deleted')::boolean) as davon_grabsteine,
  (select string_agg(k, ', ' order by k) from jsonb_object_keys(j) k) as schluessel
from abzug;

rollback;
