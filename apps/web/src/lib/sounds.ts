import { type SoundName, setSoundPlayer } from "@agenteschat/client/lib/sounds";
import { DEFAULT_SOUND_STYLE, isSoundStyle, renderSound, SAMPLE_RATE, type SoundStyle } from "@agenteschat/ui/sfx";
import { STORAGE_KEYS, sessionStore, storage } from "./storage";

/**
 * The app's sounds on the web and in the desktop app (ADR 0070): synthesized once per sound, played through
 * Web Audio, low. The choice (a style, or off) belongs to this device, like the theme.
 */
export type SoundChoice = SoundStyle | "off";

const CHANGE_EVENT = "agentes:sounds";
/** A cue under the conversation, never over it. */
const VOLUME = 0.35;
/** The same sound twice this close is one (a burst of events). */
const REPEAT_MS = 150;

const read = (): SoundChoice => {
  const saved = storage.get(STORAGE_KEYS.sounds);
  return saved === "off" || isSoundStyle(saved) ? saved : DEFAULT_SOUND_STYLE;
};
let choice: SoundChoice = read();

export const soundChoice = () => choice;
export const onSoundChoiceChange = (cb: () => void) => {
  window.addEventListener(CHANGE_EVENT, cb);
  return () => window.removeEventListener(CHANGE_EVENT, cb);
};
/** Saves the choice and lets the person hear the new style. */
export function setSoundChoice(next: SoundChoice) {
  choice = next;
  storage.set(STORAGE_KEYS.sounds, next);
  window.dispatchEvent(new Event(CHANGE_EVENT));
  play("mention");
}

let ctx: AudioContext | null = null;
let out: GainNode | null = null;
const buffers = new Map<string, AudioBuffer>();
const lastPlayed = new Map<SoundName, number>();

function audio(): AudioContext | null {
  if (ctx) return ctx;
  if (typeof AudioContext === "undefined") return null;
  ctx = new AudioContext();
  out = ctx.createGain();
  out.gain.value = VOLUME;
  out.connect(ctx.destination);
  return ctx;
}

function buffer(c: AudioContext, style: SoundStyle, name: SoundName) {
  const key = `${style}/${name}`;
  let b = buffers.get(key);
  if (!b) {
    const samples = renderSound(style, name);
    b = c.createBuffer(1, samples.length, SAMPLE_RATE);
    b.getChannelData(0).set(samples);
    buffers.set(key, b);
  }
  return b;
}

function play(name: SoundName) {
  if (choice === "off") return;
  const c = audio();
  // Before the first click or key the browser keeps audio off: nothing plays (late is worse than none).
  if (!c || !out || c.state !== "running") return;
  const now = performance.now();
  if (now - (lastPlayed.get(name) ?? -Infinity) < REPEAT_MS) return;
  lastPlayed.set(name, now);
  const source = c.createBufferSource();
  source.buffer = buffer(c, choice, name);
  source.connect(out);
  source.start();
}

/** Gap between two rings of a loop, after the sound itself. */
const LOOP_GAP_MS = 1200;
/** How soon a loop tries again while the browser still keeps audio off (no click or key yet). */
const LOOP_RETRY_MS = 500;

/**
 * A sound repeated (a call ringing) until the returned stop is called. Silent when the person's choice is off (the
 * screen still shows the call), and patient with a browser that keeps audio off until the first gesture: it asks to
 * resume the context and tries again, so the ring starts the moment it may. Always stop it when its owner goes.
 */
export function startLoop(name: SoundName, gapMs: number = LOOP_GAP_MS): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let source: AudioBufferSourceNode | null = null;
  const tick = () => {
    if (stopped) return;
    let next = LOOP_RETRY_MS;
    if (choice === "off") {
      next = 1000;
    } else {
      const c = audio();
      if (c && out) {
        if (c.state !== "running") {
          void c.resume().catch(() => {});
        } else {
          const buf = buffer(c, choice, name);
          source = c.createBufferSource();
          source.buffer = buf;
          source.connect(out);
          source.start();
          next = buf.duration * 1000 + gapMs;
        }
      }
    }
    timer = setTimeout(tick, next);
  };
  tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
    try {
      source?.stop();
    } catch {
      // Already over.
    }
    source = null;
  };
}

/**
 * The tab that had the person last: with the app open in several tabs, only that one plays what arrives while
 * hidden (each tab gets the same events).
 */
const TAB_ID = sessionStore.get(STORAGE_KEYS.soundTab) ?? Math.random().toString(36).slice(2);
sessionStore.set(STORAGE_KEYS.soundTab, TAB_ID);
const markActive = () => {
  if (document.visibilityState === "visible") storage.set(STORAGE_KEYS.soundTab, TAB_ID);
};

/** Whether a notification's sound is this tab's to play, and with the window behind others (`background`). */
export function notificationAudience(): { mine: boolean; background: boolean } {
  const background = document.visibilityState !== "visible" || !document.hasFocus();
  return { mine: document.visibilityState === "visible" || storage.get(STORAGE_KEYS.soundTab) === TAB_ID, background };
}

/** Once at start: the player for the shared code, and audio switched on by the person's first gesture. */
export function installSounds() {
  setSoundPlayer(play);
  markActive();
  document.addEventListener("visibilitychange", markActive);
  window.addEventListener("focus", markActive);
  const unlock = () => {
    const c = audio();
    if (!c) return;
    c.resume()
      .then(() => {
        if (c.state !== "running") return;
        window.removeEventListener("pointerdown", unlock, true);
        window.removeEventListener("keydown", unlock, true);
      })
      .catch(() => {});
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
}
