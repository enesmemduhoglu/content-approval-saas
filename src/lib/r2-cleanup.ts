import { deleteObject, keyBelongsToClient, r2Configured } from "@/lib/storage-r2";

/**
 * Bir postun R2 nesnelerini siler — DB kaydı gittikten (ya da anahtar DB'den
 * düşürüldükten) SONRA çağrılır: R2 transaction'ın parçası olamaz. Best-effort;
 * kalan nesne yalnızca loglanır, `scripts/r2-denetim.mjs` sonradan yakalar.
 *
 * `storage-r2.ts`'in içinde DEĞİL: aynı modülün içinden yapılan `deleteObject`
 * çağrısı testlerin `vi.mock`'unu atlardı (portal silme testleri tam olarak
 * hangi anahtarların silindiğine bakıyor).
 *
 * Anahtar DB'den geliyor ama başka müşterinin önekini gösteren bir değer, o
 * müşterinin nesnesini sildirmek demek olurdu (imzalı URL'deki kapının aynısı).
 */
export async function deleteOwnedObjects(
  clientId: string,
  keys: (string | null | undefined)[],
  logTag: string
): Promise<{ deleted: number; failed: number }> {
  if (!r2Configured()) return { deleted: 0, failed: 0 };
  const all = keys.filter((key): key is string => !!key);
  const owned = all.filter((key) => keyBelongsToClient(key, clientId));
  if (owned.length !== all.length) {
    console.error(`[${logTag}] müşteri önekinde olmayan ${all.length - owned.length} anahtar atlandı`);
  }
  const results = await Promise.allSettled(owned.map((key) => deleteObject(key)));
  const failed = results.filter((r) => r.status === "rejected" || r.value === false).length;
  if (failed > 0) {
    console.error(`[${logTag}] R2'de ${failed}/${owned.length} nesne silinemedi`);
  }
  return { deleted: owned.length - failed, failed };
}
