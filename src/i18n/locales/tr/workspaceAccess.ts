/** EINRICHTUNG-01 (AP1) — İşletme lisansı ve erişim (bkz. de/workspaceAccess.ts). */
export const trWorkspaceAccess = {
  'workspaceAccess.readOnly.title': 'Salt okunur',
  'workspaceAccess.readOnly.owner':
    'İşletmenizin lisansı geçerli değil. Her şeyi görüntüleyebilir, kayıtlı dosyaları indirip yazdırabilir ve veri yedeği oluşturabilirsiniz. Değişiklik, gönderim ve yeni belgeler ancak lisans uzatıldıktan sonra yeniden mümkündür.',
  'workspaceAccess.readOnly.admin':
    'Bu işletmenin lisansı geçerli değil. Her şeyi görüntüleyebilir, kayıtlı dosyaları indirip yazdırabilir ve veri yedeği oluşturabilirsiniz. Değişiklik ve gönderim, işletme sahibi lisansı uzattığında yeniden mümkündür.',
  'workspaceAccess.readOnly.member':
    'Bu işletmenin lisansı geçerli değil. Her şeyi görüntüleyebilir, kayıtlı dosyaları indirip yazdırabilirsiniz. Değişiklik ve gönderim, işletme sahibi lisansı uzattığında yeniden mümkündür.',
  'workspaceAccess.readOnly.control': 'Salt okunur modda kullanılamaz.',
  'workspaceAccess.readOnly.settings':
    'İşletmenin lisansı geçerli değil. Ayarlar görüntülenebilir; değişiklik ancak lisans uzatıldıktan sonra yeniden mümkündür.',
  'workspaceAccess.readOnly.route':
    'Bu sayfada veri oluşturulur veya değiştirilir. İşletmenin lisansı geçerli olmadığı sürece bu sayfa kullanılamaz.',
  'workspaceAccess.readOnly.home': 'Ana sayfaya',
  'workspaceAccess.noLicense.title': 'Henüz işletme yok',
  'workspaceAccess.noLicense.body':
    'Hesabınız onaylandı, ancak kendi işletmeniz için henüz bir lisans yok. Hiçbir şey oluşturulmadı.',
  'workspaceAccess.noLicense.next':
    'Sonraki adım: Mevcut bir işletmeye gelen davete katılın veya kendi işletmeniz için lisans isteyin. Ardından burada yeniden kontrol edin.',
  'workspaceAccess.noLicense.retry': 'Yeniden kontrol et',
  'workspaceAccess.noLicense.logout': 'Çıkış yap',
} as const;
