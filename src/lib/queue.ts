import type { CaptionStatus, PostStatus, PublishStatus } from "@prisma/client";

/**
 * Video kuyruğu (V4) — kuyruk ve slot kuralları. SAF: ne DB'ye ne ağa dokunur.
 *
 * `reminders.ts` / `instagram-token.ts` ile aynı desen: karar burada, tick
 * (`api/queue/tick`) yalnızca kararı uygular. Böylece saat dilimi, gün dönümü,
 * DST ve onay modu gibi kenar durumların hepsi tek dosyada, DB'siz testte
 * toplanır (bkz. docs/video-kuyrugu/README.md §5).
 */

// ─── Tipler ────────────────────────────────────────────────────────────────

/** `PublishSettings`in kuralların ihtiyaç duyduğu dilimi. */
export type QueueSettings = {
  /** "HH:MM" (24 saat), `timezone`a göre yerel saat. */
  slots: string[];
  /** IANA adı ("Europe/Istanbul"). Sabit ofset VARSAYILMAZ — DST'li bölgeler de çalışmalı. */
  timezone: string;
  /**
   * V8 (K28) — yayın günleri, ISO hafta günü (1 = Pazartesi … 7 = Pazar),
   * `timezone`a göre YEREL gün. `slots` yalnızca bu günlerde üretilir. Eksik
   * ya da boşsa TÜM günler: V8 öncesi çağıranlar (ve en az bir günü zorunlu
   * tutan doğrulamayı atlayan elle bozulmuş bir satır) "hiç yayın yok"a
   * düşmesin — hiç yayın istemeyenin yolu `paused`.
   */
  days?: number[] | null;
  requireApproval: boolean;
  paused: boolean;
  /**
   * Ayarın kurulduğu an. Verilirse bundan önceki slotlar hiç üretilmez: yeni
   * ayarlanan bir müşteride "dünün kaçırılmış slotları" diye hayali `skipped`
   * satırları yazılmasın.
   */
  createdAt?: Date | null;
};

/** `pickNext`/`projectSchedule`in baktığı post alanları. */
export type QueueItem = {
  id: string;
  queuePosition: number | null;
  captionStatus: CaptionStatus | null;
  status: PostStatus;
  publishStatus: PublishStatus;
};

// ─── Saat dilimi ───────────────────────────────────────────────────────────

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const SLOT_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "19:00" → { hour: 19, minute: 0 }; geçersizse null. */
export function parseSlot(slot: string): { hour: number; minute: number } | null {
  const match = SLOT_RE.exec(slot.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    // `hourCycle: "h23"`: bazı ortamlar gece yarısını "24" diye basıyor;
    // o durumda gün bir ileri kayardı.
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number };

/** Bir anın `timeZone`daki duvar saati. */
export function localParts(instant: Date, timeZone: string): LocalParts {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
  };
}

