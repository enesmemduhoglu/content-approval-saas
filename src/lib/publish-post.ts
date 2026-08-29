import type { PublishStatus } from "@prisma/client";
import { sendAlert } from "@/lib/alerts";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import type { MediaLiveness } from "@/lib/instagram";
import {
  IGError,
  checkMediaLiveness,
  createReelContainer,
  finalizeContainer,
  publishToInstagram,
} from "@/lib/instagram";
import { isInstagramTokenExpired, isPublishTarget } from "@/lib/instagram-token";

/**
 * Instagram medya container'ının ömrü. Bu süreyi geçmiş bir container artık
 * yayınlanamaz; yoklamaya devam etmek her turda aynı hatayı üretir.
 */
const CONTAINER_TTL_MS = 24 * 60 * 60 * 1000;

export type PublishOutcome = {
  publishStatus: PublishStatus;
  igPermalink?: string | null;
  /** Kullanıcıya gösterilebilir (ayrıntı içermeyen) hata metni. */
  publishError?: string | null;
};

const GENERIC_ERROR = "Instagram'a yayınlanamadı. Tekrar deneyebilirsin.";

/**
 * Onaylanmış bir postu Instagram'a yayınlar. Yayın hedefi olan müşteride
 * onay, aynı istekte yayını da tetikler.
 *
 * Yayın onay transaction'ından SONRA, ayrı adımda yapılır (tasarım kararı 2):
 * onay kaydı ASLA bir Instagram hatası yüzünden kaybolmamalı. Yayın patlarsa
 * onay yerinde durur, `publishStatus = "failed"` olur ve tekrar denenebilir.
 *
 * Bu fonksiyon hiçbir zaman throw etmez — çağıran route her durumda onayın
 * sonucunu döndürebilmelidir.
 */
