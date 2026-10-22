-- nur lesend: Dateien des DOK01-Betriebs nach Typ, mit/ohne Bindung (Kennungen gekürzt).
\pset pager off
create temp view dok01_ws as
  select m.workspace_id as id
  from public.workspace_members m join auth.users u on u.id = m.user_id
  where u.email ~ '^dok01-inhaber-[0-9a-z]+@example\.invalid$' and m.role = 'owner' and m.status = 'active';

select f.mime_type, count(*) as dateien,
       count(*) filter (where exists (select 1 from public.workspace_document_file_bindings b
                                      where b.workspace_id = f.workspace_id and b.client_file_ref_id = f.client_file_ref_id)) as gebunden,
       count(*) filter (where f.derived_from_client_file_ref_id is not null) as abgeleitet,
       min(f.size_bytes) as min_b, max(f.size_bytes) as max_b
from public.workspace_files f
where f.workspace_id in (select id from dok01_ws)
group by f.mime_type order by 1;

-- Die 38 757-Byte-Vorschau aus der Nachstellung: gibt es eine gleich große JPEG-Datei, und wovon ist sie abgeleitet?
select left(f.client_file_ref_id, 16) as datei, f.size_bytes, left(f.content_sha256, 12) as sha,
       left(coalesce(f.derived_from_client_file_ref_id, '-'), 16) as abgeleitet_von,
       to_char(f.created_at at time zone 'UTC', 'HH24:MI:SS') as angelegt_utc
from public.workspace_files f
where f.workspace_id in (select id from dok01_ws) and f.mime_type = 'image/jpeg'
order by f.created_at;
