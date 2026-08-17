/**
 * Karar geçmişi (F4).
 *
 * `ApprovalAudit` ilk günden beri yazılıyordu ama hiçbir yerde okunmuyordu:
 * README'nin öne çıkardığı "karar IP ve zaman damgasıyla kayıt altında" vaadinin
 * arayüzde hiçbir karşılığı yoktu, veri ölü duruyordu. Bu bileşen onu görünür
 * kılıyor — anlaşmazlıkta ("ben onaylamadım") bakılacak yer burası.
 *
 * Sunucu bileşeni: etkileşim yok, sadece okuma.
 */

/**
 * Etiketler bilerek durum rozetinden FARKLI: rozet postun ŞU ANKİ durumunu
 * söylüyor ("Onaylandı"), buradaki satır ise geçmişte OLAN BİR OLAY. Aynı
 * kelimeyi iki ayrı anlamda iki kez göstermek hem okuyucuyu hem testleri
 * şaşırtıyordu (e2e'de "Onaylandı" iki elemana denk geldi). "Müşteri onayladı"
 * zaman çizelgesinde zaten daha doğru bir cümle.
 */
const ACTION_LABELS: Record<string, string> = {
  approved: "Müşteri onayladı",
  rejected: "Müşteri reddetti",
};

export type AuditEntry = {
  id: string;
  action: string;
  ip: string;
  createdAt: Date;
};

export function AuditTrail({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) return null;

  return (
    <details className="audit-trail">
      <summary>Karar geçmişi ({entries.length})</summary>
      <ul>
        {entries.map((entry) => (
          <li key={entry.id}>
            <strong>{ACTION_LABELS[entry.action] ?? entry.action}</strong>
            {" · "}
            <time dateTime={entry.createdAt.toISOString()}>
              {entry.createdAt.toLocaleString("tr-TR")}
            </time>
            {/* IP "unknown" olabiliyor: proxy'siz ortamda başlık gelmiyor ve
                audit'e boş değer düşmesin diye sabit yazılıyor (rate-limit.ts).
                Öyleyse göstermek yerine sessiz kalmak daha dürüst. */}
            {entry.ip !== "unknown" && (
              <>
                {" · "}
                <span className="audit-ip">IP {entry.ip}</span>
              </>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
