package plugins

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/kandev/kandev/internal/auth/authn"
	"github.com/kandev/kandev/internal/auth/httpmw"
	"github.com/kandev/kandev/internal/plugins/marketplace"
)

// A plugin is an install-wide artifact: these tests pin that every route that
// mutates one (or the instance-wide plugin settings) is admin-only, that the
// read surface the plugin UI depends on is not, and that an instance with
// authentication disabled is unaffected because httpmw injects a synthetic
// admin.

const (
	authzConfigPluginID = "kandev-plugin-github"
	authzUIPluginID     = "kandev-plugin-ui"
	authzSideloadID     = "kandev-plugin-side"
)

// authzFixture is the whole plugin HTTP surface (settings store, marketplace
// and state attached) behind one fixed caller identity, so a single table can
// walk every route as a member, as an admin, and as the synthetic single-user
// identity that auth-disabled mode injects.
type authzFixture struct {
	router *gin.Engine
	svc    *Service
	// extraSourceID is a deletable, non-builtin marketplace source, so the
	// PATCH/DELETE source routes exercise the guard and not a 409.
	extraSourceID string
}

func newAuthzFixture(t *testing.T, identity authn.Identity) *authzFixture {
	t.Helper()
	gin.SetMode(gin.TestMode)
	svc, _, _ := newTestService(t)
	svc.SetState(newTestStateStore(t))
	svc.SetSecrets(newFakeSecretRevealer())
	attachSettingsStore(t, svc)
	attachMarketplaceWithSource(t, svc, "https://official.example/index.json")

	installConfigPlugin(t, svc, authzConfigPluginID)
	if _, err := svc.Install(t.Context(), testPackage(t, authzUIPluginID, "1.0.0", true)); err != nil {
		t.Fatalf("Install(%q): %v", authzUIPluginID, err)
	}
	writeSideloadedPlugin(t, svc, authzSideloadID)

	extra, err := svc.Marketplace().AddSource("Acme", "https://acme.example/index.json")
	if err != nil {
		t.Fatalf("AddSource: %v", err)
	}

	router := gin.New()
	useIdentity(router, identity)
	RegisterRoutes(router, svc, nil, testLogger(t))
	return &authzFixture{router: router, svc: svc, extraSourceID: extra.ID}
}