/** `instant` anında `timeZone`un UTC'ye göre ofseti (ms; İstanbul için +3 saat). */
function offsetAt(instant: number, timeZone: string): number {
  const p = localParts(new Date(instant), timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  // Saniyeleri at: ofsetler dakika hassasiyetinde, `instant` saniye taşıyabilir.
  return wall - Math.floor(instant / MINUTE_MS) * MINUTE_MS;
}

/**
 * Yerel tarih + saat → UTC anı.
 *
 * Neden sabit ofset değil: İstanbul 2016'dan beri DST uygulamıyor ama yapı
 * çok müşterili (K6) — Berlin'deki bir sayfa için "+03:00" varsayımı yılda iki
 * kez bir saat kayar. Ofset `Intl`den, o güne özel okunur.
 *
 * DST kenarları:
 *  - **İleri alma (boşluk):** 02:30 o gün yoktur. Geçişten önceki ofsetle
 *    çevrilir, yani yayın 03:30'da yapılır — atlanmaz, bir saat sonra olur.
 *  - **Geri alma (çift):** 02:30 iki kez yaşanır. İLKİ seçilir; slot günde
 *    bir kez işlenir (`SlotRun` UNIQUE zaten ikinciyi engellerdi).
 *
 * İki aday ofset `wall ± 12 saat`ten okunur: DST geçişleri aylar arayla olur,
 * yani bu iki nokta geçişin iki yakasını garanti yakalar.
 */
export function zonedTimeToUtc(
  local: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string
): Date {
  const wall = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const before = offsetAt(wall - 12 * HOUR_MS, timeZone);
  const after = offsetAt(wall + 12 * HOUR_MS, timeZone);

  const valid = [...new Set([before, after])]
    .map((offset) => wall - offset)
    .filter((candidate) => wall - offsetAt(candidate, timeZone) === candidate);
  if (valid.length > 0) return new Date(Math.min(...valid));

  // Boşluk: hiçbir aday o duvar saatine geri dönmüyor. Geçiş öncesi ofset
  // (ileri almada küçük olanı) yayını boşluğun hemen sonrasına koyar.
  return new Date(wall - Math.min(before, after));
}

/** Takvim günü aritmetiği — UTC üzerinden, saat dilimi içermez. */
function addDays(date: { year: number; month: number; day: number }, days: number) {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Geçerli, tekil ve sıralı slotlar — ayar elle bozulsa bile tick patlamasın. */
function normalizedSlots(slots: string[]): { hour: number; minute: number }[] {
  const seen = new Set<string>();
  const out: { hour: number; minute: number }[] = [];
  for (const slot of slots) {
    const parsed = parseSlot(slot);
    if (!parsed) continue;
    const key = `${parsed.hour}:${parsed.minute}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }
  return out.sort((a, b) => a.hour - b.hour || a.minute - b.minute);
}

/** ISO hafta günleri, 1 = Pazartesi … 7 = Pazar. */
export const ALL_DAYS: readonly number[] = [1, 2, 3, 4, 5, 6, 7];

/**
 * Geçerli yayın günleri kümesi. Geçersiz değerler atılır; geriye bir şey
 * kalmazsa tüm günler (bkz. `QueueSettings.days`).
 */
function normalizedDays(days: number[] | null | undefined): Set<number> {
  const valid = (days ?? []).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  return new Set(valid.length > 0 ? valid : ALL_DAYS);
}

/**
 * Yerel TAKVİM tarihinin ISO hafta günü (1 = Pazartesi … 7 = Pazar).
 *
 * Tarih zaten müşterinin yerel takvimi (`localParts`/`Intl`'den geliyor),
 * yani burada saat dilimi yok: tarih UTC gece yarısına oturtulup gün
 * okunuyor. Anın kendisinden (`Date.getDay()`) okunsaydı sunucunun saat
 * dilimi (Vercel'de UTC) karışırdı — İstanbul'da Pazartesi 01:00, UTC'de
 * hâlâ Pazar.
 */
export function isoWeekday(date: { year: number; month: number; day: number }): number {
  const utcDay = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return utcDay === 0 ? 7 : utcDay;
}

/** Bir anın `timeZone`daki ISO hafta günü. */
export function localWeekday(instant: Date, timeZone: string): number {
  return isoWeekday(localParts(instant, timeZone));
}

/**
 * `[from, to]` aralığına düşen slot anları (UTC), artan sırada.
 *
 * Günler müşterinin YEREL takvimine göre gezilir: İstanbul'da 01:00'daki bir
 * slot UTC'de önceki güne düşer; UTC günü gezilseydi o slot ya iki kez ya hiç
 * üretilirdi. Yayın günü filtresi (V8) de bu yerel günde uygulanır: gün
 * sınırı müşterinin gece yarısı, UTC'ninki değil. Takvim günü üzerinden
 * gidildiği için DST günü de tek gün sayılır (23 ya da 25 saat olsa bile).
 *
 * Saf ve istemcide de çalışır (yalnızca `Intl`): Ayarlar ekranı henüz
 * kaydedilmemiş seçimin "sıradaki yayınlar"ını bu fonksiyonla hesaplıyor —
 * ekranda görünen ile tick'in uyguladığı kural tek yerde.
 */
export function slotInstants(
  settings: Pick<QueueSettings, "slots" | "timezone" | "days">,
  range: { from: Date; to: Date }
): Date[] {
  const slots = normalizedSlots(settings.slots);
  if (slots.length === 0 || range.to < range.from) return [];

  // Yerel gün aralığı ±1 günle genişletilir: en uç ofset (UTC±14) bile bir
  // takvim gününden fazla kaydırmaz.
  const first = addDays(localParts(range.from, settings.timezone), -1);
  const last = addDays(localParts(range.to, settings.timezone), 1);
  const lastKey = Date.UTC(last.year, last.month - 1, last.day);

  const days = normalizedDays(settings.days);
  const out: Date[] = [];
  for (
    let day = first;
    Date.UTC(day.year, day.month - 1, day.day) <= lastKey;
    day = addDays(day, 1)
  ) {
    if (!days.has(isoWeekday(day))) continue;
    for (const slot of slots) {
      const instant = zonedTimeToUtc({ ...day, ...slot }, settings.timezone);
      if (instant >= range.from && instant <= range.to) out.push(instant);
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

// ─── Vadesi gelen slotlar ─────────────────────────────────────────────────

/**
 * Slot saatinden sonra yayının hâlâ yapılabileceği süre (K8). Daha geç
 * görülen slot yayın YAPMAZ, `skipped` yazılır: bir kesintiden sonra birikmiş
 * videolar art arda yayınlanmasın, kullanıcının seçtiği ritim bozulmasın.
 */
export const SLOT_WINDOW_MS = HOUR_MS;

/**
 * Geriye ne kadar bakılır. Daha eski kayıtsız slotlar için satır bile
 * yazılmaz: sistem bir hafta kapalı kalırsa ilk tick yüzlerce `skipped`
 * satırı üretmesin. Bir gün, "dün neden yayın olmadı" sorusunu SlotRun'dan
 * cevaplamaya yeter.
 */
export const SLOT_LOOKBACK_MS = DAY_MS;

export type DueSlot = {
  slotAt: Date;
  /**
   * `publish`: pencerede — yayın denenir (paused ise tick `paused` yazar).
   * `skip`: pencere kaçmış — `skipped` yazılır, yayın yapılmaz.
   */
  action: "publish" | "skip";
};

/**
 * Saati geçmiş ama `SlotRun` kaydı olmayan slotlar, eskiden yeniye.
 *
 * `existingRunSlotAts` bu müşterinin son `SLOT_LOOKBACK_MS` içindeki SlotRun
 * anları. Kayıt bir kez yazıldığında slot bir daha dönmez — idempotency'nin
 * asıl kilidi yine de `(clientId, slotAt)` UNIQUE'i; buradaki filtre yalnızca
 * gereksiz INSERT denemelerini azaltır.
 */
export function dueSlots(
  settings: Pick<QueueSettings, "slots" | "timezone" | "days" | "createdAt">,
  now: Date,
  existingRunSlotAts: Date[]
): DueSlot[] {
  let from = new Date(now.getTime() - SLOT_LOOKBACK_MS);
  if (settings.createdAt && settings.createdAt > from) from = settings.createdAt;

  const taken = new Set(existingRunSlotAts.map((d) => d.getTime()));
  return slotInstants(settings, { from, to: now })
    .filter((slotAt) => !taken.has(slotAt.getTime()))
    .map((slotAt) => ({
      slotAt,
      action: now.getTime() - slotAt.getTime() > SLOT_WINDOW_MS ? "skip" : "publish",
    }));
}

// ─── Sıradaki video ────────────────────────────────────────────────────────

/**
 * Yayına seçilebilecek `publishStatus`. Yalnızca `idle`: `failed` video hata
 * rozetiyle yerinde kalır ve portaldan "tekrar dene"yi bekler — tick onu
 * kendiliğinden yeniden denerse aynı hata her slotta tekrarlanır ve kuyruk
 * tıkanır. `publishing/published/duplicate/scheduled/skipped` zaten yolda ya
 * da yolun sonunda.
 */
const PICKABLE_PUBLISH_STATUS: PublishStatus = "idle";

/** Bu post, verilen onay modunda bir slota seçilebilir mi? */
export function isEligible(item: QueueItem, requireApproval: boolean): boolean {
  if (item.queuePosition === null) return false; // kuyruktan çıkarılmış / ajans postu
  if (item.captionStatus !== "ready") return false; // caption'ı olmayan video yayınlanmaz
  if (item.publishStatus !== PICKABLE_PUBLISH_STATUS) return false;
  // GÜVENLİK KURALI (README §5): onay açıkken onaysız video hiçbir yoldan
  // yayınlanmaz. Bu, iki kontrolün ilki; ikincisi yayın kilidinin hemen
  // önünde (`publish-post.ts`).
  if (requireApproval) return item.status === "approved";
  // Onay kapalı: bekleyen de onaylı da sırası gelince yayınlanır. `draft`,
  // `rejected`, `revision_requested` hiçbir modda seçilmez.
  return item.status === "pending" || item.status === "approved";
}

function byPosition(a: QueueItem, b: QueueItem): number {
  // Eşit pozisyonda (yeniden numaralama yarışı) sıra kararlı kalsın diye id.
  return (a.queuePosition ?? 0) - (b.queuePosition ?? 0) || a.id.localeCompare(b.id);
}

/**
 * `queuePosition` sırasındaki ilk uygun video; yoksa `null`.
 *
 * Onay açıkken baştaki video onaysızsa slot boş GEÇMEZ, sıradaki ilk ONAYLI
 * video yayınlanır (K9): ritim korunur, kullanıcı istemediği videoyu zaten
 * onaylamamıştır.
 */
export function pickNext<T extends QueueItem>(queue: T[], requireApproval: boolean): T | null {
  const sorted = [...queue].sort(byPosition);
  return sorted.find((item) => isEligible(item, requireApproval)) ?? null;
}

// ─── Sıralama ──────────────────────────────────────────────────────────────

/** Yeni numaralamada pozisyonlar arası adım; araya ~50 taşıma sığar. */
export const POSITION_STEP = 1024;

/**
 * İki komşu arasındaki boşluk bundan küçükse yeniden numaralama gerekir.
 * Float'ın 52 bitlik mantisi ~50 ardışık yarılamadan sonra ortalamayı
 * komşulardan birine eşitler; eşik o noktaya gelmeden alarm verir.
 */
export const MIN_POSITION_GAP = 1e-6;

/**
 * `before` ile `after` arasına konacak pozisyon (null = o tarafta komşu yok).
 * Tek satır güncellenir — Float seçiminin sebebi bu (bkz. schema.prisma).
 */
export function positionBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return POSITION_STEP;
  if (before === null) return after! - POSITION_STEP;
  if (after === null) return before + POSITION_STEP;
  return (before + after) / 2;
}

/**
 * Bu iki komşunun arasına güvenle yeni pozisyon konabilir mi? `true` ise
 * çağıran önce kuyruğu `renumberPositions` ile yeniden numaralamalı.
 */
export function needsRenumber(before: number | null, after: number | null): boolean {
  if (before === null || after === null) return false;
  if (after - before < MIN_POSITION_GAP) return true;
  const mid = (before + after) / 2;
  return mid <= before || mid >= after;
}

/** Sıralı id listesi → eşit aralıklı yeni pozisyonlar (1024, 2048, ...). */
export function renumberPositions(orderedIds: string[]): { id: string; queuePosition: number }[] {
  return orderedIds.map((id, index) => ({ id, queuePosition: (index + 1) * POSITION_STEP }));
}

// ─── Tahmini takvim ────────────────────────────────────────────────────────

export type ProjectedSlot = { postId: string; slotAt: Date };

/**
 * Sıradaki `n` yayının tahmini anları — portaldaki "tahmini yayın" rozeti ve
 * günlük hatırlatma e-postası için.
 *
 * Tick'in kurallarını birebir simüle eder: `now`dan sonraki her slota
 * `pickNext` ile seçilecek video yerleştirilir ve kuyruktan düşülür. Bu
 * yüzden onay açıkken ONAYSIZ videolar takvimde görünmez — tick de onları
 * seçmeyecek. Kuyruk duraklatılmışsa takvim boştur.
 *
 * Tahmin: kullanıcı sırayı değiştirir, onay verir ya da bir yayın patlarsa
 * değişir. Kesin söz değil, "şu anki sıra böyle kalırsa".
 */
export function projectSchedule<T extends QueueItem>(
  queue: T[],
  settings: Pick<QueueSettings, "slots" | "timezone" | "days" | "requireApproval" | "paused">,
  now: Date,
  n: number
): ProjectedSlot[] {
  if (settings.paused || n <= 0) return [];
  const perWeek = normalizedSlots(settings.slots).length * normalizedDays(settings.days).size;
  if (perWeek === 0) return [];

  let remaining = queue.filter((item) => isEligible(item, settings.requireApproval));
  const want = Math.min(n, remaining.length);
  if (want === 0) return [];

  // `now` anındaki slot çoktan tick'e ait (ya işlendi ya işleniyor) — yalnızca
  // sonrası. Aralık tam hafta katı: 7k günlük her pencere, seçili her günü
  // tam k kez içerir (yalnızca Pazartesi seçiliyse 3 yayın için 3 hafta).
  // +2 gün: DST günü ve bugünün geçmiş slotları için pay.
  const spanDays = Math.ceil(want / perWeek) * 7 + 2;
  const instants = slotInstants(settings, {
    from: new Date(now.getTime() + 1),
    to: new Date(now.getTime() + spanDays * DAY_MS),
  });

  const out: ProjectedSlot[] = [];
  for (const slotAt of instants) {
    if (out.length >= want) break;
    const next = pickNext(remaining, settings.requireApproval);
    if (!next) break;
    out.push({ postId: next.id, slotAt });
    remaining = remaining.filter((item) => item.id !== next.id);
  }
  return out;
}
