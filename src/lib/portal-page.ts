import { redirect } from "next/navigation";
import { getClientSession, type ClientSession } from "@/lib/client-auth";

/**
 * Portal sayfalarının oturum kapısı. Ajans panelinin `/api/auth/signin`
 * yönlendirmesinin portal eşi: müşteri NextAuth'u hiç görmez.
 */
export async function requirePortalSession(): Promise<ClientSession> {
  const session = await getClientSession();
  if (!session) redirect("/portal/giris");
  return session;
}