export async function publishApprovedPost(postId: string): Promise<PublishOutcome> {
  const post = await db.post.findUnique({
    where: { id: postId },
    include: { client: true, images: { orderBy: { sortOrder: "asc" } } },
  });
  if (!post) {
    return { publishStatus: "failed", publishError: GENERIC_ERROR };
  }

  const { client } = post;
  // Instagram bağlı değil → mevcut kullanıcıların davranışı aynen korunur:
  // post onaylanır, hiçbir şey yayınlanmaz.
  if (!isPublishTarget(client)) {
    await db.post.updateMany({
      where: { id: postId, publishStatus: "idle" },
      data: { publishStatus: "skipped" },
    });
    return { publishStatus: "skipped" };
  }

  // Çift yayın kilidi (tasarım kararı 3): `status` guard'ıyla aynı desen —
  // koşullu UPDATE. "publishing" ya da "published" ise ikinci istek çıkar.
  // "failed" dahil edilir; onay sayfasındaki "tekrar dene" yolu budur.
  // "scheduled" de dahildir (F8): `publish-scheduled` cron'u `publishAt`
  // geçmiş bir postu yayınlamak için BU fonksiyonu çağırıyor — kilit bu
  // durumdan geçiş yapmazsa cron hiçbir zaman yayın tetikleyemez. Aynı
  // koşullu UPDATE, cron ile onay yolunun (ör. gecikmiş "tekrar dene") aynı
  // postu aynı anda yakalaması durumunda da tek kazananı garanti eder.
  //
  // Videoda ("publishing" + `igContainerId` dolu) kilit BİLEREK geçirgen:
  // container zaten açık, yapılacak iş yalnızca onu yoklamak ve hazırsa
  // yayınlamak — bu adım tekrarlanabilir olmak ZORUNDA, yoksa tarayıcının
  // yoklaması ve emniyet ağı cron'u postu hiç devralamaz. Riski dar: aynı
  // container'ı iki kez `media_publish`'e vermek ikinci postu DEĞİL, Instagram
  // hatası üretir. Asıl korunması gereken adım — yeni container AÇMAK — hâlâ
  // kilitli, çünkü orada `igContainerId` null olur ve koşul tutmaz.
  const lock = await db.post.updateMany({
    where: {
      id: postId,
      OR: [
        { publishStatus: { in: ["idle", "failed", "scheduled"] } },
        { publishStatus: "publishing", igContainerId: { not: null } },
      ],
    },
    data: { publishStatus: "publishing", publishError: null },
  });
  if (lock.count === 0) {
    const current = await db.post.findUnique({
      where: { id: postId },
      select: { publishStatus: true, igPermalink: true },
    });
    return {
      publishStatus: current?.publishStatus ?? "publishing",
      igPermalink: current?.igPermalink ?? null,
    };
  }

  // Süresi dolmuş token'la API'ye gitmenin anlamı yok; hata mesajı da net olsun.
  // Aynı eşik dashboard'daki proaktif uyarıda da kullanılır (instagram-token.ts).
  if (isInstagramTokenExpired(client.instagramTokenExpiry)) {
    return markFailed(
      postId,
      "Instagram erişim token'ının süresi dolmuş — ajansın yenilemesi gerekiyor"
    );
  }

  // Token DB'de şifreli duruyor (S1). BİR KEZ çözülür ve aşağıdaki iki yerde
  // (mükerrer kontrolü + yayın) aynı değer kullanılır.
  //
  // Çözme hatası burada yakalanır çünkü bu fonksiyonun sözleşmesi "asla throw
  // etme": onay commit olmuş durumda çağrılıyor ve bir istisna onayın yanıtını
  // düşürürdü. Ajans panelde ne olduğunu okuyabilsin diye mesaj açık.
  let accessToken: string;
  try {
    accessToken = decryptSecret(client.instagramAccessToken);
  } catch (error) {
    console.error("[instagram] token çözülemedi:", error);
    return markFailed(
      postId,
      "Instagram token'ı sunucuda çözülemedi (ENCRYPTION_KEY sorunu) — " +
        "hesabın panelden yeniden bağlanması gerekebilir"
    );
  }

  // Mükerrer yayın koruması. Dış otomasyon (furi) aynı içeriği iki kez
  // gönderirse iki ayrı Post oluşur ve ikisi de onaylanınca Instagram'a İKİ KEZ
  // düşer — prod'da yaşandı.
  const liveTwin = post.externalRef
    ? await findLivePublishedTwin(post.id, post.agencyId, post.externalRef, accessToken)
    : null;
  if (liveTwin) {
    return markDuplicate(postId, post.externalRef!, liveTwin.igPermalink);
  }

  try {
    if (post.videoUrl) {
      return await publishVideo({
        postId,
        igUserId: client.instagramUserId,
        accessToken,
        videoUrl: post.videoUrl,
        caption: post.caption,
        containerId: post.igContainerId,
        containerAt: post.containerAt,
      });
    }

    const result = await publishToInstagram({
      igUserId: client.instagramUserId,
      accessToken,
      imageUrls: post.images.map((image) => image.url),
      caption: post.caption,
      altTexts: post.images.map((image) => image.altText),
    });

    return markPublished(postId, result.mediaId, result.permalink);
  } catch (error) {
    const detail =
      error instanceof IGError ? error.report() : (error as Error)?.message ?? "bilinmeyen hata";
    return markFailed(postId, detail);
  }
}

/**
 * Container'ı açılmış ama henüz yayınlanmamış bir videoyu devam ettirir.
 *
 * Onay isteği tek bir yoklama turu (30sn) yapıyor; Instagram videoyu daha uzun
 * işlerse post `publishing`de kalıyor ve yayını bitirecek olan bu fonksiyon.
 * İki yerden çağrılır: onay sayfasının yokladığı uç (hızlı yol, saniyeler
 * içinde) ve `publish-scheduled` cron'u (emniyet ağı — tarayıcı kapanırsa post
 * sonsuza kadar asılı kalmasın).
 *
 * `publishApprovedPost`ı yeniden çağırmıyor çünkü o mükerrer kontrolünü ve
 * token çözmeyi baştan yapardı; buradaki iş yalnızca "hazır mı, hazırsa yayınla".
 */
