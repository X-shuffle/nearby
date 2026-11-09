package main

import (
	"context"
	"errors"
	"log/slog"
	"nearby/internal/interfaces/httpapi"
	"nearby/internal/session/application"
	"nearby/internal/session/infrastructure"
	"nearby/web"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func main() {
	config := httpapi.Config{Origins: split(os.Getenv("ALLOWED_ORIGINS")), DiscoveryURL: os.Getenv("DISCOVERY_WS_URL")}
	for _, value := range split(os.Getenv("TRUSTED_PROXIES")) {
		prefix, err := netip.ParsePrefix(value)
		if err != nil {
			slog.Error("无效 TRUSTED_PROXIES", "value", value)
			os.Exit(1)
		}
		config.TrustedProxies = append(config.TrustedProxies, prefix)
	}
	for _, value := range split(os.Getenv("STUN_URLS")) {
		if !strings.HasPrefix(value, "stun:") && !strings.HasPrefix(value, "stuns:") {
			slog.Error("仅允许 STUN 地址，TURN 已禁用")
			os.Exit(1)
		}
		config.STUNURLs = append(config.STUNURLs, value)
	}
	if config.DiscoveryURL != "" {
		u, err := url.Parse(config.DiscoveryURL)
		if err != nil || u.Scheme != "wss" || u.Host == "" {
			slog.Error("DISCOVERY_WS_URL 必须为有效 wss 地址")
			os.Exit(1)
		}
	}
	service := application.New(infrastructure.NewMemoryRepository())
	api := httpapi.New(service, config)
	address := os.Getenv("ADDR")
	if address == "" {
		address = ":15789"
	}
	server := &http.Server{Addr: address, Handler: api.Handler(web.Assets()), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 16 * 1024}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go api.Run(ctx)
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		server.Shutdown(shutdownCtx)
	}()
	slog.Info("近邻 Nearby 已启动", "address", address, "turn", false)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("启动失败", "error", err)
		os.Exit(1)
	}
}
func split(value string) []string {
	var values []string
	for _, item := range strings.Split(value, ",") {
		if v := strings.TrimSpace(item); v != "" {
			values = append(values, v)
		}
	}
	return values
}
