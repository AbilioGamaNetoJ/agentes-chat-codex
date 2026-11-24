import { requireChannelAccess } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { AccessToken } from "livekit-server-sdk";
import { apiError, errorResponse } from "../../http/errors";
import { type AppDeps, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Chat"];

/** A join token lives long enough to connect and reconnect, not to be kept: the room checks it only on entry. */
const TOKEN_TTL_SECONDS = 10 * 60;

/** Tokens signed per person a minute, so one account can't turn the server into a token mill. */
const TOKENS = { limit: 20, windowMs: 60_000 };

const ChannelParams = OrgParams.extend({ channelId: z.uuid() });

const CallToken = z
  .object({
    url: z.string().openapi({ description: "The LiveKit server's WebSocket address to connect to." }),
    token: z.string().openapi({ description: "A join token for this conversation's room, valid for a few minutes." }),
    room: z.string(),
    expiresIn: z.number().openapi({ description: "Seconds the token can be used to join." }),
  })
  .openapi("CallToken");

const CallStatus = z.object({ enabled: z.boolean() }).openapi("CallStatus");

/** The room of a conversation: its channel id, which is unique across workspaces, so no two rooms can meet. */
export const callRoomOf = (channelId: string) => `channel:${channelId}`;

/**
 * Audio and video calls inside a conversation, on the LiveKit server in `LIVEKIT_URL`. The browser never holds the
 * key and secret: this route checks the person can read the conversation (`requireChannelAccess`, so a DM is only
 * ever joined by its two sides) and signs a short-lived token for that conversation's room alone.
 */
export function callRoutes(deps: AppDeps) {
  const { db, config } = deps;
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

  return app;
}
