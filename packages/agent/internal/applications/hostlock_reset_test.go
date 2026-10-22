package applications

import "sync"

// resetHostLockSingleton clears the lazily built lock store AND its sync.Once
// guard so the next hostlock call re-resolves the registry from the ambient
// environment. Without clearing lockRegistryOnce, only the first environment
// seen in this package's test binary is ever honored. It must live in a
// build-tag-free _test.go file because TestHostLockMutatingExclusion
// (lifecycle_test.go, compiled on every GOOS) resets the shared registry too.
func resetHostLockSingleton() {
	lockRegistryOnce = sync.Once{}
	lockRegistry = nil
	lockRegistryErr = nil
	storesMu.Lock()
	stores = make(map[string]*lockStore)
	storesMu.Unlock()
}

func overrideLockTestHooks(startFn func() int64, aliveFn func(pid int, recordedStart int64) bool) {
	procStartTimeOverride = func(pid int) (int64, error) {
		if startFn != nil {
			return startFn(), nil
		}
		return 0, nil
	}
	procAliveOverride = func(pid int, recordedStart int64) (bool, bool) {
		if aliveFn == nil {
			return true, true
		}
		return aliveFn(pid, recordedStart), true
	}
}

func resetLockTestHooks() {
	procStartTimeOverride = nil
	procAliveOverride = nil
}
