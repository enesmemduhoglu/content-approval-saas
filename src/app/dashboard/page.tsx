import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getScopedDb } from "@/lib/scoped-db";
import { AppNav } from "@/components/nav";
import { PostForm } from "@/components/post-form";
import { EmailBadge, PublishBadge, StatusBadge } from "@/components/status-badge";
import { CopyLinkButton } from "@/components/copy-link-button";
import { PostActions } from "@/components/post-actions";
import { AuditTrail } from "@/components/audit-trail";
import { TokenAlerts } from "@/components/token-alert";
import { instagramTokenAlerts } from "@/lib/instagram-token";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.agencyId) redirect("/api/auth/signin");

  const scoped = getScopedDb(session);
  // Eager-load `client` — N+1 yok (T4)
  const [posts, clients, tokenClients] = await Promise.all([
    scoped.posts.findManyWithRelations({ orderBy: { createdAt: "desc" } }),
    scoped.clients.findMany({ orderBy: { name: "asc" } }),
    scoped.clients.withInstagramTokenExpiry(),
  ]);
  const tokenAlerts = instagramTokenAlerts(tokenClients);

  return (
    <>
      <AppNav agencyName={session.agencyName ?? "Ajans"} />
      <main className="container">
        <TokenAlerts alerts={tokenAlerts} />
        <div className="page-head">
          <h1>Postlar</h1>
          <PostForm clients={clients.map(({ id, name }) => ({ id, name }))} />
        </div>
        {posts.length === 0 ? (
          <p className="empty-state">Henüz post yok. İlk postunu oluştur.</p>
        ) : (
          <ul className="post-list">
            {posts.map((post) => (
              <li key={post.id} className="post-row">
                <div className="post-thumb-wrap">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={post.images[0]?.url}
                    alt=""
                    className="post-thumb"
                    width={64}
                    height={64}
                  />
                  {post.images.length > 1 && (
                    <span className="post-thumb-count">+{post.images.length - 1}</span>
                  )}
                </div>
                <div className="post-info">
                  <strong>{post.client.name}</strong>
                  <p className="post-caption">{post.caption}</p>
                  {post.status === "rejected" && post.rejectionReason && (
                    <p className="rejection-reason">
                      Reddetme sebebi: {post.rejectionReason}
                    </p>
                  )}
                  {post.publishStatus === "failed" && post.publishError && (
                    <p className="rejection-reason">
                      Yayın hatası: {post.publishError}
                    </p>
                  )}
                  {/* Mailin NEDEN gitmediği rozet kadar önemli: "gitmedi"yi
                      görüp sebebini Vercel loglarında aramak zorunda kalmasın. */}
                  {post.approvalEmailSent === false && post.approvalEmailError && (
                    <p className="rejection-reason">
                      Mail hatası: {post.approvalEmailError}
                    </p>
                  )}
                  {/* Hatırlatma gönderildiyse söyle — ajans "müşteri neden
                      sessiz" derken dürtülüp dürtülmediğini bilmeli (F3). */}
                  {post.status === "pending" && post.reminderSentAt && (
                    <p className="post-note">
                      Hatırlatma gönderildi ·{" "}
                      {post.reminderSentAt.toLocaleDateString("tr-TR")}
                    </p>
                  )}
                  <AuditTrail entries={post.audits} />
                  {/* Mükerrer: hata değil, atlama. "Yayın hatası:" öneki olmadan,
                      publishError'daki açıklama olduğu gibi gösterilir. */}
                  {post.publishStatus === "duplicate" && post.publishError && (
                    <p className="rejection-reason">{post.publishError}</p>
                  )}
                  {(post.publishStatus === "published" ||
                    post.publishStatus === "duplicate") &&
                    post.igPermalink && (
                      <a
                        className="post-caption"
                        href={post.igPermalink}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {post.publishStatus === "duplicate"
                          ? "Yayındaki gönderiyi gör"
                          : "Instagram'da gör"}
                      </a>
                    )}
                </div>
                <div className="post-meta">
                  <StatusBadge status={post.status} />
                  <PublishBadge
                    status={post.publishStatus}
                    awaitingPublish={
                      post.status === "approved" && post.client.publishTarget
                    }
                  />
                  {/* Mail durumu yalnızca onay bekleyen postta anlamlı: karar
                      verildikten sonra mailin akıbeti artık eyleme dönüşmüyor. */}
                  {post.status === "pending" && (
                    <EmailBadge sent={post.approvalEmailSent} />
                  )}
                  <time className="post-date">
                    {post.createdAt.toLocaleDateString("tr-TR")}
                  </time>
                  {post.approvalLink && post.status === "pending" && (
                    <CopyLinkButton token={post.approvalLink.token} />
                  )}
                  <PostActions
                    postId={post.id}
                    status={post.status}
                    publishStatus={post.publishStatus}
                    caption={post.caption}
                    linkExpiresAt={post.approvalLink?.expiresAt.toISOString() ?? null}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
