package webstatic

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const headersFile = `/
  Content-Security-Policy: default-src 'none'; script-src 'self' 'sha256-home'; connect-src 'self'; upgrade-insecure-requests
  X-Frame-Options: DENY
  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload

/activity
  Content-Security-Policy: default-src 'none'; script-src 'self' 'sha256-activity'; upgrade-insecure-requests
  X-Frame-Options: DENY

/settings/rpc
  Content-Security-Policy: default-src 'none'; script-src 'self' 'sha256-rpc'
  X-Frame-Options: DENY

/404
  Content-Security-Policy: default-src 'none'; script-src 'self' 'sha256-404'
  X-Frame-Options: DENY
`

func export(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range files {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func site(t *testing.T) string {
	return export(t, map[string]string{
		"_headers":                 headersFile,
		"index.html":               "<html>home</html>",
		"activity.html":            "<html>activity</html>",
		"settings/rpc/index.html":  "<html>rpc</html>",
		"unlisted.html":            "<html>no headers</html>",
		"404.html":                 "<html>not found</html>",
		"_next/static/chunk.js":    "console.log(1)",
		"icon.svg":                 "<svg/>",
		"fonts/a.woff2":            "w",
		".env":                     "SECRET=1",
		"_next/static/.hidden.txt": "x",
		".git/config":              "[core]",
	})
}

func get(t *testing.T, h http.Handler, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, target, nil))
	return rec
}

func TestPagesGetTheirOwnHeaders(t *testing.T) {
	h, err := New(site(t), Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	for target, want := range map[string]struct{ body, hash string }{
		"/":                 {"home", "sha256-home"},
		"/activity":         {"activity", "sha256-activity"},
		"/activity.html":    {"activity", "sha256-activity"},
		"/settings/rpc":     {"rpc", "sha256-rpc"},
		"/settings/rpc/":    {"rpc", "sha256-rpc"},
		"/./activity?x=1":   {"activity", "sha256-activity"},
		"/nope":             {"not found", "sha256-404"},
		"/../../etc/passwd": {"not found", "sha256-404"},
	} {
		rec := get(t, h, http.MethodGet, target)
		if !strings.Contains(rec.Body.String(), want.body) {
			t.Errorf("%s: body %q, want %q", target, rec.Body.String(), want.body)
		}
		if csp := rec.Header().Get("Content-Security-Policy"); !strings.Contains(csp, want.hash) {
			t.Errorf("%s: CSP %q, want %s", target, csp, want.hash)
		}
		if rec.Header().Get("X-Frame-Options") != "DENY" || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/html") {
			t.Errorf("%s: headers %v", target, rec.Header())
		}
	}
	if rec := get(t, h, http.MethodGet, "/nope"); rec.Code != http.StatusNotFound || rec.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("missing page: %d %q", rec.Code, rec.Header().Get("Cache-Control"))
	}
	if rec := get(t, h, http.MethodGet, "/"); rec.Code != http.StatusOK || rec.Header().Get("Strict-Transport-Security") == "" {
		t.Errorf("home: %d, HSTS %q", rec.Code, rec.Header().Get("Strict-Transport-Security"))
	}
}

func TestAssetsAndThingsNeverServed(t *testing.T) {
	h, err := New(site(t), Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	rec := get(t, h, http.MethodGet, "/_next/static/chunk.js")
	if rec.Code != 200 || !strings.Contains(rec.Header().Get("Cache-Control"), "immutable") || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/javascript") || rec.Header().Get("X-Frame-Options") != "DENY" {
		t.Errorf("asset: %d %v", rec.Code, rec.Header())
	}
	if rec := get(t, h, http.MethodGet, "/fonts/a.woff2"); rec.Header().Get("Content-Type") != "font/woff2" {
		t.Errorf("woff2 type %q", rec.Header().Get("Content-Type"))
	}
	// The headers file, dotfiles and a page the build wrote no headers for.
	for _, target := range []string{"/_headers", "/.env", "/_next/static/.hidden.txt", "/.git/config", "/unlisted"} {
		rec := get(t, h, http.MethodGet, target)
		if strings.Contains(rec.Body.String(), "SECRET") || strings.Contains(rec.Body.String(), "Content-Security") ||
			strings.Contains(rec.Body.String(), "no headers") || rec.Code == http.StatusOK {
			t.Errorf("%s served: %d %q", target, rec.Code, rec.Body.String())
		}
	}
	// API paths are never answered with a page.
	for _, target := range []string{"/v1", "/v1/", "/v1/unknown"} {
		rec := get(t, h, http.MethodGet, target)
		if rec.Code != http.StatusNotFound || strings.Contains(rec.Body.String(), "<html>") {
			t.Errorf("%s: %d %q", target, rec.Code, rec.Body.String())
		}
	}
	if rec := get(t, h, http.MethodPost, "/"); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST: %d", rec.Code)
	}
	if rec := get(t, h, http.MethodHead, "/activity"); rec.Code != 200 || rec.Body.Len() != 0 {
		t.Errorf("HEAD: %d %d bytes", rec.Code, rec.Body.Len())
	}
}

func TestSymlinkOutOfTheExportIsNotFollowed(t *testing.T) {
	dir := site(t)
	outside := filepath.Join(t.TempDir(), "secret.html")
	if err := os.WriteFile(outside, []byte("TOPSECRET"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "leak.html")); err != nil {
		t.Skip("symlinks unavailable:", err)
	}
	h, err := New(dir, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if rec := get(t, h, http.MethodGet, "/leak"); strings.Contains(rec.Body.String(), "TOPSECRET") {
		t.Fatal("served a file outside the export through a symlink")
	}
}

func TestPlainHTTPPreview(t *testing.T) {
	h, err := New(site(t), Options{PlainHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	rec := get(t, h, http.MethodGet, "/")
	if strings.Contains(rec.Header().Get("Content-Security-Policy"), "upgrade-insecure-requests") || rec.Header().Get("Strict-Transport-Security") != "" {
		t.Fatalf("plain HTTP headers: %v", rec.Header())
	}
	if !strings.Contains(rec.Header().Get("Content-Security-Policy"), "sha256-home") {
		t.Fatal("CSP lost")
	}
}

func TestRefusesAnExportWithoutHeaders(t *testing.T) {
	for name, files := range map[string]map[string]string{
		"no _headers":         {"index.html": "x"},
		"no index.html":       {"_headers": headersFile},
		"empty _headers":      {"index.html": "x", "_headers": "\n"},
		"route without CSP":   {"index.html": "x", "_headers": "/\n  X-Frame-Options: DENY\n"},
		"no home route":       {"index.html": "x", "_headers": "/a\n  Content-Security-Policy: default-src 'none'\n"},
		"header before route": {"index.html": "x", "_headers": "  X-Frame-Options: DENY\n"},
	} {
		t.Run(name, func(t *testing.T) {
			if h, err := New(export(t, files), Options{}); err == nil {
				h.Close()
				t.Fatal("accepted")
			}
		})
	}
	if _, err := New(filepath.Join(t.TempDir(), "missing"), Options{}); err == nil {
		t.Fatal("accepted a missing directory")
	}
}
