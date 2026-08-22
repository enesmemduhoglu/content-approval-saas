/**
 * Revizyon zinciri (F10).
 *
 * `AuditTrail`'in yanında, ONUN YERİNE değil, duruyor: audit "ne karar verildi"
 * defteri (kim, ne zaman, hangi IP), bu ise "ne konuşuldu ve metin nasıl
 * değişti". İkisini tek listede birleştirmek denendiğinde her tur iki kez
 * görünüyordu — aynı olayın iki farklı kaydı, okuyucu için gürültü.
 *
 * Gösterilen asıl şey MESAJ ve METİN: ajans "müşteri ne demişti, ben ne
 * göndermiştim" sorusunu yeni post açmadan yanıtlayabilsin diye. Metin
 * `<details>` içinde katlı: tur sayısı arttıkça satırlar paneli boğmasın.
 *
 * Sunucu bileşeni: etkileşim yok, sadece okuma.
 */

export type RevisionEntry = {
  id: string;
  round: number;
  actor: string;
  event: string;
  message: string | null;
  caption: string;
  createdAt: Date;
};

const EVENT_LABELS: Record<string, string> = {
  revision_requested: "Müşteri düzeltme istedi",
  resubmitted: "Ajans düzeltip tekrar gönderdi",
};

export function RevisionTrail({ entries }: { entries: RevisionEntry[] }) {
  if (entries.length === 0) return null;

  // Tur sayısı = müşterinin kaç kez düzeltme istediği. Ajansın "tekrar
  // gönderdim" satırları aynı turun ikinci yarısı, ayrı tur sayılmaz.
  const rounds = entries.filter((entry) => entry.event === "revision_requested").length;

  return (
    <details className="revision-trail" open={entries.at(-1)?.event === "revision_requested"}>
      <summary>
        Revizyon geçmişi ({rounds} tur · {entries.length} kayıt)
      </summary>
      <ol>
        {entries.map((entry) => (
          <li key={entry.id} className={`revision-entry revision-${entry.actor}`}>
            <strong>{EVENT_LABELS[entry.event] ?? entry.event}</strong>
            {" · "}
            <span className="revision-round">{entry.round}. tur</span>
            {" · "}
            <time dateTime={entry.createdAt.toISOString()}>
              {entry.createdAt.toLocaleString("tr-TR")}
            </time>
            {/* Mesaj YOKSA satır atlanır: "not belirtilmedi" yazmak, gerçekten
                bir şey söylenmiş satırlarla arasındaki farkı silikleştirirdi. */}
            {entry.message && <p className="revision-message">{entry.message}</p>}
            <details className="revision-caption">
              <summary>O anki metin</summary>
              <p>{entry.caption}</p>
            </details>
          </li>
        ))}
      </ol>
    </details>
  );
}