// writeSideloadedPlugin drops an unregistered plugin directory into the
// service's plugins dir, so POST /sync has real work to do and skipping it is
// observable.
func writeSideloadedPlugin(t *testing.T, svc *Service, id string) {
	t.Helper()
	versionDir := filepath.Join(svc.pluginsDir, id, "1.0.0")
	if err := os.MkdirAll(versionDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	manifestYAML := "id: " + id + `
api_version: 1
version: "1.0.0"
display_name: Sideloaded
runtime:
  type: binary
  executables:
    ` + goruntime.GOOS + "-" + goruntime.GOARCH + `: server/plugin
`
	if err := os.WriteFile(filepath.Join(versionDir, "manifest.yaml"), []byte(manifestYAML), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
}

// installWideRoute is one admin-only route plus the assertion that a rejected
// call left the state it would have changed alone — a 403 that still ran the
// service method would be no fix at all.
type installWideRoute struct {
	name       string
	method     string
	path       func(f *authzFixture) string
	body       string
	assertNoOp func(t *testing.T, f *authzFixture)
}

func jsonHeaders() map[string]string {
	return map[string]string{"Content-Type": "application/json"}
}

func installWideRoutes() []installWideRoute {
	return []installWideRoute{
		{
			name:   "sync",
			method: http.MethodPost,
			path:   func(*authzFixture) string { return "/api/plugins/sync" },
			assertNoOp: func(t *testing.T, f *authzFixture) {
				if _, err := f.svc.Get(authzSideloadID); err == nil {
					t.Fatal("sync ran for a member: the sideloaded plugin was registered")
				}
			},
		},
		{
			name:   "update settings",
			method: http.MethodPut,
			path:   func(*authzFixture) string { return "/api/plugins/settings" },
			body:   `{"auto_update_default":true}`,
			assertNoOp: func(t *testing.T, f *authzFixture) {
				def, err := f.svc.AutoUpdateDefault()
				if err != nil {
					t.Fatalf("AutoUpdateDefault: %v", err)
				}
				if def {
					t.Fatal("member flipped the instance-wide auto-update default")
				}
			},
		},
		{
			name:   "get config",
			method: http.MethodGet,
			path:   func(*authzFixture) string { return "/api/plugins/" + authzConfigPluginID + "/config" },
		},
		{
			name:   "update config",
			method: http.MethodPatch,
			path:   func(*authzFixture) string { return "/api/plugins/" + authzConfigPluginID },
			body:   `{"config":{"github_token":"ghp_member","org":"attacker"}}`,
			assertNoOp: func(t *testing.T, f *authzFixture) {
				config, err := f.svc.GetMaskedConfig(authzConfigPluginID)
				if err != nil {
					t.Fatalf("GetMaskedConfig: %v", err)
				}
				if _, ok := config["org"]; ok {
					t.Fatalf("member rewrote plugin config: %v", config)
				}
			},
		},
		{
			name:   "set auto-update override",
			method: http.MethodPut,
			path:   func(*authzFixture) string { return "/api/plugins/" + authzConfigPluginID + "/auto-update" },
			body:   `{"auto_update":true}`,
			assertNoOp: func(t *testing.T, f *authzFixture) {
				rec, err := f.svc.Get(authzConfigPluginID)
				if err != nil {
					t.Fatalf("Get: %v", err)
				}
				if rec.AutoUpdate != nil {
					t.Fatalf("member set a per-plugin auto-update override: %v", *rec.AutoUpdate)
				}
			},
		},
		{
			name:   "uninstall",
			method: http.MethodDelete,
			path:   func(*authzFixture) string { return "/api/plugins/" + authzConfigPluginID },
			assertNoOp: func(t *testing.T, f *authzFixture) {
				if _, err := f.svc.Get(authzConfigPluginID); err != nil {
					t.Fatalf("member uninstalled an admin-installed plugin: %v", err)
				}
			},
		},
		{
			name:   "disable",
			method: http.MethodPost,
			path:   func(*authzFixture) string { return "/api/plugins/" + authzConfigPluginID + "/disable" },
			assertNoOp: func(t *testing.T, f *authzFixture) {
				assertStatus(t, f.svc, authzConfigPluginID, StatusActive)
			},
		},
		{
			name:   "enable",
			method: http.MethodPost,
			path:   func(*authzFixture) string { return "/api/plugins/" + authzUIPluginID + "/enable" },
			assertNoOp: func(t *testing.T, f *authzFixture) {
				assertStatus(t, f.svc, authzUIPluginID, StatusActive)
			},
		},
		{
			name:   "marketplace refresh",
			method: http.MethodPost,
			path:   func(*authzFixture) string { return "/api/plugins/marketplace/refresh" },
		},
		{
			name:   "add marketplace source",
			method: http.MethodPost,
			path:   func(*authzFixture) string { return "/api/plugins/marketplace/sources" },
			body:   `{"name":"Evil","url":"https://evil.example/index.json"}`,
			assertNoOp: func(t *testing.T, f *authzFixture) {
				for _, src := range marketplaceSources(t, f.svc) {
					if src.Name == "Evil" {
						t.Fatal("member added a marketplace source")
					}
				}
			},
		},
		{
			name:   "update marketplace source",
			method: http.MethodPatch,
			path: func(f *authzFixture) string {
				return "/api/plugins/marketplace/sources/" + f.extraSourceID
			},
			body: `{"enabled":false}`,
			assertNoOp: func(t *testing.T, f *authzFixture) {
				assertSourceEnabled(t, f, true)
			},
		},
		{
			name:   "delete marketplace source",
			method: http.MethodDelete,
			path: func(f *authzFixture) string {
				return "/api/plugins/marketplace/sources/" + f.extraSourceID
			},
			assertNoOp: func(t *testing.T, f *authzFixture) {
				assertSourceEnabled(t, f, true)
			},
		},
	}
}

func marketplaceSources(t *testing.T, svc *Service) []marketplace.SourceRecord {
	t.Helper()
	sources, err := svc.Marketplace().Sources()
	if err != nil {
		t.Fatalf("Sources: %v", err)
	}
	return sources
}

func assertSourceEnabled(t *testing.T, f *authzFixture, want bool) {
	t.Helper()
	for _, src := range marketplaceSources(t, f.svc) {
		if src.ID == f.extraSourceID {
			if src.Enabled != want {
				t.Fatalf("source enabled = %v, want %v", src.Enabled, want)
			}
			return
		}
	}
	t.Fatal("the extra marketplace source is gone")
}

func assertStatus(t *testing.T, svc *Service, id string, want Status) {
	t.Helper()
	rec, err := svc.Get(id)
	if err != nil {
		t.Fatalf("Get(%q): %v", id, err)
	}
	if rec.Status != want {
		t.Fatalf("%s status = %q, want %q", id, rec.Status, want)
	}
}

// TestInstallWideRoutesRejectMember is the defect this file exists for:
// POST /install already required admin while every sibling lifecycle mutation
// did not, so a member could uninstall, disable or reconfigure an
// admin-installed plugin for the whole instance.
func TestInstallWideRoutesRejectMember(t *testing.T) {
	for _, route := range installWideRoutes() {
		t.Run(route.name, func(t *testing.T) {
			f := newAuthzFixture(t, authn.Identity{UserID: "member-1", Role: authn.RoleMember})
			rec := doRequest(f.router, route.method, route.path(f), route.body, jsonHeaders())
			if rec.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want 403, body=%s", rec.Code, rec.Body.String())
			}
			if route.assertNoOp != nil {
				route.assertNoOp(t, f)
			}
		})
	}
}

// TestInstallWideRoutesRejectAnonymous pins the 401 an unidentified caller
// gets, so the gate never degrades into "no identity means no check".
func TestInstallWideRoutesRejectAnonymous(t *testing.T) {
	for _, route := range installWideRoutes() {
		t.Run(route.name, func(t *testing.T) {
			gin.SetMode(gin.TestMode)
			svc, _, _ := newTestService(t)
			svc.SetSecrets(newFakeSecretRevealer())
			attachSettingsStore(t, svc)
			attachMarketplaceWithSource(t, svc, "https://official.example/index.json")
			router := gin.New()
			RegisterRoutes(router, svc, nil, testLogger(t))

			f := &authzFixture{router: router, svc: svc, extraSourceID: "unused"}
			rec := doRequest(router, route.method, route.path(f), route.body, jsonHeaders())
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401, body=%s", rec.Code, rec.Body.String())
			}
		})
	}
}

