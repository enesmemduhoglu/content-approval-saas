import NextAuth, { type NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { db } from "@/lib/db";

const providers: NextAuthConfig["providers"] = [];

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  providers.push(
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    })
  );
}

// Yalnızca test/geliştirme ortamında aktif olan Credentials provider'ı (TENSION 2):
// E2E testleri gerçek Google OAuth'a gitmeden geçerli bir NextAuth session üretir.
// Production'da ENABLE_TEST_AUTH set edilmediği sürece bu provider var olmaz.
const testAuthEnabled =
  process.env.ENABLE_TEST_AUTH === "1" || process.env.NODE_ENV === "test";

if (testAuthEnabled) {
  providers.push(
    Credentials({
      id: "test-login",
      name: "Test Girişi (yalnızca test ortamı)",
      credentials: {
        email: { label: "E-posta", type: "email" },
        name: { label: "Ajans adı", type: "text" },
      },
      async authorize(credentials) {
        const email = typeof credentials?.email === "string" ? credentials.email : "";
        if (!email) return null;
        const name =
          typeof credentials?.name === "string" && credentials.name
            ? credentials.name
            : "Test Ajansı";
        return { id: `test:${email}`, email, name };
      },
    })
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  session: { strategy: "jwt" },
  trustHost: true,
  callbacks: {
    async jwt({ token, user, account }) {
      if (user?.email) {
        const googleId =
          account?.provider === "google"
            ? account.providerAccountId
            : `test:${user.email}`;
        const agency = await db.agency.upsert({
          where: { googleId },
          update: { email: user.email, name: user.name ?? undefined },
          create: { googleId, email: user.email, name: user.name ?? null },
        });
        token.agencyId = agency.id;
        token.agencyName = agency.name;
      }
      return token;
    },
    async session({ session, token }) {
      if (typeof token.agencyId === "string") session.agencyId = token.agencyId;
      if (typeof token.agencyName === "string") session.agencyName = token.agencyName;
      return session;
    },
  },
});
