import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

/**
 * Kök adres portala açılır; ajans paneli `/dashboard`'dan.
 *
 * Neden: uygulama 2026-11-15'te `portal.enesmemduhoglu.tech`'e taşındı ve
 * müşteriye verilen adres bu kök. Eskiden kök, ajans panelinin "Giriş yap"
 * (Google) ekranıydı: adresi açan müşteri oraya düştü, Google'la girdi ve
 * her ilk Google girişi ajans kurduğu için kendine boş, yeni bir AJANS açtı.
 * Müşterinin işi portal; ajans girişi kökte durmamalı.
 *
 * Ajans oturumu varsa panele gidilir (yer imi kök olan ajans kullanıcısı
 * için). Oturumsuz ajans kullanıcısı `/dashboard`'ı açar; o sayfa zaten
 * Google girişine yönlendiriyor. Portal da kendi oturumu yoksa
 * `/portal/giris`'e yollar.
 */
export default async function HomePage() {
  const session = await auth();
  if (session?.agencyId) redirect("/dashboard");
  redirect("/portal");
}
