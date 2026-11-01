/**
 * `@upstash/qstash` sahtesi — gerçek QStash'e hiçbir istek gitmez, atılan
 * mesajlar ve iptaller kaydedilir.
 *
 * Kullanım (dosyanın üstünde):
 *
 *   vi.mock("@upstash/qstash", async () => (await import("@tests/helpers/qstash")).qstashModule());
 *   import { qstashMock, resetQstashMock } from "@tests/helpers/qstash";
 *   beforeEach(() => resetQstashMock());
 *
 * `qstash.ts` istemciyi yalnızca `QSTASH_TOKEN` ve `APP_URL` varken kurar;
 * testte ikisini `vi.stubEnv` ile ver.
 *
 * `Receiver` her imzayı REDDEDER: sahte bir "her imza geçerli" alıcısı kapıyı
 * testte sessizce açardı. Tick'e istek `Bearer CRON_SECRET` ile gider.
 */

export type PublishCall = {
  url: string;
  body: unknown;
  notBefore?: number;
  delay?: number;
  deduplicationId?: string;
  retries?: number;
};

export const qstashMock = {
  published: [] as PublishCall[],
  cancelled: [] as string[],
  /** Doluysa `publishJSON` bu çağrı sayısından sonra (0 = hemen) patlar. */
  failPublishAfter: null as number | null,
  failCancel: false,
  seq: 0,
};

export function resetQstashMock(): void {
  qstashMock.published = [];
  qstashMock.cancelled = [];
  qstashMock.failPublishAfter = null;
  qstashMock.failCancel = false;
  qstashMock.seq = 0;
}

export function qstashModule() {
  class Client {
    messages = {
      cancel: async (messageId: string) => {
        if (qstashMock.failCancel) throw new Error("qstash iptal hatası (test)");
        qstashMock.cancelled.push(messageId);
        return { cancelled: 1 };
      },
    };

    async publishJSON(request: PublishCall) {
      if (
        qstashMock.failPublishAfter !== null &&
        qstashMock.published.length >= qstashMock.failPublishAfter
      ) {
        throw new Error("qstash yayın hatası (test)");
      }
      qstashMock.published.push({
        url: request.url,
        body: request.body,
        notBefore: request.notBefore,
        delay: request.delay,
        deduplicationId: request.deduplicationId,
        retries: request.retries,
      });
      qstashMock.seq += 1;
      return { messageId: `msg-${qstashMock.seq}` };
    }
  }

  class Receiver {
    async verify() {
      return false;
    }
  }

  return { Client, Receiver };
}
