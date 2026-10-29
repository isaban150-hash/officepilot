-- EINRICHTUNG-01 (AP2, EIN-19; Katalog V3 A-13, A-14) -- Zustimmung zu den Rechtstexten.
--
-- Bisher übernahm der Registrierungs-Trigger den Zustimmungszeitpunkt aus den Metadaten des Geräts
-- (raw_user_meta_data.legalAcceptedAt) und jede beliebige Versionsangabe. Der Nachweis war damit manipulierbar.
--
--   * legal_current_versions(): die geltenden Versionen von AGB, Datenschutz und Lizenzbedingungen (eine Stelle; eine
--     neue Fassung kommt mit einer Migration).
--   * handle_new_user(): speichert eine Zustimmung nur, wenn alle drei Versionen den geltenden entsprechen, und dann
--     mit der Serverzeit. Eine unbekannte Version gilt als nicht erteilt; die App zeigt beim ersten Start die
--     Zustimmungsseite. Status, Rolle und Lizenz kommen nie aus den Metadaten (Spaltenvorgaben pending/user/inactive).
--   * accept_current_legal_terms(): erneute Zustimmung des eigenen Kontos zur geltenden Fassung, mit Serverzeit.
--     Ändert nur die vier Zustimmungsfelder -- nie Status, Rolle oder Lizenz (A-14.4). Nur das angemeldete Konto
--     (A-14.3: eine unterwegs befindliche Zustimmung von A wirkt nicht für B), mit bestehender Sitzung (Vertrag 1.8),
--     nicht für gesperrte Konten (Ausnahme B, Vertrag 1.1).
--
-- Nur lokal. Nicht remote anwenden (Gesamtveröffentlichung RELEASE-01).

create or replace function public.legal_current_versions()
returns jsonb
language sql
immutable
set search_path = public
as $$
  select jsonb_build_object('terms', '1.0-draft', 'privacy', '1.0-draft', 'license', '1.0-draft');
$$;

revoke all on function public.legal_current_versions() from public, anon, authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_current jsonb := public.legal_current_versions();
  v_terms text := coalesce(nullif(meta->>'acceptedTermsVersion', ''), nullif(meta->>'accepted_terms_version', ''));
  v_privacy text := coalesce(nullif(meta->>'acceptedPrivacyVersion', ''), nullif(meta->>'accepted_privacy_version', ''));
  v_license text := coalesce(nullif(meta->>'acceptedLicenseVersion', ''), nullif(meta->>'accepted_license_version', ''));
  v_consented boolean;
begin
  -- Nur die geltende Fassung zählt; der Zeitpunkt ist immer die Serverzeit, nie die des Geräts.
  v_consented := v_terms is not distinct from (v_current->>'terms')
    and v_privacy is not distinct from (v_current->>'privacy')
    and v_license is not distinct from (v_current->>'license');

  insert into public.profiles (
    id,
    company_name,
    first_name,
    last_name,
    email,
    phone,
    industry,
    accepted_terms_version,
    accepted_privacy_version,
    accepted_license_version,
    legal_accepted_at
  )
  values (
    new.id,
    coalesce(nullif(meta->>'companyName', ''), nullif(meta->>'company_name', ''), 'Unbekannt'),
    coalesce(nullif(meta->>'firstName', ''), nullif(meta->>'first_name', ''), 'Unbekannt'),
    coalesce(nullif(meta->>'lastName', ''), nullif(meta->>'last_name', ''), 'Unbekannt'),
    coalesce(new.email, ''),
    nullif(coalesce(meta->>'phone', ''), ''),
    nullif(coalesce(meta->>'industry', ''), ''),
    case when v_consented then v_terms end,
    case when v_consented then v_privacy end,
    case when v_consented then v_license end,
    case when v_consented then now() end
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create or replace function public.accept_current_legal_terms(
  p_user_id uuid,
  p_terms_version text,
  p_privacy_version text,
  p_license_version text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_current jsonb := public.legal_current_versions();
  v_status text;
  v_row public.profiles%rowtype;
begin
  if v_uid is null then
    raise exception 'Nicht angemeldet' using errcode = '42501';
  end if;
  -- Vertrag 1.8: Eine widerrufene oder beendete Sitzung stimmt nicht zu (wirft session_not_active).
  perform public.workspace_session_active();
  -- A-14.3: Die Zustimmung gilt genau dem Konto, für das sie abgegeben wurde.
  if p_user_id is distinct from v_uid then
    raise exception 'consent_account_mismatch: Zustimmung gehört zu einem anderen Konto' using errcode = '42501';
  end if;
  select status into v_status from public.profiles where id = v_uid for update;
  if not found then
    raise exception 'Kein Profil' using errcode = '42501';
  end if;
  if v_status = 'blocked' then
    raise exception 'account_blocked: Konto ist gesperrt' using errcode = '42501';
  end if;
  if p_terms_version is distinct from (v_current->>'terms')
    or p_privacy_version is distinct from (v_current->>'privacy')
    or p_license_version is distinct from (v_current->>'license') then
    raise exception 'legal_version_unknown: Diese Fassung der Rechtstexte gilt nicht' using errcode = '22023';
  end if;

  update public.profiles
     set accepted_terms_version = p_terms_version,
         accepted_privacy_version = p_privacy_version,
         accepted_license_version = p_license_version,
         legal_accepted_at = now()
   where id = v_uid
  returning * into v_row;

  return jsonb_build_object(
    'accepted_terms_version', v_row.accepted_terms_version,
    'accepted_privacy_version', v_row.accepted_privacy_version,
    'accepted_license_version', v_row.accepted_license_version,
    'legal_accepted_at', v_row.legal_accepted_at
  );
end;
$$;

revoke all on function public.accept_current_legal_terms(uuid, text, text, text) from public, anon;
grant execute on function public.accept_current_legal_terms(uuid, text, text, text) to authenticated;
