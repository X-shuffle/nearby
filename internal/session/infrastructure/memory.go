package infrastructure

import (
	"nearby/internal/session/application"
	"sync"
)

type MemoryRepository struct {
	mu    sync.Mutex
	state *application.State
}

func NewMemoryRepository() *MemoryRepository { return &MemoryRepository{state: application.NewState()} }
func (m *MemoryRepository) Transact(fn func(*application.State) error) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return fn(m.state)
}
