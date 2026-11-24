import type { CallToken } from "@agenteschat/client";
import { ApiError, useCallsEnabled } from "@agenteschat/client";
import { Button } from "@agenteschat/ui";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useOrg } from "@/components/org-context";
import "./call.css";

// The LiveKit client is large and only a call needs it: it loads when the first call opens.
const CallRoom = lazy(() => import("./CallRoom"));

/**
 * The call button of a conversation (ADR 0220): audio or video, and the room opens over the same screen. It shows
 * only when the server has calls on. The token comes from the server, which checks the person can read the
 * conversation; the key and secret never reach the browser.
 */
export function CallButton({ channelId, name }: { channelId: string; name: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const enabled = useCallsEnabled(org.id);
  const [call, setCall] = useState<{ token: CallToken; video: boolean } | "joining" | { error: string } | null>(null);
  if (!enabled.data) return null;

  const start = async (video: boolean) => {
    setCall("joining");
    try {
      setCall({ token: await api.calls.token(org.id, channelId), video });
    } catch (e) {
      setCall({ error: e instanceof ApiError && e.status === 429 ? t("call.tooMany") : t("call.failed") });
    }
  };
  const close = () => setCall(null);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        icon="callPhone"
        className="channel__icon"
        aria-label={t("call.audio", { name })}
        title={t("call.audio", { name })}
        onClick={() => void start(false)}
      />
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        icon="camera"
        className="channel__icon"
        aria-label={t("call.video", { name })}
        title={t("call.video", { name })}
        onClick={() => void start(true)}
      />
      {call && (
        <div className="call" role="dialog" aria-modal="true" aria-label={t("call.with", { name })}>
          <div className="call__head">{t("call.with", { name })}</div>
          {call === "joining" ? (
            <p className="call__state">{t("call.joining")}</p>
          ) : "error" in call ? (
            <div className="call__state">
              <p>{call.error}</p>
              <Button onClick={close}>{t("call.close")}</Button>
            </div>
          ) : (
            <Suspense fallback={<p className="call__state">{t("call.joining")}</p>}>
              <CallRoom call={call.token} video={call.video} onLeave={close} />
            </Suspense>
          )}
        </div>
      )}
    </>
  );
}
