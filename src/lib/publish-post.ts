import type { PublishStatus } from "@prisma/client";
import { sendAlert } from "@/lib/alerts";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import type { MediaLiveness } from "@/lib/instagram";
import { IGError, checkMediaLiveness, publishToInstagram } from "@/lib/instagram";
import { isInstagramTokenExpired, isPublishTarget } from "@/lib/instagram-token";

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
  const lock = await db.post.updateMany({
    where: { id: postId, publishStatus: { in: ["idle", "failed"] } },
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
    const result = await publishToInstagram({
      igUserId: client.instagramUserId,
      accessToken,
      imageUrls: post.images.map((image) => image.url),
      caption: post.caption,
      altTexts: post.images.map((image) => image.altText),
    });

    await db.post.update({
      where: { id: postId },
      data: {
        publishStatus: "published",
        igMediaId: result.mediaId,
        igPermalink: result.permalink || null,
        publishError: null,
        publishedAt: new Date(),
      },
    });
    return { publishStatus: "published", igPermalink: result.permalink || null };
  } catch (error) {
    const detail =
      error instanceof IGError ? error.report() : (error as Error)?.message ?? "bilinmeyen hata";
    return markFailed(postId, detail);
  }
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
 */
async function markFailed(postId: string, detail: string): Promise<PublishOutcome> {
  console.error("[instagram] yayın hatası:", detail);
  await db.post.update({
    where: { id: postId },
    data: { publishStatus: "failed", publishError: detail.slice(0, 1000) },
  });
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
