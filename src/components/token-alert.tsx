import type { InstagramTokenAlert } from "@/lib/instagram-token";

/**
 * Instagram token'ı dolmak üzere / dolmuş müşteriler için uyarı şeridi.
 *
 * İki ton bilinçli olarak ayrılır: "yakında doluyor" sarı bir hatırlatma,
 * "doldu" ise yayın FİİLEN durduğu için kırmızı ve `role="alert"`.
 * Token'ın kendisi asla prop olarak buraya gelmez — yalnızca ad + gün sayısı.
 */
export function TokenAlerts({ alerts }: { alerts: InstagramTokenAlert[] }) {
  if (alerts.length === 0) return null;
  return (
    <div className="token-alerts">
      {alerts.map((alert) => (
        <p
          key={alert.clientId}
          className={`token-alert token-alert-${alert.expired ? "expired" : "soon"}`}
          role={alert.expired ? "alert" : "status"}
        >
          <strong>{alert.clientName}</strong>
          {alert.expired ? (
            <>
              {" — Instagram token'ının süresi "}
              {expiredWhen(alert.daysLeft)}
              {". Yayın şu an durmuş durumda: onaylanan postlar Instagram'a gitmiyor. "}
              {"Token'ı Instagram Graph "}
              <code>GET /refresh_access_token</code>
              {" ile yenile ve müşteri kaydını güncelle."}
            </>
          ) : (
            <>
              {" — Instagram token'ının süresi "}
              {alert.daysLeft} gün sonra doluyor
              {". Dolmadan Instagram Graph "}
              <code>GET /refresh_access_token</code>
              {" ile yenile, yoksa yayın durur."}
            </>
          )}
        </p>
      ))}
    </div>
  );
}

function expiredWhen(daysLeft: number): string {
  const daysAgo = Math.abs(daysLeft);
  return daysAgo === 0 ? "bugün doldu" : `${daysAgo} gün önce doldu`;
}
