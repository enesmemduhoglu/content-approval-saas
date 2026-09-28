# TODOS

Son güncelleme: 2026-09-28 · Canlı: https://content-approval-saas.vercel.app

**Depo PUBLIC** (`gh repo view` → `PUBLIC`). Bu dosyayı herkes okuyabiliyor:

- **Sömürülebilir bir açık bulunursa önce kapatılır, sonra buraya yazılır.** Açık
  dururken tarifini yazma. Sonradan private'a çekmek sızıntıyı geri almaz: PR diff'i
  ve gövdesi GitHub'da kalır, force-push sonrası kopuk commit'ler SHA ile erişilebilir.
- **Sır DEĞERİ hiçbir koşulda yazılmaz**, yalnızca adı (`CRON_SECRET`, `FURI_API_KEY`,
  `VAPID_PRIVATE_KEY` …). Yeni prod id'si / e-posta adresi eklemenin de faydası yok.
- Görünürlük değişirse ilk güncellenecek yer bu paragraf.

**Durum.** Onay akışı (S1–S9, F1–F14) kapalı ve canlıda. Video kuyruğu V0–V5, V7a/b/c
ve V8 canlıda; tek müşteri (Furkan) portalı telefonundan PWA olarak kullanıyor, yayın
açık; açık PR yok. Açık kod işlerinin çoğu 2026-08-23 denetiminden kalan
D serisi; hiçbiri canlıda arıza olarak yaşanmadı, hiçbiri kimliği doğrulanmamış bir
saldırgana bir şey vermiyor.

Kapanmış işlerin ve kararların uzun anlatısı bu dosyadan çıkarıldı: geçmiş için
`git log -p TODOS.md`, değişmezler ve tuzaklar için `CLAUDE.md`.

---

## Video kuyruğu

Plan, kararlar ve **oturum devri** burada DEĞİL:
[`docs/video-kuyrugu/FAZLAR.md`](docs/video-kuyrugu/FAZLAR.md) (önce onu oku) ·
[`KARARLAR.md`](docs/video-kuyrugu/KARARLAR.md) · [`V7-pwa.md`](docs/video-kuyrugu/V7-pwa.md).
Buraya yalnızca sıradaki geliştirmeler düşülür.

- [ ] **Küçük kapak (thumbnail).** Kuyruk kartları, "Sıradaki yayın" kartı ve günlük
      özet e-postası kapağı tam boy ilk kareden (`frameKeys[0]`, imzalı R2 URL'i —
      `portal-media.ts`, `queue-digest.ts`) çiziyor. Önce ölç (kart başına bayt, liste
      açılış süresi), fark anlamlıysa yüklemede küçük bir kapak üret. #83'te bilinçli
      ertelendi (FAZLAR, oturum devri).
- [ ] **V7c Web Push — canlı doğrulama.** Kod master'da (#74): `PushSubscription`,
      `push.ts > notifyClientUsers`, `/api/portal/push`, SW `push` /
      `notificationclick`, Ayarlar'da `PushToggle`, beş olay kancası (yayınlandı,
      yayınlanamadı, slot boş, caption'lar hazır, günlük hatırlatma). Kalan:
      (a) Vercel Production'da `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` /
      `VAPID_SUBJECT` var mı — yoksa gönderim sessizce atlanır, yalnızca log;
      (b) V7-pwa §6.2: ana ekrandan açılmış iPhone'da izin → yayın → kilit ekranında
      bildirim → dokun → Instagram.
- [ ] **V7d Android — ERTELENDİ.** Paylaşım hedefi (`share_target`, V7-pwa §7) ve
      Ayarlar'da `beforeinstallprompt` ile "Uygulamayı yükle" (§4.5, kodda yok).
      Furkan iPhone kullanıyor, iOS ikisini de desteklemiyor; Android kullanan müşteri
      gelince (~yarım gün).
- [ ] **Günlük özetin tekrar koruması süreç içi (K17).** "Bugün gönderildi" bilgisi
      bellekte (`queue-digest.ts`); iki soğuk instance aynı gün tetiklenirse özet —
      ve V7c'den beri özet bildirimi de — iki kez gider. Kesin çözüm
      `PublishSettings.digestSentOn` kolonu (şema).
- [ ] **altText saklanmıyor (K15).** Claude üretiyor, `caption/run.ts` atıyor: portal
      postunda (Reels) alan yok, `PostImage.altText` görsel satırına ait. Önce
      Instagram Reels API'sinin alt text alıp almadığı ölçülmeli, sonra şema kararı.

---

## Açık işler

Öncelik sırası: **D3 → D2**, sonra zamanlanmış yayın çözünürlüğü, sonra geri kalan.

