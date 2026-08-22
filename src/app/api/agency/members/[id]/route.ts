import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getScopedDb } from "@/lib/scoped-db";
import { checkOrigin } from "@/lib/origin";

/**
 * F6 — üye çıkarma.
 *
 * Kapsam `getScopedDb` üzerinden: başka ajansın üye id'si verildiğinde satır
 * eşleşmez ve 404 döner. "Yetkin yok" DEĞİL "yok" demek bilinçli — başka
 * ajansta böyle bir üyenin var olduğu bilgisi bile sızmasın.
 *
 * SON OWNER koruması `scoped.members.removeById` içinde, transaction'da:
 * iki owner aynı anda birbirini çıkarmaya kalkarsa ajans sahipsiz kalmasın.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.agencyId) {
    return NextResponse.json({ error: "Giriş gerekli" }, { status: 401 });
  }

  const originCheck = checkOrigin(request);
  if (!originCheck.ok) {
    return NextResponse.json({ error: originCheck.message }, { status: 403 });
  }

  if (session.agencyRole !== "owner") {
    return NextResponse.json(
      { error: "Yalnızca ajans sahibi üye çıkarabilir" },
      { status: 403 }
    );
  }

  const { id } = await params;
  const result = await getScopedDb(session).members.removeById(id);

  if (!result.ok) {
    if (result.reason === "last_owner") {
      return NextResponse.json(
        {
          error:
            "Ajansın son sahibi çıkarılamaz — ajans sahipsiz kalırdı. " +
            "Önce başka birini owner olarak davet et.",
        },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: "Üye bulunamadı" }, { status: 404 });
  }

  // NOT (JWT bayatlığı): çıkarılan üyenin elindeki token bu yanıtla birlikte
  // ölmüyor. Erişim en geç `MEMBERSHIP_REVALIDATE_MS` (5 dk) içinde kesilir —
  // auth.ts'teki periyodik üyelik doğrulaması bunu yapıyor. Anlık kesme JWT
  // stratejisiyle mümkün değil; gerekçe ve acil durum çıkışı auth.ts'te yazılı.
  return NextResponse.json({ ok: true });
}
