import { expect, test, type Page } from "@playwright/test";
import {
  ageVideo,
  loginCode,
  qstashMessages,
  readVideo,
  resetQStash,
  seedPortalClient,
  seedVideo,
} from "./portal-seed";

/**
 * Müşteri portalı — tarayıcıdan, kullanıcının gördüğü sayfadan veritabanındaki
 * sonuca kadar. Bileşen ve API testleri parçaları ayrı ayrı sınıyor; 2026-11-07
 * hatası (sunucu takılı caption'ı kurtarıyor, ekran düğmeyi gizliyordu) tam
 * parçaların birleştiği yerdeydi.
 *
 * Ajans senaryolarındaki NextAuth test girişi portal oturumunu sınamaz; portal
 * gerçek kod ekranından girilir.
 */

async function portalLogin(page: Page, user: { id: string; email: string }) {
  const code = await loginCode(user.id);
  await page.goto("/portal/giris");
  // "Kodum var": e-posta adımı yeni token üretip bu kodu gölgelerdi.
  await page.getByRole("button", { name: "Kodum var" }).click();
  await page.getByLabel("E-posta adresin").fill(user.email);
  await page.getByLabel("Giriş kodu").fill(code);
  await page.getByRole("button", { name: "Giriş yap" }).click();
  await page.waitForURL((url) => url.pathname === "/portal");
}

test("portal: kodla giriş → kuyruk → video detayı → caption düzenleme; onay adımı yok (K33)", async ({
  page,
}) => {
  const { agencyId, clientId, user } = await seedPortalClient();
  const video = await seedVideo(agencyId, clientId, { caption: "E2E portal caption 🎬" });
  // Başka bir müşterinin videosu: bu oturum onu ne kuyrukta görmeli ne açabilmeli.
  const other = await seedPortalClient();
  const foreign = await seedVideo(other.agencyId, other.clientId, { caption: "Yabancı müşteri videosu" });

  await portalLogin(page, user);

  await expect(page.getByText("E2E portal caption 🎬")).toBeVisible();
  await expect(page.getByText("Yabancı müşteri videosu")).toHaveCount(0);

  await page.getByText("E2E portal caption 🎬").click();
  await page.waitForURL(`**/portal/video/${video.id}`);
  await expect(page.getByRole("textbox", { name: /caption/i })).toHaveValue("E2E portal caption 🎬");

  // K33: portalda onay/red yok — video sırası gelince tick'in otomatik onayıyla yayınlanır.
  await expect(page.getByRole("button", { name: "Onayla" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reddet" })).toHaveCount(0);
  await expect(page.getByText("Onay bekliyor")).toHaveCount(0);

  // Müşterinin yayından önceki tek müdahalesi caption: düzenlenir, DB'ye yazılır,
  // durum değişmez.
  await page.getByRole("textbox", { name: /caption/i }).fill("Düzeltilmiş caption");
  await page.getByRole("button", { name: "Caption'ı kaydet" }).click();
  await expect(page.getByRole("status").getByText("Caption kaydedildi")).toBeVisible();
  const saved = await readVideo(video.id);
  expect(saved.caption).toBe("Düzeltilmiş caption");
  expect(saved.status).toBe("pending");

  // Yenilemeden sonra da onay düğmesi ya da rozeti yok.
  await page.reload();
  await expect(page.getByRole("textbox", { name: /caption/i })).toHaveValue("Düzeltilmiş caption");
  await expect(page.getByRole("button", { name: "Onayla" })).toHaveCount(0);

  // Kapsam: yabancı videonun adresi bu oturumda yok sayılır. HTTP kodu 200
  // gelir — `portal/loading.tsx` akışı başlattığı için `notFound()` yanıt
  // başlığına değil gövdeye yazılıyor; bu yüzden çizilen sayfaya bakılır.
  await page.goto(`/portal/video/${foreign.id}`);
  await expect(page.getByText("This page could not be found.")).toBeVisible();
  await expect(page.getByText("Yabancı müşteri videosu")).toHaveCount(0);
  expect((await readVideo(foreign.id)).status).toBe("pending");
});

test("portal: takılı caption (10 dk+ pending) detaydan yeniden üretilir ve iş kuyruğa girer", async ({
  page,
}) => {
  const { agencyId, clientId, user } = await seedPortalClient();
  const video = await seedVideo(agencyId, clientId, { captionStatus: "pending", caption: "" });
  // Yüklemedeki QStash çağrısı düşmüş gibi: on dakikayı beklemek yerine kayıt yaşlandırılır.
  await ageVideo(video.id, 11);
  await resetQStash();

  await portalLogin(page, user);
  await page.goto(`/portal/video/${video.id}`);

  await expect(page.getByText(/beklenenden uzun sürdü/)).toBeVisible();
  await page.getByRole("button", { name: "Yeniden üret" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Yeniden üretme onayı" });
  await expect(dialog).toContainText("yeniden başlatılacak");
  await dialog.getByRole("button", { name: "Evet, yeniden üret" }).click();
  // `next dev` regenerate route'unu bu ilk istekte derliyor (Windows'ta 5 sn'yi aşıyor);
  // varsayılan 5 sn'lik bekleme derlemeyi hata sanıyordu.
  await expect(page.getByText("Yeni caption hazırlanıyor")).toBeVisible({ timeout: 30_000 });

  // HTTP 200 yetmez (`captionQueued: false` da 200): mesaj gerçekten çıkmış olmalı.
  await expect
    .poll(async () => (await qstashMessages()).map((m) => m.destination))
    .toContain(`http://localhost:3111/api/queue/caption/${video.id}`);
  const row = await readVideo(video.id);
  expect(row.captionStatus).toBe("pending");
  expect(Date.now() - row.updatedAt.getTime()).toBeLessThan(60_000);

  // Artık taze pending: iş yolda, ikinci iş açılmasın — düğme yeniden gizli.
  await page.reload();
  await expect(page.getByText(/Caption hazırlanıyor — konuşma yazıya dökülüyor/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Yeniden üret" })).toHaveCount(0);
});
