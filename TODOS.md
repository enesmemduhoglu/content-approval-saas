# TODOs

Deferred from `/plan-ceo-review` (SELECTIVE EXPANSION cherry-pick, 2026-07-22):

- **Çoklu görsel/carousel desteği** — bir postta birden fazla görsel gösterme. Şema: `Post` 1-N `PostImage` ilişkisi. Effort: insan ~4s / CC ~30dk. v1'in çekirdek onay akışını kanıtlamak için gerekli değil.
- **Ajans markalama** — onay sayfasında ajans logosu/rengi (beyaz etiket hissi). Şema: `Agency.logoUrl`, `Agency.brandColor`. Effort: insan ~2s / CC ~15dk. Kozmetik, çekirdek akışla ilgisi yok.
- **Toplu onay** — müşterinin birden fazla postu tek seferde onaylaması. v1'de her post ayrı linkle onaylanıyor.
- **Rate limiter'ı Upstash Redis'e taşı** — D4 kararı (in-memory) MVP ölçeği için kabul edildi, ama gerçek serverless çoklu-instance ortamda koruma tam garanti değil. Trafik artarsa veya production'a geçilirse Upstash Redis'e (ya da benzeri dağıtık store) taşınmalı.
