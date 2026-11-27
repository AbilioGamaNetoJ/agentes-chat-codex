import { and, eq, schema } from "@agenteschat/db";
import { publishUserEvent, requireChannelAccess } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { AccessToken } from "livekit-server-sdk";
import { apiError, errorResponse } from "../../http/errors";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Chat"];

/** A join token lives long enough to connect and reconnect, not to be kept: the room checks it only on entry. */
const TOKEN_TTL_SECONDS = 10 * 60;

/** Tokens signed per person a minute, so one account can't turn the server into a token mill. */
const TOKENS = { limit: 20, windowMs: 60_000 };

/** How long a ring waits for an answer before it counts as missed. */
export const RING_TTL_MS = 45_000;

/** Rings a person may start a minute: enough to retry, not to ring someone nonstop. */
const RINGS = { limit: 10, windowMs: 60_000 };

const ChannelParams = OrgParams.extend({ channelId: z.uuid() });

const CallToken = z
  .object({
    url: z.string().openapi({ description: "The LiveKit server's WebSocket address to connect to." }),
    token: z.string().openapi({ description: "A join token for this conversation's room, valid for a few minutes." }),
    room: z.string(),
    expiresIn: z.number().openapi({ description: "Seconds the token can be used to join." }),
  })
  .openapi("CallToken");

const RingInput = z.object({ video: z.boolean().default(false) }).openapi("CallRingInput");
const RingResult = z
  .object({
    expiresAt: z.string().openapi({ description: "When the ring is missed if nobody answers (ISO 8601)." }),
    ttlSeconds: z.number(),
  })
  .openapi("CallRing");
const DeclineInput = z.object({ reason: z.enum(["declined", "busy"]).default("declined") }).openapi("CallDeclineInput");
const Cleared = z
  .object({ cleared: z.boolean().openapi({ description: "False when there was no ring to answer (already over)." }) })
  .openapi("CallCleared");

const CallStatus = z.object({ enabled: z.boolean() }).openapi("CallStatus");

/** The room of a conversation: its channel id, which is unique across workspaces, so no two rooms can meet. */
export const callRoomOf = (channelId: string) => `channel:${channelId}`;

/**
 * Audio and video calls inside a conversation, on the LiveKit server in `LIVEKIT_URL`. The browser never holds the
 * key and secret: this route checks the person can read the conversation (`requireChannelAccess`, so a DM is only
 * ever joined by its two sides) and signs a short-lived token for that conversation's room alone.
 */
/** A ring waiting for an answer: one per conversation, kept in this process for `RING_TTL_MS`. */
interface Ring {
  orgId: string;
  channelId: string;
  callerId: string;
  callerName: string;
  calleeId: string;
  video: boolean;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

/** Why a ring ended, as both sides hear it. */
export type RingEnd = "accepted" | "declined" | "cancelled" | "expired" | "busy";

export function callRoutes(deps: AppDeps) {
  const { db, config } = deps;
  const rings = new Map<string, Ring>();
  const pubsub = deps.adapters.pubsub;

  /** Both sides hear about a ring or its end on their own topic, in every tab they have open. */
  const tell = (ring: Ring, event: Record<string, unknown>) =>
    Promise.all(
      [ring.callerId, ring.calleeId].map((id) =>
        publishUserEvent(pubsub, ring.orgId, id, { ...event, orgId: ring.orgId, channelId: ring.channelId }),
      ),
    );
  const end = async (ring: Ring, reason: RingEnd) => {
    if (rings.get(ring.channelId) !== ring) return;
    clearTimeout(ring.timer);
    rings.delete(ring.channelId);
    await tell(ring, { type: "call.ended", reason, callerId: ring.callerId, calleeId: ring.calleeId });
  };
  const busy = (userId: string, channelId: string) =>
    [...rings.values()].some((r) => r.channelId !== channelId && (r.callerId === userId || r.calleeId === userId));
  /** The other person of a DM between two people, or null when it is anything else. */
  const otherOfDm = async (orgId: string, channelId: string, kind: string, userId: string) => {
    if (kind !== "dm") return null;
    const members = await db
      .select({ userId: schema.channelMembers.userId, agentId: schema.channelMembers.agentId })
      .from(schema.channelMembers)
      .where(and(eq(schema.channelMembers.orgId, orgId), eq(schema.channelMembers.channelId, channelId)));
    if (members.length !== 2 || members.some((m) => !m.userId)) return null;
    return members.find((m) => m.userId !== userId)?.userId ?? null;
  };
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  const livekit = () => {
    const { LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = config;
    return url && key && secret ? { url, key, secret } : null;
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/calls",
      tags,
      security,
      summary: "Whether this server has calls turned on",
      description: "True when `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` are all set.",
      request: { params: OrgParams },
      responses: { 200: json(CallStatus), ...errors },
    }),
    async (c) => c.json({ enabled: livekit() !== null }, 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/channels/{channelId}/call-token",
      tags,
      security,
      summary: "A token to join this conversation's call",
      description:
        "For anyone who can read the conversation. The token only opens this conversation's room; its key and secret stay on the server. 404 `calls_unavailable` when calls aren't set up, 429 `rate_limited` past 20 a minute.",
      request: { params: ChannelParams },
      responses: {
        200: json(CallToken),
        ...errors,
        429: errorResponse("Too many tokens (`rate_limited`)"),
      },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      const user = c.get("user");
      await requireChannelAccess(db, user.id, orgId, channelId);
      const lk = livekit();
      if (!lk) return apiError(c, 404, "calls_unavailable", "Calls aren't set up on this server.");
      if (!(await deps.adapters.rateLimiter.consume(`call-token:${user.id}`, TOKENS)).allowed) {
        return apiError(c, 429, "rate_limited", "Too many tries. Wait a minute.");
      }
      const room = callRoomOf(channelId);
      const access = new AccessToken(lk.key, lk.secret, {
        identity: user.id,
        name: user.name,
        ttl: TOKEN_TTL_SECONDS,
      });
      access.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
      return c.json({ url: lk.url, token: await access.toJwt(), room, expiresIn: TOKEN_TTL_SECONDS }, 200);
    },
  );

