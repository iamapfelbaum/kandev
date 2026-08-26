import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WebSocketClient } from "./client";

type SentRequest = {
  id: string;
  type: string;
  action: string;
  payload: unknown;
};

const CANVAS_ID = "canvas-1";
const CANVAS_SUBSCRIBE_ACTION = "canvas.subscribe";

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly sent: SentRequest[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as SentRequest);
  }

  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1006, reason: "network lost" } as CloseEvent);
  }

  static latest() {
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) throw new Error("No fake websocket exists");
    return socket;
  }

  static reset() {
    FakeWebSocket.instances = [];
  }
}

function connectClient(options?: ConstructorParameters<typeof WebSocketClient>[2]) {
  const client = new WebSocketClient("ws://test", undefined, {
    enabled: false,
    ...options,
  });
  client.connect();
  const socket = FakeWebSocket.latest();
  socket.open();
  return { client, socket };
}

function sessionSubscribeRequest(socket: FakeWebSocket, index = 0) {
  const request = socket.sent.filter((message) => message.action === "session.subscribe")[index];
  if (!request) throw new Error("No session.subscribe request was sent");
  return request;
}

function acknowledge(socket: FakeWebSocket, request: SentRequest) {
  socket.receive({
    id: request.id,
    type: "response",
    payload: { success: true },
  });
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  FakeWebSocket.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("session subscription readiness", () => {
  it("resolves only after the server acknowledges the registration", async () => {
    const { client, socket } = connectClient();
    const subscription = client.subscribeSessionWithReady("sess-1");
    const request = sessionSubscribeRequest(socket);
    let ready = false;

    void subscription.ready.then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);

    acknowledge(socket, request);

    await expect(subscription.ready).resolves.toBeUndefined();
    expect(ready).toBe(true);
    subscription.unsubscribe();
  });

  it("shares one in-flight acknowledgement between ref-counted consumers", async () => {
    const { client, socket } = connectClient();
    const first = client.subscribeSessionWithReady("sess-1");
    const second = client.subscribeSessionWithReady("sess-1");

    expect(second.ready).toBe(first.ready);
    expect(socket.sent.filter((message) => message.action === "session.subscribe")).toHaveLength(1);

    acknowledge(socket, sessionSubscribeRequest(socket));
    await expect(second.ready).resolves.toBeUndefined();

    first.unsubscribe();
    second.unsubscribe();
  });

  it("allows a failed registration to be retried with fresh readiness", async () => {
    const { client, socket } = connectClient();
    const subscription = client.subscribeSessionWithReady("sess-1");
    const firstRequest = sessionSubscribeRequest(socket);

    socket.receive({
      id: firstRequest.id,
      type: "error",
      payload: { message: "session is not ready" },
    });
    await expect(subscription.ready).rejects.toThrow("session is not ready");

    const retry = client.resubscribeSession("sess-1");
    const retryRequest = sessionSubscribeRequest(socket, 1);
    expect(retry).not.toBe(subscription.ready);

    acknowledge(socket, retryRequest);
    await expect(retry).resolves.toBeUndefined();
    subscription.unsubscribe();
  });

  it("tracks the re-registration after reconnect", async () => {
    vi.useFakeTimers();
    const { client, socket } = connectClient({ enabled: true, initialDelay: 0, maxAttempts: 1 });
    const initial = client.subscribeSessionWithReady("sess-1");
    acknowledge(socket, sessionSubscribeRequest(socket));
    await expect(initial.ready).resolves.toBeUndefined();

    socket.close();
    vi.advanceTimersByTime(0);
    const reconnectedSocket = FakeWebSocket.latest();
    reconnectedSocket.open();

    const reconnected = client.subscribeSessionWithReady("sess-1");
    const reconnectRequest = sessionSubscribeRequest(reconnectedSocket, 0);
    expect(reconnectRequest.payload).toEqual({ session_id: "sess-1" });
    expect(reconnected.ready).not.toBe(initial.ready);

    acknowledge(reconnectedSocket, reconnectRequest);
    await expect(reconnected.ready).resolves.toBeUndefined();
    initial.unsubscribe();
    reconnected.unsubscribe();
  });
});

