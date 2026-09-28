import type { PublishErrorView } from "@/lib/portal-publish-error";
import { IconAlert } from "@/components/portal/icons";

/**
 * Video detayında yayın hatası (V7 tasarımı, "Güncelleme 28 Eyl (3)"): ne
 * oldu, ne yapmalı; ham metin "Teknik ayrıntı"nın altında — ajansa iletirken
 * lazım. Açılır bölüm yerel `<details>`: sunucu bileşeni kalsın, JS'e gerek yok.
 */
export function PublishErrorCard({ error }: { error: PublishErrorView }) {
  return (
    <section className="p-perr" aria-label="Yayın hatası">
      <div className="p-perr-head">
        <span className="p-perr-icon" aria-hidden="true">
          <IconAlert size={18} />
        </span>
        <span className="p-perr-text">
          <strong className="p-perr-title">{error.title}</strong>
          <span>{error.body}</span>
        </span>
      </div>
      <p className="p-perr-todo">
        <span className="p-perr-todo-label">NE YAPMALI</span>
        <span>{error.todo}</span>
      </p>
      {error.raw && (
        <details className="p-perr-raw">
          <summary>Teknik ayrıntı</summary>
          <code>{error.raw}</code>
        </details>
      )}
    </section>
  );
}
