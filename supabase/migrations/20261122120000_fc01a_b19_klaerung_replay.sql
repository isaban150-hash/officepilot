/*
 * FINANZ-CORE-01A — Restnacharbeit nach WEISS-Bericht 18, END18-R1 (P2): Klärung der Fristgrundlage
 * wirklich idempotent.
 *
 * Folgemigration zu 20261119120000_fc01a_inv_fristgrundlage.sql (unverändert). Ersetzt nur
 * clarify_workspace_invoice_frist; Prüfregeln, Rechte, Sperrfolge Vorgang -> Rechnung, Protokoll und Bindung
 * bleiben gleich.
 *
 * Befund (WEISS K7): Die Wiederholung derselben Kennung wurde nur vor dem Sperrerwerb geprüft. Sendet eine
 * zweite Sitzung dieselbe Klärung, während die erste die Rechnung gesperrt hält, wartet sie, prüft danach
 * nicht erneut und scheitert beim Einfügen mit SQLSTATE 23505 statt mit einer erfolgreichen Wiederholung.
 *
 * Korrektur:
 *  1. Nach dem Sperrerwerb wird die Wiederholung erneut geprüft: gleicher Inhalt -> Erfolg ohne zweite
 *     Protokollzeile und ohne zweite Versionsänderung; anderer Inhalt -> invoice_frist_klaerung_conflict.
 *  2. Dieselbe Kennung parallel an einer anderen Rechnung -> invoice_frist_klaerung_conflict statt 23505.
 */

create or replace function public.clarify_workspace_invoice_frist(
  p_workspace_id uuid,
  p_client_invoice_id text,
  p_client_klaerung_id text,
  p_klaerung jsonb,
  p_begruendung text
)
returns setof public.workspace_invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_invoice_id text;
  v_klaerung_id text;
  v_begruendung text;
  v_vorgang_id text;
  v_invoice public.workspace_invoices;
  v_existing public.workspace_invoice_frist_klaerungen;
  v_art text;
  v_region text;
  v_gemeinde jsonb := '{}'::jsonb;
  v_lage_vorher jsonb;
  v_lage jsonb;
  v_kalender date;
  v_wirksam date;
  v_frueh date;
  v_i integer;
  v_pct numeric;
  v_days integer;
  v_basis date;
  v_ziel date;
  v_klaerung jsonb;
  v_updated public.workspace_invoices;
