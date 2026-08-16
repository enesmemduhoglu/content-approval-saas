import type { PublishStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { IGError, publishToInstagram } from "@/lib/instagram";

/**
 * Onaylanmış bir postu Instagram'a yayınlar.
 *
 * Yayın onay transaction'ından SONRA, ayrı adımda yapılır (tasarım kararı 2):
 * onay kaydı ASLA bir Instagram hatası yüzünden kaybolmamalı. Yayın patlarsa
 * onay yerinde durur, `publishStatus = "failed"` olur ve tekrar denenebilir.
 *
 * Bu fonksiyon hiçbir zaman throw etmez — çağıran route her durumda onayın
 * sonucunu döndürebilmelidir.
 */

export type PublishOutcome = {
  publishStatus: PublishStatus;
  igPermalink?: string | null;
  /** Kullanıcıya gösterilebilir (ayrıntı içermeyen) hata metni. */
  publishError?: string | null;
};

const GENERIC_ERROR = "Instagram'a yayınlanamadı. Tekrar deneyebilirsin.";

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
  if (!client.instagramUserId || !client.instagramAccessToken) {
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
  if (client.instagramTokenExpiry && client.instagramTokenExpiry.getTime() <= Date.now()) {
    return markFailed(
      postId,
      "Instagram erişim token'ının süresi dolmuş — ajansın yenilemesi gerekiyor"
    );
  }

  try {
    const result = await publishToInstagram({
      igUserId: client.instagramUserId,
      accessToken: client.instagramAccessToken,
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
 * Ayrıntılı hata `publishError`'a yazılır (ajans panelinde teşhis için);
 * public onay sayfasına yalnızca genel metin döner.
 */
async function markFailed(postId: string, detail: string): Promise<PublishOutcome> {
  console.error("[instagram] yayın hatası:", detail);
  await db.post.update({
    where: { id: postId },
    data: { publishStatus: "failed", publishError: detail.slice(0, 1000) },
  });
  return { publishStatus: "failed", publishError: GENERIC_ERROR };
}
