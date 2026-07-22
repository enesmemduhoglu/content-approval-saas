import { headers } from "next/headers";
import { db } from "@/lib/db";
import { getClientIp, checkRateLimit } from "@/lib/rate-limit";
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
        include: { agency: true, images: { orderBy: { sortOrder: "asc" } } },
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
        <ApprovalActions token={token} />
      ) : (
        <p className="approve-confirmation" role="status">
          {post.status === "approved"
            ? "Bu post zaten onaylandı."
            : "Bu post zaten reddedildi."}
        </p>
      )}
      {siblingPosts.length > 0 && (
        <section className="sibling-posts">
          <h2>Onay bekleyen diğer postların ({siblingPosts.length})</h2>
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
          <BatchApprove token={token} totalPending={siblingPosts.length + 1} />
        </section>
      )}
    </main>
  );
}
