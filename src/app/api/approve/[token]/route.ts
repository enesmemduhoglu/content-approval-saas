import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sendAgencyNoticeEmail } from "@/lib/email";
import { publishApprovedPost, type PublishOutcome } from "@/lib/publish-post";
import { getClientIp, checkRateLimit } from "@/lib/rate-limit";
import { isExpired } from "@/lib/tokens";

// Instagram yayını isteğin içinde tamamlanır (tasarım kararı 4): karusel için
// ~10 API çağrısı + container bekleme. Varsayılan 10sn yetmez.
export const maxDuration = 60;

type RouteParams = { params: Promise<{ token: string }> };

function findLink(token: string) {
  return db.approvalLink.findUnique({
    where: { token },
    include: {
      post: {
        include: {
          client: true,
          agency: true,
          images: { orderBy: { sortOrder: "asc" } },
        },
      },
    },
  });
}

export async function GET(request: Request, { params }: RouteParams) {
  const ip = getClientIp(request.headers);
  if (await checkRateLimit(ip)) {
    return NextResponse.json(
      { error: "Çok fazla istek, biraz sonra tekrar deneyin" },
      { status: 429 }
    );
  }

  const { token } = await params;
  const link = await findLink(token);
  if (!link) {
    return NextResponse.json({ error: "Bu link geçersiz" }, { status: 404 });
  }
  if (isExpired(link.expiresAt)) {
    return NextResponse.json({ error: "Link süresi doldu" }, { status: 410 });
  }

  const { post } = link;
  return NextResponse.json({
    post: {
      imageUrls: post.images.map((image) => image.url),
      caption: post.caption,
      status: post.status,
      rejectionReason: post.rejectionReason,
      clientName: post.client.name,
      agencyName: post.agency.name,
      // Onay ≠ yayın: ikisi ayrı alan, ayrı gösterilir.
      publishStatus: post.publishStatus,
      igPermalink: post.igPermalink,
      // F8: müşteri/ajans "ne zaman yayınlanacak" sorusunu onay sayfasından
      // görebilsin diye — null ise zamanlama yok, onayda hemen yayınlanır.
      publishAt: post.publishAt,
      instagramConnected: Boolean(post.client.instagramUserId),
    },
  });
}

