import { useCallsEnabled } from "@agenteschat/client";
import { Button } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useCalls } from "./CallProvider";

/**
 * The call buttons of a person's DM (ADR 0220): voice or video. They only ask the workspace's call provider (which
 * lives above the routes) to ring this person; the room, its sound and the ring are not here, so leaving this page
 * never drops the call. They show only when the server has calls on.
 */
export function CallButton({ channelId, peerId, name }: { channelId: string; peerId: string; name: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const enabled = useCallsEnabled(org.id);
  const calls = useCalls();
  if (!enabled.data || !calls) return null;
  const start = (video: boolean) => calls.start({ channelId, peerId, name }, video);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        icon="callPhone"
        className="channel__icon"
        aria-label={t("call.audio")}
        title={t("call.audio")}
        onClick={() => start(false)}
      />
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        icon="camera"
        className="channel__icon"
        aria-label={t("call.video")}
        title={t("call.video")}
        onClick={() => start(true)}
      />
    </>
  );
}
