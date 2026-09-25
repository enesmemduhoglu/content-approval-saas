import { RESUME_MAX_AGE_MS, type ResumeRecord } from "@/lib/multipart-client";

/**
 * Video kuyruğu (V7b) — kaldığı yerden devam kayıtları, IndexedDB'de.
 *
 * Sayfa yenilenir ya da uygulama kapanırsa `File` nesnesi kaybolur (iOS'ta
 * dosyaya kalıcı erişim yok). Kullanıcı aynı videoyu yeniden seçtiğinde hangi
 * taslağa ve hangi parçalara kadar gelindiğini buradan okuruz; `uploadId`
 * burada YOK (yalnızca sunucuda), yalnızca `postId` ve parçaların ETag'leri.
 *
 * Her erişim try/catch: gizli sekme, kapatılmış site verisi, eski tarayıcı —
 * IndexedDB açılamazsa kayıt "yok" sayılır ve yükleme baştan başlar; devam
 * özelliği hiçbir koşulda yüklemenin kendisini engellemez.
 */

const DB_NAME = "portal-yukleme";
const STORE = "devam";

let opening: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE, { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  }).then((db) => {
    // Açılamadıysa bir sonraki çağrı yeniden denesin (ör. geçici kilit).
    if (!db) opening = null;
    return db;
  });
  return opening;
}

function run<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const request = action(db.transaction(STORE, mode).objectStore(STORE));
          request.onsuccess = () => resolve(request.result ?? null);
          request.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      })
  );
}

export async function loadResume(key: string): Promise<ResumeRecord | null> {
  return (await run<ResumeRecord>("readonly", (store) => store.get(key))) ?? null;
}

export async function saveResume(record: ResumeRecord): Promise<void> {
  await run("readwrite", (store) => store.put(record));
}

export async function deleteResume(key: string): Promise<void> {
  await run("readwrite", (store) => store.delete(key));
}

/** Süresi geçmiş kayıtları atar — sunucu o taslakları zaten silmiş olur. */
export async function pruneResume(now: number = Date.now()): Promise<void> {
  const all = await run<ResumeRecord[]>("readonly", (store) => store.getAll());
  if (!all) return;
  await Promise.all(
    all
      .filter((record) => !record?.updatedAt || now - record.updatedAt > RESUME_MAX_AGE_MS)
      .map((record) => deleteResume(record.key))
  );
}
