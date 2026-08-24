// Capture the documentation screenshots for docs/public/team-access.md from the
// seeded demo instance. Run after scripts/demo-team-access.sh up:
//
//   cd apps/web && node scripts/team-access-docs-shots.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.KANDEV_DEMO_URL ?? "http://127.0.0.1:8231";
const OUT = process.env.SHOT_DIR ?? "../../docs/screenshots";
const PASSWORD = "kandev-demo-pw-1";
mkdirSync(OUT, { recursive: true });

async function signIn(context, email) {
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(PASSWORD);
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/v1/auth/login") && r.request().method() === "POST",
    ),
    page.getByRole("button", { name: /sign in|log in/i }).click(),
  ]);
  await page.waitForLoadState("networkidle");
  for (let i = 0; i < 6; i += 1) {
    const skip = page.getByRole("button", { name: /^skip$/i });
    if (!(await skip.count())) break;
    await skip
      .first()
      .click()
      .catch(() => {});
    await page.waitForTimeout(500);
  }
  return page;
}

async function shot(page, name, focus) {
  await page.waitForTimeout(1200);
  if (focus) {
    const t = page.locator(focus).first();
    if (await t.count()) {
      await t.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
    }
  }
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`captured ${name}.png`);
}

const CARD_BOTTOM = '#add-member-user, [data-testid="workspace-member-row"]:last-of-type';
const browser = await chromium.launch();
try {
  const desktop = { width: 1440, height: 1250 };

  const ana = await signIn(await browser.newContext({ viewport: desktop }), "ana@example.com");
  const { workspaces } = await (await ana.request.get(`${BASE}/api/v1/workspaces`)).json();
  const team = workspaces.find((w) => w.name === "Platform Team");

  await ana.goto(`${BASE}/settings/workspaces`, { waitUntil: "networkidle" });
  await shot(ana, "team-access-default-visibility", "#default-workspace-visibility");

  await ana.goto(`${BASE}/settings/workspace/${team.id}`, { waitUntil: "networkidle" });
  await shot(ana, "team-access-owner-card", CARD_BOTTOM);

  await ana.goto(`${BASE}/settings/users`, { waitUntil: "networkidle" });
  await shot(ana, "team-access-user-roles");

  const bruno = await signIn(await browser.newContext({ viewport: desktop }), "bruno@example.com");
  await bruno.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await shot(bruno, "team-access-shared-board");

  // The human assignee, on both boards. Ana assigns Bruno through the API so
  // the shots show a task somebody else owns, which is what the "Assign to me"
  // affordance is for.
  const tasks = await (await ana.request.get(`${BASE}/api/v1/workspaces/${team.id}/tasks`)).json();
  const task = (tasks.tasks ?? tasks)[0];
  const { users } = await (await ana.request.get(`${BASE}/api/v1/users/directory`)).json();
  const brunoId = users.find((u) => u.display_name.includes("Bruno"))?.id;
  if (task && brunoId) {
    await ana.request.patch(`${BASE}/api/v1/tasks/${task.id}`, {
      data: { assignee_user_id: brunoId },
    });
    await ana.goto(`${BASE}/t/${task.id}`, { waitUntil: "networkidle" });
    await ana.getByTestId("task-assignee-control").waitFor({ state: "visible", timeout: 25000 });
    await ana.waitForTimeout(800);
    await ana.screenshot({
      path: `${OUT}/team-access-kanban-assignee-topbar.png`,
      clip: { x: 540, y: 0, width: 900, height: 56 },
    });
    console.log("captured team-access-kanban-assignee-topbar.png");

    await ana.goto(`${BASE}/`, { waitUntil: "networkidle" });
    const badge = ana.getByTestId("kanban-card-assignee").first();
    await badge.waitFor({ state: "visible", timeout: 25000 });
    const card = badge.locator("xpath=ancestor::*[@data-testid][1]");
    await ((await card.count()) ? card : badge).screenshot({
      path: `${OUT}/team-access-kanban-assignee-card.png`,
    });
    console.log("captured team-access-kanban-assignee-card.png");
  }

  const carla = await signIn(await browser.newContext({ viewport: desktop }), "carla@example.com");
  await carla.goto(`${BASE}/settings/workspace/${team.id}`, { waitUntil: "networkidle" });
  await shot(carla, "team-access-viewer-card", CARD_BOTTOM);

  const mobile = await signIn(
    await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    }),
    "ana@example.com",
  );
  await mobile.goto(`${BASE}/settings/workspace/${team.id}`, { waitUntil: "networkidle" });
  await shot(mobile, "team-access-mobile", CARD_BOTTOM);

  console.log(`\nwritten to ${OUT}`);
} finally {
  await browser.close();
}