export async function resumePublish(postId: string): Promise<PublishOutcome> {
  const post = await db.post.findUnique({
    where: { id: postId },
    include: { client: true },
  });
  if (!post) {
    return { publishStatus: "failed", publishError: GENERIC_ERROR };
  }
  // Devam edecek bir şey yok: ya yayın bitmiş, ya hiç video değil, ya da
  // container hiç açılmamış. Çağıranın mevcut durumu görmesi yeterli.
  if (post.publishStatus !== "publishing" || !post.igContainerId) {
    return {
      publishStatus: post.publishStatus,
      igPermalink: post.igPermalink,
      publishError: post.publishStatus === "failed" ? GENERIC_ERROR : null,
    };
  }

  const { client } = post;
  if (!isPublishTarget(client)) {
    // Yayın başladıktan sonra Instagram bağlantısı kaldırılmış. Container
    // orada duruyor ama artık yayınlanamaz; `skipped` gerçeği anlatır.
    await db.post.update({ where: { id: postId }, data: { publishStatus: "skipped" } });
    return { publishStatus: "skipped" };
  }

  // Container Instagram tarafında 24 saat yaşıyor. Süresi geçmiş bir id'yi
  // yoklamak her seferinde aynı hatayı üretir; postu `failed`'a çekmek
  // "tekrar dene" yolunu açar ve o yol sıfırdan yeni bir container açar.
  if (post.containerAt && Date.now() - post.containerAt.getTime() > CONTAINER_TTL_MS) {
    await db.post.update({
      where: { id: postId },
      data: { igContainerId: null, containerAt: null },
    });
    return markFailed(
      postId,
      "Video container'ının 24 saatlik ömrü doldu — yayın tekrar denenmeli"
    );
  }

  let accessToken: string;
  try {
    accessToken = decryptSecret(client.instagramAccessToken!);
  } catch (error) {
    console.error("[instagram] token çözülemedi:", error);
    return markFailed(postId, "Instagram token'ı sunucuda çözülemedi (ENCRYPTION_KEY sorunu)");
  }

  try {
    const result = await finalizeContainer({
      igUserId: client.instagramUserId!,
      accessToken,
      containerId: post.igContainerId,
    });
    if (result.state === "processing") {
      return { publishStatus: "publishing" };
    }
    return markPublished(postId, result.mediaId, result.permalink);
  } catch (error) {
    const detail =
      error instanceof IGError ? error.report() : (error as Error)?.message ?? "bilinmeyen hata";
    // Container ERROR/EXPIRED oldu — id'yi temizle ki "tekrar dene" temiz bir
    // container açsın, ölü olanı sonsuza kadar yoklamasın.
    await db.post.update({
      where: { id: postId },
      data: { igContainerId: null, containerAt: null },
    });
    return markFailed(postId, detail);
  }
}

/**
 * Onay token'ıyla kapsamlanmış {@link resumePublish}.
 *
 * Arama route handler'ında DEĞİL burada: `getScopedDb` bir oturumun `agencyId`si
 * üzerinden kapsamlıyor, bu ise public bir yol — kapsamlayan şey token'ın
 * kendisi. Aynı desendeki tek yer olmasın diye sorgu, kullandığı mantığın
 * yanına konuldu.
 *
 * `linkExpired` bilgisi dönüyor ama yayını ENGELLEMİYOR: onay çoktan verilmiş
 * ve container Instagram'da açık; yarım kalmış bir yayını linkin süresi doldu
 * diye asılı bırakmak kimsenin işine yaramaz. Süre dolması YENİ karar vermeyi
 * kapatır (bkz. `POST /api/approve/[token]`), biteni bitirmeyi değil.
 */
export async function resumePublishByApprovalToken(
  token: string
): Promise<(PublishOutcome & { linkExpired: boolean }) | null> {
  const link = await db.approvalLink.findUnique({
    where: { token },
    select: { expiresAt: true, postId: true },
  });
  if (!link) return null;

  const outcome = await resumePublish(link.postId);
  return { ...outcome, linkExpired: link.expiresAt.getTime() <= Date.now() };
}

/**
 * Container'ı açılmış ama yayını bitmemiş, üzerinden bir süre geçmiş video
 * postları — emniyet ağı cron'unun devralacağı iş.
 *
 * Sorgu ajans kapsamlı DEĞİL ve `getScopedDb`ye konulamaz: cron'un oturumu yok,
 * işi tüm ajansların takılmış yayınlarını kurtarmak. Route handler'da ham
 * Prisma'dan kaçınmak için sorgu, kullandığı mantığın yanına konuldu.
 *
 * `stuckAfterMs` eşiği taze container'ları dışarıda bırakır: o an tarayıcıda
 * süren yoklamayla yarışmanın anlamı yok.
 */
export async function findStuckVideoPublishes(input: { stuckAfterMs: number; take: number }) {
  return db.post.findMany({
    where: {
      publishStatus: "publishing",
      igContainerId: { not: null },
      containerAt: { lte: new Date(Date.now() - input.stuckAfterMs) },
    },
    orderBy: { containerAt: "asc" },
    take: input.take,
    select: {
      id: true,
      caption: true,
      externalRef: true,
      agencyId: true,
      client: { select: { name: true } },
      agency: { select: { email: true } },
    },
  });
}