// TestInstallWideRoutesAllowAdmin is the over-gating guard for the admin side:
// every route the member table rejects must still be reachable by an admin.
func TestInstallWideRoutesAllowAdmin(t *testing.T) {
	assertInstallWideRoutesReachable(t, authn.Identity{UserID: "admin-1", Role: authn.RoleAdmin})
}

// TestInstallWideRoutesAllowSyntheticSingleUser is the "auth disabled behaves
// exactly as before" proof: httpmw injects this identity on every request when
// the auth feature is off, and it carries RoleAdmin, so the gate is a no-op.
func TestInstallWideRoutesAllowSyntheticSingleUser(t *testing.T) {
	identity := httpmw.SyntheticIdentity()
	if !identity.IsAdmin() {
		t.Fatalf("synthetic identity role = %q, want admin", identity.Role)
	}
	assertInstallWideRoutesReachable(t, identity)
}

func assertInstallWideRoutesReachable(t *testing.T, identity authn.Identity) {
	t.Helper()
	for _, route := range installWideRoutes() {
		t.Run(route.name, func(t *testing.T) {
			f := newAuthzFixture(t, identity)
			rec := doRequest(f.router, route.method, route.path(f), route.body, jsonHeaders())
			if rec.Code == http.StatusForbidden || rec.Code == http.StatusUnauthorized {
				t.Fatalf("status = %d, want the handler to run, body=%s", rec.Code, rec.Body.String())
			}
		})
	}
}