  const ringRoute = (
    action: string,
    summary: string,
    description: string,
    input?: z.ZodType,
    ok: z.ZodType = Cleared,
  ) =>
    createRoute({
      method: "post",
      path: `/organizations/{orgId}/channels/{channelId}/call/${action}`,
      tags,
      security,
      summary,
      description,
      request: { params: ChannelParams, ...(input ? { body: body(input) } : {}) },
      responses: { 200: json(ok), ...errors, 429: errorResponse("Too many rings (`rate_limited`)") },
    });

  app.openapi(
    ringRoute(
      "ring",
      "Ring the other person of a direct message",
      "Only a DM between two people. Both sides hear `call.ringing` on their own socket for 45 seconds, until `call.ended` (accepted, declined, cancelled, expired or busy). 409 `call_busy` when either side is ringing in another conversation, 400 `call_not_direct` for anything but a DM between two people, 429 `rate_limited` past 10 a minute.",
      RingInput,
      RingResult,
    ),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      const { video } = c.req.valid("json");
      const user = c.get("user");
      const { channel } = await requireChannelAccess(db, user.id, orgId, channelId);
      if (!livekit()) return apiError(c, 404, "calls_unavailable", "Calls aren't set up on this server.");
      const calleeId = await otherOfDm(orgId, channelId, channel.kind, user.id);
      if (!calleeId) return apiError(c, 400, "call_not_direct", "Only a direct message between two people can ring.");
      if (!(await deps.adapters.rateLimiter.consume(`call-ring:${user.id}`, RINGS)).allowed) {
        return apiError(c, 429, "rate_limited", "Too many tries. Wait a minute.");
      }
      const earlier = rings.get(channelId);
      if (earlier) await end(earlier, "cancelled");
      if (busy(user.id, channelId) || busy(calleeId, channelId)) {
        return apiError(c, 409, "call_busy", "Someone is already on a call.");
      }
      const expiresAt = Date.now() + RING_TTL_MS;
      const ring: Ring = {
        orgId,
        channelId,
        callerId: user.id,
        callerName: user.name,
        calleeId,
        video,
        expiresAt,
        timer: setTimeout(() => void end(ring, "expired"), RING_TTL_MS),
      };
      ring.timer.unref?.();
      rings.set(channelId, ring);
      await tell(ring, {
        type: "call.ringing",
        callerId: user.id,
        callerName: user.name,
        calleeId,
        video,
        expiresAt: new Date(expiresAt).toISOString(),
      });
      return c.json({ expiresAt: new Date(expiresAt).toISOString(), ttlSeconds: RING_TTL_MS / 1000 }, 200);
    },
  );

  /** Answers a ring of this conversation: only the side it is for (`who`) may, and a ring already over is no error. */
  const answer = async (
    orgId: string,
    channelId: string,
    userId: string,
    who: "callerId" | "calleeId",
    reason: RingEnd,
  ) => {
    await requireChannelAccess(db, userId, orgId, channelId);
    const ring = rings.get(channelId);
    if (!ring || ring.orgId !== orgId || ring[who] !== userId) return { cleared: false };
    await end(ring, reason);
    return { cleared: true };
  };

  app.openapi(
    ringRoute(
      "cancel",
      "Stop ringing",
      "The caller hangs up before an answer. `call.ended` with `cancelled` goes to both.",
    ),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      return c.json(await answer(orgId, channelId, c.get("user").id, "callerId", "cancelled"), 200);
    },
  );
  app.openapi(
    ringRoute(
      "accept",
      "Answer a ring",
      "The person being rung picks up: `call.ended` with `accepted` goes to both, and each joins the room with a token.",
    ),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      return c.json(await answer(orgId, channelId, c.get("user").id, "calleeId", "accepted"), 200);
    },
  );
  app.openapi(
    ringRoute(
      "decline",
      "Turn a ring down",
      "The person being rung declines (`reason`: `declined`, or `busy` when they are on another call).",
      DeclineInput,
    ),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      const { reason } = c.req.valid("json");
      return c.json(await answer(orgId, channelId, c.get("user").id, "calleeId", reason), 200);
    },
  );

  return app;
}