/** Video yayınının ilk turu: container aç, sakla, bütçe kadar bekle. */
async function publishVideo(input: {
  postId: string;
  igUserId: string;
  accessToken: string;
  videoUrl: string;
  caption: string;
  containerId: string | null;
  containerAt: Date | null;
}): Promise<PublishOutcome> {
  const { postId, igUserId, accessToken } = input;

  let containerId = input.containerId;
  if (!containerId) {
    containerId = await createReelContainer({
      igUserId,
      accessToken,
      videoUrl: input.videoUrl,
      caption: input.caption,
    });
    // Yoklamadan ÖNCE yazılır. Sıra tersine dönerse (önce bekle, sonra yaz)
    // fonksiyon süresi dolduğunda container id'si kaybolur, bir sonraki deneme
    // ikinci bir container açar ve Instagram bunu spam sayar (2207051).
    await db.post.update({
      where: { id: postId },
      data: { igContainerId: containerId, containerAt: new Date() },
    });
  }

  const result = await finalizeContainer({ igUserId, accessToken, containerId });
  if (result.state === "processing") {
    // Hata DEĞİL: Instagram videoyu hâlâ işliyor. Post `publishing`de bırakılır,
    // `resumePublish` devralır.
    return { publishStatus: "publishing" };
  }
  return markPublished(postId, result.mediaId, result.permalink);
}

async function markPublished(
  postId: string,
  mediaId: string,
  permalink: string
): Promise<PublishOutcome> {
  await db.post.update({
    where: { id: postId },
    data: {
      publishStatus: "published",
      igMediaId: mediaId,
      igPermalink: permalink || null,
      publishError: null,
      publishedAt: new Date(),
    },
  });
  return { publishStatus: "published", igPermalink: permalink || null };
}

/**
 * Aynı `externalRef`'i taşıyan, HÂLÂ Instagram'da duran bir kardeş post var mı?
 *
 * Neden "daha önce yayınlandı mı" diye bakmıyoruz (ve neden
 * `@@unique([agencyId, externalRef])` KOYMUYORUZ):
 * furi'nin `esitle.py`'si "yayınlandı ama sonra Instagram'dan silindi"
 * durumunda içeriği bilerek havuza geri döndürüyor. Yani aynı ref'in ikinci kez
 * gönderilmesi MEŞRU bir kurtarma yolu. DB seviyesinde benzersizlik ya da
 * "bu ref published görmüş mü" kontrolü bu yolu kalıcı olarak kırar.
 * Bizi ilgilendiren tek soru şu: içerik ŞU AN canlıda mı?
 *
 * Ajans izolasyonu: sorgu `agencyId`'ye bağlı. İki farklı ajansın aynı slug'ı
 * kullanması (ki dış otomasyon slug'ları jenerik) birbirini engellememeli.
 */
async function findLivePublishedTwin(
  postId: string,
  agencyId: string,
  externalRef: string,
  accessToken: string
): Promise<{ id: string; igPermalink: string | null } | null> {
  const twins = await db.post.findMany({
    where: {
      agencyId,
      externalRef,
      id: { not: postId },
      publishStatus: "published",
      igMediaId: { not: null },
    },
    select: { id: true, igMediaId: true, igPermalink: true },
    orderBy: { publishedAt: "desc" },
  });

  for (const twin of twins) {
    // `checkMediaLiveness` tasarımı gereği throw etmez ama bu kontrol yayının
    // ÖNÜNDE duruyor — beklenmeyen bir istisna yayını komple düşürmemeli.
    // Yakalanan her şey "belirsiz" muamelesi görür.
    let liveness: MediaLiveness;
    try {
      liveness = await checkMediaLiveness(twin.igMediaId!, accessToken);
    } catch {
      liveness = "unknown";
    }
    if (liveness === "live") return { id: twin.id, igPermalink: twin.igPermalink };
    if (liveness === "deleted") continue;

    // BELİRSİZ (ağ hatası, rate limit, beklenmeyen cevap) → yayına İZİN VERİLİR.
    //
    // Tasarım kararı, bilinçli tercih: bu kontrol bir EMNİYET AĞI, bir KAPI
    // değil. Belirsizde engellersek, Instagram API'si sallandığı her an
    // silinen-post kurtarma yolu SESSİZCE kırılır ve ajans "neden yayınlanmadı"
    // sorusunun cevabını hiçbir yerde bulamaz. Aksi yöndeki risk — nadiren bir
    // mükerrer yayın — görünür ve elle düzeltilebilir; sessizce yayınlanmayan
    // içerik değil. Onun için sadece uyarı basılır.
    console.warn(
      `[instagram] mükerrer kontrolü belirsiz kaldı (externalRef=${externalRef}, ` +
        `kardeş post=${twin.id}, igMediaId=${twin.igMediaId}) — yayına izin verildi`
    );
  }

  return null;
}