// TestPluginReadRoutesStayOpenToMembers is the regression this change is most
// likely to cause: over-gating the read surface breaks the plugin UI for every
// non-admin.
func TestPluginReadRoutesStayOpenToMembers(t *testing.T) {
	reads := []struct {
		name string
		path string
	}{
		{"list", "/api/plugins"},
		{"get", "/api/plugins/" + authzUIPluginID},
		{"bundle", "/api/plugins/" + authzUIPluginID + "/bundle"},
		{"ui asset", "/api/plugins/" + authzUIPluginID + "/ui/ui/style.css"},
		{"settings", "/api/plugins/settings"},
		{"marketplace sources", "/api/plugins/marketplace/sources"},
	}
	f := newAuthzFixture(t, authn.Identity{UserID: "member-1", Role: authn.RoleMember})
	for _, read := range reads {
		t.Run(read.name, func(t *testing.T) {
			rec := doRequest(f.router, http.MethodGet, read.path, "", nil)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200, body=%s", rec.Code, rec.Body.String())
			}
		})
	}
}

// TestMarketplaceCatalogStaysOpenToMembers covers the catalog listing
// separately: it fetches from a source, so it needs a live index server rather
// than the fixture's unreachable placeholder URL.
func TestMarketplaceCatalogStaysOpenToMembers(t *testing.T) {
	gin.SetMode(gin.TestMode)
	svc, _, _ := newTestService(t)
	attachMarketplaceWithSource(t, svc, fixtureIndexServer(t).URL)
	router := gin.New()
	useIdentity(router, authn.Identity{UserID: "member-1", Role: authn.RoleMember})
	RegisterRoutes(router, svc, nil, testLogger(t))

	rec := doRequest(router, http.MethodGet, "/api/plugins/marketplace", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", rec.Code, rec.Body.String())
	}
}

// TestActionAndWebhookRoutesUnaffectedByAdminGate pins that the two surfaces
// with their own authorization models (per-request identity + declared
// selector for actions, manifest visibility for webhooks) did not get swept
// into the admin group.
func TestActionAndWebhookRoutesUnaffectedByAdminGate(t *testing.T) {
	gin.SetMode(gin.TestMode)
	svc, _, _ := newTestService(t)
	svc.SetSecrets(newFakeSecretRevealer())
	if _, err := svc.Install(t.Context(), actionPackage(t, "kandev-plugin-actions", "create-task", "workspace", 128)); err != nil {
		t.Fatalf("Install: %v", err)
	}
	if _, err := svc.Install(t.Context(), webhookPackage(t, "kandev-plugin-hooks", "key1")); err != nil {
		t.Fatalf("Install: %v", err)
	}
	// Disabled so the relay stops at "not running" (503) instead of dispatching
	// to a subprocess this test has no reason to stand up. 503 still proves the
	// admin gate did not fire, which is all this test is about.
	if err := svc.Disable("kandev-plugin-hooks"); err != nil {
		t.Fatalf("Disable: %v", err)
	}
	router := gin.New()
	useIdentity(router, authn.Identity{UserID: "member-1", Role: authn.RoleMember})
	RegisterRoutes(router, svc, nil, testLogger(t))

	calls := []struct {
		name string
		path string
		body string
	}{
		{"action", "/api/plugins/kandev-plugin-actions/actions/create-task", `{"workspaceId":"workspace-1","body":{}}`},
		{"webhook", "/api/plugins/kandev-plugin-hooks/webhooks/key1", `{}`},
	}
	for _, call := range calls {
		t.Run(call.name, func(t *testing.T) {
			rec := doRequest(router, http.MethodPost, call.path, call.body, jsonHeaders())
			if rec.Code == http.StatusForbidden || rec.Code == http.StatusUnauthorized {
				t.Fatalf("status = %d: the admin gate swallowed a member call, body=%s", rec.Code, rec.Body.String())
			}
		})
	}
}