### Denetim bulguları (2026-08-23'ten kalan)

- [ ] **D3 · Mail gönderen iki panel yolunda tavan yok.**
      `POST /api/posts/[id]/approval-link` (onay mailini yeniden atar) ve
      `POST /api/posts/[id]/resubmit` (revize post maili) ne `checkRateLimit` ne kota
      görüyor — aynı postta düğmeye basmak müşterinin kutusuna sınırsız mail atar.
      Bedeli Resend kotası ve gönderen alan adının itibarı: tüm ajansların ortak
      kaynağı. Oturum açmış ajans kullanıcısı gerekir; dışarıdan tetiklenemez.
      Düzeltirken `quota.ts`'teki "davet butonu … tek yüzey" yorumu da düzeltilmeli
      (davet KEYFİ adrese giden tek yüzey, ama sınırsız mail atan tek yüzey değil).
- [ ] **D2 · `checkOrigin` 5 mutasyon handler'ında hâlâ yok.** `clients/route.ts` POST,
      `clients/[id]/route.ts` DELETE, `clients/[id]/instagram/route.ts` POST + DELETE,
      `posts/[id]/approval-link/route.ts` POST. (`resubmit` 2026-09-03'te kapandı.)
      Sömürülebilir değil — hepsi JSON gövde ya da DELETE, preflight tetikliyor, çerez
      `SameSite=Lax` — ama `origin.ts`'in var olma gerekçesi "tek bir çerez ayarına
      yaslanmamak". Kuralın kapsamı delikliyse kural okunduğu gibi çalışmıyor.
      (Portal route'ları `portalMutationGuard` ile korunuyor; `approve/[token]/**`
      çerezsiz, `media/upload-url` ve `queue/tick` makine yolu — bunlar muaf.)
- [ ] **D4 · Zamanlayıcılar için ölü adam anahtarı yok.** `sendAlert` yalnızca bir iş
      KOŞUP hata verdiğinde çalışıyor. Üç Vercel cron'u ya da QStash tick'i hiç
      tetiklenmezse (schedule silindi, plan düştü, deployment bozuk) ses çıkmaz:
      kuyruk yayını durur, token yenileme durur, ilk haber müşteriden gelir. En ucuz
      şekli: her iş son başarılı koşusunu yazsın, bayatlık bir yerde raporlansın.
      Dikkat: `/api/health` public ve bilerek sığ (F12) — "son koşu 3 gün önce" de iç
      durum sızıntısı; sığ yanıtı bozmadan çözülmeli (ör. bayatsa uyarı maili).
- [ ] **D5 · `error.tsx` / `not-found.tsx` / `global-error.tsx` yok.** `src/app/`
      altında yalnızca `portal/loading.tsx` var. Asıl mesele müşteriye gösterilen
      sayfalar (`/approve/[token]`, `/portal/**`): render hatasında ajansın markalı
      sayfası yerine Next'in İngilizce hata ekranı çıkar.
- [ ] **D6 · `noindex` yok.** `/approve/[token]`, `/invite/[token]` ve portal giriş
      linki (`/portal/giris/dogrula`) token'ı URL'de taşıyor; ne `robots` metadata'sı
      ne `public/robots.txt` var. `Referrer-Policy` `Referer` sızıntısını kapatıyor,
      indekslenmeyi değil.
- [ ] **D7 · `.env.example` video kuyruğunun env'lerini saymıyor.** (Özgün D7 —
      `KV_REST_API_*` — zaten karşılanmış: `.env.example`'daki Upstash yorumu iki ad
      setini de anıyor.) Bugünkü eksik: kodun okuduğu `R2_ACCOUNT_ID`,
      `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `QSTASH_URL`,
      `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`,
      `FAL_KEY`, `ANTHROPIC_API_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
      `VAPID_SUBJECT`, `PORTAL_DAILY_UPLOAD_LIMIT` dosyada yok. Sıfırdan kurulum
      bunları yalnızca `docs/video-kuyrugu/`'dan öğrenebiliyor.
- [ ] **D8 · Test boşlukları.** `src/lib/scoped-db.ts` (907 satır, panel IDOR
      korumasının tamamı) ve `src/lib/quota.ts` için ayrı birim testi yok, yalnızca
      route testlerinden dolaylı kapsanıyor. `settings/page.tsx` ve `team-panel.tsx`
      `.ui.test.tsx`'siz. e2e yalnızca `approval-flow.spec.ts` (6 senaryo): ekip
      daveti, zamanlanmış yayın, revizyon turu ve **portalın tamamı** uçtan uca hiç
      koşulmuyor. e2e CI dışında (bilinçli; ayrı DB, port, tarayıcı indirmesi).
