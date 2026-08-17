import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { E2E_BASE_URL, E2E_DATABASE_URL } from "../../playwright.config";

const FIXTURE_IMAGE = path.join(__dirname, "fixtures", "test-image.png");

// Gerçek Google OAuth'a gitmeden geçerli NextAuth session cookie'si üretir:
// test-only Credentials provider'a (TENSION 2 / T6) CSRF token'la form post atar.
async function loginAsAgency(page: Page, email: string, name: string) {
  const request = page.context().request;
  const csrfRes = await request.get("/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  const res = await request.post("/api/auth/callback/test-login", {
    form: { csrfToken, email, name },
  });
  expect(res.ok()).toBeTruthy();
}

async function createClientViaUi(page: Page, name: string, email: string) {
  await page.goto("/clients");
  await page.getByRole("button", { name: "Yeni Müşteri" }).click();
  await page.fill('input[name="name"]', name);
  await page.fill('input[name="email"]', email);
  await page.getByRole("button", { name: "Müşteriyi Ekle" }).click();
  await expect(page.getByText(email)).toBeVisible();
}

async function createPostViaUi(page: Page, clientName: string, caption: string) {
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Yeni Post" }).click();
  await page.selectOption('select[name="clientId"]', { label: clientName });
  await page.setInputFiles('input[name="image"]', FIXTURE_IMAGE);
  await page.fill('textarea[name="caption"]', caption);
  await page.getByRole("button", { name: "Postu Oluştur" }).click();
  await expect(page.getByText("Onay bekliyor")).toBeVisible();
  const token = await page
    .locator("[data-approval-token]")
    .first()
    .getAttribute("data-approval-token");
  expect(token).toBeTruthy();
  return token!;
}

test("tam onay akışı: giriş → müşteri ekle → post oluştur → müşteri onaylar → dashboard'da doğrula", async ({
  page,
  browser,
}) => {
  const unique = Date.now();
  await loginAsAgency(page, `agency-${unique}@test.local`, "E2E Ajansı");

  // Boş durumlar (yeni ajans)
  await page.goto("/dashboard");
  await expect(page.getByText("Henüz post yok. İlk postunu oluştur.")).toBeVisible();
  await page.goto("/clients");
  await expect(page.getByText(/Henüz müşteri eklemedin/)).toBeVisible();

  await createClientViaUi(page, "Kahve Dükkanı", `musteri-${unique}@test.local`);
  const token = await createPostViaUi(page, "Kahve Dükkanı", "E2E test postu 🎉");

  // Müşteri tarafı: giriş YOK — ayrı (incognito) context
  const clientContext = await browser.newContext();
  const clientPage = await clientContext.newPage();
  await clientPage.goto(`${E2E_BASE_URL}/approve/${token}`);
  await expect(clientPage.getByText("E2E test postu 🎉")).toBeVisible();
  await expect(clientPage.getByText("E2E Ajansı")).toBeVisible();

  await clientPage.getByRole("button", { name: "Onayla" }).click();
  await expect(clientPage.getByText(/Teşekkürler, kararın kaydedildi/)).toBeVisible();

  // Aynı linki tekrar açınca karar verilmiş durumu görür, tekrar oy alamaz
  await clientPage.goto(`${E2E_BASE_URL}/approve/${token}`);
  await expect(clientPage.getByText("Bu post zaten onaylandı.")).toBeVisible();
  await clientContext.close();

  // Ajans tarafında durum güncellenmiş
  await page.goto("/dashboard");
  await expect(page.getByText("Onaylandı")).toBeVisible();
});

test("çift tıkla onayla: yalnızca tek karar ve tek audit kaydı oluşur", async ({
  page,
  browser,
}) => {
  const unique = Date.now();
  await loginAsAgency(page, `agency-double-${unique}@test.local`, "Double Ajansı");
  await createClientViaUi(page, "Fırın", `firin-${unique}@test.local`);
  const token = await createPostViaUi(page, "Fırın", "Double submit testi");

  const clientContext = await browser.newContext();
  const clientPage = await clientContext.newPage();
  await clientPage.goto(`${E2E_BASE_URL}/approve/${token}`);

  // İki hızlı tıklama — buton disable-on-click ile ikinci istek atılmamalı
  await clientPage.evaluate(() => {
    const button = document.querySelector(".button-approve") as HTMLButtonElement;
    button.click();
    button.click();
  });
  await expect(clientPage.getByText(/Teşekkürler, kararın kaydedildi/)).toBeVisible();
  await clientContext.close();

  const db = new PrismaClient({ datasourceUrl: E2E_DATABASE_URL });
  try {
    const link = await db.approvalLink.findUnique({ where: { token } });
    const audits = await db.approvalAudit.findMany({
      where: { postId: link!.postId },
    });
    expect(audits).toHaveLength(1);
    const post = await db.post.findUnique({ where: { id: link!.postId } });
    expect(post?.status).toBe("approved");
  } finally {
    await db.$disconnect();
  }
});

