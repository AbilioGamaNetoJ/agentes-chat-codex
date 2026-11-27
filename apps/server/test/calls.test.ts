import { userTopic } from "@agenteschat/adapters";
import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/** Calls inside a conversation: a join token for its room alone, signed on the server (ADR 0220). */

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const LIVEKIT = {
  LIVEKIT_URL: "wss://rtc.example.com",
  LIVEKIT_API_KEY: "APIkeyForTests",
  LIVEKIT_API_SECRET: "livekit_secret_do_not_leak_0123456789abcdef",
};

const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString());

test("the token opens only this conversation's room, for someone who can read it, and never carries the secret", async () => {
  t = await createTestServer({ env: LIVEKIT, reply: () => ({ chunks: ["Ok."] }) });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const created = await api("/channels", { json: { name: "diretoria", visibility: "private" } });
  const { id: channelId } = (await created.json()) as { id: string };

  expect(await (await api("/calls")).json()).toEqual({ enabled: true });
  const res = await api(`/channels/${channelId}/call-token`, { json: {} });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).not.toContain(LIVEKIT.LIVEKIT_API_SECRET);
  const body = JSON.parse(text) as { url: string; token: string; room: string; expiresIn: number };
  expect(body.url).toBe(LIVEKIT.LIVEKIT_URL);
  expect(body.room).toBe(`channel:${channelId}`);
  const payload = claims(body.token);
  expect(payload.iss).toBe(LIVEKIT.LIVEKIT_API_KEY);
  expect(payload.video.room).toBe(body.room);
  expect(payload.video.roomJoin).toBe(true);
  expect(payload.exp - payload.nbf).toBeLessThanOrEqual(600);

  // Someone in the workspace who isn't in the private channel gets nothing.
  const outsider = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const denied = await outsider(`/api/app/organizations/${orgId}/channels/${channelId}/call-token`, { json: {} });
  expect(denied.status).toBeGreaterThanOrEqual(403);
  expect(await denied.text()).not.toContain("token");
});

test("without LiveKit set up there are no calls", async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["Ok."] }) });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  expect(await (await owner(`/api/app/organizations/${orgId}/calls`)).json()).toEqual({ enabled: false });
  const res = await owner(`/api/app/organizations/${orgId}/channels/${channelId}/call-token`, { json: {} });
  expect(res.status).toBe(404);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe("calls_unavailable");
});

/* Ringing: a ring, its answer, and who hears about it (the callee's and the caller's own tabs). */

const ringSetup = async () => {
  t = await createTestServer({ env: LIVEKIT, reply: () => ({ chunks: ["Ok."] }) });
  const owner = browser(t);
  const me = await signUp(owner, "owner@example.com");
  void me;
  const { orgId } = await seedOrg(owner);
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const leo = await joinByInvitation(t, owner, orgId, "leo@example.com");
  const idOf = async (b: typeof owner) =>
    ((await (await b("/api/app/me")).json()) as { user: { id: string } }).user.id;
  const [ownerId, biaId, leoId] = [await idOf(owner), await idOf(bia), await idOf(leo)];
  const base = `/api/app/organizations/${orgId}`;
  const dm = async (b: typeof owner, userId: string) =>
    ((await (await b(`${base}/dms`, { json: { userId } })).json()) as { channelId: string }).channelId;
  const events: Record<string, { type: string; reason?: string; calleeId?: string }[]> = { [ownerId]: [], [biaId]: [] };
  for (const id of [ownerId, biaId]) {
    t.adapters.pubsub.subscribe(userTopic(orgId, id), (e: unknown) => {
      if ((e as { type: string }).type.startsWith("call.")) events[id]?.push(e as { type: string });
    });
  }
  const call = (b: typeof owner, channelId: string, action: string, json: object = {}) =>
    b(`${base}/channels/${channelId}/call/${action}`, { json });
  return { owner, bia, leo, ownerId, biaId, leoId, base, dm, events, call };
};

test("a ring reaches both people, and accepting clears it for both", async () => {
  const s = await ringSetup();
  const ch = await s.dm(s.owner, s.biaId);
  const res = await s.call(s.owner, ch, "ring", { video: true });
  expect(res.status).toBe(200);
  await Bun.sleep(20);
  for (const id of [s.ownerId, s.biaId]) {
    expect(s.events[id]?.[0]).toMatchObject({ type: "call.ringing", callerId: s.ownerId, calleeId: s.biaId, video: true });
  }
  // Only the callee answers.
  expect(((await (await s.call(s.owner, ch, "accept")).json()) as { cleared: boolean }).cleared).toBe(false);
  expect(((await (await s.call(s.bia, ch, "accept")).json()) as { cleared: boolean }).cleared).toBe(true);
  await Bun.sleep(20);
  for (const id of [s.ownerId, s.biaId]) expect(s.events[id]?.[1]).toMatchObject({ type: "call.ended", reason: "accepted" });
  // Idempotent.
  expect(((await (await s.call(s.bia, ch, "accept")).json()) as { cleared: boolean }).cleared).toBe(false);
});

test("declining and cancelling end the ring with their reason", async () => {
  const s = await ringSetup();
  const ch = await s.dm(s.owner, s.biaId);
  await s.call(s.owner, ch, "ring", {});
  await s.call(s.bia, ch, "decline", { reason: "busy" });
  await s.call(s.owner, ch, "ring", {});
  // The callee can't cancel it; the caller can.
  expect(((await (await s.call(s.bia, ch, "cancel")).json()) as { cleared: boolean }).cleared).toBe(false);
  await s.call(s.owner, ch, "cancel");
  await Bun.sleep(20);
  expect(s.events[s.biaId]?.filter((e) => e.type === "call.ended").map((e) => e.reason)).toEqual(["busy", "cancelled"]);
});

test("someone already ringing elsewhere is busy; a conversation that isn't a DM of two people can't ring", async () => {
  const s = await ringSetup();
  const withBia = await s.dm(s.owner, s.biaId);
  const leoToBia = await s.dm(s.leo, s.biaId);
  expect((await s.call(s.owner, withBia, "ring")).status).toBe(200);
  const busy = await s.call(s.leo, leoToBia, "ring");
  expect(busy.status).toBe(409);
  expect(((await busy.json()) as { error: { code: string } }).error.code).toBe("call_busy");
  const general = (await (await s.owner(`${s.base}/channels`)).json()) as { channels?: { id: string }[] } | { id: string }[];
  const first = Array.isArray(general) ? general[0] : general.channels?.[0];
  const notDm = await s.call(s.owner, first?.id ?? "", "ring");
  expect(notDm.status).toBe(400);
  expect(((await notDm.json()) as { error: { code: string } }).error.code).toBe("call_not_direct");
});

test("someone outside the DM can't ring it, and rings are rate-limited", async () => {
  const s = await ringSetup();
  const ch = await s.dm(s.owner, s.biaId);
  expect((await s.call(s.leo, ch, "ring")).status).toBeGreaterThanOrEqual(403);
  let last = 200;
  for (let i = 0; i < 12; i++) {
    await s.call(s.owner, ch, "cancel");
    last = (await s.call(s.owner, ch, "ring")).status;
    if (last === 429) break;
  }
  expect(last).toBe(429);
});
