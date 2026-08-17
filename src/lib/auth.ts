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
//
// GÜVENLİK: production'da bu provider'ın var olmaması bir ortam değişkeninin
// doğru ayarlanmasına BIRAKILMAZ. `ENABLE_TEST_AUTH=1` Vercel'e yanlışlıkla
// girilirse /api/auth/signin üzerinden HERKES istediği e-postayla giriş yapıp
// ajans yaratabilirdi (mevcut ajanslar ele geçirilemez — test girişi googleId'yi
// `test:` önekiyle üretir, Google'ınkiyle çakışmaz — ama bedava hesap, prod
// verisi arasına yabancı ajans ve kota tüketimi demekti).
//
// Bu yüzden `NODE_ENV === "production"` mutlak bir kapıdır: env ne derse desin
// provider hiç eklenmez. Vercel hem preview hem production build'lerinde
// NODE_ENV'i "production" yapar, yani internete açık HİÇBİR deployment'ta test
// girişi bulunmaz. E2E akışı etkilenmez: Playwright `next dev` ile koşuyor
// (NODE_ENV="development"), vitest ise "test".
const isProduction = process.env.NODE_ENV === "production";
const testAuthEnabled =
  !isProduction &&
  (process.env.ENABLE_TEST_AUTH === "1" || process.env.NODE_ENV === "test");

if (isProduction && process.env.ENABLE_TEST_AUTH === "1") {
  // Sessizce yok saymak, yanlış yapılandırmayı görünmez kılardı: ajans test
  // girişinin çalıştığını sanıp beklerdi. Yüksek sesle söyle, ama AÇMA.
  console.error(
    "[auth] ENABLE_TEST_AUTH production'da set edilmiş — test girişi provider'ı " +
      "BİLEREK eklenmedi. Bu değişkeni production ortamından kaldır."
  );
}

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
