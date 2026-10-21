package ai

import (
	"errors"
	"testing"
)

func TestServiceProfile_DefaultNginx(t *testing.T) {
	reg := NewProfileRegistry()
	reg.Register(DefaultNginxProfile())
	prof, err := reg.Get("nginx")
	if err != nil {
		t.Fatalf("expected nginx profile, got: %v", err)
	}

	// 1. Actions test
	allowedActions := []string{"status", "start", "restart", "reload"}
	for _, act := range allowedActions {
		if err := prof.ValidateAction(act); err != nil {
			t.Errorf("expected action %q to be allowed, got error: %v", act, err)
		}
	}

	disallowedActions := []string{"stop", "disable", "mask", "rm", "exec", "kill"}
	for _, act := range disallowedActions {
		if err := prof.ValidateAction(act); err == nil {
			t.Errorf("expected action %q to be disallowed", act)
		} else if !errors.Is(err, ErrActionNotPermitted) {
			t.Errorf("expected ErrActionNotPermitted for %q, got: %v", act, err)
		}
	}

	// 2. Config paths test
	allowedPaths := []string{
		"/etc/nginx/nginx.conf",
		"/etc/nginx/conf.d/default.conf",
		"/etc/nginx/conf.d/app.conf",
		"/etc/nginx/sites-available/site1",
		"/etc/nginx/sites-enabled/site1",
	}
	for _, p := range allowedPaths {
		if err := prof.ValidateConfigPath(p); err != nil {
			t.Errorf("expected path %q to be allowed, got error: %v", p, err)
		}
	}

	disallowedPaths := []string{
		"/etc/shadow",
		"/etc/sudoers",
		"/etc/systemd/system/nginx.service",
		"/usr/sbin/nginx",
		"/var/www/html/index.php",
	}
	for _, p := range disallowedPaths {
		if err := prof.ValidateConfigPath(p); err == nil {
			t.Errorf("expected path %q to be disallowed", p)
		} else if !errors.Is(err, ErrConfigPathDenied) {
			t.Errorf("expected ErrConfigPathDenied for %q, got: %v", p, err)
		}
	}

	// 3. Dangerous directive test
	safeConfig := `
server {
    listen 80;
    server_name example.com;
    root /var/www/html;
}
`
	if err := prof.ValidateConfigContent(safeConfig); err != nil {
		t.Errorf("expected safe config to pass, got: %v", err)
	}

	dangerousConfigs := []string{
		"load_module /usr/lib/nginx/modules/ngx_http_evil_module.so;",
		"http { perl_require /tmp/script.pl; }",
		"lua_package_path '/tmp/?.lua;;';",
		"content_by_lua_block { os.execute('rm -rf /') }",
	}
	for _, dangerous := range dangerousConfigs {
		if err := prof.ValidateConfigContent(dangerous); err == nil {
			t.Errorf("expected dangerous config to be rejected: %s", dangerous)
		} else if !errors.Is(err, ErrDangerousDirective) {
			t.Errorf("expected ErrDangerousDirective, got: %v", err)
		}
	}
}
