-- CLOUD-ORDER-CHAIN-03B2: Invoice pull RPC for multi-device reconciliation.
-- Read-only. No new tables. Does not alter 03A/03B1 migrations.

create or replace function public.pull_workspace_invoices(
  p_workspace_id uuid,
  p_since timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;

  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;

  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', wi.id,
          'workspace_id', wi.workspace_id,
          'vorgang_id', wi.vorgang_id,
          'client_invoice_id', wi.client_invoice_id,
          'invoice_number', wi.invoice_number,
          'invoice_year', wi.invoice_year,
          'invoice_sequence_number', wi.invoice_sequence_number,
          'invoice_type', wi.invoice_type,
          'invoice_status', wi.invoice_status,
          'payload', wi.payload,
          'row_version', wi.row_version,
          'created_at', wi.created_at,
          'updated_at', wi.updated_at
        )
        order by wi.created_at asc, wi.id asc
      )
      from public.workspace_invoices wi
      where wi.workspace_id = p_workspace_id
        and (p_since is null or wi.updated_at > p_since)
    ),
    '[]'::jsonb
  );
end;
$$;

revoke all on function public.pull_workspace_invoices(uuid, timestamptz) from public;
grant execute on function public.pull_workspace_invoices(uuid, timestamptz) to authenticated;
