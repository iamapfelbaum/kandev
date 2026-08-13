import { defineConfig, devices } from "@playwright/test";
import { resolveWorkerCount } from "./worker-ports";

const CI = !!process.env.CI;

export default defineConfig({
  testDir: "./tests",
  // The file is the unit of parallelism: different files run concurrently
  // across workers, tests inside one file stay serial and in order on a single
  // worker.
  //
  // This was `true` while `workers: 1` pinned everything to one worker, so
  // test-level splitting never actually happened and no spec has ever had to
  // prove its tests are order-independent. Turning on a second worker with
  // `fullyParallel: true` would have cashed that unverified assumption across
  // all ~640 specs at once, and — because CI keeps `failOnFlakyTests` off —
  // any order-dependence would have surfaced as a test that passes on retry
  // rather than as an honest failure. File-level parallelism gets the same
  // wall-clock win with today's semantics intact, and it matches how the
  // duration-aware planner already reasons (it packs shards by file).
  //
  // Intra-shard concurrency is set by `workers` below (default 1, opt in via
  // E2E_WORKERS). The worker-scoped backend invariant the testPage fixture
  // relies on (e2eReset before each test on a shared backend) holds at any
  // worker count: the fixture gives every worker its own backend process,
  // port, agentctl range, HOME, tmpdir, and database, so tests only ever share
  // a backend with others on the same worker — which Playwright runs serially.
  // `beforeAll`/`afterAll` specs that call `backend.restart()` stay correct
  // too: Playwright brackets those hooks per file per worker, and each worker
  // restarts only its own backend.
  //
  // Isolation strategy: office-routing-* specs are gathered into their own
  // Playwright project (see below) so the worker-scoped backend env
  // (KANDEV_MOCK_PROVIDERS, KANDEV_PROVIDER_FAILURES) that those specs
  // restart with cannot leak into specs that count agents or read the
  // topbar agent name. Each routing spec restarts the backend back to
  // baseline in `afterAll` (see backend.restart() — no args = revert to
  // the fixture's baseline env snapshot).
  fullyParallel: false,
  forbidOnly: CI,
  failOnFlakyTests: !CI || process.env.E2E_FAIL_ON_FLAKY === "1",
  retries: CI ? 2 : 0,
  // Each worker costs a backend process plus a browser, so this is bounded by
  // runner CPU/RAM rather than by test isolation. CI's chromium/mobile-chrome
  // shards set E2E_WORKERS=2 (4 vCPU / 16 GB runners); the container-backed
  // project and local runs stay at 1 unless explicitly opted in, since each of
  // those workers also drives real Docker containers.
  workers: resolveWorkerCount(process.env.E2E_WORKERS),
  timeout: 60_000,
  // CI uses blob reporter for cross-shard merge-reports; local uses list.
  reporter: CI ? [["blob", { outputDir: "./blob-report" }]] : "list",
  outputDir: "./test-results",

  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "on-first-retry",
  },

  projects: [
    {
      // The office-routing-* specs call `backend.restart()` with
      // KANDEV_MOCK_PROVIDERS, which permanently mutates the backend's
      // env for the lifetime of the worker (and registers extra
      // canonical providers). Run them in their own project so that
      // pollution can never leak into specs that count agents or read
      // the topbar agent name — see CLAUDE.md's note on
      // KANDEV_MOCK_PROVIDERS for the underlying invariant.
      name: "routing",
      testMatch: /office-routing-.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // Opt-in authentication specs restart the worker's backend with
      // KANDEV_AUTH_REQUIRED=true, which locks the whole API behind a login.
      // They live in their own project so that env can never leak into the
      // default suite (which assumes an open backend and a tokenless
      // ApiClient). Serial within the file; afterAll restarts to baseline.
      name: "auth",
      testMatch: /auth\/.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium",
      testIgnore: [
        /mobile-.*\.spec\.ts/,
        // Container-backed tests (Docker executor, SSH executor) live in the
        // `containers` project and skip when Docker is not available locally.
        // See apps/web/e2e/README.md for what runs there.
        /docker\/.*\.spec\.ts/,
        /ssh\/.*\.spec\.ts/,
        /office-routing-.*\.spec\.ts/,
        // Auth specs run in the dedicated `auth` project (see above).
        /auth\/.*\.spec\.ts/,
      ],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chrome",
      testMatch: /mobile-.*\.spec\.ts/,
      use: { ...devices["Pixel 5"] },
    },
    {
      // Real-container E2E. Opt-in: run with `playwright test --project=containers`.
      // Spawns the backend with KANDEV_E2E_CONTAINERS=1 (KANDEV_E2E_DOCKER=1
      // is honored as a deprecated alias for one release). Builds the
      // kandev-agent:e2e and kandev-sshd:e2e images and skips entirely on
      // hosts without a Docker daemon — Docker is used as the runtime for
      // both the Docker executor's own containers AND the sshd target the
      // SSH executor connects to. Container-bound tests are slow (~10-30s
      // each) so they live in their own project to keep the default CI fast.
      //
      // See apps/web/e2e/README.md for context and how to run locally.
      name: "containers",
      testMatch: [/docker\/.*\.spec\.ts/, /ssh\/.*\.spec\.ts/],
      use: { ...devices["Desktop Chrome"] },
      timeout: 180_000,
      // Single-worker operation for this project is enforced by the CI job, not
      // here: `workers` is a top-level Playwright option with no per-project
      // form, so the contract is the containers job leaving E2E_WORKERS unset.
      // These tests build images and drive real containers, where a second
      // worker contends for the Docker daemon for no critical-path gain.
      //
      // Parallelism granularity is inherited from the top-level
      // `fullyParallel: false`, so local `--shard=N/6` runs split this project
      // by file, matching the duration-aware containers manifests CI uses.
    },
  ],

  // No webServer — each Playwright worker spawns its own frontend
  // via the backend fixture (see fixtures/backend.ts)

  globalSetup: "./global-setup.ts",
});
