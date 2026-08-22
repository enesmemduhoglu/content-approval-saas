import { headers } from "next/headers";
import { db } from "@/lib/db";
import { getClientIp, checkRateLimit } from "@/lib/rate-limit";
import { isPublishTarget } from "@/lib/instagram-token";
import { isExpired } from "@/lib/tokens";
import { ApprovalActions } from "@/components/approval-actions";
import { BatchApprove } from "@/components/batch-approve";

export const dynamic = "force-dynamic";

function FullPageMessage({ title, body }: { title: string; body: string }) {
  return (
    <main className="full-page-message">
      <h1>{title}</h1>
      <p>{body}</p>
    </main>
  );
}

export default async function ApprovePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // Public sayfa da API ile aynı rate limiter'ı paylaşır — token brute-force
  // sayfa üzerinden de yapılamaz.
  const requestHeaders = await headers();
  if (await checkRateLimit(getClientIp(requestHeaders))) {
    return (
      <FullPageMessage
        title="Çok fazla istek"
        body="Biraz sonra tekrar deneyin."
      />
    );
  }

  const link = await db.approvalLink.findUnique({
    where: { token },
    include: {
      post: {
        include: {
          agency: true,
          client: true,
          images: { orderBy: { sortOrder: "asc" } },
        },
      },
    },
  });

  if (!link) {
    return (
      <FullPageMessage
        title="Bu link geçersiz"
        body="Link hatalı olabilir. Ajansınla iletişime geçip yeni bir link isteyebilirsin."
      />
    );
  }
  if (isExpired(link.expiresAt)) {
    return (
      <FullPageMessage
        title="Link süresi doldu"
        body="Bu onay linkinin süresi geçti. Ajansınla iletişime geçip yeni bir link isteyebilirsin."
      />
    );
  }

  const { post } = link;
  // Bu müşteride onay = yayın. O yüzden postlar toplu onaylanmaz, tek tek
  // onaylanır (bkz. api/approve/[token]/batch).
  const publishTargeted = isPublishTarget(post.client);

  // Toplu onay: aynı müşterinin onay bekleyen (linki geçerli) diğer postları.
  // Token zaten bu müşteriye ait bir postu açtığı için aynı müşterinin kendi
  // bekleyen işlerini göstermek yetki sınırını aşmaz.
  const siblingPosts =
    post.status === "pending"
      ? await db.post.findMany({
          where: {
            clientId: post.clientId,
            status: "pending",
            id: { not: post.id },
            approvalLink: { expiresAt: { gt: new Date() } },
          },
          include: {
            approvalLink: true,
            images: { orderBy: { sortOrder: "asc" }, take: 1 },
          },
          orderBy: { createdAt: "asc" },
        })
      : [];

  // Ajans markalama (D3.4): brandColor accent değişkenini override eder,
  // logo başlıkta gösterilir. İkisi de opsiyonel.
  const accentStyle = post.agency.brandColor
    ? ({ "--color-accent": post.agency.brandColor } as React.CSSProperties)
    : undefined;

  return (
    <main className="approve-page" style={accentStyle}>
      <header className="approve-header">
        {post.agency.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={post.agency.logoUrl} alt="" className="approve-logo" />
        )}
        <span>{post.agency.name ?? "Ajansın"}</span>
      </header>
      {/* Çoklu görsel (D3.3): tek görsel eskisi gibi, birden çoksa yatay
          scroll-snap carousel (JS gerektirmez) */}
      {post.images.length > 1 ? (
        <>
          <div className="approve-carousel" role="group" aria-label="Post görselleri">
            {post.images.map((image, index) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={image.id}
                src={image.url}
                alt={`Post görseli ${index + 1}/${post.images.length}`}
                className="approve-image approve-carousel-item"
              />
            ))}
          </div>
          <p className="approve-carousel-hint">
            {post.images.length} görsel — kaydırarak gör
          </p>
        </>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={post.images[0]?.url}
          alt="Onay bekleyen post görseli"
          className="approve-image"
        />
      )}
      <p className="approve-caption">{post.caption}</p>
      {post.status === "pending" ? (
        <ApprovalActions
          token={token}
          instagramConnected={Boolean(post.client.instagramUserId)}
        />
      ) : (
        <div className="approve-actions">
          <p className="approve-confirmation" role="status">
            {post.status === "approved"
              ? "Bu post zaten onaylandı."
              : "Bu post zaten reddedildi."}
            {post.publishStatus === "published" && " Instagram'da yayınlandı."}
            {post.publishStatus === "failed" &&
              " Instagram'a yayınlanamadı — aşağıdan tekrar deneyebilirsin."}
            {/* Mükerrer: aynı içerik zaten canlıda olduğu için yayın atlandı.
                "Tekrar dene" butonu bilerek çıkmaz — tekrar denemek tam da
                engellenmek istenen şeyi yapar. */}
            {post.publishStatus === "duplicate" &&
              " Bu içerik zaten Instagram'da yayında olduğu için tekrar yayınlanmadı."}
            {/* F8: "yayınlandı" DEĞİL — henüz olmadı, zamanı geldiğinde
                otomatik yayınlanacak. Saat TR ile gösterilir (ajans Türkiye'de). */}
            {post.publishStatus === "scheduled" &&
              post.publishAt &&
              ` Instagram'a ${post.publishAt.toLocaleString("tr-TR", {
                timeZone: "Europe/Istanbul",
                dateStyle: "medium",
                timeStyle: "short",
              })} itibarıyla otomatik yayınlanacak.`}
            {publishTargeted &&
              post.status === "approved" &&
              post.publishStatus === "idle" &&
              " Instagram'a henüz yayınlanmadı — aşağıdan yayınlayabilirsin."}
          </p>
          {(post.publishStatus === "published" || post.publishStatus === "duplicate") &&
            post.igPermalink && (
              <a
                className="button-secondary"
                href={post.igPermalink}
                target="_blank"
                rel="noreferrer"
              >
                Instagram&apos;da gör
              </a>
            )}
          {/* Onay yerinde duruyor; buton yalnızca yayını çalıştırır. "idle"
              eski toplu onaylardan kalan, yayını hiç denenmemiş postlardır. */}
          {post.status === "approved" && post.publishStatus === "failed" && (
            <ApprovalActions token={token} instagramConnected retryOnly />
          )}
          {publishTargeted && post.status === "approved" && post.publishStatus === "idle" && (
            <ApprovalActions
              token={token}
              instagramConnected
              retryOnly
              retryLabel="Instagram'a yayınla"
            />
          )}
        </div>
      )}
      {siblingPosts.length > 0 && (
        <section className="sibling-posts">
          <h2>
            {publishTargeted
              ? `Tek tek onaylanacak diğer postların (${siblingPosts.length})`
              : `Onay bekleyen diğer postların (${siblingPosts.length})`}
          </h2>
          {/* Neden "Tümünü onayla" yok: dürüstçe söylenir, kullanıcı aramasın. */}
          {publishTargeted && (
            <p className="sibling-note">
              Bu postlar onaylandığı anda Instagram&apos;a yayınlanıyor. Yayın her post
              için ayrı sürdüğünden toplu onay yapılamıyor — aşağıdakileri kendi
              sayfalarında tek tek onaylaman gerekiyor.
            </p>
          )}
          <ul className="sibling-list">
            {siblingPosts.map((sibling) => (
              <li key={sibling.id}>
                <a
                  href={`/approve/${sibling.approvalLink!.token}`}
                  className="sibling-row"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={sibling.images[0]?.url}
                    alt=""
                    className="post-thumb"
                    width={48}
                    height={48}
                  />
                  <span className="sibling-caption">{sibling.caption}</span>
                </a>
              </li>
            ))}
          </ul>
          {!publishTargeted && (
            <BatchApprove token={token} totalPending={siblingPosts.length + 1} />
          )}
        </section>
      )}
    </main>
  );
}
