import type { CallToken } from "@agenteschat/client";
import "@livekit/components-styles";
import {
  DisconnectButton,
  GridLayout,
  LiveKitRoom,
  ParticipantTile,
  RoomAudioRenderer,
  TrackToggle,
  useTracks,
} from "@livekit/components-react";
import { Track } from "livekit-client";
import { useTranslation } from "react-i18next";
import "./call.css";

/**
 * What a screen share captures (ADR 0220 §4): the screen of the machine whoever shares is on, the browser's own picker,
 * with the system's sound beside the picture. The sound only comes when the whole screen is shared, in Chrome and
 * Edge on Windows: the room says so next to the button.
 */
const SCREEN = {
  audio: true,
  systemAudio: "include",
  selfBrowserSurface: "exclude",
  surfaceSwitching: "include",
} as const;

/** The room itself, drawn once the token is in: tiles, the sound of everyone, and the controls. */
export default function CallRoom({ call, video, onLeave }: { call: CallToken; video: boolean; onLeave: () => void }) {
  const { t } = useTranslation();
  const canShare = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;
  return (
    <LiveKitRoom
      className="call__room"
      serverUrl={call.url}
      token={call.token}
      connect
      audio
      video={video}
      data-lk-theme="default"
      onDisconnected={onLeave}
    >
      <Tiles />
      <RoomAudioRenderer />
      <div className="call__bar" role="toolbar" aria-label={t("call.controls")}>
        <TrackToggle source={Track.Source.Microphone} showIcon>
          {t("call.mic")}
        </TrackToggle>
        <TrackToggle source={Track.Source.Camera} showIcon>
          {t("call.camera")}
        </TrackToggle>
        {canShare && (
          <TrackToggle source={Track.Source.ScreenShare} captureOptions={SCREEN} showIcon>
            {t("call.share")}
          </TrackToggle>
        )}
        <DisconnectButton>{t("call.leave")}</DisconnectButton>
      </div>
      <p className="call__hint">{canShare ? t("call.shareHint") : t("call.shareUnsupported")}</p>
    </LiveKitRoom>
  );
}

/** Everyone's camera and screen, in a grid that gives the screen shares the room. */
function Tiles() {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  return (
    <GridLayout tracks={tracks} className="call__grid">
      <ParticipantTile />
    </GridLayout>
  );
}