describe("canvas subscriptions", () => {
  it("sends one subscription for multiple consumers and unsubscribes on the last release", () => {
    const { client, socket } = connectClient();

    const first = client.subscribeCanvas(CANVAS_ID);
    const second = client.subscribeCanvas(CANVAS_ID);
    expect(
      socket.sent.filter((message) => message.action === CANVAS_SUBSCRIBE_ACTION),
    ).toHaveLength(1);

    first();
    expect(socket.sent.filter((message) => message.action === "canvas.unsubscribe")).toHaveLength(
      0,
    );
    second();
    expect(socket.sent.filter((message) => message.action === "canvas.unsubscribe")).toHaveLength(
      1,
    );
  });

  it("re-subscribes active canvases after reconnect", () => {
    vi.useFakeTimers();
    const { client, socket } = connectClient({ enabled: true, initialDelay: 0, maxAttempts: 1 });
    const release = client.subscribeCanvas(CANVAS_ID);

    socket.close();
    vi.runOnlyPendingTimers();
    const reconnectedSocket = FakeWebSocket.latest();
    reconnectedSocket.open();

    expect(
      reconnectedSocket.sent.filter((message) => message.action === CANVAS_SUBSCRIBE_ACTION),
    ).toHaveLength(1);
    release();
  });

  it("delivers the subscription snapshot response to canvas handlers", async () => {
    const { client, socket } = connectClient();
    const snapshots: number[] = [];
    const removeHandler = client.onCanvasSubscription(CANVAS_ID, (payload) => {
      snapshots.push(payload.canvas.revision);
    });
    const release = client.subscribeCanvas(CANVAS_ID);
    const request = socket.sent.find((message) => message.action === CANVAS_SUBSCRIBE_ACTION);
    if (!request) throw new Error(`No ${CANVAS_SUBSCRIBE_ACTION} request was sent`);

    socket.receive({
      id: request.id,
      type: "response",
      payload: {
        canvas: { id: CANVAS_ID, revision: 3 },
        events: [],
        recovery: "snapshot",
      },
    });

    await Promise.resolve();
    expect(snapshots).toEqual([3]);
    removeHandler();
    release();
  });
});

describe("canvas subscription recovery", () => {
  it("advances the applied revision for ordered canvas events", async () => {
    const { client, socket } = connectClient();
    const release = client.subscribeCanvas(CANVAS_ID);
    const request = socket.sent.find((message) => message.action === CANVAS_SUBSCRIBE_ACTION);
    if (!request) throw new Error(`No ${CANVAS_SUBSCRIBE_ACTION} request was sent`);
    socket.receive({
      id: request.id,
      type: "response",
      payload: { canvas: { id: CANVAS_ID, revision: 0 }, events: [], recovery: "events" },
    });
    await Promise.resolve();

    socket.receive({
      type: "notification",
      action: "canvas.event",
      payload: { canvas_id: CANVAS_ID, revision: 1, action: "canvas.rename" },
    });

    expect(client.getCanvasSubscriptionState(CANVAS_ID)).toMatchObject({
      status: "connected",
      revision: 1,
      gap: false,
    });
    release();
  });

  it("marks a skipped canvas event as recovering without applying the gap", async () => {
    const { client, socket } = connectClient();
    const release = client.subscribeCanvas(CANVAS_ID);
    const request = socket.sent.find((message) => message.action === CANVAS_SUBSCRIBE_ACTION);
    if (!request) throw new Error(`No ${CANVAS_SUBSCRIBE_ACTION} request was sent`);
    socket.receive({
      id: request.id,
      type: "response",
      payload: { canvas: { id: CANVAS_ID, revision: 0 }, events: [], recovery: "events" },
    });
    await Promise.resolve();

    socket.receive({
      type: "notification",
      action: "canvas.event",
      payload: { canvas_id: CANVAS_ID, revision: 2, action: "canvas.rename" },
    });

    expect(client.getCanvasSubscriptionState(CANVAS_ID)).toMatchObject({
      status: "recovering",
      revision: 0,
      gap: true,
    });
    client.acknowledgeCanvasRevision(CANVAS_ID, 2);
    expect(client.getCanvasSubscriptionState(CANVAS_ID)).toMatchObject({
      status: "connected",
      revision: 2,
      gap: false,
    });
    release();
  });
});

