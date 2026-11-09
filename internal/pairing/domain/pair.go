package domain

import (
	"errors"
	"sort"
	"strings"
	"time"
)

type Status string

const (
	Pending      Status = "pending"
	Accepted     Status = "accepted"
	Rejected     Status = "rejected"
	Expired      Status = "expired"
	Disconnected Status = "disconnected"
)

type Pair struct {
	From, To  string
	Status    Status
	ExpiresAt time.Time
}

func Key(a, b string) string {
	values := []string{a, b}
	sort.Strings(values)
	return strings.Join(values, ":")
}
func New(from, to string, now time.Time) (*Pair, error) {
	if from == to {
		return nil, errors.New("不能连接自己")
	}
	return &Pair{From: from, To: to, Status: Pending, ExpiresAt: now.Add(45 * time.Second)}, nil
}
func (p *Pair) Respond(actor string, accept bool, now time.Time) error {
	if p.Status != Pending {
		return errors.New("连接请求已处理")
	}
	if !now.Before(p.ExpiresAt) {
		p.Status = Expired
		return errors.New("连接请求已过期")
	}
	if actor != p.To {
		return errors.New("只有接收方可以确认连接")
	}
	if accept {
		p.Status = Accepted
	} else {
		p.Status = Rejected
	}
	return nil
}
func (p *Pair) Allows(a, b string) bool {
	return p.Status == Accepted && Key(a, b) == Key(p.From, p.To)
}
