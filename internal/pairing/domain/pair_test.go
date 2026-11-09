package domain

import (
	"testing"
	"time"
)

func TestOnlyRecipientCanAccept(t *testing.T) {
	now := time.Now()
	p, _ := New("a", "b", now)
	if err := p.Respond("a", true, now); err == nil {
		t.Fatal("initiator accepted own request")
	}
	if p.Allows("a", "b") {
		t.Fatal("pending pair allows signaling")
	}
	if err := p.Respond("b", true, now); err != nil {
		t.Fatal(err)
	}
	if !p.Allows("a", "b") || !p.Allows("b", "a") || p.Allows("a", "c") {
		t.Fatal("incorrect pair authorization")
	}
	if err := p.Respond("b", false, now); err == nil {
		t.Fatal("accepted pair changed by duplicate response")
	}
}
func TestExpiredRequestCannotBeAccepted(t *testing.T) {
	now := time.Now()
	p, _ := New("a", "b", now)
	if p.Respond("b", true, now.Add(time.Minute)) == nil || p.Status != Expired {
		t.Fatal("expired request accepted")
	}
}
func TestSelfPairRejected(t *testing.T) {
	if _, err := New("a", "a", time.Now()); err == nil {
		t.Fatal("self pair accepted")
	}
}
