import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

export default async function HomePage() {
  const session = await auth();
  if (session?.agencyId) redirect("/dashboard");

  return (
    <main className="landing">
      <h1>İçerik Onay</h1>
      <p>
        Müşterilerin için hazırladığın sosyal medya postlarını tek tıkla onaya gönder.
        Müşterin giriş yapmadan, telefonundan onaylar veya reddeder.
      </p>
      <a className="button-primary" href="/api/auth/signin">
        Giriş yap
      </a>
    </main>
  );
}
