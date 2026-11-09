package httpapi

import (
	"net/http/httptest"
	"net/netip"
	"testing"
)

func TestCloudflareExtractsActualVisitorAfterSpoofedPrefix(t *testing.T) {
	s := api()
	s.config.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("173.245.48.0/20")}
	r := httptest.NewRequest("GET", "http://nearby.your-domain.com/api/ws", nil)
	r.RemoteAddr = "173.245.48.5:1234"
	// Cloudflare appends the actual connecting visitor after any incoming XFF.
	r.Header.Set("X-Forwarded-For", "192.0.2.123, 198.51.100.7")
	ip, err := s.ClientIP(r)
	if err != nil || ip.String() != "198.51.100.7" {
		t.Fatalf("wrong visitor IP: %v %v", ip, err)
	}
}

func TestCloudflareIPv6VisitorPreserved(t *testing.T) {
	s := api()
	s.config.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("2606:4700::/32")}
	r := httptest.NewRequest("GET", "http://nearby.your-domain.com/api/ws", nil)
	r.RemoteAddr = "[2606:4700::1]:1234"
	r.Header.Set("X-Forwarded-For", "2001:db8:1234::7")
	ip, err := s.ClientIP(r)
	if err != nil || ip.String() != "2001:db8:1234::7" {
		t.Fatalf("wrong IPv6 visitor: %v %v", ip, err)
	}
}

func TestTrustedCloudflareWithoutVisitorHeaderFailsClosed(t *testing.T) {
	s := api()
	s.config.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("173.245.48.0/20")}
	r := httptest.NewRequest("GET", "http://nearby.your-domain.com/api/ws", nil)
	r.RemoteAddr = "173.245.48.5:1234"
	if _, err := s.ClientIP(r); err == nil {
		t.Fatal("missing visitor header must not group users by Cloudflare edge IP")
	}
}
