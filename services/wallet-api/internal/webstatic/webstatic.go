// Package webstatic serves the web app's static export (apps/web/out) from the
// API's own origin, so the browser, the session cookies and the API share one
// site. That matters where the web app and the API cannot be given sibling
// subdomains of one registrable domain (for example two *.onrender.com
// services, which browsers treat as different sites, so SameSite=Strict
// cookies would not be sent).
//
// Every page is served with the headers the web build generated for it in
// _headers (a hash-based Content-Security-Policy per page, HSTS, framing and
// referrer policy). Serving refuses to start without that file, so a page is
// never served without its CSP.
package webstatic

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"strings"
	"time"
)

// Options adjust headers for a non-production preview over plain HTTP.
type Options struct {
	// PlainHTTP drops upgrade-insecure-requests from the CSP and omits HSTS,
	// as the web app's own local preview server does. Never set in production.
	PlainHTTP bool
}

// Handler serves the export. Paths under /v1/ are never answered with a page:
// they get a plain 404, as an unknown API route always has.
type Handler struct {
	root    *os.Root
	headers map[string]http.Header // route ("/", "/activity", "/404") -> headers
	common  http.Header            // non-CSP headers for assets
	modTime time.Time
}

// New opens dir, which must hold the export: index.html and the _headers file
// the web build writes (apps/web/scripts/csp.mjs).
func New(dir string, opt Options) (*Handler, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, fmt.Errorf("webstatic: %w", err)
	}
	if _, err := root.Stat("index.html"); err != nil {
		root.Close()
		return nil, fmt.Errorf("webstatic: %s has no index.html: %w", dir, err)
	}
	f, err := root.Open("_headers")
	if err != nil {
		root.Close()
		return nil, fmt.Errorf("webstatic: %s has no _headers (run the web build, which writes it): %w", dir, err)
	}
	headers, err := parseHeaders(f)
	f.Close()
	if err != nil {
		root.Close()
		return nil, err
	}
	for route, h := range headers {
		if h.Get("Content-Security-Policy") == "" {
			root.Close()
			return nil, fmt.Errorf("webstatic: _headers gives route %s no Content-Security-Policy", route)
		}
		if opt.PlainHTTP {
			h.Set("Content-Security-Policy", strings.ReplaceAll(h.Get("Content-Security-Policy"), "; upgrade-insecure-requests", ""))
			h.Del("Strict-Transport-Security")
		}
	}
	home, ok := headers["/"]
	if !ok {
		root.Close()
		return nil, errors.New("webstatic: _headers has no entry for /")
	}
	common := home.Clone()
	common.Del("Content-Security-Policy")
	return &Handler{root: root, headers: headers, common: common, modTime: time.Now()}, nil
}

// Close releases the directory handle.
func (h *Handler) Close() error { return h.root.Close() }

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/v1" || strings.HasPrefix(r.URL.Path, "/v1/") {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
		return
	}
	name, route, ok := h.resolve(r.URL.Path)
	status := http.StatusOK
	if !ok {
		name, route, status = "404.html", "/404", http.StatusNotFound
	}
	f, err := h.root.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()

	out := w.Header()
	if strings.HasSuffix(name, ".html") {
		hdr, ok := h.headers[route]
		if !ok {
			// A page the build wrote no headers for is not served: no page
			// leaves this server without its CSP.
			http.NotFound(w, r)
			return
		}
		for k, v := range hdr {
			out[k] = append([]string(nil), v...)
		}
		out.Set("Cache-Control", "no-cache")
	} else {
		for k, v := range h.common {
			out[k] = append([]string(nil), v...)
		}
		if strings.HasPrefix(name, "_next/static/") {
			out.Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			out.Set("Cache-Control", "no-cache")
		}
	}
	if ct := contentType(name); ct != "" {
		out.Set("Content-Type", ct)
	} else {
		out.Set("Content-Type", "application/octet-stream")
	}
	if status != http.StatusOK {
		out.Del("Cache-Control")
		out.Set("Cache-Control", "no-store")
		w.WriteHeader(status)
		if r.Method != http.MethodHead {
			_, _ = io.Copy(w, f)
		}
		return
	}
	http.ServeContent(w, r, name, h.modTime, f)
}

// resolve maps a URL path to a file in the export and the _headers route it
// belongs to, the way the export is laid out: /x -> x.html or x/index.html.
func (h *Handler) resolve(urlPath string) (name, route string, ok bool) {
	clean := path.Clean("/" + urlPath)
	rel := strings.TrimPrefix(clean, "/")
	if rel == "_headers" {
		return "", "", false
	}
	for _, seg := range strings.Split(rel, "/") {
		if strings.HasPrefix(seg, ".") { // .env, .git/…: never served
			return "", "", false
		}
	}
	var candidates []string
	if rel == "" {
		candidates = []string{"index.html"}
	} else {
		candidates = []string{rel, rel + ".html", path.Join(rel, "index.html")}
	}
	for _, c := range candidates {
		st, err := h.root.Stat(c)
		if err != nil || !st.Mode().IsRegular() {
			continue
		}
		return c, routeFor(c), true
	}
	return "", "", false
}

// routeFor gives the _headers route of an HTML file, as csp.mjs writes it.
func routeFor(name string) string {
	if !strings.HasSuffix(name, ".html") {
		return ""
	}
	r := strings.TrimSuffix(name, ".html")
	if r == "index" {
		return "/"
	}
	r = strings.TrimSuffix(r, "/index")
	return "/" + r
}

// parseHeaders reads the Netlify/Cloudflare Pages _headers format: a route
// line, then indented "Name: value" lines.
func parseHeaders(r io.Reader) (map[string]http.Header, error) {
	out := map[string]http.Header{}
	var cur http.Header
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for n := 1; sc.Scan(); n++ {
		line := sc.Text()
		switch {
		case strings.TrimSpace(line) == "":
			continue
		case line[0] != ' ' && line[0] != '\t':
			cur = http.Header{}
			out[strings.TrimSpace(line)] = cur
		default:
			if cur == nil {
				return nil, fmt.Errorf("webstatic: _headers line %d: header before any route", n)
			}
			k, v, ok := strings.Cut(strings.TrimSpace(line), ":")
			if !ok {
				return nil, fmt.Errorf("webstatic: _headers line %d: not \"Name: value\"", n)
			}
			cur.Add(strings.TrimSpace(k), strings.TrimSpace(v))
		}
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("webstatic: _headers: %w", err)
	}
	if len(out) == 0 {
		return nil, errors.New("webstatic: _headers is empty")
	}
	return out, nil
}

// extraTypes covers what Go's built-in table lacks; the runtime image
// (distroless) has no system MIME database to fall back on.
var extraTypes = map[string]string{
	".woff2":       "font/woff2",
	".woff":        "font/woff",
	".ico":         "image/x-icon",
	".txt":         "text/plain; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".map":         "application/json",
}

func contentType(name string) string {
	ext := strings.ToLower(path.Ext(name))
	if t, ok := extraTypes[ext]; ok {
		return t
	}
	return mime.TypeByExtension(ext)
}
