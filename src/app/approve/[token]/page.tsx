import { headers } from "next/headers";
import { db } from "@/lib/db";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { isExpired } from "@/lib/tokens";
import { ApprovalActions } from "@/components/approval-actions";

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
  if (isRateLimited(getClientIp(requestHeaders))) {
    return (
      <FullPageMessage
        title="Çok fazla istek"
        body="Biraz sonra tekrar deneyin."
      />
    );
  }

  const link = await db.approvalLink.findUnique({
    where: { token },
    include: { post: { include: { agency: true } } },
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

  return (
    <main className="approve-page">
      <header className="approve-header">{post.agency.name ?? "Ajansın"}</header>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={post.imageUrl} alt="Onay bekleyen post görseli" className="approve-image" />
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
    </main>
  );
}
