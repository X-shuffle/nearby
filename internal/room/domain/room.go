package domain

import "errors"

const MaxMembers = 50

type Room struct {
	ID      string
	Members map[string]bool
}

func New(id string) *Room { return &Room{ID: id, Members: map[string]bool{}} }
func (r *Room) Join(id string) error {
	if len(r.Members) >= MaxMembers && !r.Members[id] {
		return errors.New("当前网络在线设备过多，请稍后重试")
	}
	r.Members[id] = true
	return nil
}
func (r *Room) Leave(id string) { delete(r.Members, id) }
func (r *Room) Empty() bool     { return len(r.Members) == 0 }
