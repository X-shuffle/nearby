package domain

import (
	"errors"
	"strings"
	"unicode/utf8"
)

type Device struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Platform string `json:"platform"`
	Network  string `json:"-"`
	IPv6     bool   `json:"ipv6"`
}

func NewDevice(id, name, platform, network string) (Device, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > 24 {
		return Device{}, errors.New("设备名称需为 1–24 个字符")
	}
	if len(platform) > 80 {
		return Device{}, errors.New("设备信息过长")
	}
	return Device{ID: id, Name: name, Platform: platform, Network: network}, nil
}
