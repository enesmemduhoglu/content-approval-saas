import Link from "next/link";
import { signOut } from "@/lib/auth";

export function AppNav({ agencyName }: { agencyName: string }) {
  return (
    <header className="app-nav">
      <span className="app-nav-agency">{agencyName}</span>
      <nav>
        <Link href="/dashboard">Dashboard</Link>
        <Link href="/clients">Müşteriler</Link>
      </nav>
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/" });
        }}
      >
        <button type="submit" className="link-button">
          Çıkış
        </button>
      </form>
    </header>
  );
}
