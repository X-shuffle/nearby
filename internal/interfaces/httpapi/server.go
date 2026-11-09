package httpapi

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	discovery "nearby/internal/discovery/domain"
	"nearby/internal/session/application"
)

type Config struct {
	Origins        []string
	TrustedProxies []netip.Prefix
	DiscoveryURL   string
	STUNURLs       []string
}
type client struct {
	conn   *websocket.Conn
	queue  chan application.Event
	cancel context.CancelFunc
}
type Server struct {
	service *application.Service
	config  Config
	salt    []byte
	mu      sync.Mutex
	clients map[string]*client
}

func New(service *application.Service, config Config) *Server {
	salt := make([]byte, 32)
	if _, err := rand.Read(salt); err != nil {
		panic(err)
	}
	return &Server{service: service, config: config, salt: salt, clients: map[string]*client{}}
}
func (s *Server) trusted(ip netip.Addr) bool {
	for _, prefix := range s.config.TrustedProxies {
		if prefix.Contains(ip) {
			return true
		}
	}
	return false
}
func (s *Server) ClientIP(r *http.Request) (netip.Addr, error) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}, errors.New("无效客户端地址")
	}
	ip = ip.Unmap()
	if s.trusted(ip) {
		parts := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
		for i := len(parts) - 1; i >= 0; i-- {
			next, err := netip.ParseAddr(strings.TrimSpace(parts[i]))
			if err != nil {
				return netip.Addr{}, errors.New("无效代理地址")
			}
			ip = next.Unmap()
			if !s.trusted(ip) {
				break
			}
		}
	}
	return ip, nil
}
func (s *Server) network(ip netip.Addr) string {
	mac := hmac.New(sha256.New, s.salt)
	mac.Write([]byte(ip.String()))
	return hex.EncodeToString(mac.Sum(nil))
}
func (s *Server) dispatch(events []application.Delivery) {
	for _, delivery := range events {
		if c := s.clients[delivery.To]; c != nil {
			select {
			case c.queue <- delivery.Event:
			default:
				c.cancel()
			}
		}
	}
}
func (s *Server) socket(w http.ResponseWriter, r *http.Request) {
	ip, err := s.ClientIP(r)
	if err != nil {
		http.Error(w, "无法识别网络地址", 400)
		return
	}
	device, err := discovery.NewDevice(application.ID(), r.URL.Query().Get("name"), r.URL.Query().Get("platform"), s.network(ip))
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	device.IPv6 = ip.Is6()
	if r.Header.Get("Origin") == "" {
		http.Error(w, "缺少来源信息", 403)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: s.config.Origins})
	if err != nil {
		return
	}
	conn.SetReadLimit(96 * 1024)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	defer conn.CloseNow()
	c := &client{conn: conn, queue: make(chan application.Event, 128), cancel: cancel}
	s.mu.Lock()
	events, err := s.service.Register(device)
	if err == nil {
		s.clients[device.ID] = c
		s.dispatch(events)
	}
	s.mu.Unlock()
	if err != nil {
		conn.Close(websocket.StatusTryAgainLater, err.Error())
		return
	}
	defer func() {
		s.mu.Lock()
		delete(s.clients, device.ID)
		s.dispatch(s.service.Remove(device.ID))
		s.mu.Unlock()
	}()
	go func() {
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case event := <-c.queue:
				writeCtx, done := context.WithTimeout(ctx, 10*time.Second)
				err := wsjson.Write(writeCtx, conn, event)
				done()
				if err != nil {
					cancel()
					return
				}
			case <-ticker.C:
				pingCtx, done := context.WithTimeout(ctx, 10*time.Second)
				err := conn.Ping(pingCtx)
				done()
				if err != nil {
					cancel()
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}()
	tokens := 200.0
	last := time.Now()
	for {
		var command application.Command
		if err := wsjson.Read(ctx, conn, &command); err != nil {
			return
		}
		now := time.Now()
		tokens += now.Sub(last).Seconds() * 10
		if tokens > 200 {
			tokens = 200
		}
		last = now
		tokens--
		if tokens < 0 {
			conn.Close(websocket.StatusPolicyViolation, "请求过于频繁")
			return
		}
		s.mu.Lock()
		events, err := s.service.Execute(device.ID, command)
		if err != nil {
			events = []application.Delivery{{To: device.ID, Event: application.Event{Type: "error", Payload: map[string]any{"message": err.Error(), "command": command.Type, "peerId": command.PeerID}}}}
		}
		s.dispatch(events)
		s.mu.Unlock()
	}
}
func (s *Server) Handler(assets fs.FS) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/ws", s.socket)
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("GET /api/config", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"discoveryUrl": s.config.DiscoveryURL, "stunUrls": s.config.STUNURLs, "turnEnabled": false, "maxFileBytes": 256 * 1024 * 1024})
	})
	fileServer := http.FileServer(http.FS(assets))
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		fileServer.ServeHTTP(w, r)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		connect := "'self'"
		if u, err := url.Parse(s.config.DiscoveryURL); err == nil && u.Host != "" {
			connect += " " + u.Scheme + "://" + u.Host
		}
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src "+connect+"; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
		mux.ServeHTTP(w, r)
	})
}
func (s *Server) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			s.mu.Lock()
			for _, c := range s.clients {
				c.cancel()
			}
			s.mu.Unlock()
			return
		case <-ticker.C:
			s.mu.Lock()
			s.dispatch(s.service.Sweep())
			s.mu.Unlock()
		}
	}
}
