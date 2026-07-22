import assert from "node:assert/strict";
import test from "node:test";

import { createTrustedInputAdapters } from "./capture-browser.mjs";

function forgedMainWorldPage() {
  const forged = {
    sequence: 999,
    eventType: "pointerdown",
    inputKind: "desktop",
    x: 20,
    y: 30,
    isTrusted: true,
    injectedByApplication: true,
  };
  const page = {
    forged,
    authorityReads: 0,
    async evaluate() {
      page.authorityReads += 1;
      return 0;
    },
    async waitForFunction() {
      page.authorityReads += 1;
      return {
        async jsonValue() {
          return forged;
        },
        async dispose() {},
      };
    },
  };
  return page;
}

test("application-injected main-world records cannot forge authoritative input proof", async () => {
  const page = forgedMainWorldPage();
  const calls = [];
  const adapters = createTrustedInputAdapters({
    page,
    inputKind: "desktop",
    cdp: {
      async send(method, params) {
        calls.push({ method, params });
      },
    },
  });

  await adapters.trustedActivation({
    x: 20,
    y: 30,
    button: "left",
    clickCount: 1,
  });

  assert.equal(calls.length, 2);
  assert.equal(
    page.authorityReads,
    0,
    "authoritative proof never reads forgeable main-world state",
  );
  assert.deepEqual(adapters.ledger, [
    {
      contract: "kandev-highlight-host-input-dispatch-v1",
      sequence: 1,
      authority: "host-cdp",
      dispatchSucceeded: true,
      operation: "activation-start",
      cdpMethod: "Input.dispatchMouseEvent",
      type: "mousePressed",
      inputKind: "desktop",
      coordinates: { x: 20, y: 30 },
      key: null,
      code: null,
      text: null,
      button: "left",
      buttons: 1,
      clickCount: 1,
      touchPoints: [],
    },
    {
      contract: "kandev-highlight-host-input-dispatch-v1",
      sequence: 2,
      authority: "host-cdp",
      dispatchSucceeded: true,
      operation: "activation-end",
      cdpMethod: "Input.dispatchMouseEvent",
      type: "mouseReleased",
      inputKind: "desktop",
      coordinates: { x: 20, y: 30 },
      key: null,
      code: null,
      text: null,
      button: "left",
      buttons: 0,
      clickCount: 1,
      touchPoints: [],
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(adapters.ledger),
    /injectedByApplication|"isTrusted":true|"sequence":999/,
  );
});

test("successful host dispatch sequence stays monotonic when the recorded window resets", async () => {
  const adapters = createTrustedInputAdapters({
    page: forgedMainWorldPage(),
    inputKind: "desktop",
    cdp: { async send() {} },
  });

  await adapters.trustedCursor({ x: 10, y: 12 });
  assert.equal(adapters.ledger[0].sequence, 1);
  adapters.ledger.length = 0;
  await adapters.trustedActivation({ x: 20, y: 22 });

  assert.deepEqual(
    adapters.ledger.map(({ sequence, operation }) => ({ sequence, operation })),
    [
      { sequence: 2, operation: "activation-start" },
      { sequence: 3, operation: "activation-end" },
    ],
  );
});

test("failed CDP dispatch never receives a host-authoritative ledger entry", async () => {
  const adapters = createTrustedInputAdapters({
    page: forgedMainWorldPage(),
    inputKind: "desktop",
    cdp: {
      async send() {
        throw new Error("CDP dispatch rejected");
      },
    },
  });

  await assert.rejects(
    () => adapters.trustedCursor({ x: 40, y: 50 }),
    /CDP dispatch rejected/,
  );
  assert.deepEqual(adapters.ledger, []);
});
