import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getClientIp, checkRateLimit } from "@/lib/rate-limit";
import { isExpired } from "@/lib/tokens";

type RouteParams = { params: Promise<{ token: string }> };

/**
 * Toplu onay: geçerli bir approval token'ı, AYNI müşterinin onay bekleyen ve
 * linki geçerli tüm postlarını tek istekte onaylamaya yetki verir. Reddetme
 * bilinçli olarak toplu değildir — sebep alanı post başına anlamlıdır.
 */
export async function POST(request: Request, { params }: RouteParams) {
  const ip = getClientIp(request.headers);
  if (await checkRateLimit(ip)) {
    return NextResponse.json(
      { error: "Çok fazla istek, biraz sonra tekrar deneyin" },
      { status: 429 }
    );
  }

  const { token } = await params;
  const link = await db.approvalLink.findUnique({
    where: { token },
    include: { post: true },
  });
  if (!link) {
    return NextResponse.json({ error: "Bu link geçersiz" }, { status: 404 });
  }
  if (isExpired(link.expiresAt)) {
    return NextResponse.json({ error: "Link süresi doldu" }, { status: 410 });
  }

  const now = new Date();
  const pendingPosts = await db.post.findMany({
    where: {
      clientId: link.post.clientId,
      status: "pending",
      approvalLink: { expiresAt: { gt: now } },
    },
    select: { id: true },
  });

  if (pendingPosts.length === 0) {
    return NextResponse.json(
      { error: "Onay bekleyen post yok", approved: 0 },
      { status: 409 }
    );
  }

  // Post başına WHERE status='pending' guard'ı korunur — eşzamanlı tekil
  // kararla yarışta çifte karar oluşmaz; audit kaydı aynı transaction'da.
  const approvedCount = await db.$transaction(async (tx) => {
    let approved = 0;
    for (const post of pendingPosts) {
      const result = await tx.post.updateMany({
        where: { id: post.id, status: "pending" },
        data: { status: "approved", rejectionReason: null },
      });
      if (result.count === 1) {
        await tx.approvalAudit.create({
          data: { postId: post.id, action: "approved", ip },
        });
        approved += 1;
      }
    }
    return approved;
  });

  return NextResponse.json({ approved: approvedCount });
}
