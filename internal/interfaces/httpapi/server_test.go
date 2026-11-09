package httpapi

import (
	"context"
	"encoding/json"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"nearby/internal/session/application"
	"nearby/internal/session/infrastructure"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func api() *Server { return New(application.New(infrastructure.NewMemoryRepository()), Config{}) }
func TestUntrustedForwardedHeaderIgnored(t *testing.T) {
	s := api()
	r := httptest.NewRequest("GET", "http://localhost/", nil)
	r.RemoteAddr = "192.0.2.1:1234"
	r.Header.Set("X-Forwarded-For", "203.0.113.4")
	ip, err := s.ClientIP(r)
	if err != nil || ip.String() != "192.0.2.1" {
		t.Fatalf("spoofed IP: %v %v", ip, err)
	}
}
func TestProxyChainRightToLeft(t *testing.T) {
	s := api()
	s.config.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
	r := httptest.NewRequest("GET", "http://localhost/", nil)
	r.RemoteAddr = "10.0.0.1:1234"
	r.Header.Set("X-Forwarded-For", "1.2.3.4, 203.0.113.4, 10.0.0.2")
	ip, err := s.ClientIP(r)
	if err != nil || ip.String() != "203.0.113.4" {
		t.Fatalf("untrusted prefix used: %v %v", ip, err)
	}
}

type event struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

func TestWebSocketLifecycleAndSignalGate(t *testing.T) {
	s := api()
	server := httptest.NewServer(s.Handler(fstest.MapFS{"index.html": {Data: []byte("nearby")}}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	connect := func(name string) *websocket.Conn {
		t.Helper()
		conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/ws?name="+name, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{server.URL}}})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { conn.CloseNow() })
		return conn
	}
	read := func(conn *websocket.Conn, kind string) event {
		t.Helper()
		var e event
		if err := wsjson.Read(ctx, conn, &e); err != nil {
			t.Fatal(err)
		}
		if e.Type != kind {
			t.Fatalf("expected %s got %s: %s", kind, e.Type, e.Payload)
		}
		return e
	}
	a := connect("a")
	welcomeA := read(a, "welcome")
	var p struct {
		Self struct {
			ID string `json:"id"`
		} `json:"self"`
	}
	json.Unmarshal(welcomeA.Payload, &p)
	aID := p.Self.ID
	b := connect("b")
	welcomeB := read(b, "welcome")
	json.Unmarshal(welcomeB.Payload, &p)
	bID := p.Self.ID
	read(a, "peer.joined")
	write := func(conn *websocket.Conn, c application.Command) {
		t.Helper()
		if err := wsjson.Write(ctx, conn, c); err != nil {
			t.Fatal(err)
		}
	}
	payload := json.RawMessage(`{"kind":"description","data":{"type":"offer","sdp":"test"}}`)
	write(a, application.Command{Type: "signal", PeerID: bID, Payload: payload})
	read(a, "error")
	write(a, application.Command{Type: "pair.request", PeerID: bID})
	read(a, "pair.state")
	read(b, "pair.state")
	write(b, application.Command{Type: "pair.respond", PeerID: aID, Payload: json.RawMessage(`{"accept":true}`)})
	read(a, "pair.state")
	read(b, "pair.state")
	write(a, application.Command{Type: "signal", PeerID: bID, Payload: payload})
	read(b, "signal")
	a.CloseNow()
	read(b, "peer.left")
}
func TestOriginAndHTTPBoundaries(t *testing.T) {
	s := api()
	server := httptest.NewServer(s.Handler(fstest.MapFS{"index.html": {Data: []byte("nearby")}}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, res, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/ws?name=a", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{"https://evil.example"}}})
	if conn != nil {
		conn.CloseNow()
	}
	if err == nil || res == nil || res.StatusCode != 403 {
		t.Fatal("cross-origin socket accepted")
	}
	response, err := http.Get(server.URL + "/api/config")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var config map[string]any
	json.NewDecoder(response.Body).Decode(&config)
	if config["turnEnabled"] != false {
		t.Fatal("TURN enabled")
	}
	if response.Header.Get("Content-Security-Policy") == "" {
		t.Fatal("missing CSP")
	}
}
