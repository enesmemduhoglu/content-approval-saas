import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { InvalidImageError, uploadPostImage } from "@/lib/blob";

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export async function GET() {
  const session = await auth();
  if (!session?.agencyId) {
    return NextResponse.json({ error: "Giriş gerekli" }, { status: 401 });
  }
  const agency = await db.agency.findUnique({
    where: { id: session.agencyId },
    select: { name: true, email: true, logoUrl: true, brandColor: true },
  });
  return NextResponse.json({ agency });
}

// Markalama güncellemesi: renk (hex) ve/veya logo dosyası. Oturumdaki ajansın
// KENDİ kaydı güncellenir — id istekten alınmaz, IDOR mümkün değil.
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.agencyId) {
    return NextResponse.json({ error: "Giriş gerekli" }, { status: 401 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Geçersiz istek" }, { status: 400 });
  }

  const data: { brandColor?: string | null; logoUrl?: string } = {};

  const brandColor = formData.get("brandColor");
  if (typeof brandColor === "string" && brandColor !== "") {
    if (!HEX_COLOR_RE.test(brandColor)) {
      return NextResponse.json(
        { error: "Renk #rrggbb formatında olmalı", field: "brandColor" },
        { status: 400 }
      );
    }
    data.brandColor = brandColor.toLowerCase();
  }
  if (formData.get("clearBrandColor") === "1") {
    data.brandColor = null;
  }

  const logo = formData.get("logo");
  if (logo instanceof File && logo.size > 0) {
    try {
      data.logoUrl = await uploadPostImage(logo);
    } catch (error) {
      if (error instanceof InvalidImageError) {
        return NextResponse.json({ error: error.message, field: "logo" }, { status: 400 });
      }
      console.error("[agency] logo yükleme hatası:", error);
      return NextResponse.json(
        { error: "Logo yüklenemedi, tekrar deneyin", field: "logo" },
        { status: 400 }
      );
    }
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Güncellenecek alan yok" }, { status: 400 });
  }

  const agency = await db.agency.update({
    where: { id: session.agencyId },
    data,
    select: { name: true, logoUrl: true, brandColor: true },
  });
  return NextResponse.json({ agency });
}
