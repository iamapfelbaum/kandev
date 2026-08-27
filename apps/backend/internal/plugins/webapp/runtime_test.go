package webapp

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestRuntimeServesEntryWithSecurityHeadersAndNoCookies(t *testing.T) {
	archive := canvasArchive(t, map[string]string{
		"manifest.yaml": staticManifestYAML,
		"ui/index.html": "<!doctype html><html><body>safe</body></html>",
	})
	pkg, err := ValidatePackage(bytes.NewReader(archive))
	if err != nil {
		t.Fatalf("ValidatePackage: %v", err)
	}
	artifacts, err := NewArtifactStore(filepath.Join(t.TempDir(), "artifacts"))
	if err != nil {
		t.Fatalf("NewArtifactStore: %v", err)
	}
	artifact, err := artifacts.Put(pkg)
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	manager := NewTokenManager(nil)
	token, err := manager.Issue(CapabilityBinding{
		UserID: "user-1", InstanceID: "instance-1", ReleaseID: "release-1", WebAppKey: "main", Placement: "task-canvas", Artifact: artifact, Entry: "ui/index.html",
	}, 0)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	runtime := NewRuntime(manager, artifacts, nil, []string{"http://127.0.0.1:38429", "tauri://localhost", "http://tauri.localhost"})
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Origin", "null")
	req.AddCookie(&http.Cookie{Name: "kandev_session", Value: "must-not-be-used"})
	response := httptest.NewRecorder()
	runtime.Serve(response, req, token, "")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "safe") {
		t.Fatalf("body = %q", response.Body.String())
	}
	if got := response.Header().Get("Content-Security-Policy"); !strings.Contains(got, "sandbox allow-scripts allow-forms") || !strings.Contains(got, "frame-ancestors http://127.0.0.1:38429") {
		t.Fatalf("CSP = %q", got)
	}
	for key, want := range map[string]string{
		"Cache-Control":                "no-store",
		"X-Content-Type-Options":       "nosniff",
		"Referrer-Policy":              "no-referrer",
		"Cross-Origin-Resource-Policy": "cross-origin",
		"Access-Control-Allow-Origin":  "null",
	} {
		if got := response.Header().Get(key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
	if got := response.Header().Get("Set-Cookie"); got != "" {
		t.Fatalf("runtime set a cookie: %q", got)
	}
}

func TestRuntimeRejectsStaleCapabilityBeforeReadingArtifact(t *testing.T) {
	manager := NewTokenManager(nil)
	token, err := manager.Issue(CapabilityBinding{UserID: "u", InstanceID: "i", ReleaseID: "r", WebAppKey: "main", Artifact: Artifact{Digest: strings.Repeat("c", 64), RelativePath: "releases/" + strings.Repeat("c", 64)}, Entry: "ui/index.html"}, 0)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	runtime := NewRuntime(manager, nil, func(_ context.Context, _ CapabilityBinding) error { return ErrRuntimeTokenStale }, nil)
	response := httptest.NewRecorder()
	runtime.Serve(response, httptest.NewRequest(http.MethodGet, "/", nil), token, "ui/index.html")
	if response.Code != http.StatusUnauthorized || !strings.Contains(response.Body.String(), "runtime_token_stale") {
		t.Fatalf("response = %d %q", response.Code, response.Body.String())
	}
	if body, _ := io.ReadAll(response.Body); len(body) == 0 {
		t.Fatal("stale token response has no safe error")
	}
}
