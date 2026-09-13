-- EMAIL-01B2 — autoritative Uebernahme des Provider-Ergebnisses samt
-- atomarer Rechnungs-Kopplung.
--
-- Nur der Server (Edge Function `send-document`, service_role) ruft diese
-- Funktion. Ein Client kann weder provider_message_id noch
-- provider_accepted noch sent_source='officepilot' setzen.
--
-- Kopplungsregel (monoton, kein Zwischenzustand):
--   * document_kind = 'invoice' und Ergebnis provider_accepted
--       -> in derselben Transaktion: invoice_status = 'versendet',
--          sentAt = heutiges Datum (Serverzeit, UTC), sentVia = 'email'.
--   * sent_source/sent_delivery_id:
--       - null                      -> officepilot + diese Delivery
--       - 'manual'                  -> officepilot + diese Delivery; die
--                                      manuellen Angaben bleiben als
--                                      payload.sentManualPrior erhalten
--       - 'officepilot' mit anderer, noch als versendet geltender Delivery
--                                   -> unveraendert (erste erfolgreiche
--                                      Delivery bleibt die Referenz; die neue
--                                      Delivery ist trotzdem provider_accepted
--                                      und steht in der Historie)
--       - 'officepilot' mit derselben Delivery -> idempotent
--   * document_kind = 'invoice_correction' -> Original wird NIE veraendert.
--   * Fehlschlaege (failed/rejected/unknown) veraendern die Rechnung nie.

