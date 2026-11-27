import {
  ApiError,
  type CallEndReason,
  type CallRingingEvent,
  type CallToken,
  useCallsEnabled,
} from "@agenteschat/client";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useOrg } from "@/components/org-context";
import {
  askCallPermission,
  type CallAction,
  closeCallNotice,
  listenForCallActions,
  showCallNotice,
} from "@/lib/call-notify";
import { onRingEnded, resetRings, ringsNow, subscribeRings } from "@/lib/call-signal";
import { startLoop } from "@/lib/sounds";
import { CallCards, type OutgoingView } from "./CallCards";
import "./call.css";

// The LiveKit client is large and only a call needs it: it loads when the first call opens.
const CallRoom = lazy(() => import("./CallRoom"));

/** What ends a ring, after the person's own answer: how long a finished outgoing card stays up. */
const RESULT_SHOWN_MS = 4000;

export interface CallSession {
  channelId: string;
  peerId: string;
  name: string;
  video: boolean;
  state: "joining" | "live" | "error";
  token?: CallToken;
  error?: string;
  /** When the room connected, for the timer. */
  startedAt?: number;
}

interface CallsApi {
  /** The call in progress, or null. */
  session: CallSession | null;
  /** Rings the person of this DM (or opens the call that is already on, or answers the ring they started). */
  start(target: { channelId: string; peerId: string; name: string }, video: boolean): void;
  leave(): void;
}

const CallsContext = createContext<CallsApi | null>(null);

/** The call controls of whoever is on screen. Outside the provider it is a call that never starts. */
export function useCalls(): CallsApi | null {
  return useContext(CallsContext);
}

/** The address of a person's DM. */
const dmPath = (orgId: string, userId: string) => `/org/${orgId}/dm/person/${userId}`;

/**
 * The calls of the workspace (ADR 0220), above every route: the room, its sound and the ring live here, so going from
 * one conversation to another, or to another window, never drops the call. The DM of the call shows the room; any other
 * screen shows a small bar with the timer, mute, leave and a way back. A call ends only with "Sair", or when the room
 * disconnects. Reloading the page ends it too (the browser asks first).
 */