describe("canvas subscription reconnect recovery", () => {
  it("delivers the recovery response after reconnect", async () => {
    vi.useFakeTimers();
    const { client, socket } = connectClient({ enabled: true, initialDelay: 0, maxAttempts: 1 });
    const snapshots: number[] = [];
    const removeHandler = client.onCanvasSubscription(CANVAS_ID, (payload) => {
      snapshots.push(payload.canvas.revision);
    });
    const release = client.subscribeCanvas(CANVAS_ID);
    const initialRequest = socket.sent.find(
      (message) => message.action === CANVAS_SUBSCRIBE_ACTION,
    );
    if (!initialRequest) throw new Error(`No initial ${CANVAS_SUBSCRIBE_ACTION} request was sent`);
    socket.receive({
      id: initialRequest.id,
      type: "response",
      payload: { canvas: { id: CANVAS_ID, revision: 1 }, events: [], recovery: "events" },
    });
    await Promise.resolve();

    socket.close();
    vi.runOnlyPendingTimers();
    const reconnectedSocket = FakeWebSocket.latest();
    reconnectedSocket.open();
    const reconnectRequest = reconnectedSocket.sent.find(
      (message) => message.action === CANVAS_SUBSCRIBE_ACTION,
    );
    if (!reconnectRequest)
      throw new Error(`No reconnect ${CANVAS_SUBSCRIBE_ACTION} request was sent`);
    reconnectedSocket.receive({
      id: reconnectRequest.id,
      type: "response",
      payload: { canvas: { id: CANVAS_ID, revision: 4 }, events: [], recovery: "events" },
    });
    await Promise.resolve();

    expect(snapshots).toEqual([1, 4]);
    removeHandler();
    release();
  });

  it("sends the latest applied revision on reconnect", async () => {
    vi.useFakeTimers();
    const { client, socket } = connectClient({ enabled: true, initialDelay: 0, maxAttempts: 1 });
    const release = client.subscribeCanvas(CANVAS_ID);
    const initialRequest = socket.sent.find(
      (message) => message.action === CANVAS_SUBSCRIBE_ACTION,
    );
    if (!initialRequest) throw new Error(`No initial ${CANVAS_SUBSCRIBE_ACTION} request was sent`);
    expect(initialRequest.payload).toEqual({ canvas_id: CANVAS_ID, after_revision: 0 });
    socket.receive({
      id: initialRequest.id,
      type: "response",
      payload: { canvas: { id: CANVAS_ID, revision: 7 }, events: [], recovery: "events" },
    });
    await Promise.resolve();

    socket.close();
    vi.runOnlyPendingTimers();
    const reconnectedSocket = FakeWebSocket.latest();
    reconnectedSocket.open();
    const reconnectRequest = reconnectedSocket.sent.find(
      (message) => message.action === CANVAS_SUBSCRIBE_ACTION,
    );
    if (!reconnectRequest)
      throw new Error(`No reconnect ${CANVAS_SUBSCRIBE_ACTION} request was sent`);
    expect(reconnectRequest.payload).toEqual({ canvas_id: CANVAS_ID, after_revision: 7 });
    release();
  });

  it("exposes a recovery state when the ordered event stream has a gap", async () => {
    const { client, socket } = connectClient();
    const states: Array<{ status: string; gap: boolean }> = [];
    const removeState = client.onCanvasSubscriptionState(CANVAS_ID, (state) => {
      states.push({ status: state.status, gap: state.gap });
    });
    const release = client.subscribeCanvas(CANVAS_ID);
    const request = socket.sent.find((message) => message.action === CANVAS_SUBSCRIBE_ACTION);
    if (!request) throw new Error(`No ${CANVAS_SUBSCRIBE_ACTION} request was sent`);
    socket.receive({
      id: request.id,
      type: "response",
      payload: {
        canvas: { id: CANVAS_ID, revision: 3 },
        events: [{ revision: 2 }],
        recovery: "events",
      },
    });
    await Promise.resolve();
    expect(states.at(-1)).toEqual({ status: "recovering", gap: true });
    removeState();
    release();
  });
});

describe("canvas connection state", () => {
  it("marks active canvases unavailable when the socket disconnects", () => {
    const { client, socket } = connectClient();
    const states: string[] = [];
    const removeState = client.onCanvasSubscriptionState(CANVAS_ID, (state) => {
      states.push(state.status);
    });
    const release = client.subscribeCanvas(CANVAS_ID);

    socket.close();

    expect(states.at(-1)).toBe("error");
    removeState();
    release();
  });
});

describe("session subscription reconnect recovery", () => {
  it("keeps queued hydration behind the reconnect subscription acknowledgement", async () => {
    vi.useFakeTimers();
    const { client, socket } = connectClient({ enabled: true, initialDelay: 0, maxAttempts: 1 });
    const initial = client.subscribeSessionWithReady("sess-1");
    acknowledge(socket, sessionSubscribeRequest(socket));
    await expect(initial.ready).resolves.toBeUndefined();

    socket.close();
    const reconnectReadiness = client.getSessionSubscriptionReadiness("sess-1");
    let readinessResolved = false;
    void reconnectReadiness.then(() => {
      readinessResolved = true;
    });
    client.send({
      id: "hydration-1",
      type: "request",
      action: "message.list",
      payload: { session_id: "sess-1" },
    });
    await Promise.resolve();
    expect(readinessResolved).toBe(false);

    vi.runOnlyPendingTimers();
    const reconnectedSocket = FakeWebSocket.latest();
    reconnectedSocket.open();

    expect(reconnectedSocket.sent.map((message) => message.action)).toEqual([
      "session.subscribe",
      "message.list",
    ]);
    const reconnectRequest = sessionSubscribeRequest(reconnectedSocket);
    const hydrationRequest = reconnectedSocket.sent.find(
      (message) => message.action === "message.list",
    );
    if (!hydrationRequest) throw new Error("No queued message.list request was sent");

    acknowledge(reconnectedSocket, reconnectRequest);
    await expect(reconnectReadiness).resolves.toBeUndefined();
    expect(hydrationRequest.id).toBe("hydration-1");
    initial.unsubscribe();
  });

  it("rejects an active readiness when reconnect recovery is disabled", async () => {
    const { client, socket } = connectClient({ enabled: false });
    const subscription = client.subscribeSessionWithReady("sess-1");
    socket.close();

    await expect(subscription.ready).rejects.toThrow("WebSocket connection closed");
    subscription.unsubscribe();
  });
});
