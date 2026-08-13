import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { waitForPortFree } from "./fixtures/backend";

/**
 * Guards the primitive the backend fixture relies on before rebinding a port.
 *
 * Playwright reuses a worker's `parallelIndex` when it replaces that worker
 * after a failure, so the replacement rebinds the exact port its predecessor
 * held. Spawning without waiting loses that race and exits the new backend with
 * code 1, which took down a whole shard in CI.
 */
describe("waitForPortFree", () => {
  const servers: net.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });

  async function listen(): Promise<number> {
    const server = net.createServer(() => {});
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as net.AddressInfo).port;
  }

  it("returns promptly when nothing holds the port", async () => {
    const port = await listen();
    await new Promise((resolve) => servers.splice(0)[0]!.close(resolve));

    const started = Date.now();
    await waitForPortFree(port, 5_000);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("blocks while the port is held and resolves once it is released", async () => {
    const port = await listen();
    const holder = servers[0]!;

    let released = false;
    setTimeout(() => {
      released = true;
      holder.close();
    }, 600);

    await waitForPortFree(port, 10_000);
    // The wait must have outlasted the holder rather than returning immediately.
    expect(released).toBe(true);
  });

  it("gives up after the timeout so a leaked holder surfaces instead of hanging", async () => {
    const port = await listen();

    const started = Date.now();
    await waitForPortFree(port, 700);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(600);
    expect(elapsed).toBeLessThan(5_000);
  });
});
