# V8 — Yayın günleri (haftanın hangi günleri)

> **Durum: ✅ uygulandı (2026-09-26, branch `feat/v8-yayin-gunleri`).** Karar:
> K28. Faz durumu: [`FAZLAR.md`](FAZLAR.md). Uygulananın şartnameden
> sapmaları: §9.

## 1. Neden
Bugün yayın saatleri (`PublishSettings.slots`) **her gün** geçerli. Kullanıcı
her gün paylaşım yapmak istemeyebilir: ör. yalnızca Pazartesi–Perşembe–Cuma,
ya da yalnızca Pazartesi 19:00.

## 2. Karar (K28)
**Tek gün kümesi × tek saat listesi.** Seçilen her günde, seçilen her saatte
yayın slotu vardır. "Pzt, Per, Cum · 19:00" = haftada 3 video.

- **Neden bu model:** kullanıcının örneklerinin hepsini karşılıyor, ekranda
  iki satırlık bir ayar (gün çipleri + saat çipleri), hesap tek bir filtre.
- **Bilinçli olarak yok:** güne göre farklı saat ("Pzt 09:30, Cum 19:00").
  İstenirse ileride `schedule: {day, time}[]` modeline geçilir; açık soru.
- **En az bir gün zorunlu.** Hiç yayın istemiyorsa "Yayını duraklat" var —
  iki ayrı "kapalı" hâli olmasın.

## 3. Veri modeli
- `PublishSettings.days Int[] @default([1,2,3,4,5,6,7])` — ISO hafta günü,
  **1 = Pazartesi … 7 = Pazar**, müşterinin `timezone`'una göre YEREL gün.
  Varsayılan tüm günler: mevcut satırlar göçten sonra aynen her gün yayınlar.
- Göç: `nextjs-prisma:goc`; eski veriyle sınanır (mevcut satırda
  `days = {1..7}`).

## 4. Hesap (`src/lib/queue.ts`)
- `slotInstants(settings, range)`: gün döngüsünde, yerel tarihin ISO hafta
  günü (`localParts` + `Intl`, DST güvenli) `days` içinde değilse o günün
  slotları üretilmez. `dueSlots`, `projectSchedule` bunu otomatik kullanır.
- `QueueSettings`'e `days: number[]`; eksikse (eski çağrılar) tüm günler.
- **K8 (kaçırılan slot telafi edilmez) değişmez.**
- **Günlük hatırlatma** (`queue-digest.ts`): "yarın şu yayınlanacak" yalnızca
  yarın gerçekten slot varsa — `projectSchedule` zaten boş döner.
- **"Onaylı video yok" e-postası/bildirimi** yalnızca gerçekten slot olan
  günlerde doğar (slot yoksa tick hiçbir şey yapmaz) — ek iş yok.
- Tahmini yayın zamanları (kuyruk kartları, "Sıradaki yayın") seçili günlere
  göre kayar: Pzt/Per seçiliyse Salı yüklenen video Perşembe görünür.

## 5. API ve doğrulama
- `src/lib/portal-validation.ts` (ayarlar): `days` — dizi, 1–7 arası
  tamsayılar, tekrarsız, **en az 1**; kaydedilirken sıralanır. Eksikse
  (eski istemci) mevcut değer korunur.
- `src/lib/portal-settings.ts` / ayarlar route'u: alanı okuyup yazar.
- Ajans paneli değişmez.

