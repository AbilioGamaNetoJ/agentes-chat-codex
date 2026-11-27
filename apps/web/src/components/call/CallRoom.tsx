import type { CallToken } from "@agenteschat/client";
import "@livekit/components-styles";
import {
  DisconnectButton,
  GridLayout,
  LiveKitRoom,
  ParticipantTile,
  RoomAudioRenderer,
  StartAudio,
  TrackToggle,
  useTracks,
} from "@livekit/components-react";
import { type RoomOptions, Track } from "livekit-client";
import { useEffect, useState } from "react";
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

/**
 * The room outlives the screen (ADR 0220): leaving the page ends it (`disconnectOnPageLeave`, the browser's `pagehide`),
 * but a hidden tab does not, and adaptive streaming stays off so a tab brought back needs no re-subscribing: only
 * audio matters while it is behind, and it never depends on the page being visible.
 */
const ROOM_OPTIONS: RoomOptions = { disconnectOnPageLeave: true, adaptiveStream: false, dynacast: false };

/**
 * The room itself, drawn once the token is in: tiles, the sound of everyone, and the controls. `minimized` swaps the
 * tiles for a small bar (name, timer, mute, back, leave) while the room, and its sound, stay mounted.
 */
export default function CallRoom({
  call,
  video,
  name,
  minimized,
  startedAt,
  onConnected,
  onLeave,
  onMinimize,
  onBack,
}: {
  call: CallToken;
  video: boolean;
  name: string;
  minimized: boolean;
  startedAt?: number;
  onConnected: () => void;
  onLeave: () => void;
  onMinimize: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const canShare = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;
  return (
    <LiveKitRoom
      className={minimized ? "call__room call__room--mini" : "call__room"}
      serverUrl={call.url}
      token={call.token}
      options={ROOM_OPTIONS}
      connect
      audio
      video={video}
      data-lk-theme="default"
      onConnected={onConnected}
      onDisconnected={onLeave}
    >
      <RoomAudioRenderer />
      <StartAudio label={t("call.startAudio")} className="call__btn" />
      {minimized ? (
        <div className="call__minibar">
          <span className="call__miniwho">
            <span className="call__dot" aria-hidden="true" />
            <span className="call__mininame">{name}</span>
            <Elapsed since={startedAt} />
          </span>
          <TrackToggle source={Track.Source.Microphone} showIcon className="call__btn" aria-label={t("call.mic")} />
          <button type="button" className="call__btn" onClick={onBack}>
            {t("call.back")}
          </button>
          <DisconnectButton className="call__btn call__btn--leave">{t("call.leave")}</DisconnectButton>
        </div>
      ) : (
        <>
          <div className="call__head">
            <span>{t("call.with", { name })}</span>
            <Elapsed since={startedAt} />
          </div>
          <Tiles />
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
            <button type="button" className="lk-button" onClick={onMinimize}>
              {t("call.minimize")}
            </button>
            <DisconnectButton>{t("call.leave")}</DisconnectButton>
          </div>
          <p className="call__hint">{canShare ? t("call.shareHint") : t("call.shareUnsupported")}</p>
        </>
      )}
    </LiveKitRoom>
  );
}

/** mm:ss since the room connected, once a second. */
function Elapsed({ since }: { since?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  if (!since) return null;
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const h = Math.floor(seconds / 3600);
  const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return <time className="call__time">{h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`}</time>;
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