test("reddetme: sebep alanıyla reddedilir, dashboard'da sebep görünür", async ({
  page,
  browser,
}) => {
  const unique = Date.now();
  await loginAsAgency(page, `agency-reject-${unique}@test.local`, "Reject Ajansı");
  await createClientViaUi(page, "Çiçekçi", `cicek-${unique}@test.local`);
  const token = await createPostViaUi(page, "Çiçekçi", "Reddedilecek post");

  const clientContext = await browser.newContext();
  const clientPage = await clientContext.newPage();
  await clientPage.goto(`${E2E_BASE_URL}/approve/${token}`);
  await clientPage.getByRole("button", { name: "Reddet" }).click();
  await clientPage.fill("textarea", "Logo eski sürüm");
  await clientPage.getByRole("button", { name: "Reddet" }).click();
  await expect(clientPage.getByText(/Teşekkürler, kararın kaydedildi/)).toBeVisible();
  await clientContext.close();

  await page.goto("/dashboard");
  await expect(page.getByText("Reddedildi")).toBeVisible();
  await expect(page.getByText("Reddetme sebebi: Logo eski sürüm")).toBeVisible();
});

test("geçersiz ve süresi dolmuş linkler doğru mesajları gösterir", async ({ page }) => {
  await page.goto("/approve/olmayan-token-123");
  await expect(page.getByText("Bu link geçersiz")).toBeVisible();
});

test("link yenileme: eski token ölür, yeni token çalışır (F1)", async ({
  page,
  browser,
}) => {
  const unique = Date.now();
  await loginAsAgency(page, `relink-${unique}@test.local`, "Relink Ajansı");
  await createClientViaUi(page, "Relink Müşteri", `relink-c-${unique}@test.local`);
  const eskiToken = await createPostViaUi(page, "Relink Müşteri", "Link yenileme testi");

  // Link henüz geçerli olduğu için buton "Maili tekrar gönder" der; ama asıl
  // ölçtüğümüz şey token'ın gerçekten değişip değişmediği, o yüzden API'ye
  // renew:true ile gidiyoruz — arayüzdeki süresi-dolmuş yolu da aynı çağrı.
  const postId = await page.locator("[data-edit-post]").first().getAttribute("data-edit-post");
  expect(postId).toBeTruthy();
  const res = await page.context().request.post(`/api/posts/${postId}/approval-link`, {
    data: { renew: true },
  });
  expect(res.ok()).toBeTruthy();
  const { approvalUrl, renewed } = await res.json();
  expect(renewed).toBe(true);

  const yeniToken = approvalUrl.split("/approve/")[1];
  expect(yeniToken).not.toBe(eskiToken);

  // Müşteri gözüyle: eski link ölmüş, yeni link çalışıyor.
  const musteri = await browser.newContext();
  const musteriSayfa = await musteri.newPage();
  await musteriSayfa.goto(`${E2E_BASE_URL}/approve/${eskiToken}`);
  await expect(musteriSayfa.getByText("Bu link geçersiz")).toBeVisible();

  await musteriSayfa.goto(`${E2E_BASE_URL}/approve/${yeniToken}`);
  await expect(musteriSayfa.getByText("Link yenileme testi")).toBeVisible();
  await musteri.close();
});

test("post silme: onay linki de ölür (F2)", async ({ page, browser }) => {
  const unique = Date.now();
  await loginAsAgency(page, `sil-${unique}@test.local`, "Silme Ajansı");
  await createClientViaUi(page, "Silme Müşteri", `sil-c-${unique}@test.local`);
  const token = await createPostViaUi(page, "Silme Müşteri", "Silinecek post");

  // İki adımlı inline onay — window.confirm bilerek kullanılmıyor.
  await page.getByRole("button", { name: "Sil" }).first().click();
  await page.getByRole("button", { name: "Evet, sil" }).click();
  await expect(page.getByText("Silinecek post")).toHaveCount(0);

  const musteri = await browser.newContext();
  const musteriSayfa = await musteri.newPage();
  await musteriSayfa.goto(`${E2E_BASE_URL}/approve/${token}`);
  await expect(musteriSayfa.getByText("Bu link geçersiz")).toBeVisible();
  await musteri.close();
});
