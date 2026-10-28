// Package cache provides a small key/value cache abstraction with two
// backends: an in-process memory cache (zero dependencies, single node) and
// Valkey/Redis (shared across replicas).
package cache

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

type Cache interface {
	Get(ctx context.Context, key string) ([]byte, bool, error)
	Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
	Delete(ctx context.Context, keys ...string) error
	Ping(ctx context.Context) error
	Close() error
	Name() string
}

// New returns a cache for the given URL: "memory" (or empty) for the
// in-process cache, or redis://[:password@]host:port/db for Valkey/Redis.
func New(url string) (Cache, error) {
	switch {
	case url == "" || url == "memory":
		return NewMemory(50_000), nil
	case strings.HasPrefix(url, "redis://"), strings.HasPrefix(url, "rediss://"),
		strings.HasPrefix(url, "valkey://"), strings.HasPrefix(url, "valkeys://"):
		url = strings.Replace(url, "valkey", "redis", 1)
		opt, err := redis.ParseURL(url)
		if err != nil {
			return nil, fmt.Errorf("cache url: %w", err)
		}
		return &Remote{client: redis.NewClient(opt)}, nil
	default:
		return nil, fmt.Errorf("unsupported cache url %q (use memory or redis://host:6379/0)", url)
	}
}

// ---- in-process memory cache ----

type entry struct {
	value   []byte
	expires time.Time
}

type Memory struct {
	mu         sync.RWMutex
	items      map[string]entry
	maxEntries int
	stop       chan struct{}
	once       sync.Once
}

func NewMemory(maxEntries int) *Memory {
	m := &Memory{items: make(map[string]entry), maxEntries: maxEntries, stop: make(chan struct{})}
	go m.janitor()
	return m
}

func (m *Memory) Name() string { return "memory" }

func (m *Memory) Get(_ context.Context, key string) ([]byte, bool, error) {
	m.mu.RLock()
	e, ok := m.items[key]
	m.mu.RUnlock()
	if !ok || time.Now().After(e.expires) {
		return nil, false, nil
	}
	return e.value, true, nil
}

func (m *Memory) Set(_ context.Context, key string, value []byte, ttl time.Duration) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.items) >= m.maxEntries {
		// Cheap bounded eviction: drop roughly a quarter of the entries
		// (Go map iteration order is randomised).
		drop := m.maxEntries / 4
		for k := range m.items {
			delete(m.items, k)
			if drop--; drop <= 0 {
				break
			}
		}
	}
	m.items[key] = entry{value: value, expires: time.Now().Add(ttl)}
	return nil
}

func (m *Memory) Delete(_ context.Context, keys ...string) error {
	m.mu.Lock()
	for _, k := range keys {
		delete(m.items, k)
	}
	m.mu.Unlock()
	return nil
}

func (m *Memory) Ping(context.Context) error { return nil }

func (m *Memory) Close() error {
	m.once.Do(func() { close(m.stop) })
	return nil
}

func (m *Memory) janitor() {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-m.stop:
			return
		case now := <-t.C:
			m.mu.Lock()
			for k, e := range m.items {
				if now.After(e.expires) {
					delete(m.items, k)
				}
			}
			m.mu.Unlock()
		}
	}
}

// ---- Valkey / Redis ----

type Remote struct {
	client *redis.Client
}

func (r *Remote) Name() string { return "valkey" }

func (r *Remote) Get(ctx context.Context, key string) ([]byte, bool, error) {
	b, err := r.client.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return b, true, nil
}

func (r *Remote) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	return r.client.Set(ctx, key, value, ttl).Err()
}

func (r *Remote) Delete(ctx context.Context, keys ...string) error {
	if len(keys) == 0 {
		return nil
	}
	return r.client.Del(ctx, keys...).Err()
}

func (r *Remote) Ping(ctx context.Context) error { return r.client.Ping(ctx).Err() }

func (r *Remote) Close() error { return r.client.Close() }
