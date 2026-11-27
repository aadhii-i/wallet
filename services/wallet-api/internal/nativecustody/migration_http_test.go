package nativecustody

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/auth"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMigrationHTTPDeviceAccessAndPublicErrors(t *testing.T) {
	e := newMigrationEnv(t)
	m := e.draft(t)
	router := chi.NewRouter()
	e.c.Routes(router)
	path := "/v1/native-migrations/" + m.Manifest.ID
	request := func(principal *auth.Principal, method, url, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, url, strings.NewReader(body))
		r = r.WithContext(auth.WithPrincipal(context.Background(), principal))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	for _, principal := range []*auth.Principal{nil, {UserID: uuid.New(), DeviceID: uuid.New()}, {UserID: e.actors[0].UserID, DeviceID: uuid.New()}} {
		if got := request(principal, "GET", path, ""); got.Code != 404 {
			t.Fatal("unauthorized device accessed migration", got.Code)
		}
	}
	if got := request(e.actors[0], "GET", path, ""); got.Code != 200 {
		t.Fatal("member access failed", got.Code)
	}
	signature := signDevice(t, e.keys[0], ApprovalMessage(m, "source"))
	body, _ := json.Marshal(map[string]any{"side": "source", "signature": signature})
	if got := request(e.actors[0], "POST", path+"/confirm", string(body)); got.Code != 200 {
		t.Fatal("client confirmation route mismatch", got.Code, got.Body.String())
	}
	if got := request(e.actors[0], "POST", path+"/confirm", `{"side":"source","signature":"bad","privateKey":"reject"}`); got.Code != 400 {
		t.Fatal("unknown fields accepted", got.Code)
	}
	output := httptest.NewRecorder()
	r := httptest.NewRequest("GET", path, nil)
	migrationError(output, r, errors.New("postgres://sensitive/internal/path"))
	if strings.Contains(output.Body.String(), "sensitive") {
		t.Fatal("internal error leaked")
	}
}
