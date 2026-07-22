import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getScopedDb } from "@/lib/scoped-db";
import { AppNav } from "@/components/nav";
import { PostForm } from "@/components/post-form";
import { StatusBadge } from "@/components/status-badge";
import { CopyLinkButton } from "@/components/copy-link-button";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.agencyId) redirect("/api/auth/signin");

  const scoped = getScopedDb(session);
  // Eager-load `client` — N+1 yok (T4)
  const [posts, clients] = await Promise.all([
    scoped.posts.findManyWithRelations({ orderBy: { createdAt: "desc" } }),
    scoped.clients.findMany({ orderBy: { name: "asc" } }),
  ]);

  return (
    <>
      <AppNav agencyName={session.agencyName ?? "Ajans"} />
      <main className="container">
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
                </div>
                <div className="post-meta">
                  <StatusBadge status={post.status} />
                  <time className="post-date">
                    {post.createdAt.toLocaleDateString("tr-TR")}
                  </time>
                  {post.approvalLink && post.status === "pending" && (
                    <CopyLinkButton token={post.approvalLink.token} />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
