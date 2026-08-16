import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getScopedDb } from "@/lib/scoped-db";
import { AppNav } from "@/components/nav";
import { ClientForm } from "@/components/client-form";
import { InstagramForm } from "@/components/instagram-form";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const session = await auth();
  if (!session?.agencyId) redirect("/api/auth/signin");

  const clients = await getScopedDb(session).clients.findMany({
    orderBy: { createdAt: "desc" },
  });

  return (
    <>
      <AppNav agencyName={session.agencyName ?? "Ajans"} />
      <main className="container">
        <div className="page-head">
          <h1>Müşteriler</h1>
          <ClientForm />
        </div>
        {clients.length === 0 ? (
          <p className="empty-state">
            Henüz müşteri eklemedin. Post oluşturmadan önce bir müşteri ekle.
          </p>
        ) : (
          <ul className="client-list">
            {clients.map((client) => (
              <li key={client.id} className="client-row">
                <div className="post-info">
                  <strong>{client.name}</strong>
                  <p className="post-caption">{client.email}</p>
                  {/* `clients.findMany` ClientView döner — token prop olarak geçmez. */}
                  <InstagramForm
                    clientId={client.id}
                    clientName={client.name}
                    connected={client.instagramConnected}
                    instagramUserId={client.instagramUserId}
                    tokenHint={client.instagramTokenHint}
                    tokenExpiry={client.instagramTokenExpiry?.toISOString() ?? null}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
