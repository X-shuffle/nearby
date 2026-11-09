package application

import (
	"encoding/json"
	discovery "nearby/internal/discovery/domain"
	pairing "nearby/internal/pairing/domain"
	"strings"
	"sync"
	"testing"
	"time"
)

type memory struct {
	mu    sync.Mutex
	state *State
}

func (m *memory) Transact(f func(*State) error) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return f(m.state)
}
func setup(t *testing.T) (*Service, *memory) {
	t.Helper()
	m := &memory{state: NewState()}
	s := New(m)
	for _, v := range []struct{ id, network string }{{"a", "networkA000"}, {"b", "networkA000"}, {"c", "networkB000"}} {
		d, _ := discovery.NewDevice(v.id, v.id, "test", v.network)
		if _, err := s.Register(d); err != nil {
			t.Fatal(err)
		}
	}
	return s, m
}
func command(kind, to string, payload any) Command {
	raw, _ := json.Marshal(payload)
	return Command{Type: kind, PeerID: to, Payload: raw}
}
func TestNewDeviceNeverReceivesRemovedDevice(t *testing.T) {
	s, _ := setup(t)
	s.Remove("a")
	newcomer, _ := discovery.NewDevice("newcomer", "新加入设备", "test", "networkA000")
	events, err := s.Register(newcomer)
	if err != nil {
		t.Fatal(err)
	}
	welcome := events[0].Event.Payload.(map[string]any)
	peers := welcome["peers"].([]discovery.Device)
	if len(peers) != 1 || peers[0].ID != "b" {
		t.Fatalf("new device received stale peers: %#v", peers)
	}
}
func TestScopeAndPairingAuthorization(t *testing.T) {
	s, _ := setup(t)
	signal := command("signal", "b", map[string]any{"kind": "description", "data": map[string]string{"type": "offer", "sdp": "test"}})
	if _, err := s.Execute("a", signal); err == nil {
		t.Fatal("signal before pairing")
	}
	if _, err := s.Execute("a", command("pair.request", "c", nil)); err == nil {
		t.Fatal("cross-room request")
	}
	if _, err := s.Execute("a", command("pair.request", "b", nil)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Execute("a", command("pair.respond", "b", map[string]bool{"accept": true})); err == nil {
		t.Fatal("self acceptance")
	}
	if _, err := s.Execute("b", command("pair.respond", "a", map[string]bool{"accept": true})); err != nil {
		t.Fatal(err)
	}
	events, err := s.Execute("a", signal)
	if err != nil || len(events) != 1 || events[0].To != "b" {
		t.Fatalf("accepted signal: %v %#v", err, events)
	}
	if _, err := s.Execute("c", command("signal", "a", map[string]any{"kind": "candidate", "data": nil})); err == nil {
		t.Fatal("third device allowed")
	}
	if _, err := s.Execute("a", command("chat", "b", map[string]string{"text": "private"})); err == nil {
		t.Fatal("server accepted chat payload")
	}
}
func TestInviteGrantsOnlyInvitedPairAndIsSingleUse(t *testing.T) {
	s, m := setup(t)
	events, err := s.Execute("a", command("invite.create", "", nil))
	if err != nil {
		t.Fatal(err)
	}
	token := events[0].Event.Payload.(map[string]any)["token"].(string)
	if len(token) != 64 {
		t.Fatal("weak invitation")
	}
	if _, err = s.Execute("c", command("invite.join", "", map[string]string{"token": token})); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Execute("c", command("pair.request", "a", nil)); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Execute("c", command("pair.request", "b", nil)); err == nil {
		t.Fatal("invite granted unrelated room access")
	}
	if _, err = s.Execute("b", command("invite.join", "", map[string]string{"token": token})); err == nil {
		t.Fatal("invite reused")
	}
	s.Remove("a")
	if len(m.state.Grants) != 0 || len(m.state.Invites) != 0 {
		t.Fatal("offline grants leaked")
	}
}
func TestSweepAndRoomCleanup(t *testing.T) {
	s, m := setup(t)
	now := time.Now()
	s.now = func() time.Time { return now }
	s.Execute("a", command("pair.request", "b", nil))
	s.Execute("a", command("invite.create", "", nil))
	now = now.Add(11 * time.Minute)
	events := s.Sweep()
	if len(events) != 2 || len(m.state.Pairs) != 0 || len(m.state.Invites) != 0 {
		t.Fatal("expired state not cleared")
	}
	if events[0].Event.Payload.(map[string]any)["status"] != pairing.Expired {
		t.Fatal("expiry not notified")
	}
	s.Remove("a")
	s.Remove("b")
	if _, exists := m.state.Rooms["networkA000"]; exists {
		t.Fatal("empty room retained")
	}
}
func TestNamesAndRoomCapacity(t *testing.T) {
	s, m := setup(t)
	if _, err := s.Execute("a", command("device.rename", "", map[string]string{"name": strings.Repeat("名", 25)})); err == nil {
		t.Fatal("oversized name")
	}
	for i := 0; i < 48; i++ {
		id := ID()
		d, _ := discovery.NewDevice(id, "test", "test", "networkA000")
		_, err := s.Register(d)
		if err != nil {
			t.Fatal(err)
		}
	}
	d, _ := discovery.NewDevice("overflow", "test", "test", "networkA000")
	if _, err := s.Register(d); err == nil {
		t.Fatal("room capacity not enforced")
	}
	if _, exists := m.state.Devices["overflow"]; exists {
		t.Fatal("failed registration persisted")
	}
}