export function CallProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const enabled = useCallsEnabled(org.id).data === true;
  const rings = useSyncExternalStore(subscribeRings, ringsNow);

  const [session, setSession] = useState<CallSession | null>(null);
  const [outgoing, setOutgoing] = useState<OutgoingView | null>(null);
  const [minimized, setMinimized] = useState(false);
  /** Rings this person already answered here: gone from the screen before the server's `call.ended` comes back. */
  const [handled, setHandled] = useState<ReadonlySet<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());

  const live = useRef({ session, outgoing, me: me.user.id });
  live.current = { session, outgoing, me: me.user.id };

  // Another workspace's rings are not this one's.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the workspace changes
  useEffect(() => resetRings(), [org.id]);

  const incoming: CallRingingEvent | null = useMemo(() => {
    for (const ring of rings.values()) {
      if (ring.orgId !== org.id || ring.calleeId !== me.user.id || handled.has(ring.channelId)) continue;
      if (Date.parse(ring.expiresAt) <= now) continue;
      return ring;
    }
    return null;
  }, [rings, org.id, me.user.id, handled, now]);

  // A ring that waits past its time goes without waiting for the socket (which may have been down).
  useEffect(() => {
    if (!incoming) return;
    const wait = Date.parse(incoming.expiresAt) - Date.now();
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, wait) + 50);
    return () => clearTimeout(timer);
  }, [incoming]);

  const goToDm = useCallback(
    (userId: string) => {
      void navigate({ to: "/org/$orgId/dm/person/$userId", params: { orgId: org.id, userId } });
    },
    [navigate, org.id],
  );

  /** Joins the room of a conversation: the token, and the room mounts. */
  const join = useCallback(
    async (target: { channelId: string; peerId: string; name: string }, video: boolean) => {
      setMinimized(false);
      setSession({ ...target, video, state: "joining" });
      try {
        const token = await api.calls.token(org.id, target.channelId);
        setSession((s) => (s?.channelId === target.channelId ? { ...s, token, state: "live" } : s));
      } catch (e) {
        const error = e instanceof ApiError && e.status === 429 ? t("call.tooMany") : t("call.failed");
        setSession((s) => (s?.channelId === target.channelId ? { ...s, state: "error", error } : s));
      }
    },
    [api, org.id, t],
  );

  const leave = useCallback(() => setSession(null), []);

  const clearOutgoing = useCallback(() => setOutgoing(null), []);

  const showResult = useCallback((view: OutgoingView) => {
    setOutgoing(view);
    return setTimeout(() => setOutgoing((o) => (o === view ? null : o)), RESULT_SHOWN_MS);
  }, []);

  const answer = useCallback(
    async (ring: CallRingingEvent) => {
      const target = { channelId: ring.channelId, peerId: ring.callerId, name: ring.callerName };
      const current = live.current.session;
      if (current && current.channelId !== ring.channelId) {
        if (!window.confirm(t("call.switchIncoming", { current: current.name, name: ring.callerName }))) return;
        setSession(null);
      }
      setHandled((h) => new Set(h).add(ring.channelId));
      try {
        await api.calls.accept(org.id, ring.channelId);
      } catch {
        // The ring was over: the room is empty, but joining is still harmless.
      }
      void join(target, ring.video);
      goToDm(ring.callerId);
    },
    [api, org.id, t, join, goToDm],
  );

  const start = useCallback<CallsApi["start"]>(
    (target, video) => {
      const { session: current, outgoing: calling } = live.current;
      if (current) {
        if (current.channelId === target.channelId) {
          setMinimized(false);
          goToDm(target.peerId);
          return;
        }
        if (!window.confirm(t("call.switchConfirm", { current: current.name, name: target.name }))) return;
        setSession(null);
      }
      if (calling?.status === "ringing") return;
      // The person called us first: calling back is answering.
      const theirs = ringsNow().get(target.channelId);
      if (theirs && theirs.calleeId === live.current.me) {
        void answer(theirs);
        return;
      }
      // The first call asks to show notifications: inside this click, where browsers allow the question.
      void askCallPermission();
      const view: OutgoingView = { ...target, video, status: "ringing" };
      setOutgoing(view);
      api.calls.ring(org.id, target.channelId, video).catch((e: unknown) => {
        const code = e instanceof ApiError ? e.code : undefined;
        const status = code === "call_busy" ? "busy" : e instanceof ApiError && e.status === 429 ? "tooMany" : "error";
        showResult({ ...view, status });
      });
    },
    [api, org.id, goToDm, showResult, t, answer],
  );

  const decline = (ring: CallRingingEvent, reason: "declined" | "busy" = "declined") => {
    setHandled((h) => new Set(h).add(ring.channelId));
    void api.calls.decline(org.id, ring.channelId, reason).catch(() => {});
  };

  const cancel = () => {
    const calling = live.current.outgoing;
    if (!calling) return;
    clearOutgoing();
    if (calling.status === "ringing") void api.calls.cancel(org.id, calling.channelId).catch(() => {});
  };

  // How my own ring ended, from the socket.
  const resultTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: handlers read the latest state through `live`
  useEffect(
    () =>
      onRingEnded((event) => {
        const calling = live.current.outgoing;
        setHandled((h) => {
          if (!h.has(event.channelId)) return h;
          const next = new Set(h);
          next.delete(event.channelId);
          return next;
        });
        if (!calling || calling.channelId !== event.channelId || event.callerId !== live.current.me) return;
        if (event.reason === "accepted") {
          clearOutgoing();
          void join(calling, calling.video);
          return;
        }
        if (event.reason === "cancelled") return clearOutgoing();
        const status: Record<Exclude<CallEndReason, "accepted" | "cancelled">, OutgoingView["status"]> = {
          expired: "missed",
          declined: "declined",
          busy: "busy",
        };
        clearTimeout(resultTimer.current);
        resultTimer.current = showResult({ ...calling, status: status[event.reason] });
      }),
    [],
  );
  useEffect(() => () => clearTimeout(resultTimer.current), []);

  // Already on a call (or ringing someone): a new ring is told "busy" right away.
  const incomingKey = incoming?.channelId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per ring
  useEffect(() => {
    if (!incoming) return;
    const { session: current, outgoing: calling } = live.current;
    if ((current && current.state !== "error") || calling?.status === "ringing") decline(incoming, "busy");
  }, [incomingKey]);

  // The ring's sound, until it is answered, missed or the page goes. Off in the sound settings: only the screen.
  useEffect(() => (incomingKey ? startLoop("ring") : undefined), [incomingKey]);
  const callingNow = outgoing?.status === "ringing";
  useEffect(() => (callingNow ? startLoop("ringback") : undefined), [callingNow]);

  // The system's notification, when this tab isn't the one in front.
  useEffect(() => {
    if (!incoming) return;
    const channelId = incoming.channelId;
    if (document.visibilityState === "visible" && document.hasFocus()) return;
    void showCallNotice({
      channelId,
      orgId: org.id,
      title: t(incoming.video ? "call.ringingVideo" : "call.ringing", { name: incoming.callerName }),
      body: t("call.notificationBody"),
      accept: t("call.answer"),
      decline: t("call.decline"),
      path: dmPath(org.id, incoming.callerId),
    });
    return () => void closeCallNotice(channelId);
  }, [incoming, org.id, t]);

  // "Atender" and "Recusar" on the system's notification, passed on by the service worker.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads the latest ring through the store
  useEffect(
    () =>
      listenForCallActions((a: { action: CallAction; orgId: string; channelId: string }) => {
        const ring = ringsNow().get(a.channelId);
        if (a.orgId !== org.id || !ring || ring.calleeId !== live.current.me) return;
        if (a.action === "accept") void answer(ring);
        else if (a.action === "decline") decline(ring);
        else goToDm(ring.callerId);
      }),
    [org.id],
  );

  // Closing the page ends the call: the browser asks first.
  const inCall = session !== null;
  useEffect(() => {
    if (!inCall) return;
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [inCall]);

  const onCallDm = session ? pathname === dmPath(org.id, session.peerId) : false;
  const full = session !== null && onCallDm && !minimized;

  const api_ = useMemo<CallsApi>(() => ({ session, start, leave }), [session, start, leave]);
  if (!enabled) return <CallsContext.Provider value={null}>{children}</CallsContext.Provider>;

  return (
    <CallsContext.Provider value={api_}>
      {children}
      <CallCards
        incoming={incoming ? { channelId: incoming.channelId, name: incoming.callerName, video: incoming.video } : null}
        outgoing={outgoing}
        onAnswer={() => incoming && void answer(incoming)}
        onDecline={() => incoming && decline(incoming)}
        onCancel={cancel}
        onDismiss={clearOutgoing}
        onOpenDm={goToDm}
      />
      {session && (
        <div
          className={full ? "call" : "call call--mini"}
          // A full room covers the page and holds focus; minimized it is a bar over the page: nothing modal.
          {...(full
            ? { role: "dialog", "aria-modal": true, "aria-label": t("call.with", { name: session.name }) }
            : { role: "region", "aria-label": t("call.miniLabel", { name: session.name }) })}
        >
          {session.state === "live" && session.token ? (
            <Suspense fallback={<p className="call__state">{t("call.joining")}</p>}>
              <CallRoom
                key={session.token.room}
                call={session.token}
                video={session.video}
                name={session.name}
                minimized={!full}
                startedAt={session.startedAt}
                onConnected={() => setSession((s) => (s && !s.startedAt ? { ...s, startedAt: Date.now() } : s))}
                onLeave={leave}
                onMinimize={() => setMinimized(true)}
                onBack={() => {
                  setMinimized(false);
                  goToDm(session.peerId);
                }}
              />
            </Suspense>
          ) : session.state === "error" ? (
            <div className="call__state">
              <p>{session.error}</p>
              <button type="button" className="call__btn" onClick={leave}>
                {t("call.close")}
              </button>
            </div>
          ) : (
            <p className="call__state">{t("call.joining")}</p>
          )}
        </div>
      )}
    </CallsContext.Provider>
  );
}