- [ ] **D9 · Toplu onay `publishStatus`'a dokunmuyor.** Tekil yol `skipped` yazarken
      `/api/approve/[token]/batch` postu `idle` bırakıyor. Bugün görünür hata değil
      (batch yalnızca Instagram'ı OLMAYAN postları onaylıyor, rozet çıkmıyor); batch'in
      kapsamı genişlerse yanlış rozete döner. Aşağıdaki "toplu onayda bildirim"le
      aynı turda kapatılmalı.

### Zamanlama

- [ ] **Panelin zamanlanmış yayını (`publishAt`) hâlâ ±24 saat.** Video kuyruğu Hobby
      sınırını QStash'in 5 dk tick'iyle aştı (K7), ama tick yalnızca portal
      postlarına bakıyor (`queue-db.ts`, `source: "portal"`). Panel/furi postunun
      `publishAt`'ı hâlâ `vercel.json`'daki günlük `publish-scheduled`'a
      (`0 5 * * *`, ±59 dk) bağlı; aynı cron 10 dk'dan eski `publishing` Reels
      container'larını da devralıyor, yani o emniyet ağı da günlük. Pro yok (K7:
      para harcanmayacak). Seçenekler: `publish-scheduled`'ın işini tick'e taşımak,
      ya da aynı route'a ikinci bir QStash schedule'ı (route bugün `CRON_SECRET`
      bekliyor, QStash imzası değil — kimlik doğrulama kararı gerekir).

### Elle yapılacaklar (repo yapamaz)

- [ ] `ALERT_EMAIL`'e gerçek bir uyarının teslim edildiği hiç gözlenmedi — ilk
      `cron:*` / `portal:frames:*` uyarısında kutuya düştüğünü kontrol et.
- [ ] 2026-08-17'de `ENCRYPTION_KEY` önce yanlışlıkla `web-projesi` Vercel projesine
      eklenmişti; oradan silindiğini doğrula.

### Bilinen sınırlar / bilinçli kapsam dışı

Hepsi bilerek bırakıldı; yeniden ele alınırsa notu oku.

- [ ] **Toplu onayda ajans bildirimi yok.** Doğru şekli: `notifyAgencyTeam` ile N postu
      tek satırda özetleyen bir bildirim. Ele alınırsa D9 da aynı turda.
- [ ] **Toplu reddetme yok.** Red sebebi post başına anlamlı; yapılırsa "ortak sebep"
      alanı gerekir.
- [ ] **Yalnızca Instagram** (F9). Başka platform yok.
- [ ] **Ajans panelinden video yüklenemiyor.** Video iki yoldan geliyor: furi
      (`/api/media/upload-url` → Blob'a presigned PUT) ve müşteri portalı (R2'ye
      parçalı yükleme, V7b). Panel formu yalnızca görsel kabul ediyor
      (`post-form.tsx`); Vercel'in 4.5 MB gövde sınırı yüzünden panele eklenecekse
      aynı "tarayıcı doğrudan depoya yükler" deseniyle. Ajans panelinde kuyruk
      görünümü de yok (K19). Bugün talep yok.
- [ ] **`failed` zamanlanmış yayın otomatik tekrar denenmiyor** (F8). Uyarı ve ajans
      bildirimi gidiyor; tekrar deneme onay sayfasından elle. Otomatik tekrar çift
      yayın riski taşır, ayrı tasarım kararı.
- [ ] **Revizyon bekleyen posta hatırlatma yok** (F10). `reminders.ts` yalnızca
      `pending` tarıyor; top ajanstayken kimse dürtülmüyor.
- [ ] **Revizyon turunda onay linki AYNI token'la devam ediyor** (F10). Maildeki link
      ölmesin diye yalnızca süre tazeleniyor; çok turlu postta link aylarca
      yaşayabilir. Sızmış linkte ajans ayrıca `renew: true` demeli. F10'un en az emin
      olunan kararı.
- [ ] **Uyarı bastırması süreç içi** (F11, `alerts.ts` `Map`). Soğuk başlangıçta aynı
      hata için birden fazla mail gidebilir. Upstash artık başka yerde kullanılıyor
      (`push.ts` `SET NX PX`) — istenirse aynı desen.