// TestMemberCannotReadPluginConfig documents why GET /:id/config is admin-only
// even though it masks declared secrets: masking is driven by the plugin
// author's config_schema, so an under-declaring manifest hands every member a
// live credential, and the non-secret half is operator-owned regardless.
func TestMemberCannotReadPluginConfig(t *testing.T) {
	f := newAuthzFixture(t, authn.Identity{UserID: "admin-1", Role: authn.RoleAdmin})
	if err := f.svc.UpdateConfig(context.Background(), authzConfigPluginID, map[string]any{
		"github_token": "ghp_real", "org": "kdlbs",
	}); err != nil {
		t.Fatalf("UpdateConfig: %v", err)
	}

	member := gin.New()
	useIdentity(member, authn.Identity{UserID: "member-1", Role: authn.RoleMember})
	RegisterRoutes(member, f.svc, nil, testLogger(t))

	rec := doRequest(member, http.MethodGet, "/api/plugins/"+authzConfigPluginID+"/config", "", nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403, body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "kdlbs") {
		t.Fatalf("plugin config leaked to a member: %s", rec.Body.String())
	}
}

// adminGateBody is the exact response authn.RequireAdmin writes. Matching on it
// (rather than the bare 403) keeps this test from confusing the gate with a
// handler's own 403.
const adminGateBody = "admin role required"

// routePathParams fills the registered route patterns with concrete values so
// every route can actually be dispatched.
var routePathParams = strings.NewReplacer(
	"/:id", "/"+authzConfigPluginID,
	"/:sid", "/some-source",
	"/:key", "/some-key",
	"/:scope/:scopeId", "/instance/global",
	"/*path", "/ui/style.css",
)

// TestEveryPluginRouteIsClassified is the completeness guard: it walks the
// routes gin actually registered and fails if any of them is admin-gated
// without being listed, or listed without being gated. A new route cannot be
// added to this package without the author deciding, in this table, whether it
// mutates install-wide state.
func TestEveryPluginRouteIsClassified(t *testing.T) {
	adminOnly := map[string]bool{
		"POST /api/plugins/install":                    true,
		"POST /api/plugins/sync":                       true,
		"PUT /api/plugins/settings":                    true,
		"GET /api/plugins/:id/config":                  true,
		"PATCH /api/plugins/:id":                       true,
		"PUT /api/plugins/:id/auto-update":             true,
		"DELETE /api/plugins/:id":                      true,
		"POST /api/plugins/:id/enable":                 true,
		"POST /api/plugins/:id/disable":                true,
		"POST /api/plugins/marketplace/refresh":        true,
		"POST /api/plugins/marketplace/sources":        true,
		"PATCH /api/plugins/marketplace/sources/:sid":  true,
		"DELETE /api/plugins/marketplace/sources/:sid": true,
	}

	f := newAuthzFixture(t, authn.Identity{UserID: "member-1", Role: authn.RoleMember})
	seen := map[string]bool{}
	for _, route := range f.router.Routes() {
		key := route.Method + " " + route.Path
		seen[key] = true
		rec := doRequest(f.router, route.Method, routePathParams.Replace(route.Path), "{}", jsonHeaders())
		gated := rec.Code == http.StatusForbidden && strings.Contains(rec.Body.String(), adminGateBody)
		if gated != adminOnly[key] {
			t.Errorf("%s: admin-gated = %v, want %v (status %d, body %s)",
				key, gated, adminOnly[key], rec.Code, rec.Body.String())
		}
	}
	for key := range adminOnly {
		if !seen[key] {
			t.Errorf("%s is listed as admin-only but is not registered", key)
		}
	}
}
