import { expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { backendFixture as test } from "../../fixtures/backend";
import { acceptInvite, createInviteToken, login, setupAdmin } from "../../helpers/auth";
import { PACKAGE_PATH, PLUGIN_ID } from "../plugins/plugin-test-helpers";

/**
 * A plugin is an install-wide artifact: it runs on the host and its UI loads
 * for every user. Install already required the admin role while uninstall,
 * disable, config and the rest did not, so a member could remove or reconfigure
 * an admin's plugin for the whole instance. This pins both halves of the fix
 * against a real backend: the HTTP routes reject a member, and the settings
 * surface does not offer them in the first place.
 *
 * Runs in the `auth` project (backend restarted with auth required). Serial:
 * the admin, the member and the installed plugin are shared across the tests.
 */
const ADMIN = { email: "admin@demo.dev", password: "adminpass123", displayName: "Ada Admin" };
const MEMBER = { email: "sam@demo.dev", password: "memberpass123", displayName: "Sam Member" };

test.describe.serial("plugin lifecycle authorization", () => {
  test.beforeAll(async ({ backend }) => {
    await backend.restart({
      KANDEV_FEATURES_AUTH: "true",
      KANDEV_DATABASE_PATH: path.join(backend.tmpDir, "kandev-auth-plugin-authz.db"),
    });
  });

  test.afterAll(async ({ backend }) => {
    await backend.restart();
  });

  test("a member cannot mutate an admin-installed plugin, and is not offered the controls", async ({
    browser,
    backend,
  }) => {
    test.skip(!fs.existsSync(PACKAGE_PATH), `run \`make -C apps/backend e2e-plugin-package\``);

    const adminCtx = await browser.newContext({ baseURL: backend.frontendUrl });
    await setupAdmin(adminCtx, backend.baseUrl, ADMIN);
    await login(adminCtx, backend.baseUrl, ADMIN);

    const install = await adminCtx.request.post(`${backend.baseUrl}/api/plugins/install`, {
      multipart: {
        package: {
          name: path.basename(PACKAGE_PATH),
          mimeType: "application/gzip",
          buffer: fs.readFileSync(PACKAGE_PATH),
        },
      },
    });
    expect(
      install.ok(),
      `install failed: ${install.status()} ${await install.text()}`,
    ).toBeTruthy();

    const token = await createInviteToken(adminCtx, backend.baseUrl, { role: "member" });
    const memberCtx = await browser.newContext({ baseURL: backend.frontendUrl });
    await acceptInvite(memberCtx, backend.baseUrl, token, MEMBER);
    await login(memberCtx, backend.baseUrl, MEMBER);

    // Every install-wide mutation is rejected before it reaches the service.
    const base = `${backend.baseUrl}/api/plugins`;
    const rejected: Array<[string, Promise<{ status(): number }>]> = [
      [`DELETE ${PLUGIN_ID}`, memberCtx.request.delete(`${base}/${PLUGIN_ID}`)],
      [`POST ${PLUGIN_ID}/disable`, memberCtx.request.post(`${base}/${PLUGIN_ID}/disable`)],
      [
        `PATCH ${PLUGIN_ID}`,
        memberCtx.request.patch(`${base}/${PLUGIN_ID}`, { data: { config: { hijacked: true } } }),
      ],
      [`GET ${PLUGIN_ID}/config`, memberCtx.request.get(`${base}/${PLUGIN_ID}/config`)],
      [
        "PUT auto-update",
        memberCtx.request.put(`${base}/${PLUGIN_ID}/auto-update`, { data: { auto_update: true } }),
      ],
      ["POST sync", memberCtx.request.post(`${base}/sync`)],
      [
        "PUT settings",
        memberCtx.request.put(`${base}/settings`, { data: { auto_update_default: true } }),
      ],
      [
        "POST marketplace/sources",
        memberCtx.request.post(`${base}/marketplace/sources`, {
          data: { name: "Evil", url: "https://evil.example/index.json" },
        }),
      ],
    ];
    for (const [label, pending] of rejected) {
      expect((await pending).status(), `${label} must be forbidden for a member`).toBe(403);
    }

    // The plugin is untouched: still installed, still active.
    const after = await adminCtx.request.get(`${base}/${PLUGIN_ID}`);
    expect(after.ok(), await after.text()).toBeTruthy();
    expect(((await after.json()) as { status?: string }).status).toBe("active");

    // Reads stay open, or the plugin UI would break for every non-admin.
    expect((await memberCtx.request.get(base)).status()).toBe(200);
    expect((await memberCtx.request.get(`${base}/${PLUGIN_ID}`)).status()).toBe(200);
    expect((await memberCtx.request.get(`${base}/${PLUGIN_ID}/bundle`)).status()).toBe(200);

    // And the settings surface offers the member none of the above.
    const memberPage = await memberCtx.newPage();
    await memberPage.goto("/settings/plugins");
    await expect(memberPage.getByTestId("plugins-admin-only-notice")).toBeVisible();
    await expect(memberPage.getByTestId(`plugin-row-${PLUGIN_ID}`)).toBeVisible();
    await expect(memberPage.getByTestId("plugins-sync-button")).toHaveCount(0);
    await expect(memberPage.getByTestId("install-plugin-trigger")).toHaveCount(0);
    await expect(memberPage.getByTestId("plugins-tab-browse")).toHaveCount(0);
    await expect(memberPage.getByRole("button", { name: /uninstall/i })).toHaveCount(0);

    // The admin keeps them.
    const adminPage = await adminCtx.newPage();
    await adminPage.goto("/settings/plugins");
    await expect(adminPage.getByTestId("plugins-sync-button")).toBeVisible();
    await expect(adminPage.getByTestId("install-plugin-trigger")).toBeVisible();
    await expect(adminPage.getByRole("button", { name: /uninstall/i })).toBeVisible();
    await expect(adminPage.getByTestId("plugins-admin-only-notice")).toHaveCount(0);
  });
});
