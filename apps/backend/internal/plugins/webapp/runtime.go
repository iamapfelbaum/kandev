package webapp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Runtime serves only validated immutable release files through capability
// URLs. It has no dependency on the ambient Kandev session middleware.
type Runtime struct {
	tokens         *TokenManager
	artifacts      *ArtifactStore
	validate       BindingValidator
	frameAncestors []string
}

func NewRuntime(tokens *TokenManager, artifacts *ArtifactStore, validate BindingValidator, frameAncestors []string) *Runtime {
	if tokens == nil {
		tokens = NewTokenManager(nil)
	}
	if len(frameAncestors) == 0 {
		frameAncestors = []string{"http://127.0.0.1:38429", "tauri://localhost", "http://tauri.localhost"}
	}
	return &Runtime{tokens: tokens, artifacts: artifacts, validate: validate, frameAncestors: append([]string(nil), frameAncestors...)}
}

// Serve handles one capability URL request. path is the path below the
// capability segment; an empty path serves the declared entry document.
func (rt *Runtime) Serve(w http.ResponseWriter, r *http.Request, token, requestPath string) {
	if rt == nil || rt.tokens == nil {
		writeRuntimeError(w, http.StatusNotFound, ErrRuntimeTokenInvalid)
		return
	}
	binding, err := rt.tokens.Validate(token)
	if err != nil {
		writeRuntimeError(w, http.StatusNotFound, err)
		return
	}
	if rt.validate != nil {
		if err := rt.validate(r.Context(), binding); err != nil {
			writeRuntimeError(w, runtimeAuthorizationStatus(err), err)
			return
		}
	}
	name, err := runtimeFilePath(requestPath, binding.Entry)
	if err != nil {
		writeRuntimeError(w, http.StatusNotFound, err)
		return
	}
	if rt.artifacts == nil {
		writeRuntimeError(w, http.StatusNotFound, ErrArtifactUnavailable)
		return
	}
	file, err := rt.artifacts.Open(binding.Artifact, name)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeRuntimeError(w, http.StatusNotFound, ErrArtifactUnavailable)
			return
		}
		writeRuntimeError(w, http.StatusNotFound, err)
		return
	}
	defer func() { _ = file.Close() }()

	policy, err := BuildContentSecurityPolicy(binding.NetworkOrigins, rt.frameAncestors)
	if err != nil {
		writeRuntimeError(w, http.StatusInternalServerError, err)
		return
	}
	setRuntimeHeaders(w, policy, r.Header.Get("Origin"))
	contentType := mime.TypeByExtension(strings.ToLower(filepath.Ext(name)))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	if stat, err := file.Stat(); err == nil {
		w.Header().Set("Content-Length", fmt.Sprintf("%d", stat.Size()))
	}
	_, _ = io.Copy(w, file)
}

// Handler returns a standard-library handler bound to one capability token.
// Backend routing uses this helper when its router already extracted the
// token and the remainder path.
func (rt *Runtime) Handler(token, requestPath string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rt.Serve(w, r, token, requestPath)
	})
}

func runtimeFilePath(requestPath, entry string) (string, error) {
	name := strings.TrimPrefix(strings.TrimSpace(requestPath), "/")
	if name == "" {
		name = entry
	}
	if strings.HasPrefix(name, "_kandev/") || name == "_kandev" {
		return "", ErrUnsafePath
	}
	return normalizePackagePath(name, MaxPathBytes)
}

func setRuntimeHeaders(w http.ResponseWriter, policy, origin string) {
	w.Header().Set("Content-Security-Policy", policy)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cross-Origin-Resource-Policy", "cross-origin")
	if origin == "null" {
		w.Header().Set("Access-Control-Allow-Origin", "null")
		w.Header().Add("Vary", "Origin")
	}
}

func writeRuntimeError(w http.ResponseWriter, status int, err error) {
	code := runtimeErrorCode(err)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	http.Error(w, fmt.Sprintf(`{"error":%q}`, code), status)
}

func runtimeAuthorizationStatus(err error) int {
	if errors.Is(err, ErrRuntimeTokenStale) {
		return http.StatusUnauthorized
	}
	return http.StatusForbidden
}

func runtimeErrorCode(err error) string {
	switch {
	case errors.Is(err, ErrRuntimeTokenInvalid):
		return ErrRuntimeTokenInvalid.Error()
	case errors.Is(err, ErrRuntimeTokenExpired):
		return ErrRuntimeTokenExpired.Error()
	case errors.Is(err, ErrRuntimeTokenStale):
		return ErrRuntimeTokenStale.Error()
	case errors.Is(err, ErrArtifactUnavailable):
		return ErrArtifactUnavailable.Error()
	case errors.Is(err, ErrUnsafePath):
		return ErrUnsafePath.Error()
	default:
		return "runtime_unavailable"
	}
}

// Keep context in this file's API surface so implementations of a validator
// can use request cancellation without importing the HTTP package elsewhere.
var _ BindingValidator = func(context.Context, CapabilityBinding) error { return nil }
