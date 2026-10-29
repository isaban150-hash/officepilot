/** P1-KORREKTURBLOCK A-04 — giderin vergi dağılımı ve indirilecek KDV (form, ayrıntı, kilitler, uyarılar). */
export const trExpenseTaxSplit = {
  'expense.taxSplit.label': 'Belgedeki net tutar ve vergi',
  'expense.taxSplit.option.belegt': 'Net tutar ve vergi belgede yazıyor (tek vergi oranı)',
  'expense.taxSplit.option.gemischt': 'Belgede birden fazla vergi oranı var – net tutar ve vergi toplam olarak',
  'expense.taxSplit.option.offen': 'Henüz açık – net tutar ve vergi (henüz) bilinmiyor',
  'expense.taxSplit.amountsHint':
    'Net tutarı veya vergiyi belgede yazdığı gibi girin. Diğer değer brüt tutardan hesaplanır. Vergi oranından tahmin yapılmaz.',
  'expense.taxSplit.mixedHint':
    'Belgedeki tüm net tutarların toplamını ve tüm vergi tutarlarının toplamını girin.',
  'expense.taxSplit.openHint':
    'Net tutar ve indirilecek KDV boş kalır – hiçbir şey tahmin edilmez veya 0 € vergi olarak kabul edilmez. Gerçekten yapılmış bir ödemeyi yine de kaydedebilirsiniz. Değerleri orijinal belgeden girene kadar işe atama ve hesap atamasının onayı kilitli kalır ve ay kapatılamaz. Veri dışa aktarımında ve aylık dosyada net tutar ve vergi açıklamayla birlikte boş görünür.',
  'expense.taxSplit.legacyHint':
    'Eski kayıt: Net = brüt ve 0,00 € vergi kayıtlı – bu vergi durumunda bu değerler muhtemelen belgeden gelmiyor. Belgedeki net tutarı veya vergiyi girin ya da „Henüz açık“ seçeneğini seçin. Giriş yapmazsanız kayıtlı değerler değişmeden kalır.',
  'expense.taxSplit.amountsRequired':
    'Lütfen belgedeki net tutarı veya vergiyi girin – ya da dağılım (henüz) bilinmiyorsa „Henüz açık“ seçeneğini seçin.',
  'expense.taxSplit.zeroTaxForTaxableStatus':
    '0,00 € vergi %19 veya %7 ile uyuşmaz. Belgede KDV yoksa uygun vergi durumunu seçin (ör. vergiden muaf, küçük işletme, §13b). Belgede indiremeyeceğiniz KDV varsa: vergiyi girin ve „İndirilemez“ seçeneğini seçin. Dağılım bilinmiyorsa „Henüz açık“ seçeneğini seçin.',
  'expense.taxSplit.openNeedsTax':
    'Açık bir vergi dağılımı, belgedeki net tutar ve vergi ile netleştirilir. Belgede KDV yoksa uygun vergi durumunu seçin (ör. vergiden muaf, küçük işletme, §13b); aksi halde dağılım „Henüz açık“ kalır.',
  'expense.taxSplit.closedPeriod':
    'Bu ay, vergi dağılımını ve KDV indirimini henüz bağlamayan eski bir kapanış sürümüyle kapatıldı. Bunlardaki değişiklikler ancak ay yeniden açıldıktan sonra mümkündür (yeni revizyon).',
  'expense.taxSplit.openWithAllocations':
    'Bu gider işlere atanmış. Açık vergi dağılımında belgelenmiş net tutar yoktur – lütfen önce atamayı kaldırın veya net tutarı ve vergiyi girin.',
  'expense.inputTaxDeduction.label': 'İndirilecek KDV',
  'expense.inputTaxDeduction.option.voll': 'Tamamen indirilebilir',
  'expense.inputTaxDeduction.option.teilweise': 'Kısmen indirilebilir',
  'expense.inputTaxDeduction.option.keiner': 'İndirilemez',
  'expense.inputTaxDeduction.hint':
    'Yalnızca KDV hiç veya kısmen indirilemiyorsa değiştirin (ör. ağırlama, özel kullanım payı). Emin değilseniz mali müşavirinize danışın.',
  'expense.inputTaxDeduction.amountLabel': 'İndirilebilir KDV tutarı',
  'expense.inputTaxDeduction.amountInvalid':
    '„Kısmen indirilebilir“ için indirilebilir tutarı girin: 0’dan büyük ve vergiden küçük olmalıdır.',
  'expense.allocation.taxSplitOpen':
    'Bu giderin vergi dağılımı açık – belgelenmiş net tutar olmadan işe atama yapılamaz. Lütfen önce net tutarı ve vergiyi girin.',
  'accounting.reason.taxSplitOpen':
    'Net tutar ve KDV belgeye henüz girilmedi (vergi dağılımı açık). Lütfen önce belgede tamamlayın, sonra hesap atayın.',
  'accounting.reason.taxSplitEntered':
    'Net tutar ve KDV artık belgede girildi. Lütfen hesap atamasını kontrol edip onaylayın.',
  'accounting.confirmNeedsTaxSplit':
    'Onay için belgenin vergi dağılımı eksik. Lütfen belgede net tutarı ve KDV’yi girin.',
  'accounting.action.enterTaxSplit': 'Belgede net tutarı ve vergiyi gir',
  'accountingPeriod.blocker.tax_split_open': 'Vergi dağılımı açık olan giderler: {count}',
  'expense.fieldTaxSplit': 'Vergi dağılımı',
  'expense.taxSplit.state.belegt': 'Net tutar ve vergi girildi',
  'expense.taxSplit.state.gemischt': 'Net tutar ve vergi girildi, birden fazla vergi oranı (toplamlar)',
  'expense.taxSplit.state.steuerfrei': 'KDV yok (vergi durumuna göre)',
  'expense.taxSplit.state.offen': 'Açık – net tutar ve KDV belgelenmemiş',
  'expense.taxSplit.state.altbestand_pruefen': 'Lütfen kontrol edin – 0,00 € vergi kayıtlı (eski kayıt)',
  'expense.taxSplit.notProvided': 'belgelenmemiş',
  'expense.fieldInputTaxDeduction': 'İndirilecek KDV',
  'expense.inputTaxDeduction.partialValue': 'Kısmen indirilebilir: {amount}',
  'expense.taxSplit.detailOpenNotice':
    'Vergi dağılımı açık: Net tutar ve KDV belgelenmemiştir ve hiçbir yerde değer olarak gösterilmez – veri dışa aktarımında ve aylık dosyada boş kalır. Gerçekten yapılmış bir ödemeyi kaydedebilirsiniz. Net tutarı ve KDV’yi orijinal belgeden girene kadar işe atama, hesap atamasının onayı ve ay kapanışı kilitli kalır.',
  'expense.taxSplit.detailLegacyNotice':
    'Lütfen kontrol edin: „{status}“ vergi durumunda 0,00 € vergi ve net = brüt kayıtlı. Bu dağılım muhtemelen belgeden gelmiyor. Siz düzeltene kadar değerler değişmeden kalır.',
  'expense.taxSplit.detailLegacyLocked':
    'Kayıtlı ödemeler nedeniyle tutarlar sabittir: Düzeltme yalnızca ödemenin geri alınması veya iptal ve yeniden kayıt ile mümkündür.',
  'expense.taxSplit.enterAction': 'Net tutarı ve vergiyi gir',
  'expense.taxSplit.nextAction':
    'Sıradaki adım: Orijinal belgeden net tutarı ve KDV’yi girin. Ancak bundan sonra hesap ataması ve ay kapanışı tamamlanabilir. Yapılmış bir ödemeyi şimdiden kaydedebilirsiniz.',
  'expense.taxSplit.overviewOpen': 'Vergi açık',
  'expense.taxSplit.overviewLegacy': 'Vergiyi kontrol et',
  /* P1 A-04 Produktregeln A (Zahlung bei offener Steuerprüfung) und B (Nullsteuer). */
  'expense.taxSplit.zeroTaxUnclear':
    'Vergi durumu belirsiz olduğunda 0,00 € vergi bir netleştirme değildir. Belgede KDV yoksa uygun vergi durumunu seçin (vergiden muaf, küçük işletme / gösterilmiş KDV yok, §13b). Belgede indiremeyeceğiniz KDV varsa: vergiyi girin ve „İndirilemez“ seçeneğini seçin. Henüz bilmiyorsanız „Henüz açık“ seçeneğini seçin.',
  'expense.payment.taxReviewOpenNotice':
    'Bu belgenin vergi kontrolü açık: net tutar ve KDV henüz girilmedi. Gerçekten yapılmış bir ödemeyi yine de kaydedebilirsiniz. Net tutarı ve KDV’yi belgeden girene kadar hesap ataması ve ay kapanışı kilitli kalır.',
  'expense.payment.taxReviewAck':
    'Ödeme gerçekten yapıldı (ör. hesap özetine veya kasa fişine göre).',
  'expense.payment.taxReviewAckRequired':
    'Lütfen ödemenin gerçekten yapıldığını onaylayın.',
  'expense.payment.statusTaxReviewOpen':
    '{status} – vergi kontrolü açık',
  'bankConfirm.taxReviewOpenNotice':
    'Bu belgenin vergi kontrolü açık. Banka ödemesi eşleştirilir; net tutar ve KDV belgeye girilene kadar hesap ataması ve ay kapanışı kilitli kalır.',
  'accountingPeriod.blocker.tax_split_open_payment':
    'Vergi kontrolü açık belgelere yapılan ödemeler (başka ay): {count}',
  'expense.taxSplit.nextActionPaid':
    'Ödeme kaydedildi – vergi kontrolü açık. Sıradaki adım: Orijinal belgeden net tutarı ve KDV’yi girin; ardından hesap ataması ve ay kapanışı tamamlanabilir.',
  'expense.edit.grossLockedTaxReviewHint':
    'Kaydedilen ödemeden sonra brüt tutar sabit kalır. Belgedeki net tutarı ve KDV’yi – veya KDV’siz bir vergi durumunu – şimdi girebilirsiniz.',
  /* P1 A-04 (Nacharbeit WEISS, Abschlussgültigkeit) — abgeschlossen, Stand unverändert, aber ein Sperrgrund besteht. */
  'accountingPeriod.state.recheck_required': 'Yeniden kontrol gerekli',
  'accountingPeriod.recheckHint':
    'Yeniden kontrol gerekli: Kayıtlı ay kapanışı (revizyon {revision}) bağlı verilerle hâlâ uyumlu, ancak bu arada bir engel oluştu – {reasons}. Bu engel giderilene kadar kapanış geçerli değildir ve mali müşavire teslim kilitlidir. Ardından kapanış yeniden geçerli olur; bunun için yeni bir revizyon oluşturulmaz.',
  'accountingExport.blocker.closure_recheck_required':
    'Ay kapatıldı, ancak bu arada bir engel oluştu. Kapanışın yeniden kontrol edilmesi gerekiyor – lütfen önce yukarıda belirtilen noktaları giderin.',
  'handover.state.recheck_required':
    'Yeniden kontrol gerekli – kapanış değişmedi, ancak yeni bir engel var. Lütfen önce bu engeli giderin.',
  'handover.closure.recheck': 'Kapatıldı (revizyon {revision}) – yeniden kontrol gerekli',
} as const;
