import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getScopedDb } from "@/lib/scoped-db";
import { maxClientsPerAgency } from "@/lib/quota";
import { validateClientEmail, validateClientName } from "@/lib/validation";

export async function GET() {
  const session = await auth();
  if (!session?.agencyId) {
    return NextResponse.json({ error: "Giriş gerekli" }, { status: 401 });
  }
  const clients = await getScopedDb(session).clients.findMany({
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ clients });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.agencyId) {
    return NextResponse.json({ error: "Giriş gerekli" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Geçersiz istek" }, { status: 400 });
  }

  const { name, email } = (body ?? {}) as { name?: unknown; email?: unknown };

  const nameError = validateClientName(name);
  if (nameError) {
    return NextResponse.json({ error: nameError, field: "name" }, { status: 400 });
  }
  const emailError = validateClientEmail(email);
  if (emailError) {
    return NextResponse.json({ error: emailError, field: "email" }, { status: 400 });
  }

  const scoped = getScopedDb(session);

  // Kota (F7): 429 DEĞİL 403 — bu bir rate limit değil, kaba bir kötüye
  // kullanım tavanı. Sayıp-sonra-yazmak yarışa açık: iki eşzamanlı istek
  // aynı sayımı okuyup ikisi de geçebilir, tavan bir-iki kayıt aşılabilir.
  // Kabul edilebilir — burada mükemmel atomiklik istemiyoruz, amaç kötüye
  // kullanımı DURDURMAK, tek kaydı bile geçirmemek değil. Onay/red gibi
  // parayla/veriyle ilgili kritik yarışlarda (`updateCaption` vb.) koşullu
  // UPDATE kullanılıyor; burada gerek yok.
  const maxClients = maxClientsPerAgency();
  const clientCount = await scoped.clients.count();
  if (clientCount >= maxClients) {
    return NextResponse.json(
      {
        error: `Müşteri tavanına ulaşıldı (${maxClients}). Kullanılmayan müşterileri silin ya da tavanı yükseltmek için bizimle iletişime geçin.`,
      },
      { status: 403 }
    );
  }

  const client = await scoped.clients.create({
    name: (name as string).trim(),
    email: (email as string).trim(),
  });
  return NextResponse.json({ client }, { status: 201 });
}
