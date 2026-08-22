import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * F12 — uptime/canary izlemesi için sağlık uç noktası.
 *
 * ─── Neden DB'ye bakıyor ────────────────────────────────────────────────────
 * "Sunucu ayakta" ile "uygulama çalışıyor" aynı şey değil — Next.js süreci
 * yanıt verirken DB bağlantısı kopmuş/havuzu tükenmiş olabilir, ki bu durumda
 * onay akışının tamamı zaten durur. Sağlık kontrolünün asıl değeri tam
 * burada: en ucuz sorguyla (`SELECT 1`, tablo okumaz, index kullanmaz) bu
 * bağlantıyı gerçekten test etmek. Bundan daha ağır bir kontrol (örn. bir
 * tabloyu saymak) hem gereksiz yük hem de "kaç kayıt var" gibi envanter
 * bilgisini yanıt yoluna sızdırma riski taşır — o yüzden bilerek bu kadar sığ.
 *
 * ─── Neden sır SIZDIRMIYOR ──────────────────────────────────────────────────
 * Bu uç nokta KİMLİK DOĞRULAMASIZ ve public — herhangi bir uptime izleyici
 * (ya da internetteki herkes) çağırabilir. Bu yüzden yanıt gövdesi BİLEREK
 * en aza indirildi: sürüm yok, müşteri/post sayısı yok, env değişkeni adı
 * yok, ham hata mesajı yok. DB sorgusu patlarsa bile `error` alanına asla
 * `error.message` konmaz — yalnızca "unhealthy" gibi sabit bir metin. Ayrıntı
 * yalnızca `console.error` ile sunucu loguna gider (buraya bakabilen zaten
 * yetkili).
 *
 * ─── Durum kodları ──────────────────────────────────────────────────────────
 * Sağlıklıyken 200, sağlıksızken 503 — uptime izleyicileri (Vercel, UptimeRobot
 * vb.) genelde 2xx dışını "down" sayar; 503 "geçici olarak hizmet veremiyor"
 * anlamına geldiğinden burada en doğru kod.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Tabloya değil, bağlantının kendisine bakılıyor — en ucuz canlılık testi.
    await db.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok" }, { status: 200 });
  } catch (error) {
    // Ayrıntı yalnızca sunucu logunda kalır; public yanıt hiçbir iz taşımaz.
    console.error("[health] DB erişilemedi:", error);
    return NextResponse.json({ status: "error" }, { status: 503 });
  }
}
