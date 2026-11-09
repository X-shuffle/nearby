package httpapi

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"testing"

	"nearby/internal/session/application"
	"nearby/internal/session/infrastructure"
)

type auditBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *auditBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}
func (b *auditBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}
func (b *auditBuffer) records(t *testing.T) []map[string]any {
	t.Helper()
	var records []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(b.String()), "\n") {
		if line == "" {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatal(err)
		}
		records = append(records, record)
	}
	return records
}

func TestRejectedConnectionAuditUsesTrustedClientIP(t *testing.T) {
	for _, trusted := range []bool{false, true} {
		t.Run(map[bool]string{false: "untrusted", true: "trusted"}[trusted], func(t *testing.T) {
			var logs auditBuffer
			config := Config{Logger: slog.New(slog.NewJSONHandler(&logs, nil))}
			if trusted {
				config.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
			}
			s := New(application.New(infrastructure.NewMemoryRepository()), config)
			r := httptest.NewRequest("GET", "http://localhost/api/ws?name=test&platform=phone", nil)
			r.RemoteAddr = "10.0.0.1:1234"
			r.Header.Set("X-Forwarded-For", "203.0.113.7")
			w := httptest.NewRecorder()
			s.socket(w, r)
			records := logs.records(t)
			if w.Code != 403 || len(records) != 1 {
				t.Fatalf("unexpected rejection: %d %v", w.Code, records)
			}
			record := records[0]
			wantIP := "10.0.0.1"
			if trusted {
				wantIP = "203.0.113.7"
			}
			if record["ip"] != wantIP || record["device_name"] != "test" || record["platform"] != "phone" || record["reason"] != "missing_origin" {
				t.Fatalf("incorrect rejection identity: %v", record)
			}
		})
	}
}

func TestCommandAuditDoesNotLogPayloadOrHeartbeats(t *testing.T) {
	var logs auditBuffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	s := api()
	s.logCommand(logger, application.Command{Type: "ping"}, nil, nil)
	if logs.String() != "" {
		t.Fatal("heartbeat logged")
	}
	for _, command := range []application.Command{
		{Type: "invite.join", Payload: json.RawMessage(`{"token":"secret-invite-token"}`)},
		{Type: "signal", Payload: json.RawMessage(`{"kind":"candidate","data":"secret-ice-data"}`)},
		{Type: "signal", Payload: json.RawMessage(`{"kind":"description","data":{"sdp":"secret-sdp"}}`)},
	} {
		s.logCommand(logger, command, nil, nil)
	}
	if strings.Contains(logs.String(), "secret-") {
		t.Fatal("sensitive payload logged")
	}
	if len(logs.records(t)) != 3 {
		t.Fatal("missing commands")
	}
}
