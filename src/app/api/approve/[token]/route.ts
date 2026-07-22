import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getClientIp, checkRateLimit } from "@/lib/rate-limit";
import { isExpired } from "@/lib/tokens";

type RouteParams = { params: Promise<{ token: string }> };

function findLink(token: string) {
  return db.approvalLink.findUnique({
    where: { token },
    include: { post: { include: { client: true, agency: true } } },
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
      imageUrl: post.imageUrl,
      caption: post.caption,
      status: post.status,
      rejectionReason: post.rejectionReason,
      clientName: post.client.name,
      agencyName: post.agency.name,
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
  const { action, rejectionReason } = (body ?? {}) as {
    action?: unknown;
    rejectionReason?: unknown;
  };
  if (action !== "approve" && action !== "reject") {
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
    return NextResponse.json(
      { error: "Zaten karar verildi", status: link.post.status },
      { status: 409 }
    );
  }

  const newStatus = action === "approve" ? "approved" : "rejected";
  const reason =
    action === "reject" && typeof rejectionReason === "string" && rejectionReason.trim()
      ? rejectionReason.trim().slice(0, 2000)
      : null;

  // Yarış koruması: UPDATE yalnızca `status = 'pending'` iken çalışır — aynı anda
  // gelen ikinci karar 0 satır etkiler ve 409 alır. Audit kaydı aynı transaction'da.
  const decided = await db.$transaction(async (tx) => {
    const result = await tx.post.updateMany({
      where: { id: link.postId, status: "pending" },
      data: { status: newStatus, rejectionReason: reason },
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

  return NextResponse.json({ status: newStatus });
}
