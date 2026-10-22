-- DOKUMENTE-01 — Rücknahme der lokal eingespielten Migrationen 20261125120000 und 20261126120000.
--
-- Nur für die LOKALE Instanz (Docker, 127.0.0.1:54321), niemals --linked oder remote.
-- Eingespielt am 2026-10-20T02:23:58Z per psql in einer Transaktion (die lokale
-- Migrationshistorie wird wie seit 20261023 nicht geführt). Die Altbestandsumstellung
-- aus 20261126 hat lokal 0 Zeilen geändert; es gibt nichts zurückzuschreiben.
--
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1 \
--     < pruefunterlagen/dokumente-01/lokal/ruecknahme-20261125-20261126-lokal.sql

drop trigger if exists workspace_paper_register_entries_document_owner on public.workspace_paper_register_entries;
drop function if exists public.workspace_paper_register_entries_document_owner();
drop function if exists public.workspace_paper_register_entries_assign_document_owner();

drop trigger if exists workspace_files_retention_guard on public.workspace_files;
drop trigger if exists workspace_document_file_bindings_retention_guard on public.workspace_document_file_bindings;
drop trigger if exists workspace_documents_retention_guard on public.workspace_documents;
drop function if exists public.workspace_files_retention_guard();
drop function if exists public.workspace_document_file_bindings_retention_guard();
drop function if exists public.workspace_documents_retention_guard();
drop function if exists public.workspace_document_retention(public.workspace_documents);
drop function if exists public.workspace_retention_rule(text, text, text, boolean, boolean, text[], integer, date);
drop function if exists public.workspace_retention_year(text);
