import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getScopedDb } from "@/lib/scoped-db";
import { AppNav } from "@/components/nav";
import { ReviseForm } from "@/components/revise-form";
import { RevisionTrail } from "@/components/revision-trail";

export const dynamic = "force-dynamic";

/**
 * Revizyon sayfası (F10).
 *
 * Neden dashboard'daki satır içi kutu değil: müşteri çoğu zaman metni değil
 * POSTU beğenmiyor ("şunu şöyle yapalım"). Satır içi kutu yalnızca caption
 * düzenletiyordu ve dar bir alandı — ajans, müşterinin isteğini okuyup görseli
 * değiştiremediği için revizyon turu pratikte yarım kalıyordu. Burası post
 * oluşturma formunun eşi: aynı genişlik, aynı alanlar, üstünde müşterinin
 * isteği ve turun geçmişi.
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

export default async function RevisePage({ params }: { params: Promise<{ id: string }> }) {
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
  // Sunucunun reddedeceği bir formu çizmemek: aynı iki kapı `resubmit` uç
  // noktasında da var, buradaki yalnızca kullanıcıyı boşuna yazdırmamak için.
  if (post.publishStatus === "published") {
    return (
      <FullPageMessage
        title="Yayınlanmış post revize edilemez"
        body="Metni burada değiştirmek Instagram'daki gönderiyi değiştirmez, yalnızca panelle gerçekliği ayırır. Düzeltme gerekiyorsa yeni bir post oluştur."
      />
    );
  }
  if (post.status !== "revision_requested") {
    return (
      <FullPageMessage
        title="Bu post revizyon beklemiyor"
        body="Yalnızca müşterinin düzeltme istediği postlar buradan tekrar gönderilebilir."
      />
    );
  }

  // Bekleyen istek: ajansın yapacağı iş TAM OLARAK bu cümle, formun üstünde
  // durmalı — zincirin içinde katlı kalırsa okunmadan düzeltme yazılır.
  const openRequest =
    [...post.revisions].reverse().find((revision) => revision.event === "revision_requested") ??
    null;

  return (
    <>
      <AppNav agencyName={session.agencyName ?? "Ajans"} />
      <main className="container">
        <div className="page-head">
          <h1>Revizyon · {post.client.name}</h1>
          <Link className="button-secondary" href="/dashboard">
            Vazgeç
          </Link>
        </div>
        <p className="rejection-reason">
          Müşteri düzeltme istedi ({post.revisionRound}. tur):{" "}
          {openRequest?.message ?? "ne istediğini yazmadı — müşteriyle konuşman gerekebilir."}
        </p>
        <RevisionTrail entries={post.revisions} />
        <ReviseForm
          postId={post.id}
          caption={post.caption}
          images={post.images.map((image) => ({ id: image.id, url: image.url }))}
        />
      </main>
    </>
  );
}
