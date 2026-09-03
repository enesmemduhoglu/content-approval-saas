import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getScopedDb } from "@/lib/scoped-db";
import { AppNav } from "@/components/nav";
import { PostEditor } from "@/components/post-editor";
import { RevisionTrail } from "@/components/revision-trail";

export const dynamic = "force-dynamic";

/**
 * Post düzenleme sayfası — iki iş, tek ekran (F2 + F10).
 *
 * • `pending` → sessiz düzeltme: metin/görsel değişir, durum ve müşteri
 *   bildirimi olduğu yerde kalır.
 * • `revision_requested` → revizyon turunun ajans yarısı: aynı form, ama
 *   gönderim postu onaya döndürür ve müşteriye mail attırır.
 *
 * Neden dashboard'daki satır içi kutu değil: o kutu yalnızca caption
 * düzenletiyordu ve dardı. Müşteri çoğu zaman metni değil POSTU beğenmiyor
 * ("şunu şöyle yapalım"); görseli değiştiremeyen bir düzeltme o isteği
 * karşılamıyordu.
 */

function FullPageMessage({ title, body }: { title: string; body: string }) {
  return (
    <main className="container">
      <div className="card form">
        <h1>{title}</h1>
        <p>{body}</p>
        <Link href="/dashboard">Panele dön</Link>
      </div>
    </main>
  );
}

export default async function EditPostPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.agencyId) redirect("/api/auth/signin");

  const { id } = await params;
  const post = await getScopedDb(session).posts.findByIdForRevision(id);

  if (!post) {
    return (
      <FullPageMessage
        title="Bu post bulunamadı"
        body="Silinmiş olabilir ya da bu ajansa ait değil."
      />
    );
  }
  // Sunucunun reddedeceği formu çizmemek: aynı kapılar `resubmit` ve `PATCH`
  // uçlarında da var, buradaki yalnızca kullanıcıyı boşuna yazdırmamak için.
  if (post.publishStatus === "published") {
    return (
      <FullPageMessage
        title="Yayınlanmış post düzenlenemez"
        body="Metni burada değiştirmek Instagram'daki gönderiyi değiştirmez, yalnızca panelle gerçekliği ayırır. Düzeltme gerekiyorsa yeni bir post oluştur."
      />
    );
  }
  const mode =
    post.status === "revision_requested"
      ? ("revise" as const)
      : post.status === "pending"
        ? ("edit" as const)
        : null;
  if (!mode) {
    return (
      <FullPageMessage
        title="Bu post düzenlenemez"
        body="Müşteri karar verdikten sonra metin değiştirilemez — onayladığı şeyle kayıttaki şey ayrışırdı. Yeni bir post oluştur."
      />
    );
  }

  // Bekleyen istek: ajansın yapacağı iş TAM OLARAK bu cümle, formun üstünde
  // durmalı — zincirin içinde katlı kalırsa okunmadan düzeltme yazılır.
  const openRequest =
    mode === "revise"
      ? ([...post.revisions]
          .reverse()
          .find((revision) => revision.event === "revision_requested") ?? null)
      : null;

  return (
    <>
      <AppNav agencyName={session.agencyName ?? "Ajans"} />
      <main className="container">
        <div className="page-head">
          <h1>
            {mode === "revise" ? "Revizyon" : "Postu düzenle"} · {post.client.name}
          </h1>
          <Link className="button-secondary" href="/dashboard">
            Vazgeç
          </Link>
        </div>
        {mode === "revise" && (
          <p className="rejection-reason">
            Müşteri düzeltme istedi ({post.revisionRound}. tur):{" "}
            {openRequest?.message ?? "ne istediğini yazmadı — müşteriyle konuşman gerekebilir."}
          </p>
        )}
        {/* Onay bekleyen postta uyarı: bu ekran sessiz düzeltme yapar, müşteri
            elindeki linkten yeni hâli görür ama haberi olmaz. */}
        {mode === "edit" && (
          <p className="post-note">
            Bu post onay bekliyor. Kaydettiğin değişiklikler müşteriye mail attırmaz; müşteri
            elindeki linki açtığında güncel hâli görür.
          </p>
        )}
        <RevisionTrail entries={post.revisions} />
        <PostEditor
          postId={post.id}
          mode={mode}
          caption={post.caption}
          images={post.images.map((image) => ({ id: image.id, url: image.url }))}
        />
      </main>
    </>
  );
}