## 6. Arayüz (Ayarlar → "Yayın günleri ve saatleri")
Tasarım: Claude Design, `Ayarlar` artboard'u + `Ayarlar-gunler` varyantı
(https://claude.ai/artifact/WUckhyutaTLTtwo7V5CpYC).

- **Gün çipleri:** tek satırda 7 yuvarlak çip `Pzt Sal Çar Per Cum Cmt Paz`
  (≥ 44 px; seçili: lacivert dolgu + krem yazı; seçili değil: kenarlı krem).
  Her çip `<button aria-pressed>`; grup `role="group" aria-label="Yayın günleri"`.
- **Hazır seçimler:** `Her gün` · `Hafta içi` · `Hafta sonu` (tek dokunuş).
- **Saat çipleri:** mevcut (09:30 ×, 19:00 ×, + Saat ekle).
- **Özet kartı:** "Haftada 3 video · Pzt, Per, Cum · 19:00" + **sıradaki 3
  yayın zamanı** ("Pzt 29 Eyl 19:00 · Per 2 Eki 19:00 · Cum 3 Eki 19:00") —
  kullanıcı ne seçtiğini somut görsün.
- **Hata:** son seçili gün kaldırılmak istenirse çip kapanmaz, altta "En az
  bir gün seç — hiç yayın istemiyorsan Yayını duraklat" notu.
- **Kuyruk ekranı:** "Sıradaki yayın" kartında gün adı ("Perşembe · 19:00").

## 7. Testler
- `queue.test.ts`: yalnızca Pazartesi (Pazar gecesi → Pazartesi slotu),
  Pzt/Per/Cum, DST geçişinde gün, farklı saat diliminde gün sınırı,
  `projectSchedule` seçili günlere kayıyor, `days` eksik → tüm günler.
- Ayar doğrulama: boş dizi 400, 0/8/tekrar 400, sıralama.
- Tick entegrasyonu: seçili olmayan günde slot/`SlotRun` doğmuyor.
- UI: çip seçimi, hazır seçimler, son günü kaldırma engeli, özet metni.

## 8. Uygulama sırası
1. Mobil arayüz PR'ı (V7) merge → 2. göç + `queue.ts` + doğrulama
(`core:faz`, tek PR) → 3. Ayarlar arayüzü tasarıma göre → 4. prod'da
Furkan'ın ayarı değişmeden kalır (tüm günler); kullanıcı portaldan seçer.

## 9. Uygulama notları ve sapmalar

- **Göç** `20260926130000_yayin_gunleri`: `ADD COLUMN "days" INTEGER[]
  DEFAULT ARRAY[1..7]`. Eski veriyle sınandı: göçten önce yazılmış iki satır
  (İstanbul + Berlin, biri duraklatılmış) göçten sonra `{1,2,3,4,5,6,7}`;
  boş DB'de de uygulandı; iki durumda da `migrate diff` → "No difference
  detected". Ayrı backfill yok. **Sapma:** Prisma skaler listeleri
  Postgres'te `NOT NULL` üretmiyor, kolon teknik olarak null alabilir —
  `queue.ts` null/boş/geçersiz `days`i "tüm günler" sayıyor (hiç yayın hâli
  `paused`), doğrulama da boş diziyi kabul etmiyor.
- **Geri alma:** göç toplayıcı; geri almak için `ALTER TABLE
  "PublishSettings" DROP COLUMN "days"` + kodu geri al. Kaybolan tek şey
  kullanıcıların gün seçimi (hepsi yeniden "her gün" olur).
- **`queue.ts`:** `slotInstants` yerel takvim gününü gezerken
  `isoWeekday(day)` seçili değilse o günün slotlarını üretmez; `dueSlots` ve
  `projectSchedule` bunu doğrudan kullanıyor. `projectSchedule`in bakış
  aralığı artık hafta katı (`ceil(n / (saat × gün)) × 7 + 2` gün) — yalnız
  Pazartesi seçiliyken 3 yayın 3 haftaya yayılıyor. Yeni dışa açık
  yardımcılar: `ALL_DAYS`, `isoWeekday`, `localWeekday`. Tick ve günlük
  hatırlatma koduna dokunulmadı (ayar satırı `days`i zaten taşıyor).
- **API:** `days` isteğe bağlı; gönderilmezse güncellemede mevcut değer,
  ilk kayıtta şema varsayılanı. `null` ve boş dizi 400 (`field: "days"`).
- **Özet kutusu** `slotInstants`i istemcide çağırıyor (saf, yalnız `Intl`) —
  tick ile aynı kural; kuyruğa bakmaz, yani "sıradaki 3 yayın ZAMANI"
  (video değil). **Sapma (maketten):** her gün seçiliyken başlık "Her gün 2
  video · 09:30, 19:00" — maketteki "Her gün 1 video · Her gün · 19:00"
  tekrarı atıldı; çok saatte saatler virgülle. Tekrarlanan saat özet
  sayısında bir kez sayılır. Duraklatılmışken alt not "yayın duraklatıldı;
  devam ettirince bu saatlerde sürer" olur. "Şimdi" istemcide montajdan sonra
  alınır (SSR/hidrasyon ayrışmasın).
- **Kuyruk ekranı:** "Sıradaki yayın" kartı `slotWeekdayLabel` ile "Bugün ·
  19:00", "Yarın · 19:00", hafta içindeyse "Perşembe · 19:00", 7+ gün
  uzaksa "Pazartesi 12 Eki · 19:00". Kuyruk kartlarındaki küçük tahmin
  rozetleri ve video detay sayfası aynı kaldı ("Paz 27 Eyl 19:00").
