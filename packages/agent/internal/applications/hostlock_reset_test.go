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
}