export async function POST(request: Request, { params }: RouteParams) {
  const ip = getClientIp(request.headers);
  if (await checkRateLimit(ip)) {
    return NextResponse.json(
      { error: "Çok fazla istek, biraz sonra tekrar deneyin" },
      { status: 429 }
    );
  }

  const { token } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const { action, rejectionReason } = (body ?? {}) as {
    action?: unknown;
    rejectionReason?: unknown;
  };
  if (action !== "approve" && action !== "reject") {
    return NextResponse.json({ error: "Geçersiz işlem" }, { status: 400 });
  }

  const link = await findLink(token);
  if (!link) {
    return NextResponse.json({ error: "Bu link geçersiz" }, { status: 404 });
  }
  if (isExpired(link.expiresAt)) {
    return NextResponse.json({ error: "Link süresi doldu" }, { status: 410 });
  }
  if (link.post.status !== "pending") {
    // "Tekrar dene": onay yerinde duruyor ama yayın başarısız olmuş ya da hiç
    // denenmemiş ("idle" — eski toplu onaylardan kalan postlar böyle). Karar
    // yeniden verilmez, yalnızca yayın çalıştırılır (kilit publishStatus'ta).
    if (
      action === "approve" &&
      link.post.status === "approved" &&
      (link.post.publishStatus === "failed" || link.post.publishStatus === "idle")
    ) {
      const outcome = await publishApprovedPost(link.postId);
      // Tekrar denemenin sonucu da bildirilir: ilk denemesi "failed" diye mail
      // alan is sahibi, ikincisinin tuttugunu ogrenemezse panele bakmak zorunda.
      await notifyAgency(link, "approved", outcome);
      return NextResponse.json({ status: "approved", ...outcome });
    }
    return NextResponse.json(
      { error: "Zaten karar verildi", status: link.post.status },
      { status: 409 }
    );
  }

  const newStatus = action === "approve" ? "approved" : "rejected";
  const reason =
    action === "reject" && typeof rejectionReason === "string" && rejectionReason.trim()
      ? rejectionReason.trim().slice(0, 2000)
      : null;

  // F8: publishAt gelecekteyse onay ANINDA yayınlamaz — yayın `publish-scheduled`
  // cron'una bırakılır. Boş ya da GEÇMİŞTEYSE (ör. onay linki günlerce beklemiş)
  // mevcut davranış aynen korunur: aşağıda hemen publishApprovedPost çağrılır.
  // Karar `status` update'iyle AYNI transaction'da yazılır (publishStatus da) —
  // aksi halde iki ayrı yazma arasında cron'un status='approved' ama
  // publishStatus hâlâ 'idle' bir postu yakalayıp ERKEN yayınlaması mümkün olurdu.
  const willSchedule =
    newStatus === "approved" && !!link.post.publishAt && link.post.publishAt.getTime() > Date.now();

  // Yarış koruması: UPDATE yalnızca `status = 'pending'` iken çalışır — aynı anda
  // gelen ikinci karar 0 satır etkiler ve 409 alır. Audit kaydı aynı transaction'da.
  const decided = await db.$transaction(async (tx) => {
    const result = await tx.post.updateMany({
      where: { id: link.postId, status: "pending" },
      data: {
        status: newStatus,
        rejectionReason: reason,
        ...(willSchedule ? { publishStatus: "scheduled" } : {}),
      },
    });
    if (result.count === 0) return false;
    await tx.approvalAudit.create({
      data: { postId: link.postId, action: newStatus, ip },
    });
    return true;
  });

  if (!decided) {
    const current = await db.post.findUnique({ where: { id: link.postId } });
    return NextResponse.json(
      { error: "Zaten karar verildi", status: current?.status },
      { status: 409 }
    );
  }

  if (newStatus !== "approved") {
    await notifyAgency(link, "rejected", { rejectionReason: reason });
    return NextResponse.json({ status: newStatus });
  }

  if (willSchedule) {
    // Yayın hemen tetiklenmez — "yayınlandı" demek yanıltıcı olurdu.
    await notifyAgency(link, "approved", {
      publishStatus: "scheduled",
      publishAt: link.post.publishAt,
    });
    return NextResponse.json({ status: newStatus, publishStatus: "scheduled" });
  }

  // Onay commit oldu; buradan sonrası onayı ETKİLEMEZ. publishApprovedPost
  // throw etmez, en kötü ihtimalle publishStatus "failed" döner.
  const outcome = await publishApprovedPost(link.postId);
  // Bildirim yayından SONRA gidiyor ki iş sahibi tek mailde hem kararı hem
  // yayının akibetini gorsun — "onaylandi" deyip yayinin patladigini
  // soylemeyen bir mail en cok bilinmesi gereken seyi gizlerdi.
  await notifyAgency(link, "approved", outcome);
  return NextResponse.json({ status: newStatus, ...outcome });
}

/**
 * İş sahibine karar bildirimi. Onayı ASLA etkilemez: hata yalnızca loglanır.
 * Müşteri onay e-postasını alıyordu, ajansın ise akıştan hiç haberi olmuyordu.
 */
async function notifyAgency(
  link: NonNullable<Awaited<ReturnType<typeof findLink>>>,
  event: "approved" | "rejected",
  extra: { rejectionReason?: string | null; publishAt?: Date | null } & Partial<PublishOutcome>
): Promise<void> {
  const { post } = link;
  if (!post.agency.email) return;
  await sendAgencyNoticeEmail({
    to: post.agency.email,
    event,
    clientName: post.client.name,
    postRef: post.externalRef ?? post.caption.split("\n")[0].slice(0, 60),
    rejectionReason: extra.rejectionReason ?? null,
    publishStatus: extra.publishStatus ?? null,
    igPermalink: extra.igPermalink ?? null,
    publishAt: extra.publishAt ?? null,
  }).catch((error) => console.error("[approve] ajans bildirimi hatası:", error));
}
