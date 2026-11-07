// e2e için sahte QStash. `next dev` `.env.local`'i yüklüyor ve orada GERÇEK
// QSTASH_TOKEN var; sunucu bu adrese yönlendirilmeseydi portal testleri prod
// token'ıyla gerçek mesaj yayınlardı (hedef localhost olduğu için ya reddedilir
// ya da teslim edilemeyen mesaj olarak kalırdı). Ayrıca "iş kuyruğa alındı mı"
// sorusu ancak mesajı GÖREN bir uçla cevaplanabilir: `captionQueued: false`
// HTTP 200 ile dönüyor, yanıt koduna bakmak yanlış güven verir.
//
// SDK'nın çağırdığı her şeye 200 döner; `/v2/publish/<hedef>` istekleri
// kaydedilir. Test `GET /__e2e/messages` ile okur, `DELETE` ile sıfırlar.
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 3112);
const messages = [];
let seq = 0;

createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const json = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/__e2e/messages") {
      if (req.method === "DELETE") messages.length = 0;
      return json(200, messages);
    }

    if (req.method === "POST" && url.pathname.startsWith("/v2/publish/")) {
      seq += 1;
      const messageId = `e2e-msg-${seq}`;
      let body = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // Gövde JSON değilse ham hâliyle kaydedilir.
      }
      messages.push({
        messageId,
        destination: decodeURIComponent(url.pathname.slice("/v2/publish/".length)),
        body,
      });
      return json(200, { messageId });
    }

    // Uyandırma iptali vb. — sonuç önemsiz, yalnızca SDK hata görmesin.
    return json(200, {});
  });
}).listen(port, () => console.log(`[fake-qstash] :${port}`));