- [ ] **Ekipten çıkarılan üyenin erişimi en fazla 5 dk sürer** (F6, üyelik 5 dk'da bir
      DB'den doğrulanıyor). Acil durumda kesin çözüm `AUTH_SECRET` döndürmek.
- [ ] **Çok-ajanslı üyelik yok.** `AgencyMember.googleId @unique`: bir Google hesabı
      bir ajans. Başka ajansa katılım yalnızca davet **devri**yle
      (`POST /api/invites/[token]/accept`, açık onayla; giriş sessizce devretmez).
- [ ] **Next 16 yükseltmesi** — kendi başına planlanacak iş; güvenlik gerekçesiyle
      aceleye getirilmez (kalan 3 `npm audit` high'ı için bkz. CLAUDE.md).

---

## Bilinmesi gerekenler

`CLAUDE.md`'deki tuzaklar burada tekrarlanmıyor; bunlar orada olmayanlar.

- **Silinmiş Instagram medyası 404 DEĞİL, 400 döner** (prod'da ölçüldü, 2026-08-17):
  `GET /{media-id}?fields=id` → `HTTP 400 · code=100 · error_subcode=33`
  ("Unsupported get request. Object with ID '…' does not exist…"). Mükerrer yayın
  kontrolünün `isMissingObjectError`'ı bu imzaya dayanıyor; yalnızca HTTP koduna bakan
  kontrol yanılır.
- **Her yayın denemesinde yeni container açmak hesabı kısıtlatır.** 2026-08-19'da aynı
  postun iki container'ı `error_subcode 2207051` (spam koruması) getirdi. Reels yayını
  bu yüzden iki fazlı: container id `Post.igContainerId`'e yoklamadan ÖNCE yazılır,
  bütçe dolunca `{ state: "processing" }` döner, devam eden çağrı aynı container'ı
  bitirir. Yeni container açan adım kilitli kalmalı.
- **Token'ı şifreliye çevirmenin doğru yolu — CLAUDE.md'deki kuralın ayrıntısı.**
  Sensitive env'lerin hepsi `env pull`'da aynı yer tutucuyu döndürür; prod anahtarı
  yalnızca davranıştan doğrulanır. Panelden yeniden bağlarken **bitiş tarihini de gir**
  (boşsa yenileme hiç çalışmaz). Doğrulama:
  `GET /api/clients/[id]/instagram-token` (Bearer `FURI_API_KEY`) gerçek token
  dönüyorsa anahtar, şifreleme ve furi tek çağrıda kanıtlanır; `500 token_undecryptable`
  anahtar sorunu demek. `scripts/token-sifrele.mjs` yerel anahtarla yazar ve yedek
  tutmaz — yalnızca anahtar eşliğinden emin olunduğunda.
- **CSP hataları sessizdir.** Sayfa çizilir, işlev çalışmaz, tek iz konsoldaki
  "Refused to…" satırı (üç kez yaşandı: `form-action` → Google girişi kapalı,
  `'unsafe-eval'` → dev'de hidrasyon ölü, `media-src` → video önizlemesi oynamıyor).
  `next.config.ts`'e dokunan her değişiklik `src/lib/csp.test.ts`'ten geçer;
  `'unsafe-eval'` yalnızca dev'de verilir, CSP değişikliğini e2e (dev sunucusu) ile de
  dene.
- **Branch protection açık** (ruleset `master korumasi`): PR zorunlu, gerekli check
  **`dogrula`** (workflow adı `CI` değil, job adı; GitHub Actions'a sabitli), PR
  master'la güncel olmalı, bypass listesi bilerek boş. Acil çıkış ruleset'i geçici
  `Disabled` yapmak.
- **Deploy GitHub'a bağlı:** master'a merge → production, PR → preview. Elle deploy
  gerekmez.
- **Enum ekleyen göç** (`ALTER TYPE … ADD VALUE`) Prisma transaction'ında PG 12+'da
  çalışıyor — ölçüldü, varsayılmadı; yine de boş DB'de `migrate deploy` + `migrate diff`
  ile sına.
- **`Credentials()` kendisine verilen `id`'yi yok sayar**, `id: "credentials"` döner;
  test girişini ayırt eden ayraç `type === "credentials"`.
- **2026-08-17 güvenlik turunda temiz çıkan alanlar — yeniden taranmasın:** IDOR
  (`getScopedDb`, makine yolu dahil), yarış koşulları (koşullu UPDATE), token entropisi
  (`randomUUID`), sabit zamanlı sır karşılaştırma (`secretsMatch`, SHA-256'lı), XSS
  (`dangerouslySetInnerHTML`/`eval` yok, e-postada `escapeHtml`, hex regex), token'ın
  yanıtlardan ayıklanması (`ClientView`) ve loglarda sır redaksiyonu (`IGError.report()`,
  `safeDetail`). Video kuyruğu (portal, QStash, R2, push) bu turdan sonra geldi ve
  kapsamında değil.
