// Package application coordinates domain rules. It has no HTTP or WebSocket dependency.
package application

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	discovery "nearby/internal/discovery/domain"
	pairing "nearby/internal/pairing/domain"
	room "nearby/internal/room/domain"
)

type Event struct {
	Type    string `json:"type"`
	Payload any    `json:"payload"`
}
type Delivery struct {
	To    string
	Event Event
}
type Command struct {
	Type    string          `json:"type"`
	PeerID  string          `json:"peerId"`
	Payload json.RawMessage `json:"payload"`
}
type Invite struct {
	DeviceID string
	Expires  time.Time
}
type State struct {
	Devices map[string]discovery.Device
	Rooms   map[string]*room.Room
	Pairs   map[string]*pairing.Pair
	Invites map[string]Invite
	Grants  map[string]bool
}

func NewState() *State {
	return &State{Devices: map[string]discovery.Device{}, Rooms: map[string]*room.Room{}, Pairs: map[string]*pairing.Pair{}, Invites: map[string]Invite{}, Grants: map[string]bool{}}
}

// Repository serializes transactions; implementations own persistence and locking.
type Repository interface {
	Transact(func(*State) error) error
}
type Service struct {
	repo Repository
	now  func() time.Time
}

func New(repo Repository) *Service { return &Service{repo: repo, now: time.Now} }
func ID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func delivery(to, kind string, payload any) Delivery {
	return Delivery{To: to, Event: Event{Type: kind, Payload: payload}}
}
func visible(s *State, a, b discovery.Device) bool {
	return a.ID != b.ID && (a.Network == b.Network || s.Grants[pairing.Key(a.ID, b.ID)])
}
func (s *Service) Register(d discovery.Device) ([]Delivery, error) {
	var out []Delivery
	err := s.repo.Transact(func(st *State) error {
		if len(st.Devices) >= 1000 {
			return errors.New("服务繁忙，请稍后重试")
		}
		r := st.Rooms[d.Network]
		if r == nil {
			r = room.New(d.Network)
			st.Rooms[d.Network] = r
		}
		if err := r.Join(d.ID); err != nil {
			return err
		}
		peers := []discovery.Device{}
		for _, other := range st.Devices {
			if visible(st, d, other) {
				peers = append(peers, other)
				out = append(out, delivery(other.ID, "peer.joined", d))
			}
		}
		st.Devices[d.ID] = d
		roomID := d.Network
		if len(roomID) > 8 {
			roomID = roomID[:8]
		}
		out = append([]Delivery{delivery(d.ID, "welcome", map[string]any{"self": d, "peers": peers, "roomId": roomID, "ipv6": d.IPv6})}, out...)
		return nil
	})
	return out, err
}
func pairEvents(p *pairing.Pair) []Delivery {
	return []Delivery{
		delivery(p.From, "pair.state", map[string]any{"peerId": p.To, "status": p.Status, "initiator": p.From}),
		delivery(p.To, "pair.state", map[string]any{"peerId": p.From, "status": p.Status, "initiator": p.From}),
	}
}
func (s *Service) Execute(actor string, c Command) ([]Delivery, error) {
	var out []Delivery
	err := s.repo.Transact(func(st *State) error {
		d, ok := st.Devices[actor]
		if !ok {
			return errors.New("会话已失效")
		}
		now := s.now()
		switch c.Type {
		case "ping":
			out = append(out, delivery(actor, "pong", nil))
		case "device.rename":
			var p struct {
				Name string `json:"name"`
			}
			if json.Unmarshal(c.Payload, &p) != nil {
				return errors.New("无效名称")
			}
			updated, err := discovery.NewDevice(d.ID, p.Name, d.Platform, d.Network)
			if err != nil {
				return err
			}
			updated.IPv6 = d.IPv6
			st.Devices[actor] = updated
			out = append(out, delivery(actor, "self.updated", updated))
			for _, peer := range st.Devices {
				if visible(st, d, peer) {
					out = append(out, delivery(peer.ID, "peer.updated", updated))
				}
			}
		case "invite.create":
			count := 0
			for _, invite := range st.Invites {
				if invite.DeviceID == actor {
					count++
				}
			}
			if count >= 5 {
				return errors.New("邀请链接过多，请等待旧链接过期")
			}
			token := ID() + ID()
			st.Invites[token] = Invite{DeviceID: actor, Expires: now.Add(10 * time.Minute)}
			out = append(out, delivery(actor, "invite.created", map[string]any{"token": token, "expiresAt": now.Add(10 * time.Minute)}))
		case "invite.join":
			var p struct {
				Token string `json:"token"`
			}
			if json.Unmarshal(c.Payload, &p) != nil {
				return errors.New("邀请链接无效")
			}
			invite, ok := st.Invites[p.Token]
			if !ok || !now.Before(invite.Expires) {
				return errors.New("邀请已失效，请重新生成")
			}
			other, ok := st.Devices[invite.DeviceID]
			if !ok {
				return errors.New("邀请方已离线")
			}
			if other.ID == actor {
				return errors.New("请在另一台设备打开邀请链接")
			}
			st.Grants[pairing.Key(actor, other.ID)] = true
			delete(st.Invites, p.Token)
			out = append(out, delivery(actor, "peer.joined", other), delivery(other.ID, "peer.joined", d), delivery(actor, "invite.joined", map[string]any{"peerId": other.ID}))
		default:
			other, ok := st.Devices[c.PeerID]
			if !ok || !visible(st, d, other) {
				return errors.New("设备已离线或不属于当前发现范围")
			}
			key := pairing.Key(actor, other.ID)
			p := st.Pairs[key]
			switch c.Type {
			case "pair.request":
				if p != nil && (p.Status == pairing.Accepted || p.Status == pairing.Pending && now.Before(p.ExpiresAt)) {
					return errors.New("连接已存在或正在等待确认")
				}
				pending := 0
				for _, existing := range st.Pairs {
					if existing.Status == pairing.Pending && (existing.From == actor || existing.To == actor) {
						pending++
					}
				}
				if pending >= 10 {
					return errors.New("连接请求过多，请稍后重试")
				}
				p, _ = pairing.New(actor, other.ID, now)
				st.Pairs[key] = p
				out = append(out, pairEvents(p)...)
			case "pair.respond":
				if p == nil {
					return errors.New("未找到连接请求")
				}
				var body struct {
					Accept bool `json:"accept"`
				}
				if json.Unmarshal(c.Payload, &body) != nil {
					return errors.New("无效响应")
				}
				if err := p.Respond(actor, body.Accept, now); err != nil {
					if p.Status == pairing.Expired {
						out = append(out, pairEvents(p)...)
						delete(st.Pairs, key)
						return nil
					}
					return err
				}
				out = append(out, pairEvents(p)...)
			case "pair.disconnect":
				if p == nil {
					return errors.New("连接不存在")
				}
				p.Status = pairing.Disconnected
				out = append(out, pairEvents(p)...)
				delete(st.Pairs, key)
			case "signal":
				if p == nil || !p.Allows(actor, other.ID) {
					return errors.New("对方尚未接受连接，不能交换信令")
				}
				var payload struct {
					Kind string          `json:"kind"`
					Data json.RawMessage `json:"data"`
				}
				if json.Unmarshal(c.Payload, &payload) != nil || !strings.Contains("|description|candidate|", "|"+payload.Kind+"|") || payload.Kind == "" {
					return errors.New("无效信令")
				}
				if payload.Kind == "description" {
					var desc struct {
						Type string `json:"type"`
						SDP  string `json:"sdp"`
					}
					if json.Unmarshal(payload.Data, &desc) != nil || (desc.Type != "offer" && desc.Type != "answer") || desc.SDP == "" {
						return errors.New("无效连接描述")
					}
				}
				out = append(out, delivery(other.ID, "signal", map[string]any{"peerId": actor, "kind": payload.Kind, "data": payload.Data}))
			default:
				return fmt.Errorf("不支持的消息类型：%s", c.Type)
			}
		}
		return nil
	})
	return out, err
}
func (s *Service) Remove(id string) []Delivery {
	var out []Delivery
	_ = s.repo.Transact(func(st *State) error {
		d, ok := st.Devices[id]
		if !ok {
			return nil
		}
		for _, peer := range st.Devices {
			if visible(st, d, peer) {
				out = append(out, delivery(peer.ID, "peer.left", map[string]string{"id": id}))
			}
		}
		delete(st.Devices, id)
		if r := st.Rooms[d.Network]; r != nil {
			r.Leave(id)
			if r.Empty() {
				delete(st.Rooms, d.Network)
			}
		}
		for key, p := range st.Pairs {
			if p.From == id || p.To == id {
				delete(st.Pairs, key)
			}
		}
		for key := range st.Grants {
			if strings.HasPrefix(key, id+":") || strings.HasSuffix(key, ":"+id) {
				delete(st.Grants, key)
			}
		}
		for token, invite := range st.Invites {
			if invite.DeviceID == id {
				delete(st.Invites, token)
			}
		}
		return nil
	})
	return out
}
func (s *Service) Sweep() []Delivery {
	var out []Delivery
	_ = s.repo.Transact(func(st *State) error {
		now := s.now()
		for key, p := range st.Pairs {
			if p.Status == pairing.Pending && !now.Before(p.ExpiresAt) {
				p.Status = pairing.Expired
				out = append(out, pairEvents(p)...)
				delete(st.Pairs, key)
			}
		}
		for key, invite := range st.Invites {
			if !now.Before(invite.Expires) {
				delete(st.Invites, key)
			}
		}
		return nil
	})
	return out
}
