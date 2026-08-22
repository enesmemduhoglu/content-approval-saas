import NextAuth, { type NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { findMembership, resolveMembershipOnSignIn } from "@/lib/membership";

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

/**
 * F6 — üyelik tazeleme aralığı.
 *
 * ─── ÇÖZÜLEN SORUN: JWT BAYATLIĞI ──────────────────────────────────────────
 * Oturum JWT stratejisiyle çalışıyor ve `agencyId` token'ın İÇİNDE taşınıyor.
 * Bir üye ekipten çıkarıldığında elindeki token hiçbir şeyden haberdar olmaz:
 * imzası geçerli, içindeki `agencyId` yerli yerinde. Hiçbir şey yapmasaydık
 * çıkarılan kişi token'ın ömrü boyunca (NextAuth varsayılanı 30 GÜN) ajansın
 * bütün müşteri ve postlarına erişmeye devam ederdi — "çıkardım" tıklaması
 * neredeyse anlamsız olurdu.
 *
 * Çözüm: jwt callback JWT stratejisinde her oturum okumasında çalışıyor; bunu
 * kullanıp üyeliği periyodik olarak DB'den yeniden doğruluyoruz. Üyelik
 * gitmişse `agencyId` token'dan SİLİNİYOR, `session.agencyId` undefined
 * kalıyor ve bütün route'lar/sayfalar zaten sahip oldukları
 * `if (!session?.agencyId)` kontrolüyle 401 veriyor / girişe yönlendiriyor.
 *
 * ─── Neden HER İSTEKTE değil ───────────────────────────────────────────────
 * Her istekte doğrulamak, her sayfa görüntülemesine bir DB gidiş-dönüşü ekler
 * — token'ın var oluş sebebini (durumsuz oturum) ortadan kaldırır. 5 dakika,
 * ödenen bedel (kullanıcı başına 5 dakikada bir indeksli tek sorgu) ile
 * kalan pencere arasındaki dengeyi kuruyor.
 *
 * ─── KALAN SINIR (dürüstçe) ────────────────────────────────────────────────
 * Erişim ANINDA kesilmiyor: çıkarılan üyenin erişimi en fazla 5 dakika daha
 * sürebilir. Anlık kesme, JWT yerine DB oturumu (ya da her istekte doğrulama)
 * ister. Acil bir durumda kesin çözüm `AUTH_SECRET`i döndürmek — tüm
 * token'lar aynı anda geçersizleşir, herkes yeniden giriş yapar.
 */
export const MEMBERSHIP_REVALIDATE_MS = 5 * 60 * 1000;

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  session: { strategy: "jwt" },
  trustHost: true,
  callbacks: {
    async jwt({ token, user, account }) {
      if (user?.email) {
        // GİRİŞ. `test:` öneki korunuyor: test girişiyle üretilen kimlik
        // gerçek bir Google `providerAccountId` ile ASLA çakışmasın diye
        // (bkz. yukarıdaki provider yorumu). Artık `Agency.googleId` değil
        // `AgencyMember.googleId` bu değeri taşıyor — önek aynı işi görüyor.
        const googleId =
          account?.provider === "google"
            ? account.providerAccountId
            : `test:${user.email}`;
        const membership = await resolveMembershipOnSignIn({
          googleId,
          email: user.email,
          name: user.name,
        });
        token.googleId = googleId;
        token.agencyId = membership.agencyId;
        token.agencyName = membership.agencyName;
        token.agencyRole = membership.role;
        token.membershipCheckedAt = Date.now();
        return token;
      }

      // TAZELEME. `googleId` yoksa token F6 öncesinden kalmış demektir:
      // doğrulayamayız, ama iptal de edemeyiz (o token bugün meşru bir
      // kullanıcıya ait). Olduğu gibi bırakılır; kullanıcı bir sonraki
      // girişinde yeni alanları kazanır.
      if (typeof token.googleId !== "string") return token;

      const checkedAt =
        typeof token.membershipCheckedAt === "number" ? token.membershipCheckedAt : 0;
      if (Date.now() - checkedAt < MEMBERSHIP_REVALIDATE_MS) return token;

      const membership = await findMembership(token.googleId);
      if (!membership) {
        // Üyelik gitmiş (ekipten çıkarıldı ya da ajans silindi). Erişimi kes.
        token.agencyId = undefined;
        token.agencyName = undefined;
        token.agencyRole = undefined;
      } else {
        token.agencyId = membership.agencyId;
        token.agencyName = membership.agencyName;
        token.agencyRole = membership.role;
      }
      token.membershipCheckedAt = Date.now();
      return token;
    },
    async session({ session, token }) {
      if (typeof token.agencyId === "string") session.agencyId = token.agencyId;
      if (typeof token.agencyName === "string") session.agencyName = token.agencyName;
      if (token.agencyRole === "owner" || token.agencyRole === "member") {
        session.agencyRole = token.agencyRole;
      }
      return session;
    },
  },
});
