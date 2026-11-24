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
