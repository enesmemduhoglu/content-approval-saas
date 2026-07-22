import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getScopedDb } from "@/lib/scoped-db";
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

  const client = await getScopedDb(session).clients.create({
    name: (name as string).trim(),
    email: (email as string).trim(),
  });
  return NextResponse.json({ client }, { status: 201 });
}
