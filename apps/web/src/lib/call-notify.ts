import { inDesktopApp, thisMac } from "./desktop";

/**
 * The system's notification for a call that rings (ADR 0220): shown while the tab is behind, closed the moment the
 * ring ends. With the service worker it carries "Atender" and "Recusar"; without, a plain notification that brings
 * the tab forward on a click; in the desktop app, the app's own notification.
 */

export const CALL_ACTION_MESSAGE = "agentes.call.action";
export type CallAction = "accept" | "decline" | "open";

const tagOf = (channelId: string) => `call:${channelId}`;
const SW_URL = "/sw.js";

const supported = () => typeof Notification !== "undefined";
export const callPermission = (): NotificationPermission | "unsupported" =>
  supported() ? Notification.permission : "unsupported";

/** Asks once, on the first click that starts a call, when the person never chose. Never throws. */
export async function askCallPermission(): Promise<void> {
  if (!supported() || Notification.permission !== "default" || inDesktopApp()) return;
  try {
    await Notification.requestPermission();
  } catch {
    // Some browsers refuse outside a gesture: the visual ring still works.
  }
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return (
      (await navigator.serviceWorker.getRegistration("/")) ??
      (await navigator.serviceWorker.register(SW_URL, { scope: "/" }))
    );
  } catch {
    return null;
  }
}

export interface CallNotice {
  channelId: string;
  orgId: string;
  title: string;
  body: string;
  accept: string;
  decline: string;
  /** Where a click goes (the DM of the caller). */
  path: string;
}

/** Shows the ring in the system's list. Never throws; nothing shows without permission. */
export async function showCallNotice(n: CallNotice): Promise<void> {
  try {
    if (inDesktopApp()) {
      await thisMac.notify(n.title, n.body, n.path);
      return;
    }
    if (!supported() || Notification.permission !== "granted") return;
    const reg = await registration();
    const data = { call: { orgId: n.orgId, channelId: n.channelId }, url: n.path };
    if (reg) {
      await reg.showNotification(n.title, {
        body: n.body,
        tag: tagOf(n.channelId),
        requireInteraction: true,
        renotify: true,
        data,
        icon: "/email/mark.png",
        actions: [
          { action: "accept", title: n.accept },
          { action: "decline", title: n.decline },
        ],
      } as NotificationOptions);
      return;
    }
    const plain = new Notification(n.title, { body: n.body, tag: tagOf(n.channelId), requireInteraction: true });
    plain.onclick = () => {
      window.focus();
      plain.close();
    };
  } catch {
    // The card in the page is the fallback.
  }
}

/** Takes the ring off the system's list. Never throws. */
export async function closeCallNotice(channelId: string): Promise<void> {
  try {
    const reg =
      typeof navigator !== "undefined" && "serviceWorker" in navigator
        ? await navigator.serviceWorker.getRegistration("/")
        : null;
    for (const shown of (await reg?.getNotifications({ tag: tagOf(channelId) })) ?? []) shown.close();
  } catch {
    // Quiet.
  }
}

/** A click or action on the notification, passed on by the service worker to the tab. */
export function listenForCallActions(
  onAction: (a: { action: CallAction; orgId: string; channelId: string }) => void,
): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => {};
  const container = navigator.serviceWorker;
  const onMessage = (event: MessageEvent) => {
    const d = event.data as { type?: unknown; action?: unknown; orgId?: unknown; channelId?: unknown } | null;
    if (!d || d.type !== CALL_ACTION_MESSAGE || typeof d.orgId !== "string" || typeof d.channelId !== "string") return;
    const action = d.action === "accept" || d.action === "decline" ? d.action : "open";
    onAction({ action, orgId: d.orgId, channelId: d.channelId });
  };
  container.addEventListener("message", onMessage);
  container.startMessages?.();
  return () => container.removeEventListener("message", onMessage);
}