create or replace function public.mark_workspace_document_delivery_accepted(
  p_delivery_id uuid,
  p_provider_message_id text,
  p_expected_row_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_delivery public.workspace_document_deliveries;
  v_invoice public.workspace_invoices;
  v_linked public.workspace_document_deliveries;
  v_message_id text;
  v_today text := to_char((now() at time zone 'utc')::date, 'YYYY-MM-DD');
  v_coupling text := 'none';
  v_prior jsonb;
begin
  if p_delivery_id is null then
    raise exception 'delivery_id fehlt';
  end if;
  v_message_id := nullif(btrim(coalesce(p_provider_message_id, '')), '');
  if v_message_id is null or length(v_message_id) > 255 then
    raise exception 'provider_message_id fehlt';
  end if;

  select * into v_delivery from public.workspace_document_deliveries where id = p_delivery_id for update;
  if v_delivery.id is null then
    raise exception 'Delivery nicht gefunden';
  end if;
  if p_expected_row_version is not null and v_delivery.row_version <> p_expected_row_version then
    raise exception 'row_version veraltet';
  end if;

  -- Bereits angenommen (auch spaetere Webhook-Zustaende): nur die Kopplung bestaetigen, nie zurueck.
  if v_delivery.status not in ('provider_accepted', 'delivered', 'bounced', 'complained') then
    if not public.document_delivery_transition_allowed(v_delivery.status, 'provider_accepted') then
      raise exception 'Statusuebergang % -> provider_accepted nicht erlaubt', v_delivery.status;
    end if;
    update public.workspace_document_deliveries
    set
      status = 'provider_accepted',
      provider_message_id = v_message_id,
      provider_accepted_at = now(),
      error_category = null,
      error_code = null,
      error_message_safe = null,
      row_version = row_version + 1,
      updated_at = now()
    where id = v_delivery.id
    returning * into v_delivery;
  elsif v_delivery.provider_message_id is distinct from v_message_id then
    -- Replay mit anderer Provider-ID: die erste bleibt die Wahrheit.
    raise exception 'Delivery bereits mit anderer provider_message_id angenommen';
  end if;

  -- Kopplung nur fuer die Rechnung selbst; der Korrekturbeleg laesst das Original in Ruhe.
  if v_delivery.document_kind = 'invoice' then
    select * into v_invoice
    from public.workspace_invoices
    where workspace_id = v_delivery.workspace_id
      and client_invoice_id = v_delivery.linked_invoice_id
    for update;
    if v_invoice.id is null then
      raise exception 'Rechnung nicht gefunden';
    end if;
    if v_invoice.invoice_status = 'entwurf' then
      raise exception 'Rechnung nicht finalisiert';
    end if;

    if v_invoice.sent_delivery_id = v_delivery.id then
      v_coupling := 'already_linked';
    elsif v_invoice.sent_source = 'officepilot' and v_invoice.sent_delivery_id is not null then
      select * into v_linked from public.workspace_document_deliveries where id = v_invoice.sent_delivery_id;
      if v_linked.id is not null and v_linked.status in ('provider_accepted', 'delivered', 'bounced', 'complained') then
        -- Erste erfolgreiche Delivery bleibt Referenz; Rechnung ist bereits versendet.
        v_coupling := 'kept_existing';
      else
        v_coupling := 'relinked';
      end if;
    elsif v_invoice.sent_source = 'manual' then
      v_coupling := 'upgraded_from_manual';
      v_prior := jsonb_strip_nulls(jsonb_build_object(
        'sentAt', v_invoice.payload->>'sentAt',
        'sentVia', v_invoice.payload->>'sentVia',
        'sentNote', v_invoice.payload->>'sentNote'
      ));
    else
      v_coupling := 'linked';
    end if;

    if v_coupling in ('linked', 'relinked', 'upgraded_from_manual') then
      update public.workspace_invoices
      set
        invoice_status = 'versendet',
        sent_source = 'officepilot',
        sent_delivery_id = v_delivery.id,
        payload = (payload - 'sentNote')
          || jsonb_build_object(
            'status', 'versendet',
            'sentAt', v_today,
            'sentVia', 'email',
            'sentSource', 'officepilot',
            'sentDeliveryId', v_delivery.id::text
          )
          || case when v_prior is null or v_prior = '{}'::jsonb then '{}'::jsonb
                  else jsonb_build_object('sentManualPrior', v_prior) end,
        row_version = row_version + 1,
        updated_at = now()
      where id = v_invoice.id
      returning * into v_invoice;
    elsif v_coupling = 'kept_existing' and v_invoice.invoice_status <> 'versendet' then
      -- Defensiv: eine verknuepfte, angenommene Delivery bedeutet immer versendet.
      update public.workspace_invoices
      set invoice_status = 'versendet',
          payload = payload || jsonb_build_object('status', 'versendet'),
          row_version = row_version + 1,
          updated_at = now()
      where id = v_invoice.id
      returning * into v_invoice;
    end if;

    if v_invoice.invoice_status is distinct from 'versendet' then
      raise exception 'Sent-Kopplung Nachbedingung verletzt: invoice_status';
    end if;
  end if;

  return jsonb_build_object(
    'delivery', to_jsonb(v_delivery),
    'coupling', v_coupling,
    'invoice', case when v_invoice.id is null then null else jsonb_build_object(
      'invoice_status', v_invoice.invoice_status,
      'sent_source', v_invoice.sent_source,
      'sent_delivery_id', v_invoice.sent_delivery_id,
      'row_version', v_invoice.row_version
    ) end
  );
end;
$$;

revoke all on function public.mark_workspace_document_delivery_accepted(uuid, text, bigint) from public;
revoke all on function public.mark_workspace_document_delivery_accepted(uuid, text, bigint) from authenticated;
grant execute on function public.mark_workspace_document_delivery_accepted(uuid, text, bigint) to service_role;

-- Server-Lesepfad: Delivery samt Rechnungskontext (Snapshot fuer Absender/Reply-To), ohne RLS-Umweg.
create or replace function public.get_workspace_document_delivery_for_send(
  p_workspace_id uuid,
  p_client_delivery_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_delivery public.workspace_document_deliveries;
  v_invoice public.workspace_invoices;
begin
  select * into v_delivery
  from public.workspace_document_deliveries
  where workspace_id = p_workspace_id
    and client_delivery_id = btrim(coalesce(p_client_delivery_id, ''));
  if v_delivery.id is null then
    return null;
  end if;
  select * into v_invoice
  from public.workspace_invoices
  where workspace_id = v_delivery.workspace_id
    and client_invoice_id = v_delivery.linked_invoice_id;
  return jsonb_build_object(
    'delivery', to_jsonb(v_delivery),
    'invoice', case when v_invoice.id is null then null else jsonb_build_object(
      'client_invoice_id', v_invoice.client_invoice_id,
      'invoice_number', v_invoice.invoice_number,
      'invoice_status', v_invoice.invoice_status,
      'cancelled_at', v_invoice.cancelled_at,
      'cancellation_kind', v_invoice.cancellation_kind,
      'correction_document_id', v_invoice.correction_document_id,
      'sent_source', v_invoice.sent_source,
      'sent_delivery_id', v_invoice.sent_delivery_id,
      'company_snapshot', v_invoice.payload->'companySnapshot'
    ) end
  );
end;
$$;

revoke all on function public.get_workspace_document_delivery_for_send(uuid, text) from public;
revoke all on function public.get_workspace_document_delivery_for_send(uuid, text) from authenticated;
grant execute on function public.get_workspace_document_delivery_for_send(uuid, text) to service_role;

-- Schreibrecht eines konkreten Nutzers — der Server prueft es fuer den Aufrufer, nicht fuer sich selbst.
create or replace function public.workspace_user_can_write(p_workspace_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = p_user_id
      and wm.status = 'active'
      and wm.role in ('owner', 'admin')
  );
$$;

revoke all on function public.workspace_user_can_write(uuid, uuid) from public;
revoke all on function public.workspace_user_can_write(uuid, uuid) from authenticated;
grant execute on function public.workspace_user_can_write(uuid, uuid) to service_role;