begin
  perform public.assert_financial_action_allowed(p_workspace_id);

  v_invoice_id := nullif(btrim(coalesce(p_client_invoice_id, '')), '');
  if v_invoice_id is null then
    raise exception 'client_invoice_id fehlt';
  end if;
  v_klaerung_id := nullif(btrim(coalesce(p_client_klaerung_id, '')), '');
  if v_klaerung_id is null or length(v_klaerung_id) > 120 then
    raise exception 'invoice_frist_klaerung_invalid: client_klaerung_id' using errcode = 'P0001';
  end if;
  v_begruendung := btrim(coalesce(p_begruendung, ''));
  if length(v_begruendung) < 3 or length(v_begruendung) > 500 then
    raise exception 'invoice_frist_klaerung_invalid: begruendung' using errcode = 'P0001';
  end if;
  if p_klaerung is null or jsonb_typeof(p_klaerung) <> 'object' then
    raise exception 'invoice_frist_klaerung_invalid: klaerung' using errcode = 'P0001';
  end if;

  /* Normalform der Angabe -- nur die Schluessel, die fuer ihre Art etwas bedeuten. */
  v_art := p_klaerung->>'art';
  if v_art = 'inland' then
    v_region := p_klaerung->>'region';
    if v_region is null or not (v_region = any (array['BW', 'BY', 'BE', 'BB', 'HB', 'HH', 'HE', 'MV', 'NI', 'NW', 'RP', 'SL', 'SN', 'ST', 'SH', 'TH'])) then
      raise exception 'invoice_frist_klaerung_invalid: region' using errcode = 'P0001';
    end if;
    if v_region in ('SN', 'TH') and jsonb_typeof(p_klaerung->'fronleichnam') = 'boolean' then
      v_gemeinde := v_gemeinde || jsonb_build_object('fronleichnam', p_klaerung->'fronleichnam');
    end if;
    if v_region = 'BY' then
      if jsonb_typeof(p_klaerung->'mariaeHimmelfahrt') = 'boolean' then
        v_gemeinde := v_gemeinde || jsonb_build_object('mariaeHimmelfahrt', p_klaerung->'mariaeHimmelfahrt');
      end if;
      if jsonb_typeof(p_klaerung->'augsburgerFriedensfest') = 'boolean' then
        v_gemeinde := v_gemeinde || jsonb_build_object('augsburgerFriedensfest', p_klaerung->'augsburgerFriedensfest');
      end if;
    end if;
    v_klaerung := jsonb_build_object('art', 'inland', 'region', v_region) || v_gemeinde;
  elsif v_art = 'ausland' then
    v_kalender := public.workspace_safe_date(p_klaerung->>'kalenderEnde');
    v_wirksam := public.workspace_safe_date(p_klaerung->>'wirksamesEnde');
    if v_kalender is null or v_wirksam is null then
      raise exception 'invoice_frist_klaerung_invalid: datum' using errcode = 'P0001';
    end if;
    v_frueh := v_kalender;
    v_i := 0;
    while v_i < 40 and extract(isodow from v_frueh) in (6, 7) loop
      v_frueh := v_frueh + 1;
      v_i := v_i + 1;
    end loop;
    /* Das wirksame Ende liegt nie vor dem Sa/So-Ende; 60 Tage sind eine Eingabegrenze, keine Fristregel. */
    if v_wirksam < v_frueh or v_wirksam > v_kalender + 60 or extract(isodow from v_wirksam) in (6, 7) then
      raise exception 'invoice_frist_klaerung_invalid: wirksamesEnde' using errcode = 'P0001';
    end if;
    v_klaerung := jsonb_build_object(
      'art', 'ausland',
      'kalenderEnde', to_char(v_kalender, 'YYYY-MM-DD'),
      'wirksamesEnde', to_char(v_wirksam, 'YYYY-MM-DD')
    );
  else
    raise exception 'invoice_frist_klaerung_invalid: art' using errcode = 'P0001';
  end if;

  /* Wiederholung derselben Kennung. */
  select * into v_existing
  from public.workspace_invoice_frist_klaerungen k
  where k.workspace_id = p_workspace_id
    and k.client_klaerung_id = v_klaerung_id;
  if v_existing.id is not null then
    if v_existing.client_invoice_id is distinct from v_invoice_id
       or v_existing.klaerung is distinct from v_klaerung
       or v_existing.begruendung is distinct from v_begruendung then
      raise exception 'invoice_frist_klaerung_conflict' using errcode = 'P0001';
    end if;
    return query
      select wi.* from public.workspace_invoices wi
      where wi.workspace_id = p_workspace_id and wi.client_invoice_id = v_invoice_id;
    return;
  end if;

  /* Sperrfolge wie Zahlung, Storno und Schlussrechnung: erst der Vorgang, dann die Rechnung. */
  select wi.vorgang_id into v_vorgang_id
  from public.workspace_invoices wi
  where wi.workspace_id = p_workspace_id
    and wi.client_invoice_id = v_invoice_id;
  if v_vorgang_id is not null then
    perform 1
    from public.workspace_vorgaenge v
    where v.workspace_id = p_workspace_id
      and v.vorgang_id = v_vorgang_id
    for update;
  end if;

  select * into v_invoice
  from public.workspace_invoices
  where workspace_id = p_workspace_id
    and client_invoice_id = v_invoice_id
  for update;

  if v_invoice.id is null then
    raise exception 'Rechnung nicht gefunden';
  end if;

  /*
   * FINANZ-CORE-01A (END18-R1) — dieselbe Prüfung **nach** dem Sperrerwerb: Ein paralleler Aufruf mit
   * derselben Kennung hat gewartet, bis der erste festgeschrieben war, und sieht dessen Zeile jetzt. Gleicher
   * Inhalt ist eine Wiederholung (Erfolg, keine zweite Protokollzeile), anderer Inhalt ein Konflikt.
   */
  select * into v_existing
  from public.workspace_invoice_frist_klaerungen k
  where k.workspace_id = p_workspace_id
    and k.client_klaerung_id = v_klaerung_id;
  if v_existing.id is not null then
    if v_existing.client_invoice_id is distinct from v_invoice_id
       or v_existing.klaerung is distinct from v_klaerung
       or v_existing.begruendung is distinct from v_begruendung then
      raise exception 'invoice_frist_klaerung_conflict' using errcode = 'P0001';
    end if;
    return query
      select wi.* from public.workspace_invoices wi
      where wi.workspace_id = p_workspace_id and wi.client_invoice_id = v_invoice_id;
    return;
  end if;
  if v_invoice.invoice_status = 'entwurf' then
    raise exception 'Rechnung nicht finalisiert';
  end if;
  if v_invoice.cancelled_at is not null then
    raise exception 'Rechnung storniert';
  end if;
  if v_invoice.invoice_type = 'abschlag'
     and public.workspace_invoice_abschlag_abzug(p_workspace_id, v_invoice_id) is not null then
    raise exception 'invoice_frist_final_invoice_exists' using errcode = 'P0001';
  end if;

  v_lage_vorher := coalesce(v_invoice.frist_basis->'lage',
                            public.workspace_invoice_frist_lage(p_workspace_id, v_invoice.payload));
  if v_lage_vorher->>'art' = 'abbedungen' then
    raise exception 'invoice_frist_abbedungen' using errcode = 'P0001';
  end if;

  if v_art = 'inland' then
    v_lage := jsonb_build_object(
      'art', 'inland',
      'laender', jsonb_build_array(v_region),
      'gemeinde', v_gemeinde,
      'quelle', 'klaerung'
    );
  else
    /* Nur ein Fristende dieser Rechnung: die Skontofrist oder das Zahlungsziel. */
    select s.pct, s.days into v_pct, v_days from public.workspace_skonto_terms(v_invoice.payload->>'skontoText') s;
    v_basis := public.workspace_safe_date(
      case when jsonb_typeof(v_invoice.payload->'issueDate') = 'string'
           then v_invoice.payload->>'issueDate' else v_invoice.payload->>'date' end
    );
    v_ziel := public.workspace_safe_date(left(coalesce(v_invoice.payload->>'paymentDueDate', ''), 10));
    if not (
      (v_pct is not null and v_pct > 0 and v_pct < 100 and v_days is not null and v_basis is not null
         and v_kalender = v_basis + v_days)
      or (v_ziel is not null and v_kalender = v_ziel)
    ) then
      raise exception 'invoice_frist_klaerung_invalid: kalenderEnde' using errcode = 'P0001';
    end if;
    v_lage := jsonb_build_object(
      'art', 'ausland',
      'ohneFeiertagBestaetigt',
        case when v_lage_vorher->>'art' = 'ausland'
             then coalesce(v_lage_vorher->'ohneFeiertagBestaetigt' = 'true'::jsonb, false)
             else false end,
      'geprueft',
        (case when v_lage_vorher->>'art' = 'ausland' and jsonb_typeof(v_lage_vorher->'geprueft') = 'object'
              then v_lage_vorher->'geprueft' else '{}'::jsonb end)
        || jsonb_build_object(to_char(v_kalender, 'YYYY-MM-DD'), to_char(v_wirksam, 'YYYY-MM-DD')),
      'quelle', 'klaerung'
    );
  end if;

  begin
    insert into public.workspace_invoice_frist_klaerungen (
      workspace_id, client_invoice_id, client_klaerung_id, klaerung, begruendung,
      lage_vorher, lage_nachher, created_by
    )
    values (
      p_workspace_id, v_invoice_id, v_klaerung_id, v_klaerung, v_begruendung,
      v_lage_vorher, v_lage, v_user_id
    );
  exception when unique_violation then
    /*
     * END18-R1 — dieselbe Kennung wurde zeitgleich an einer **anderen** Rechnung festgeschrieben (deren Sperre
     * schützt diese Zeile nicht). Das ist nie eine Wiederholung dieser Klärung, sondern ein Konflikt.
     */
    raise exception 'invoice_frist_klaerung_conflict' using errcode = 'P0001';
  end;

  perform set_config('officetakt.frist_klaerung', 'on', true);
  update public.workspace_invoices
  set
    frist_basis = jsonb_build_object(
      'lage', v_lage,
      'quelle', 'klaerung',
      'festgelegtAm', to_jsonb(now()),
      'klaerung', jsonb_build_object(
        'id', v_klaerung_id,
        'angabe', v_klaerung,
        'begruendung', v_begruendung,
        'von', v_user_id,
        'am', to_jsonb(now())
      )
    ),
    row_version = row_version + 1,
    updated_by = v_user_id
  where workspace_id = p_workspace_id
    and client_invoice_id = v_invoice_id
  returning * into v_updated;
  perform set_config('officetakt.frist_klaerung', 'off', true);

  return next v_updated;
end;
$$;

revoke all on function public.clarify_workspace_invoice_frist(uuid, text, text, jsonb, text) from public, anon;
grant execute on function public.clarify_workspace_invoice_frist(uuid, text, text, jsonb, text) to authenticated;
