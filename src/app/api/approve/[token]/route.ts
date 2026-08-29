import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { notifyAgencyTeam } from "@/lib/agency-notify";
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
      // Reel postu: dolu ise `imageUrls` boştur, sayfa <video> gösterir.
      videoUrl: post.videoUrl,
      caption: post.caption,
      status: post.status,
      rejectionReason: post.rejectionReason,
      // Revizyon turu (F10): müşteri en son ne istediğini görebilsin — aksi
      // hâlde "ben ne demiştim" sorusunun yanıtı yalnızca ajansta olurdu.
      revisionRound: post.revisionRound,
      clientName: post.client.name,
      agencyName: post.agency.name,
      // Onay ≠ yayın: ikisi ayrı alan, ayrı gösterilir.
      publishStatus: post.publishStatus,
      igPermalink: post.igPermalink,
      // Yayın anının tek kaydı bu kolon. furi'nin defteri onu buradan okuyamayınca
      // eşitlemenin koştuğu anı yayın saati sanıyor; eşitleme çoğu zaman ertesi
      // günün cron'unda koştuğu için kayıtlar bir gün ileri kayıyordu.
      publishedAt: post.publishedAt,
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
  const { action, rejectionReason, revisionMessage } = (body ?? {}) as {
    action?: unknown;
    rejectionReason?: unknown;
    revisionMessage?: unknown;
  };
  // "request_revision" (F10) üçüncü bir KARAR, red'in bir çeşidi değil: post
  // ölmüyor, ajansa geri dönüyor. Bu yüzden ayrı bir action adı ve ayrı bir
  // durum — `reject` gövdesine bir bayrak eklemek iki farklı sonucu tek isim
  // altında gizlerdi.
  if (action !== "approve" && action !== "reject" && action !== "request_revision") {
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
    // Revizyon turu sürerken top ajansta: müşteri aynı link üzerinden ikinci
    // kez karar veremez. "Zaten karar verildi" demek yanıltıcı olurdu — ortada
    // kapanmış bir iş yok, beklenen bir düzeltme var.
    if (link.post.status === "revision_requested") {
      return NextResponse.json(
        {
          error:
            "Bu post için düzeltme istedin; ajans güncel hâlini gönderdiğinde bu sayfadan karar verebilirsin.",
          status: link.post.status,
        },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: "Zaten karar verildi", status: link.post.status },
      { status: 409 }
    );
  }

  // ---------------------------------------------- revizyon talebi (F10)
  if (action === "request_revision") {
    const message =
      typeof revisionMessage === "string" && revisionMessage.trim()
        ? revisionMessage.trim().slice(0, 2000)
        : null;
    // Tur numarası UPDATE'in içinde `increment` ile artıyor; buradaki değer
    // yalnızca zincire yazılacak satırın etiketi. İki eşzamanlı talepte
    // ikincisi WHERE'e takılıp hiç yazmadığı için ikisi aynı numarayı almaz.
    const round = link.post.revisionRound + 1;

    const requested = await db.$transaction(async (tx) => {
      const result = await tx.post.updateMany({
        where: { id: link.postId, status: "pending" },
        data: { status: "revision_requested", revisionRound: { increment: 1 } },
      });
      if (result.count === 0) return false;
      await tx.postRevision.create({
        data: {
          postId: link.postId,
          round,
          actor: "client",
          event: "revision_requested",
          message,
          // O ANKİ metin donduruluyor: ajans postu düzelttiğinde "müşteri neye
          // itiraz etmişti" sorusunun yanıtı kaybolmasın.
          caption: link.post.caption,
          ip,
        },
      });
      // Karar defterine de yazılır: revizyon talebi de müşterinin verdiği bir
      // karardır ve anlaşmazlıkta bakılacak yer orası (F4).
      await tx.approvalAudit.create({
        data: { postId: link.postId, action: "revision_requested", ip },
      });
      return true;
    });

    if (!requested) {
      const current = await db.post.findUnique({ where: { id: link.postId } });
      return NextResponse.json(
        { error: "Zaten karar verildi", status: current?.status },
        { status: 409 }
      );
    }

    await notifyAgency(link, "revision_requested", {
      revisionRequest: message,
      revisionRound: round,
    });
    return NextResponse.json({ status: "revision_requested", revisionRound: round });
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
 * Ajans EKİBİNE karar bildirimi. Onayı ASLA etkilemez: hata yalnızca loglanır.
 * Müşteri onay e-postasını alıyordu, ajansın ise akıştan hiç haberi olmuyordu.
 *
 * Bildirim `Agency.email`e değil, ekipteki HERKESE gider: o kolon ajansı
 * kuranın adresi, ekibin değil — davetle katılan üyeler hiç haber almıyordu
 * (gerekçe `agency-notify.ts` başında).
 */
async function notifyAgency(
  link: NonNullable<Awaited<ReturnType<typeof findLink>>>,
  event: "approved" | "rejected" | "revision_requested",
  extra: {
    rejectionReason?: string | null;
    /** F8 — zamanlanmış yayında "ne zaman" bilgisi. */
    publishAt?: Date | null;
    /** F10 — müşterinin kendi cümlesiyle ne istediği. */
    revisionRequest?: string | null;
    /** F10 — kaçıncı tur. */
    revisionRound?: number;
  } & Partial<PublishOutcome>
): Promise<void> {
  const { post } = link;
  await notifyAgencyTeam(post.agencyId, {
    agencyEmail: post.agency.email,
    event,
    clientName: post.client.name,
    postRef: post.externalRef ?? post.caption.split("\n")[0].slice(0, 60),
    rejectionReason: extra.rejectionReason ?? null,
    revisionRequest: extra.revisionRequest ?? null,
    revisionRound: extra.revisionRound,
    publishStatus: extra.publishStatus ?? null,
    igPermalink: extra.igPermalink ?? null,
    publishAt: extra.publishAt ?? null,
  }).catch((error) => console.error("[approve] ajans bildirimi hatası:", error));
}
