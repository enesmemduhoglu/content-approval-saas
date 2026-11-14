/**
 * Kuyruk dışındaki videoyu kuyruğa geri alma çağrıları (detay ve "Kuyruk dışı"
 * listesi ortak). İki yol var çünkü sunucuda iki ayrı koşullu UPDATE var:
 * çıkarılan video `to-end` ile sona alınır, K33 öncesinde REDDEDİLMİŞ video
 * `restore` ile — `to-end` reddedileni bilerek kabul etmiyor.
 */

type Result = { ok: true } | { ok: false; error: string };

async function post(path: string): Promise<Result> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (res.ok) return { ok: true };
    const data = await res.json().catch(() => ({}));
    return { ok: false, error: data.error ?? "Video kuyruğa alınamadı, tekrar dene" };
  } catch {
    return { ok: false, error: "Bağlantı hatası, tekrar dene" };
  }
}

/** K33 öncesinde reddedilmiş videoyu kuyruğun sonuna geri alır. */
export function restoreVideo(id: string): Promise<Result> {
  return post(`/api/portal/videos/${id}/restore`);
}

/** Kuyruktan çıkarılmış videoyu sona alır — mevcut "Sona at" yolu. */
export function requeueVideo(id: string): Promise<Result> {
  return post(`/api/portal/videos/${id}/to-end`);
}