/**
 * Yayın atlandı: içerik zaten canlıda. Hata DEĞİL, bilinçli atlama.
 *
 * `publishError` alanı burada teşhis metni değil, ajansın panelde okuyacağı
 * açıklama olarak kullanılır — "neyin engellendiği" görünsün diye.
 * `igPermalink`'e canlı kardeşin linki yazılır: `igMediaId` boş kaldığı için
 * bu satırın kendisinin yayınlandığı sanılmaz, ama ajans tek tıkla "peki o
 * zaman hangisi yayında" sorusunun cevabına gidebilir.
 */
async function markDuplicate(
  postId: string,
  externalRef: string,
  twinPermalink: string | null
): Promise<PublishOutcome> {
  const note = `Bu içerik zaten Instagram'da yayında (referans: ${externalRef}) — tekrar yayınlanmadı.`;
  console.warn(`[instagram] mükerrer yayın engellendi: post=${postId} ref=${externalRef}`);
  await db.post.update({
    where: { id: postId },
    data: {
      publishStatus: "duplicate",
      publishError: note,
      igPermalink: twinPermalink,
    },
  });
  return { publishStatus: "duplicate", publishError: note, igPermalink: twinPermalink };
}

/**
 * Ayrıntılı hata `publishError`'a yazılır (ajans panelinde teşhis için);
 * public onay sayfasına yalnızca genel metin döner.
 *
 * Yazma KOŞULLU (`updateMany` + beklenen durum): yalnızca post hâlâ
 * `publishing` ise `failed`'a düşer. Video'da devam eden yayını iki yer birden
 * yoklayabiliyor (onay sayfası + emniyet ağı cron'u); ikisi aynı container'ı
 * yakalarsa biri yayını bitirir, diğeri Instagram'dan "bu container zaten
 * yayınlandı" hatası alır. Koşulsuz yazsaydık o hata, BAŞARILI yayının
 * üzerine `failed` yazardı — post Instagram'da duruyorken panelde
 * "yayınlanamadı" görünürdü.
 */
async function markFailed(postId: string, detail: string): Promise<PublishOutcome> {
  console.error("[instagram] yayın hatası:", detail);
  const yazildi = await db.post.updateMany({
    where: { id: postId, publishStatus: "publishing" },
    data: { publishStatus: "failed", publishError: detail.slice(0, 1000) },
  });
  if (yazildi.count === 0) {
    // Yarışı kaybettik: başka bir çağrı bu postu çoktan sonuçlandırmış.
    // Onun sonucu geçerli olan, bizimki bayat — durumu okuyup öyle döneriz.
    const current = await db.post.findUnique({
      where: { id: postId },
      select: { publishStatus: true, igPermalink: true },
    });
    console.warn(`[instagram] hata yazılmadı, post zaten sonuçlanmış: post=${postId}`);
    return {
      publishStatus: current?.publishStatus ?? "failed",
      igPermalink: current?.igPermalink ?? null,
    };
  }
  // F11: bu, ajansa giden per-post bildirimin (approve route'undaki
  // `sendAgencyNoticeEmail`) YERİNE geçmiyor — o zaten "bu post yayınlanamadı"
  // der. Buradaki operatöre giden EK sinyal: "yayın hattı bozuk olabilir".
  // `key` hatanın kendisinden türetilir (postId'den DEĞİL) — amaç aynı temel
  // sebepten (örn. Instagram genel kesintisi) art arda başarısız olan FARKLI
  // postların operatörün kutusunu tek tek doldurmasını önlemek; "aynı hata"
  // tekrar ediyorsa tek mail yeter.
  await sendAlert(
    `publish:failed:${detail.slice(0, 80)}`,
    "Instagram yayını başarısız oldu",
    { postId, detail: detail.slice(0, 300) }
  );
  return { publishStatus: "failed", publishError: GENERIC_ERROR };
}
