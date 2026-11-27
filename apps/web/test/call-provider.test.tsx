import { afterEach, describe, expect, mock, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { applyCallEvent, resetRings } from "@/lib/call-signal";
import { createFakeApi, ENG_ID, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/* Calls above the routes (ADR 0220): the room outlives the DM, and a ring shows on both sides. */

let mounts = 0;
let unmounts = 0;
mock.module("@/components/call/CallRoom", () => ({
  default: ({ minimized, name }: { minimized: boolean; name: string }) => {
    const React = require("react") as typeof import("react");
    React.useEffect(() => {
      mounts++;
      return () => {
        unmounts++;
      };
    }, []);
    return <div data-testid="room" data-minimized={String(minimized)} data-name={name} />;
  },
}));

afterEach(() => {
  cleanup();
  resetRings();
  mounts = 0;
  unmounts = 0;
});

const click = (el: Element) => act(async () => fireEvent.click(el));
const CH = "dm-u-joao";
const setup = async (path: string) => {
  const state = seedState();
  state.callsEnabled = true;
  seedDm(state, { type: "person", id: "u-joao" });
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(6);
  return { ...r, state };
};
const ended = (reason: "accepted" | "declined" | "cancelled" | "expired" | "busy") =>
  act(async () =>
    applyCallEvent({
      type: "call.ended",
      orgId: ORG_ID,
      channelId: CH,
      callerId: "u-walter",
      calleeId: "u-joao",
      reason,
    }),
  );
const tokens = (s: ReturnType<typeof seedState>) => s.calls.filter((c) => c.method === "calls.token").length;

describe("calls", () => {
  test("a ring that is answered opens the room once, and it survives going to another screen and back", async () => {
    const { state } = await setup("dm/person/u-joao");
    await click(screen().getByRole("button", { name: "Ligação de voz" }));
    await settle(3);
    expect(state.calls.some((c) => c.method === "calls.ring")).toBe(true);
    expect(screen().getByText(/Chamando/)).toBeTruthy();
    expect(tokens(state)).toBe(0);

    await ended("accepted");
    await settle(4);
    expect(tokens(state)).toBe(1);
    expect(screen().getByTestId("room").getAttribute("data-minimized")).toBe("false");

    // Another conversation: the same room, now as a bar.
    await click(screen().getByRole("link", { name: /eng/ }));
    await settle(4);
    expect(screen().getByTestId("room").getAttribute("data-minimized")).toBe("true");
    expect(screen().getByRole("region", { name: /João/ })).toBeTruthy();

    // Back to the call's DM: still the same room, no new token.
    await click(within(screen().getByRole("navigation", { name: "Navegação do workspace" })).getByText("João"));
    await settle(4);
    expect(screen().getByTestId("room").getAttribute("data-minimized")).toBe("false");
    expect(tokens(state)).toBe(1);
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
  });

  test("the person who is rung sees the card and the sidebar says who is calling; declining clears both", async () => {
    const { state } = await setup(`c/${ENG_ID}`);
    await act(async () =>
      applyCallEvent({
        type: "call.ringing",
        orgId: ORG_ID,
        channelId: CH,
        callerId: "u-joao",
        callerName: "João",
        calleeId: "u-walter",
        video: false,
        expiresAt: new Date(Date.now() + 40_000).toISOString(),
      }),
    );
    await settle(2);
    const card = screen().getByRole("alert");
    expect(card.textContent).toContain("João");
    expect(document.querySelector(".sidebar__ringing")).toBeTruthy();

    await click(within(card).getByRole("button", { name: "Recusar" }));
    await settle(2);
    expect(state.calls.some((c) => c.method === "calls.decline")).toBe(true);
    await ended("declined");
    await settle(2);
    expect(document.querySelector(".sidebar__ringing")).toBeNull();
    expect(screen().queryByRole("alert")).toBeNull();
  });
});
