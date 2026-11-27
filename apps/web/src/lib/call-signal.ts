import type { CallEvent, CallRingingEvent, UserEvent } from "@agenteschat/client";
import { useSyncExternalStore } from "react";

/**
 * What the socket says about rings (`call.ringing`, `call.ended`), kept for the whole tab: the provider above the
 * routes acts on it, and the sidebar reads who is ringing now. Nothing here talks to the server.
 */

const listeners = new Set<() => void>();
const endListeners = new Set<(event: Extract<CallEvent, { type: "call.ended" }>) => void>();
let rings: ReadonlyMap<string, CallRingingEvent> = new Map();

const emit = () => {
  for (const l of listeners) l();
};

export const isCallEvent = (event: UserEvent): event is CallEvent =>
  event.type === "call.ringing" || event.type === "call.ended";

/** Feeds one socket event; anything that isn't a call event is ignored. */
export function applyCallEvent(event: UserEvent): void {
  if (!isCallEvent(event)) return;
  const next = new Map(rings);
  if (event.type === "call.ringing") {
    next.set(event.channelId, event);
    rings = next;
    emit();
    return;
  }
  next.delete(event.channelId);
  rings = next;
  emit();
  for (const l of endListeners) l(event);
}

export const ringsNow = () => rings;
export const subscribeRings = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};
/** Called once per `call.ended`, after the ring left `ringsNow`. */
export const onRingEnded = (cb: (event: Extract<CallEvent, { type: "call.ended" }>) => void) => {
  endListeners.add(cb);
  return () => {
    endListeners.delete(cb);
  };
};

/** Forgets everything (another workspace, or a test). */
export function resetRings(): void {
  rings = new Map();
  emit();
}

/** The person on the other end of the ring in this conversation, or null. */
export const ringPeer = (ring: CallRingingEvent, me: string) => (ring.callerId === me ? ring.calleeId : ring.callerId);

/** Whether this person is ringing me, or being rung by me, right now: the sidebar's "ligando…" on their row. */
export function useRingingWith(userId: string, me: string): boolean {
  const all = useSyncExternalStore(subscribeRings, ringsNow);
  for (const ring of all.values())
    if (ringPeer(ring, me) === userId && (ring.callerId === me || ring.calleeId === me)) return true;
  return false;
}
