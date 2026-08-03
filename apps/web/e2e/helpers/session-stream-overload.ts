import { expect, type Page } from "@playwright/test";
import type { ApiClient } from "./api-client";
import type { GatewayTrafficFrame } from "./ws-traffic";

export const REASONING_BURST_COUNT = 2_000;

export function reasoningBurstPrompt(count = REASONING_BURST_COUNT): string {
  return `e2e:reasoning_burst(${count})`;
}

export function expectedReasoningContent(count = REASONING_BURST_COUNT): string {
  let content = "";
  for (let index = 1; index <= count; index += 1) {
    content += `reasoning-burst-${String(index).padStart(6, "0")}|`;
  }
  return content;
}

export async function waitForExactReasoningBurst(
  apiClient: ApiClient,
  sessionId: string,
  count = REASONING_BURST_COUNT,
): Promise<{ sourceChunks: number; reasoningBytes: number }> {
  const expected = expectedReasoningContent(count);
  const firstChunk = `reasoning-burst-${String(1).padStart(6, "0")}|`;
  const findBurst = (messages: Awaited<ReturnType<ApiClient["listSessionMessages"]>>["messages"]) =>
    messages.find((message) => String(message.metadata?.thinking ?? "").startsWith(firstChunk));
  let latestMessages: Awaited<ReturnType<ApiClient["listSessionMessages"]>>["messages"] = [];
  await expect
    .poll(
      async () => {
        latestMessages = (await apiClient.listSessionMessages(sessionId)).messages;
        const marker = latestMessages.some(
          (message) => message.content === `reasoning-burst-produced:${count}`,
        );
        const reasoning = findBurst(latestMessages);
        return marker && reasoning?.metadata?.thinking === expected;
      },
      {
        timeout: 120_000,
        message: `reasoning burst did not persist exact ${count}-chunk content`,
      },
    )
    .toBe(true);

  const reasoning = findBurst(latestMessages);
  return {
    sourceChunks: count,
    reasoningBytes: Buffer.byteLength(String(reasoning?.metadata?.thinking ?? ""), "utf8"),
  };
}

/**
 * Resolve once `capture`'s page is *currently* subscribed to `sessionId`.
 *
 * The burst is emitted with no per-chunk delay, and the gateway coalescer
 * merges the whole run into one or two `session.message.updated` frames inside
 * a single 100ms window. An observer that is not subscribed at that instant
 * records nothing at all — the traffic it exists to measure is already gone.
 * Gate the burst on a live subscription rather than racing a browser page boot
 * against agent start-up.
 *
 * "Currently" matters: a page that briefly subscribes during boot and then
 * settles on a different session (the mobile layout displays one session at a
 * time and drops the rest) would satisfy a naive "has ever subscribed" check
 * while receiving none of the traffic.
 */
export async function waitForSessionSubscription(
  capture: { frames: readonly GatewayTrafficFrame[] },
  sessionId: string,
): Promise<void> {
  await expect
    .poll(
      () => {
        const latest = capture.frames.findLast(
          (frame) =>
            frame.direction === "sent" &&
            frame.sessionId === sessionId &&
            (frame.action === "session.subscribe" || frame.action === "session.unsubscribe"),
        );
        return latest?.action === "session.subscribe";
      },
      { timeout: 30_000, message: `observer is not subscribed to session ${sessionId}` },
    )
    .toBe(true);
}

/** Wait until `sessionId` is idle, so a follow-up prompt opens a new turn. */
export async function waitForSessionAwaitingInput(
  apiClient: ApiClient,
  taskId: string,
  sessionId: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const { sessions } = await apiClient.listTaskSessions(taskId);
        return sessions.find((session) => session.id === sessionId)?.state ?? "";
      },
      { timeout: 60_000, message: `session ${sessionId} never returned to WAITING_FOR_INPUT` },
    )
    .toBe("WAITING_FOR_INPUT");
}

/**
 * Start the high-volume reasoning burst on a session that is already being
 * observed. Always call `waitForSessionSubscription` first — the frames this
 * produces are unrecoverable once emitted.
 */
export async function startReasoningBurst(
  apiClient: ApiClient,
  taskId: string,
  sessionId: string,
  count = REASONING_BURST_COUNT,
): Promise<void> {
  await apiClient.addUserMessage(taskId, sessionId, reasoningBurstPrompt(count));
}

/**
 * Frame actions that carry the noisy session's message stream to a client.
 *
 * Both actions matter. The stream coalescer folds adjacent append chunks into
 * one segment, and when the producer outruns the first chunk's persistence the
 * entire burst can land as a single `session.message.added` with no
 * `session.message.updated` at all. Counting only updates therefore measures a
 * scheduling accident rather than delivery, and reads as zero on a run where
 * the observer saw the whole stream.
 */
const NOISY_MESSAGE_ACTIONS = new Set(["session.message.added", "session.message.updated"]);

/**
 * Frames a client actually received for `sessionId`'s message stream. Used
 * both to prove an observer saw the stream (and saw far fewer frames than the
 * burst produced chunks) and to prove an unrelated view received none of it.
 */
export function noisyReceivedFrames(
  frames: readonly GatewayTrafficFrame[],
  sessionId: string,
): GatewayTrafficFrame[] {
  return frames.filter(
    (frame) =>
      frame.direction === "received" &&
      frame.sessionId === sessionId &&
      NOISY_MESSAGE_ACTIONS.has(frame.action ?? ""),
  );
}

export async function assertNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(dimensions.scrollWidth, `${label} scroll width`).toBeLessThanOrEqual(
    dimensions.clientWidth,
  );
}
