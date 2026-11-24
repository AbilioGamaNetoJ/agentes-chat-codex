# 0220. Calls on LiveKit

- Status: Accepted
- Date: 2026-11-24
- Code: config `packages/config/src/schema.ts` (`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`); server
  `routes/app/calls.ts` (`GET …/calls`, `POST …/channels/{channelId}/call-token`), test `test/calls.test.ts`

## Context

People talk in conversations but had to leave the app to call. A LiveKit server is cheaper and simpler to run than
building media transport, and its client SDK runs in the browser, so the call can open on the same screen.

## Decision

1. Calls are optional: with `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` all set a conversation shows a
   call button; with any missing there are no calls and the token route answers 404 `calls_unavailable`.
2. The key and secret never leave the server (the rule for every key here). The browser asks
   `POST …/channels/{channelId}/call-token`; the server runs `requireChannelAccess` first, so only someone who can
   read the conversation gets a token (a DM is joined only by its two sides, a private channel by its members), then
   signs a ten-minute LiveKit token that opens that conversation's room alone (`channel:<channelId>`), with the
   person's id as identity and their name.
3. Tokens are rate-limited per person (20 a minute).
4. Screen sharing captures the screen of the machine whoever shares is on (`getDisplayMedia`, system audio where the
   browser gives it); nothing here reaches a remote screen.

## Consequences

The call has no record in the chat's database: a room exists while someone is in it. Who is in a call is LiveKit's
state, not ours; a later step may post call start and end in the conversation.

## Known gaps

- No ring or invite: the other side joins only by pressing the call button in the DM themselves. A notification step is future work.
- The room has not been exercised by hand against `rtc.codexcreate.cloud` yet; the token route is covered by tests, the media path is not.
