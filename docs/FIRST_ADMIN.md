# Erster Administrator (SUPABASE-AUTH-03)

Nach Anwendung der Migration `20250710120000_profiles_foundation.sql` existiert noch kein Administrator in `public.profiles`. Admin-Rechte werden ausschließlich serverseitig über `profiles.role` vergeben — nicht über `user_metadata`.

## Einmaliger SQL-Schritt

Führen Sie diesen Befehl **einmalig** in der Supabase SQL-Konsole aus, nachdem der gewünschte Benutzer registriert ist und ein Profil besitzt:

```sql
update public.profiles
set
  role = 'admin',
  status = 'approved',
  license_status = 'active'
where email = '<ADMIN_EMAIL>';
```

Ersetzen Sie `<ADMIN_EMAIL>` durch die E-Mail-Adresse des Administrator-Kontos. Verwenden Sie keinen Platzhalter in Produktion unverändert.

## Hinweise

- Kein Service-Role-Key im Frontend verwenden.
- Keine Admin-E-Mail im Anwendungscode hinterlegen.
- Der Backfill der Migration setzt für bestehende Benutzer immer `pending`, `user` und `inactive`.
- Nach dem SQL-Update muss sich der Administrator neu anmelden, damit das Frontend das aktualisierte Profil lädt.
