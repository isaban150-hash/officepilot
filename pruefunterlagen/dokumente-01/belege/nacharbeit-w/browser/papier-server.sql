-- nur lesend: Papierregister-Einträge des DOK01-Betriebs, Eigentümer als Rolle, Kennungen gekürzt.
\pset pager off
create temp view dok01_ws as
  select m.workspace_id as id
  from public.workspace_members m
  join auth.users u on u.id = m.user_id
  where u.email ~ '^dok01-inhaber-[0-9a-z]+@example\.invalid$' and m.role = 'owner' and m.status = 'active';

select left(e.client_entry_id, 22) as eintrag, left(e.client_document_id, 13) as dok,
       coalesce(mc.role, '?') as created_by_rolle, coalesce(mu.role, '?') as updated_by_rolle,
       coalesce(md.role, '(kein Dok)') as dok_anleger_rolle, d.deleted as dok_geloescht,
       e.deleted, e.row_version as v,
       to_char(e.created_at at time zone 'UTC', 'HH24:MI:SS') as angelegt_utc,
       to_char(e.updated_at at time zone 'UTC', 'HH24:MI:SS') as geaendert_utc,
       e.payload->>'physicalFiled' as abgeheftet,
       public.workspace_document_is_restricted(e.workspace_id, e.client_document_id) as geschuetzt
from public.workspace_paper_register_entries e
left join public.workspace_members mc on mc.workspace_id = e.workspace_id and mc.user_id = e.created_by
left join public.workspace_members mu on mu.workspace_id = e.workspace_id and mu.user_id = e.updated_by
left join public.workspace_documents d on d.workspace_id = e.workspace_id and d.client_document_id = e.client_document_id
left join public.workspace_members md on md.workspace_id = d.workspace_id and md.user_id = d.created_by
where e.workspace_id in (select id from dok01_ws)
order by e.created_at;
