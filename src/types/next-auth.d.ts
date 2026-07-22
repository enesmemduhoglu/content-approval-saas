import "next-auth";

declare module "next-auth" {
  interface Session {
    agencyId: string;
    agencyName?: string | null;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    agencyId?: string;
    agencyName?: string | null;
  }
}
