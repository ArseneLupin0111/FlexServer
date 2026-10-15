#!/usr/bin/env python3
"""Behavior regression tests for flexserverctl.

The CLI is Linux-only, so this suite runs on Linux and exercises the real
POSIX seams (/proc symlinks, chown, chmod) rather than faking them. A few
paths still need care and are skipped explicitly: permission bits do not
constrain root, and a real subprocess needs the real /proc to be inspected.

Each reviewer-flagged defect has at least one
dedicated test here:

  1.  a relative `-config` resolves against that process's own /proc cwd
  2.  `stop_exact_process` reports non-ownership instead of signalling
  3.  a spawn whose identity cannot be verified is killed and never published
  4.  systemd orders `stop` before the delivery preflight and `restart` after
  5.  a systemd restart failure rolls the config back byte-for-byte
  6.  an inactive/failed updater rolls the cutover back
  7.  a user preflight failure restarts the original loop with its own argv
  8.  a user post-health failure stops the new loop and restarts the original
  9.  rollback restores bytes AND owner/mode, and never deletes the backup
      when the restore itself failed
  10. an updater with ANY job evidence refuses before any config mutation
  11. systemd serialises concurrent invocations via the lock
  12. https-only migration, no host allow/deny list, no token leakage
"""
from __future__ import annotations

import contextlib
import http.server
import io
import json
import os
import shutil
import signal
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock

# Ensure the scripts/install directory is in sys.path
INSTALL_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "install"))
if INSTALL_DIR not in sys.path:
    sys.path.insert(0, INSTALL_DIR)

import flexserverctl  # noqa: E402

AGENT_CFG = {
    "backendUrl": "https://initial.flexserver.tech",
    "vpsId": "vps_test",
    "token": "vma_secret_token_12345",
    "intervalSeconds": 10,
    "requestTimeoutSeconds": 5,
    "keepCustomField": "important_value",
}
UPDATER_CFG = {
    "apiBase": "https://initial.flexserver.tech",
    "credential": "vma_updater_cred_abcdef",
    "pinnedPublicKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "keepUpdaterField": 42,
}
BAK = ".flexserverctl.bak"


class HealthStub:
    """In-process HTTP server providing dynamic /api/health responses."""

    def __init__(self, handler_cb):
        self.handler_cb = handler_cb

    def start(self):
        cb = self.handler_cb

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                status, headers, body = cb(self.path, self.headers)
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.end_headers()
                if body:
                    self.wfile.write(body)

            def log_message(self, fmt, *args):  # noqa: A002
                pass

        self.server = socketserver.TCPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return f"http://127.0.0.1:{self.port}"

    def stop(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()
        if self.thread:
            self.thread.join(timeout=2)


def ok_cb(path, headers):
    return 200, {"Content-Type": "application/json"}, b'{"ok": true}'


class LinuxGuard(unittest.TestCase):
    """Marker base for tests that exercise real POSIX seams.

    The suite is Linux-only and the CLI is Linux-only. On non-Linux platforms,
    tests skip consistently without fragile Windows monkeypatching.
    """

    @classmethod
    def setUpClass(cls):
        if not sys.platform.startswith("linux"):
            raise unittest.SkipTest("flexserverctl is Linux-only")


class TestUrlValidation(LinuxGuard):
    def test_valid_https(self):
        self.assertEqual(
            flexserverctl.validate_backend_url("https://flexserver.tech"),
            "https://flexserver.tech",
        )
        self.assertEqual(
            flexserverctl.validate_backend_url("https://flexserver.tech/"),
            "https://flexserver.tech",
        )
        self.assertEqual(
            flexserverctl.validate_backend_url("https://custom.backend.org:8443/"),
            "https://custom.backend.org:8443",
        )
        self.assertEqual(
            flexserverctl.validate_backend_url("https://api.flexserver.tech"),
            "https://api.flexserver.tech",
        )

    def test_loopback_http_allowed(self):
        self.assertEqual(flexserverctl.validate_backend_url("http://127.0.0.1:3000"),
                         "http://127.0.0.1:3000")
        self.assertEqual(flexserverctl.validate_backend_url("http://localhost:8080/"),
                         "http://localhost:8080")
        self.assertEqual(flexserverctl.validate_backend_url("http://[::1]:3000"),
                         "http://[::1]:3000")

    def test_non_loopback_http_rejected(self):
        for bad in ("http://192.168.1.100:3000", "http://example.com"):
            with self.assertRaises(ValueError):
                flexserverctl.validate_backend_url(bad)

    def test_host_is_neither_allowed_nor_denied(self):
        """No host allow/deny list exists. Shape only."""
        for good in (
            "https://api.flexserver.tech",
            "https://whatever.invalid",
            "https://localhost",
        ):
            self.assertEqual(flexserverctl.validate_backend_url(good), good)

    def test_bad_shapes_rejected(self):
        for bad in (
            "https://user:pass@flexserver.tech",
            "ftp://flexserver.tech",
            "/path/only",
            "",
        ):
            with self.assertRaises(ValueError):
                flexserverctl.validate_backend_url(bad)

    def test_updater_requires_https(self):
        self.assertEqual(
            flexserverctl.validate_updater_apibase("https://flexserver.tech"),
            "https://flexserver.tech",
        )
        with self.assertRaises(ValueError) as ctx:
            flexserverctl.validate_updater_apibase("http://127.0.0.1:3000")
        self.assertIn("apiBase must stay https", str(ctx.exception))


class TestConfigValidation(LinuxGuard):
    def test_agent_config_ok(self):
        flexserverctl.validate_agent_config(dict(AGENT_CFG))

    def test_agent_config_rejects_missing_key(self):
        cfg = dict(AGENT_CFG)
        del cfg["vpsId"]
        with self.assertRaises(ValueError):
            flexserverctl.validate_agent_config(cfg)

    def test_agent_config_rejects_bad_interval(self):
        cfg = dict(AGENT_CFG)
        cfg["intervalSeconds"] = 0
        with self.assertRaises(ValueError):
            flexserverctl.validate_agent_config(cfg)

    def test_updater_config_ok(self):
        flexserverctl.validate_updater_config(dict(UPDATER_CFG))

    def test_updater_config_without_pinned_key_ok(self):
        cfg = dict(UPDATER_CFG)
        del cfg["pinnedPublicKey"]
        flexserverctl.validate_updater_config(cfg)
    def test_updater_config_rejects_bad_key_length(self):
        cfg = dict(UPDATER_CFG)
        cfg["pinnedPublicKey"] = "AAA="
        with self.assertRaises(ValueError):
            flexserverctl.validate_updater_config(cfg)

    def test_updater_config_rejects_unscoped_credential(self):
        cfg = dict(UPDATER_CFG)
        cfg["credential"] = "not_a_token"
        with self.assertRaises(ValueError):
            flexserverctl.validate_updater_config(cfg)


class TestTokenHygiene(LinuxGuard):
    def test_redaction(self):
        sample = '{"token":"vma_secret_token_12345"}'
        self.assertEqual(flexserverctl.redact(sample), '{"token":"[redacted]"}')


class TestHealthProbe(LinuxGuard):
    def test_health_ok(self):
        stub = HealthStub(ok_cb)
        url = stub.start()
        try:
            ok, msg = flexserverctl.health_probe(url, timeout=5)
            self.assertTrue(ok)
        finally:
            stub.stop()

    def test_health_missing_ok(self):
        stub = HealthStub(lambda p, h: (200, {}, b'{"status":"healthy"}'))
        url = stub.start()
        try:
            ok, msg = flexserverctl.health_probe(url, timeout=5)
            self.assertFalse(ok)
        finally:
            stub.stop()

    def test_health_non_json(self):
        stub = HealthStub(lambda p, h: (200, {}, b"<html>nope</html>"))
        url = stub.start()
        try:
            ok, msg = flexserverctl.health_probe(url, timeout=5)
            self.assertFalse(ok)
        finally:
            stub.stop()

    def test_health_error_status(self):
        stub = HealthStub(lambda p, h: (503, {}, b'{"ok": false}'))
        url = stub.start()
        try:
            ok, msg = flexserverctl.health_probe(url, timeout=5)
            self.assertFalse(ok)
        finally:
            stub.stop()

    def test_health_redirect_refused(self):
        def cb(path, headers):
            if path == "/api/health":
                return 307, {"Location": "http://127.0.0.1:1/api/health"}, b""
            return 200, {}, b'{"ok": true}'

        stub = HealthStub(cb)
        url = stub.start()
        try:
            ok, msg = flexserverctl.health_probe(url, timeout=5)
            self.assertFalse(ok)
        finally:
            stub.stop()

    def test_probe_never_sends_authorization(self):
        seen = {}

        def cb(path, headers):
            seen.update({k.lower(): v for k, v in headers.items()})
            return 200, {}, b'{"ok": true}'

        stub = HealthStub(cb)
        url = stub.start()
        try:
            flexserverctl.health_probe(url, timeout=5)
            self.assertNotIn("authorization", seen)
        finally:
            stub.stop()


class TestConfigIdentity(LinuxGuard):
    """Backup/restore must preserve bytes AND owner/mode, never a fallback.

    Owner/mode assertions are POSIX-only: Windows `os.chmod` only supports the
    write bit, so mode round-trips cannot be observed there.
    """

    def posix_mode(self, path):
        if os.name != "posix":
            self.skipTest("POSIX mode semantics required")
        return flexserverctl.file_identity(path)[2]

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cfg = os.path.join(self.tmp, "config.json")
        with open(self.cfg, "w") as fh:
            fh.write('{"a": 1}')
        os.chmod(self.cfg, 0o640)
        self.identity = flexserverctl.file_identity(self.cfg)
        self.assertIsNotNone(self.identity)

    def test_make_backup_refuses_retained_backup(self):
        flexserverctl.make_backup(self.cfg)
        with self.assertRaises(ValueError):
            flexserverctl.make_backup(self.cfg)

    def test_backup_preserves_mode(self):
        flexserverctl.make_backup(self.cfg)
        self.assertEqual(self.posix_mode(self.cfg + BAK), 0o640)

    def test_restore_roundtrips_bytes_and_mode(self):
        original = flexserverctl.make_backup(self.cfg)
        with open(self.cfg, "w") as fh:
            fh.write('{"a": 2}')
        flexserverctl.restore_backup_with_identity(self.cfg, self.identity)
        with open(self.cfg) as fh:
            self.assertEqual(fh.read(), original.decode())
        self.assertEqual(self.posix_mode(self.cfg), 0o640)

    def test_restore_refuses_without_identity(self):
        flexserverctl.make_backup(self.cfg)
        with self.assertRaises(ValueError):
            flexserverctl.restore_backup_with_identity(self.cfg, None)

    def test_restore_refuses_missing_backup(self):
        with self.assertRaises(ValueError):
            flexserverctl.restore_backup_with_identity(self.cfg, self.identity)

    def test_atomic_write_uses_recorded_identity(self):
        flexserverctl.atomic_write_json(self.cfg, {"a": 3}, self.identity)
        with open(self.cfg) as fh:
            self.assertEqual(json.load(fh), {"a": 3})
        self.assertEqual(self.posix_mode(self.cfg), 0o640)

    def test_safe_chown_propagates_failure(self):
        """A chown failure must never be swallowed."""
        with unittest.mock.patch("os.chown", side_effect=OSError(1, "Operation not permitted")):
            with self.assertRaises(OSError):
                flexserverctl.safe_chown(self.cfg, 999999, 999999)


class FakeProc:
    """A minimal, controllable /proc tree."""

    def __init__(self, root):
        self.root = root
        os.makedirs(root, exist_ok=True)

    def add(self, pid, exe, cwd, argv, starttime="12345", alive=True):
        d = os.path.join(self.root, str(pid))
        os.makedirs(d, exist_ok=True)
        if not alive:
            return pid
        with open(os.path.join(d, "cmdline"), "wb") as fh:
            fh.write(b"\0".join(a.encode() for a in argv) + b"\0")
        cwd_target = os.path.join(d, "cwd")
        if os.path.lexists(cwd_target):
            os.unlink(cwd_target)
        try:
            os.symlink(cwd, cwd_target)
        except OSError:
            with open(cwd_target, "w") as fh:
                fh.write(cwd)
        exe_target = os.path.join(d, "exe")
        if os.path.lexists(exe_target):
            os.unlink(exe_target)
        try:
            os.symlink(exe, exe_target)
        except OSError:
            with open(exe_target, "w") as fh:
                fh.write(exe)
        with open(os.path.join(d, "stat"), "w") as fh:
            fh.write(f"{pid} (proc) S 1 1 1 0 -1 8192 0 0 0 0 0 0 0 0 20 0 1 0 {starttime} 0")
        return pid

    def set_starttime(self, pid, starttime):
        with open(os.path.join(self.root, str(pid), "stat"), "w") as fh:
            fh.write(f"{pid} (proc) S 1 1 1 0 -1 8192 0 0 0 0 0 0 0 0 20 0 1 0 {starttime} 0")

    def remove(self, pid):
        p = os.path.join(self.root, str(pid))
        if os.path.isdir(p):
            shutil.rmtree(p)


class TestProcessIdentity(LinuxGuard):
    """Defects 1 and 2: relative -config resolution and owned-only kills."""

    def setUp(self):
        super().setUp()  # keep the Linux-only gate neutralised
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.proc_root = os.path.join(self.tmp, "proc")
        os.makedirs(self.proc_root)
        self.home = os.path.join(self.tmp, "home")
        os.makedirs(self.home)
        self.agent_dir = os.path.join(self.home, ".vps-manager-agent")
        os.makedirs(self.agent_dir)
        self.exe = os.path.join(self.agent_dir, "vps-agent")
        self.cfg = os.path.join(self.agent_dir, "config.json")
        with open(self.cfg, "w") as fh:
            json.dump(dict(AGENT_CFG), fh)
        self.pid_file = os.path.join(self.agent_dir, "vps-agent.pid")
        patcher = unittest.mock.patch.dict(
            os.environ,
            {
                "FLEXSERVERCTL_PROC_ROOT": self.proc_root,
                "FLEXSERVERCTL_HOME": self.home,
                "FLEXSERVERCTL_AGENT_CONFIG": self.cfg,
                "FLEXSERVERCTL_JOURNALCTL_BIN": "false",
            },
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_relative_config_resolves_against_process_cwd(self):
        """Defect 1: a loop started with -config ./config.json must be found."""
        proc = FakeProc(self.proc_root)
        pid = proc.add(881, self.exe, self.agent_dir, [self.exe, "-config", "config.json"])
        matches = flexserverctl.find_managed_processes(self.exe, self.cfg)
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["pid"], str(pid))
        self.assertEqual(matches[0]["argv"][1], "-config")

    def test_loop_config_relative(self):
        self.assertEqual(
            flexserverctl.loop_config_from_argv(["x", "-config", "config.json"], "/a/b/c"),
            flexserverctl.canonical("/a/b/c/config.json"),
        )
        self.assertEqual(
            flexserverctl.loop_config_from_argv(
                ["x", "-config", "/etc/vps-manager-agent/config.json"], "/a"
            ),
            flexserverctl.canonical("/etc/vps-manager-agent/config.json"),
        )

    def test_loop_config_relative_without_cwd_is_none(self):
        self.assertIsNone(flexserverctl.loop_config_from_argv(["x", "-config", "c.json"], ""))

    def test_one_shot_flag_excluded(self):
        proc = FakeProc(self.proc_root)
        pid = proc.add(883, self.exe, self.agent_dir, [self.exe, "-config", self.cfg, "-once"])
        self.assertEqual(flexserverctl.find_managed_processes(self.exe, self.cfg), [])

    def test_stop_exact_process_reports_non_ownership(self):
        """Defect 2: never signal a process we do not fully own."""
        proc = FakeProc(self.proc_root)
        pid = proc.add(889, "/usr/local/bin/other-binary", self.agent_dir,
                       ["/usr/local/bin/other-binary", "-config", self.cfg])
        # Same exe, but a starttime the caller does not own.
        result = flexserverctl.stop_exact_process(
            {"pid": str(pid), "starttime": "999999",
             "argv": ["/usr/local/bin/other-binary", "-config", self.cfg], "cwd": self.agent_dir},
            "/usr/local/bin/other-binary", self.cfg,
        )
        self.assertFalse(result)
        self.assertTrue(os.path.isdir(os.path.join(self.proc_root, str(pid))))

    def test_stop_exact_process_stops_owned_live_child(self):
        """A genuinely owned live child is TERMed and gone."""
        with unittest.mock.patch.dict(os.environ, {"FLEXSERVERCTL_PROC_ROOT": "/proc"}):
            argv = [sys.executable, "-c", "import time; time.sleep(60)", "-config", self.cfg]
            child = subprocess.Popen(
                argv,
                cwd=self.agent_dir,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            self.addCleanup(lambda: (child.poll() is None and (child.kill(), child.wait())))
            time.sleep(0.3)
            starttime = flexserverctl.read_starttime(child.pid)
            self.assertTrue(starttime)
            proc_dict = {
                "pid": str(child.pid),
                "starttime": starttime,
                "argv": argv,
                "cwd": flexserverctl.read_cwd(child.pid),
            }
            result = flexserverctl.stop_exact_process(proc_dict, sys.executable, self.cfg)
            self.assertTrue(result)
            child.wait(timeout=5)
            self.assertIsNotNone(child.returncode)
            self.assertFalse(flexserverctl.pid_alive(child.pid))


class TestClassifyInspection(LinuxGuard):
    def setUp(self):
        super().setUp()
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.liveness = os.path.join(self.tmp, "live")
        os.makedirs(self.liveness)
        self.pid_file = os.path.join(self.tmp, "vps-agent.pid")

    def _write(self, content):
        with open(self.pid_file, "w") as fh:
            fh.write(content)

    def test_owned_new_field(self):
        self._write("123\n")
        result = flexserverctl.classify_inspection(
            [{"pid": "123", "starttime": "77"}], self.pid_file, self.liveness
        )
        self.assertEqual(result, "owned:123:77")

    def test_stale_owner_returns_stale_owner(self):
        self._write("999\n")
        # PID 999 is alive in liveness tree, but no managed process matches -> mismatch
        os.makedirs(os.path.join(self.liveness, "999"), exist_ok=True)
        result = flexserverctl.classify_inspection([], self.pid_file, self.liveness)
        self.assertEqual(result, "mismatch")

    def test_dead_pid_file_returns_none(self):
        self._write("999\n")
        # PID 999 is not alive in liveness tree -> stale pid file of dead process is "none"
        result = flexserverctl.classify_inspection([], self.pid_file, self.liveness)
        self.assertEqual(result, "none")

    def test_none_when_no_pid_file(self):
        result = flexserverctl.classify_inspection([], self.pid_file, self.liveness)
        self.assertEqual(result, "none")

    def test_invalid_pid_file_content(self):
        self._write("not-a-pid\n")
        result = flexserverctl.classify_inspection([], self.pid_file, self.liveness)
        self.assertEqual(result, "invalid")

    def test_ambiguous_when_many_matches(self):
        self._write("13\n")
        matches = [{"pid": "13", "starttime": "1"}, {"pid": "14", "starttime": "2"}]
        self.assertEqual(
            flexserverctl.classify_inspection(matches, self.pid_file, self.liveness),
            "ambiguous",
        )

    def test_pid_file_points_at_process_that_is_not_ours(self):
        self._write("13\n")
        self.assertEqual(
            flexserverctl.classify_inspection(
                [{"pid": "77", "starttime": "9"}], self.pid_file, self.liveness
            ),
            "mismatch",
        )

class TestLifecycleLock(LinuxGuard):
    def setUp(self):
        super().setUp()
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.path = os.path.join(self.tmp, "lock")

    def test_roundtrip(self):
        lock = flexserverctl.LifecycleLock(self.path)
        self.assertTrue(lock.acquire())
        self.assertTrue(os.path.isdir(self.path))
        second = flexserverctl.LifecycleLock(self.path)
        self.assertFalse(second.acquire())
        lock.release()
        self.assertFalse(os.path.exists(self.path))
        self.assertTrue(second.acquire())


class TestGoFlagArgv(LinuxGuard):
    """Reviewer follow-up: Go flag forms, not just the exact literal token."""

    def test_config_value_forms(self):
        for argv in (
            ["/bin/x", "-config", "/a/b.json"],
            ["/bin/x", "--config", "/a/b.json"],
            ["/bin/x", "-config=/a/b.json"],
            ["/bin/x", "--config=/a/b.json"],
        ):
            self.assertTrue(flexserverctl.is_loop_argv(argv), argv)
            self.assertEqual(
                flexserverctl.loop_config_from_argv(argv, "/home/user"),
                flexserverctl.canonical("/a/b.json"),
                argv,
            )

    def test_config_equality_form_relative(self):
        argv = ["/bin/x", "-config=config.json"]
        self.assertEqual(
            flexserverctl.loop_config_from_argv(argv, "/home/.vps-manager-agent"),
            flexserverctl.canonical("/home/.vps-manager-agent/config.json"),
        )

    def test_once_true_variants_are_not_loops(self):
        for argv in (
            ["/bin/x", "-once", "-config", "/a/b.json"],
            ["/bin/x", "--once", "-config", "/a/b.json"],
            ["/bin/x", "-once=true", "-config", "/a/b.json"],
            ["/bin/x", "--once=true", "-config", "/a/b.json"],
            ["/bin/x", "-host-only", "-once", "-config", "/a/b.json"],
        ):
            self.assertFalse(flexserverctl.is_loop_argv(argv), argv)

    def test_once_false_is_still_a_loop(self):
        argv = ["/bin/x", "-once=false", "-config", "/a/b.json"]
        self.assertTrue(flexserverctl.is_loop_argv(argv))

    def test_version_and_provision_are_not_loops(self):
        for argv in (
            ["/bin/x", "-version"],
            ["/bin/x", "--version", "daemon", "-config", "/a/b.json"],
            ["/bin/x", "-provision-docker-state", "-config", "/a/b.json"],
            ["/bin/x", "-validate-config", "-config", "/a/b.json"],
            ["/bin/x", "--validate-config", "-config", "/a/b.json"],
        ):
            self.assertFalse(flexserverctl.is_loop_argv(argv), argv)
    def test_missing_config_value_is_not_a_loop(self):
        self.assertFalse(flexserverctl.is_loop_argv(["/bin/x", "-config"]))
        self.assertFalse(flexserverctl.is_loop_argv(["/bin/x", "-config="]))
        self.assertIsNone(flexserverctl.loop_config_from_argv(["/bin/x", "-config"], "/x"))

    def test_extra_docker_identity_argv_preserved(self):
        """A loop carrying extra flags is still a loop."""
        argv = [
            "/bin/x", "-config", "/a/b.json",
            "-docker-identity-path", "/run/docker/identity.json",
            "-docker-runtime-keys-path", "/run/docker/runtime-keys.json",
        ]
        self.assertTrue(flexserverctl.is_loop_argv(argv))
        self.assertEqual(
            flexserverctl.loop_config_from_argv(argv, "/home"),
            flexserverctl.canonical("/a/b.json"),
        )

    def test_parse_go_flags_directly(self):
        self.assertEqual(
            flexserverctl.parse_go_flags(["/bin/x", "-config", "/a/b.json", "-state", "/s.json"]),
            {"config": "/a/b.json", "state": "/s.json"},
        )
        self.assertEqual(
            flexserverctl.parse_go_flags(["/bin/x", "-once=true", "-config=/a/b.json"]),
            {"once": True, "config": "/a/b.json"},
        )
        self.assertEqual(
            flexserverctl.parse_go_flags(["/bin/x", "--once", "-config=/a/b.json"]),
            {"once": True, "config": "/a/b.json"},
        )


class TestUpdaterGuard(LinuxGuard):
    """Defect 6/10: any job evidence refuses; busy never stops the daemon."""

    def setUp(self):
        super().setUp()  # keep the Linux-only gate neutralised
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.state = os.path.join(self.tmp, "state")
        os.makedirs(self.state)
        self.bin = os.path.join(self.tmp, "vps-updater")
        # A portable stub: Python, exit code configurable per test.
        with open(self.bin, "w") as fh:
            fh.write("import sys\nsys.exit(%d)\n" % 0)
        os.chmod(self.bin, 0o755)
        # The CLI shells out to `vps-updater status -config <cfg>`; make that
        # resolve to the Python interpreter so the test is host-independent.
        self.bin = sys.executable
        self.cfg = os.path.join(self.tmp, "updater.json")
        with open(self.cfg, "w") as fh:
            json.dump(dict(UPDATER_CFG), fh)

    def _journal(self, obj):
        with open(os.path.join(self.state, "journal.json"), "w") as fh:
            json.dump(obj, fh)

    def test_idle_state_dir_is_not_busy(self):
        """An absent journal is idle, not busy: absence is not evidence."""
        busy, _ = flexserverctl.updater_busy(self.state)
        self.assertFalse(busy)

    def test_missing_state_dir_is_not_busy(self):
        busy, _ = flexserverctl.updater_busy(os.path.join(self.tmp, "absent"))
        self.assertFalse(busy)

    def test_active_job_refuses(self):
        self._journal({"phase": "downloading", "jobId": "job-1"})
        busy, _ = flexserverctl.updater_busy(self.state)
        self.assertTrue(busy)

    def test_unparseable_journal_fails_closed(self):
        with open(os.path.join(self.state, "journal.json"), "w") as fh:
            fh.write("{not json")
        busy, _ = flexserverctl.updater_busy(self.state)
        self.assertTrue(busy)

    def test_non_object_journal_fails_closed(self):
        with open(os.path.join(self.state, "journal.json"), "w") as fh:
            fh.write('["a", "b"]')
        self.assertTrue(flexserverctl.updater_busy(self.state)[0])

    def test_any_present_daemon_journal_is_busy(self):
        """A present daemon journal is in-flight by construction.

        `Daemon.Run` removes it only after the server's terminal ruling, and the
        "terminal" phase coexists with outcome=hold / rollback_unverified and
        retained backups, so no phase lets a present daemon journal through.
        """
        for phase in (
            "terminal",
            "rollback_unverified",
            "hold",
            "done",
            "complete",
            "completed",
            "awaiting_heartbeat",
            "restarting",
            "rolling_back",
        ):
            self._journal({"phase": phase, "jobId": "j"})
            busy, _ = flexserverctl.updater_busy(self.state)
            self.assertTrue(busy, phase)

    def test_pending_entry_refuses(self):
        os.makedirs(os.path.join(self.state, "pending"))
        with open(os.path.join(self.state, "pending", "job-1.json"), "w") as fh:
            fh.write("{}")
        busy, _ = flexserverctl.updater_busy(self.state)
        self.assertTrue(busy)

    def test_unreadable_pending_fails_closed(self):
        if not hasattr(os, "geteuid") or os.geteuid() == 0:
            self.skipTest("root bypasses mode 000 directory permissions")
        os.makedirs(os.path.join(self.state, "pending"))
        os.chmod(os.path.join(self.state, "pending"), 0o000)
        self.addCleanup(os.chmod, os.path.join(self.state, "pending"), 0o755)
        present, names = flexserverctl.pending_entries(self.state)
        self.assertTrue(present)
        self.assertEqual(names, ["<unreadable>"])

    def _helper(self, obj):
        os.makedirs(os.path.join(self.state, "helper"), exist_ok=True)
        with open(os.path.join(self.state, "helper", "journal.json"), "w") as fh:
            json.dump(obj, fh)

    def test_settled_helper_journal_is_quiescent(self):
        """`handleCleanup` only removes the helper journal best-effort.

        A completed job therefore routinely leaves a settled "restarted" (or
        "rolled_back") record behind with no daemon journal and no pending
        entries. That is a historical record, not live work, so it must not
        block a backend-URL cutover.
        """
        for phase in ("restarted", "rolled_back", "rolled-back", "rolledback"):
            self._helper(
                {
                    "jobId": "lug_j-lEw9PGEEj-",
                    "phase": phase,
                    "oldSha256": "a",
                    "newSha256": "b",
                    "backupPath": "/b",
                }
            )
            busy, _ = flexserverctl.updater_busy(self.state)
            self.assertFalse(busy, phase)
            os.remove(os.path.join(self.state, "helper", "journal.json"))

    def test_mid_swap_helper_journal_refuses(self):
        """Only intent/renamed describe an unfinished privileged mutation."""
        for phase in ("intent", "renamed"):
            self._helper({"jobId": "j", "phase": phase})
            busy, _ = flexserverctl.updater_busy(self.state)
            self.assertTrue(busy, phase)

    def test_unrecognised_helper_phase_fails_closed(self):
        for phase in ("done", "complete", "cleaned", "unknown", ""):
            self._helper({"jobId": "j", "phase": phase})
            busy, _ = flexserverctl.updater_busy(self.state)
            self.assertTrue(busy, phase)

    def test_daemon_journal_overrides_settled_helper(self):
        """A live job is never cleared by a settled helper record."""
        self._helper({"jobId": "j", "phase": "restarted"})
        self._journal({"phase": "awaiting_heartbeat", "jobId": "j"})
        busy, _ = flexserverctl.updater_busy(self.state)
        self.assertTrue(busy)

    def test_pending_overrides_settled_helper(self):
        self._helper({"jobId": "j", "phase": "restarted"})
        os.makedirs(os.path.join(self.state, "pending"))
        with open(os.path.join(self.state, "pending", "apply-j.json"), "w") as fh:
            fh.write("{}")
        busy, _ = flexserverctl.updater_busy(self.state)
        self.assertTrue(busy)

    def test_helper_journal_unparseable_fails_closed(self):
        os.makedirs(os.path.join(self.state, "helper"))
        with open(os.path.join(self.state, "helper", "journal.json"), "w") as fh:
            fh.write("{nope")
        busy, _ = flexserverctl.updater_busy(self.state)
        self.assertTrue(busy)

    def test_empty_helper_journal_fails_closed(self):
        self._helper({})
        self.assertTrue(flexserverctl.updater_busy(self.state)[0])

    def test_helper_journal_without_phase_fails_closed(self):
        self._helper({"jobId": "j"})
        busy, _ = flexserverctl.updater_busy(self.state)
        self.assertTrue(busy)

    def test_local_proof_status_failed(self):
        """A non-zero `status -config` is reported as failed, not proof.

        `run_updater_status` is stubbed here rather than executed so the result
        does not depend on a real updater binary or on the host shell.
        """
        with unittest.mock.patch.object(
            flexserverctl, "run_updater_status", lambda bin_, cfg, timeout=30: (3, "denied")
        ):
            state, detail = flexserverctl.updater_local_proof(self.state, self.bin, self.cfg)
        self.assertEqual(state, "updater-status-failed")

    def test_local_proof_never_claims_delivery(self):
        """Idle journal silence is never reported as authenticated delivery."""
        for phase in ("domain-claim", "observing", "pending"):
            self._journal({"phase": phase, "jobId": "j"})
            state, detail = flexserverctl.updater_local_proof(self.state, self.bin, self.cfg)
            self.assertNotIn("authenticated delivery", detail)


class TestSystemdCutover(LinuxGuard):
    """Defects 4, 5, 11: ordering, rollback target, and serialisation."""

    def setUp(self):
        super().setUp()  # keep the Linux-only gate neutralised
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.etc = os.path.join(self.tmp, "etc")
        os.makedirs(self.etc)
        self.agent_cfg = os.path.join(self.etc, "agent.json")
        self.updater_cfg = os.path.join(self.etc, "updater.json")
        with open(self.agent_cfg, "w") as fh:
            json.dump(dict(AGENT_CFG), fh)
        with open(self.updater_cfg, "w") as fh:
            json.dump(dict(UPDATER_CFG), fh)
        self.lock_path = os.path.join(self.etc, "flexserverctl.lock")
        self.state = os.path.join(self.tmp, "state")
        os.makedirs(self.state)
        state_patch = unittest.mock.patch.object(flexserverctl, "UPDATER_STATE_DIR", self.state)
        state_patch.start()
        self.addCleanup(state_patch.stop)
        self.env = unittest.mock.patch.dict(
            os.environ,
            {
                "FLEXSERVERCTL_AGENT_CONFIG": self.agent_cfg,
                "FLEXSERVERCTL_UPDATER_CONFIG": self.updater_cfg,
                "FLEXSERVERCTL_SYSTEMD_LOCK": self.lock_path,
                "FLEXSERVERCTL_SYSTEMCTL_BIN": "systemctl-stub",
                "FLEXSERVERCTL_AGENT_BIN": os.path.join(self.tmp, "agent-binary"),
                "FLEXSERVERCTL_UPDATER_BIN": os.path.join(self.tmp, "updater-binary"),
            },
        )
        self.env.start()
        self.addCleanup(self.env.stop)
        # Never reach the network from a test: the health gate is a
        # deliberate seam, so every cutover path here is fully offline.
        health = unittest.mock.patch.object(
            flexserverctl, "_health_gate", lambda url, timeout=10: (True, "ok")
        )
        health.start()
        self.addCleanup(health.stop)
        self.calls = []
        self._install_stubs()

    def _install_stubs(self):
        self.calls = []
        unit_states = {}

        def fake_systemctl(unit, action, rc=0, out="active"):
            self.calls.append(f"systemctl {action} {unit}")
            if action == "stop":
                unit_states[unit] = "inactive"
                return (0, "")
            elif action in ("start", "restart"):
                unit_states[unit] = "active"
                return (0, "")
            elif action == "is-active":
                state = unit_states.get(unit, "active")
                return (0, "active\n") if state == "active" else (3, "inactive\n")
            return rc, out

        def fake_status(bin_, cfg, timeout=30):
            self.calls.append("updater status")
            return 0, "Up to date"

        self.sys_patcher = unittest.mock.patch.object(
            flexserverctl, "run_systemctl",
            lambda args, timeout=30: (
                fake_systemctl(args[-1], args[0]) if len(args) > 1 else (0, "")
            ),
        )
        self.sys_patcher.start()
        self.addCleanup(self.sys_patcher.stop)

    def _patch_ctl(self, actions=None):
        """actions: {('vps-updater.service','restart'): (rc,out), ...}"""
        actions = actions or {}
        unit_states = {}

        def fake(args, timeout=30):
            action = args[0]
            unit = args[-1] if len(args) > 1 else ""
            key = (unit, action)
            self.calls.append(f"systemctl {action} {unit}")
            if key in actions:
                return actions[key]
            if action == "stop":
                unit_states[unit] = "inactive"
                return (0, "")
            elif action in ("start", "restart"):
                unit_states[unit] = "active"
                return (0, "")
            elif action == "is-active":
                state = unit_states.get(unit, "active")
                return (0, "active\n") if state == "active" else (3, "inactive\n")
            return (0, "active\n")

        p = unittest.mock.patch.object(flexserverctl, "run_systemctl", fake)
        p.start()
        self.addCleanup(p.stop)


    def test_ordering_stop_before_preflight_restart_after(self):
        self._patch_ctl({})
        p = unittest.mock.patch.object(
            flexserverctl, "_preflight",
            lambda b, c: (True, "ok"),
        )
        p.start()
        self.addCleanup(p.stop)
        p2 = unittest.mock.patch.object(
            flexserverctl, "updater_local_proof",
            lambda *a, **k: ("updater-process-observed", "job=1 phase=done"),
        )
        p2.start()
        self.addCleanup(p2.stop)
        rc = flexserverctl.do_systemd_cutover("https://new.flexserver.tech")
        self.assertEqual(rc, 0)
        stop_idx = self.calls.index("systemctl stop vps-manager-agent.service")
        restart_idx = self.calls.index("systemctl restart vps-manager-agent.service")
        self.assertLess(stop_idx, restart_idx)
        # The updater must be stopped before the guard re-check, and restarted
        # afterwards; the agent's restart is the last unit action.
        self.assertLess(
            self.calls.index("systemctl stop vps-updater.service"), stop_idx
        )
        with open(self.agent_cfg) as fh:
            self.assertEqual(json.load(fh)["backendUrl"], "https://new.flexserver.tech")
        with open(self.updater_cfg) as fh:
            self.assertEqual(json.load(fh)["apiBase"], "https://new.flexserver.tech")
        self.assertFalse(os.path.exists(self.agent_cfg + BAK))

    def test_restart_failure_rolls_both_units_back(self):
        self._patch_ctl({("vps-manager-agent.service", "restart"): (1, "Job failed")})
        p = unittest.mock.patch.object(flexserverctl, "_preflight", lambda b, c: (True, "ok"))
        p.start()
        self.addCleanup(p.stop)
        rc = flexserverctl.do_systemd_cutover("https://new.flexserver.tech")
        self.assertEqual(rc, 1)
        with open(self.agent_cfg) as fh:
            self.assertEqual(json.load(fh)["backendUrl"], "https://initial.flexserver.tech")
        # Both units were restarted (not merely started) onto the restored bytes.
        self.assertIn("systemctl stop vps-manager-agent.service", self.calls)
        self.assertIn("systemctl stop vps-updater.service", self.calls)
        self.assertIn("systemctl restart vps-manager-agent.service", self.calls)
        self.assertIn("systemctl restart vps-updater.service", self.calls)

    def test_updater_status_failure_rolls_back(self):
        self._patch_ctl({})
        with unittest.mock.patch.object(flexserverctl, "run_updater_status",
                                        lambda *a, **k: (3, "auth denied")):
            p = unittest.mock.patch.object(flexserverctl, "_preflight", lambda b, c: (True, "ok"))
            p.start()
            self.addCleanup(p.stop)
            rc = flexserverctl.do_systemd_cutover("https://new.flexserver.tech")
        self.assertEqual(rc, 1)
        with open(self.agent_cfg) as fh:
            self.assertEqual(json.load(fh)["backendUrl"], "https://initial.flexserver.tech")

    def test_busy_updater_refuses_before_any_write(self):
        journal = os.path.join(self.state, "journal.json")
        with open(journal, "w") as fh:
            json.dump({"phase": "downloading", "jobId": "j"}, fh)
        before = open(self.agent_cfg, "rb").read()
        p = unittest.mock.patch.object(
            flexserverctl, "_preflight", lambda b, c: (_ for _ in ()).throw(RuntimeError("should not run"))
        )
        p.start()
        self.addCleanup(p.stop)
        with self.assertRaises(SystemExit) as ctx:
            flexserverctl.do_systemd_cutover("https://new.flexserver.tech")
        self.assertEqual(ctx.exception.code, 1)
        self.assertEqual(open(self.agent_cfg, "rb").read(), before)
        self.assertFalse(os.path.exists(self.agent_cfg + BAK))
        self.assertNotIn("preflight", " ".join(self.calls))

    def test_busy_updater_does_not_leave_it_down(self):
        self._patch_ctl({})
        busy_calls = [False, True]
        with unittest.mock.patch.object(
            flexserverctl,
            "updater_busy",
            side_effect=lambda d: (busy_calls.pop(0), "active") if busy_calls else (True, "active"),
        ):
            with self.assertRaises(SystemExit):
                flexserverctl.do_systemd_cutover("https://new.flexserver.tech")
        self.assertIn("systemctl restart vps-updater.service", self.calls)

    def test_health_reject_does_not_write_or_touch_units(self):
        self._patch_ctl({})
        before_agent = open(self.agent_cfg, "rb").read()
        before_updater = open(self.updater_cfg, "rb").read()
        with unittest.mock.patch.object(
            flexserverctl, "_health_gate", lambda u, timeout=10: (False, "unreachable")
        ):
            with self.assertRaises(SystemExit) as ctx:
                flexserverctl.do_systemd_cutover("https://bad.flexserver.tech")
            self.assertEqual(ctx.exception.code, 1)
        self.assertEqual(open(self.agent_cfg, "rb").read(), before_agent)
        self.assertEqual(open(self.updater_cfg, "rb").read(), before_updater)
        self.assertFalse(os.path.exists(self.agent_cfg + BAK))
        self.assertFalse(os.path.exists(self.updater_cfg + BAK))
        self.assertEqual(self.calls, [])

    def test_corrupt_journal_refuses(self):
        with open(os.path.join(self.state, "journal.json"), "w") as fh:
            fh.write("{corrupt")
        self._patch_ctl({})
        with self.assertRaises(SystemExit):
            flexserverctl.do_systemd_cutover("https://new.flexserver.tech")

    def test_lock_contention_refuses(self):
        os.makedirs(self.lock_path)
        self._patch_ctl({})
        with self.assertRaises(SystemExit) as ctx:
            flexserverctl.do_systemd_cutover("https://new.flexserver.tech")
        self.assertEqual(ctx.exception.code, 1)
        self.assertFalse(os.path.exists(self.agent_cfg + BAK))
        shutil.rmtree(self.lock_path, ignore_errors=True)

    def test_dry_run_touches_nothing(self):
        self._patch_ctl({})
        with unittest.mock.patch.object(
            flexserverctl, "_health_gate", lambda url: (True, "ok")
        ):
            rc = flexserverctl.do_systemd_cutover("https://new.flexserver.tech", dry_run=True)
        self.assertEqual(rc, 0)
        self.assertEqual(self.calls, [])
        self.assertFalse(os.path.exists(self.agent_cfg + BAK))


class TestUserCutover(LinuxGuard):
    """Defects 7, 8, 9: user-mode loop behaviour."""

    def setUp(self):
        super().setUp()  # keep the Linux-only gate neutralised
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = os.path.join(self.tmp, "home")
        self.agent_dir = os.path.join(self.home, ".vps-manager-agent")
        os.makedirs(self.agent_dir)
        self.agent_cfg = os.path.join(self.agent_dir, "config.json")
        with open(self.agent_cfg, "w") as fh:
            json.dump(dict(AGENT_CFG), fh)
        self.pid_file = os.path.join(self.agent_dir, "vps-agent.pid")
        self.agent_bin = os.path.join(self.agent_dir, "vps-agent")
        with open(self.agent_bin, "w") as fh:
            fh.write("#!/bin/sh\nsleep 2\n")
        os.chmod(self.agent_bin, 0o755)
        self.env = unittest.mock.patch.dict(
            os.environ,
            {
                "FLEXSERVERCTL_HOME": self.home,
                "FLEXSERVERCTL_AGENT_BIN": self.agent_bin,
                "FLEXSERVERCTL_PROC_ROOT": os.path.join(self.tmp, "proc"),
                "FLEXSERVERCTL_JOURNALCTL_BIN": "false",
            },
        )
        self.env.start()
        self.addCleanup(self.env.stop)
        # Never reach the network from a test: the health gate is a
        # deliberate seam, so every cutover path here is fully offline.
        health = unittest.mock.patch.object(
            flexserverctl, "_health_gate", lambda url, timeout=10: (True, "ok")
        )
        health.start()
        self.addCleanup(health.stop)

    def test_default_user_binary_is_userdir_not_systemd(self):
        """A real user install's loop lives in ~/.vps-manager-agent."""
        self.assertEqual(flexserverctl.user_agent_bin_path(), self.agent_bin)

    def test_explicit_override_wins_over_user_default(self):
        with unittest.mock.patch.dict(os.environ, {"FLEXSERVERCTL_AGENT_BIN": "/opt/x"}):
            self.assertEqual(flexserverctl.user_agent_bin_path(), "/opt/x")

    def test_systemd_binary_default_unchanged(self):
        os.environ.pop("FLEXSERVERCTL_AGENT_BIN", None)
        self.assertEqual(flexserverctl.agent_bin_path(), flexserverctl.AGENT_BINARY)

    def test_user_cutover_uses_user_binary(self):
        with unittest.mock.patch.object(flexserverctl, "_health_gate", lambda u, timeout=10: (True, "ok")), \
             unittest.mock.patch.object(flexserverctl, "find_managed_processes", return_value=[]) as mock_find, \
             unittest.mock.patch.object(flexserverctl, "_preflight", return_value=(True, "ok")), \
             unittest.mock.patch.object(
                 flexserverctl,
                 "spawn_verified_loop",
                 return_value=flexserverctl.SpawnedLoop("1", self.agent_bin, self.agent_cfg, [], self.agent_dir, "1"),
             ):
            rc = flexserverctl.do_user_cutover("https://new.flexserver.tech")
            self.assertEqual(rc, 0)
            self.assertEqual(mock_find.call_args[0][0], self.agent_bin)

    def test_health_reject_does_not_write_or_touch_process(self):
        before = open(self.agent_cfg, "rb").read()
        with unittest.mock.patch.object(
            flexserverctl, "_health_gate", lambda u, timeout=10: (False, "unreachable")
        ):
            with self.assertRaises(SystemExit) as ctx:
                flexserverctl.do_user_cutover("https://bad.flexserver.tech")
            self.assertEqual(ctx.exception.code, 1)
        self.assertEqual(open(self.agent_cfg, "rb").read(), before)
        self.assertFalse(os.path.exists(self.agent_cfg + BAK))

    def test_config_candidate_mismatch_fails_closed(self):
        """A pid file that disagrees must refuse, never be silently ignored."""
        with open(self.pid_file, "w") as fh:
            fh.write("999999\n")
        with unittest.mock.patch.object(flexserverctl, "_health_gate", lambda u: (True, "ok")):
            with unittest.mock.patch.object(
                flexserverctl, "find_managed_processes", lambda b, c: []
            ):
                with unittest.mock.patch.object(flexserverctl, "pid_alive", lambda p: True):
                    with self.assertRaises(SystemExit) as ctx:
                        flexserverctl.do_user_cutover("https://x.invalid")
        self.assertEqual(ctx.exception.code, 1)
        self.assertTrue(os.path.exists(self.pid_file))
        self.assertFalse(os.path.exists(self.agent_cfg + BAK))

    def test_preflight_failure_restarts_original_with_preserved_argv(self):
        with open(self.pid_file, "w") as fh:
            fh.write("1\n")
        old_argv = [
            self.agent_bin, "-config", "config.json",
            "-docker-runtime-keys-path", "/run/docker/runtime-keys.json",
        ]
        original = {
            "pid": "1", "starttime": "1", "argv": old_argv, "cwd": self.agent_dir,
        }
        spawned = {}

        def fail_preflight(b, c):
            return False, "preflight rc=1"

        def fake_stop(proc, exe, cfg):
            return True

        def fake_spawn(exe, config, pid_file, cwd="", argv=None):
            spawned["argv"] = argv
            spawned["cwd"] = cwd
            return flexserverctl.SpawnedLoop("4242", exe, config, argv or [], cwd, "99")

        with unittest.mock.patch.object(flexserverctl, "_health_gate", lambda u: (True, "ok")):
            with unittest.mock.patch.object(
                flexserverctl, "find_managed_processes", lambda b, c: [dict(original)]
            ):
                with unittest.mock.patch.object(flexserverctl, "stop_exact_process", fake_stop):
                    with unittest.mock.patch.object(flexserverctl, "_preflight", fail_preflight):
                        with unittest.mock.patch.object(
                            flexserverctl, "spawn_verified_loop", fake_spawn
                        ):
                            rc = flexserverctl.do_user_cutover("https://new.flexserver.tech")
        self.assertEqual(rc, 1)
        self.assertEqual(spawned.get("argv"), old_argv)
        self.assertEqual(spawned.get("cwd"), self.agent_dir)
        with open(self.agent_cfg) as fh:
            self.assertEqual(json.load(fh)["backendUrl"], "https://initial.flexserver.tech")
        self.assertFalse(os.path.exists(self.agent_cfg + BAK))

    def test_spawn_failure_restarts_original(self):
        with open(self.pid_file, "w") as fh:
            fh.write("77\n")
        original = {
            "pid": "77", "starttime": "77", "argv": [self.agent_bin, "-config", "config.json"],
            "cwd": self.agent_dir,
        }

        def exploding_spawn(exe, config, pid_file, cwd="", argv=None):
            raise RuntimeError("verification failed")

        with unittest.mock.patch.object(flexserverctl, "_health_gate", lambda u: (True, "ok")):
            with unittest.mock.patch.object(
                flexserverctl, "find_managed_processes", lambda b, c: [dict(original)]
            ):
                with unittest.mock.patch.object(
                    flexserverctl, "stop_exact_process", lambda *a: True
                ):
                    with unittest.mock.patch.object(flexserverctl, "_preflight",
                                                    lambda b, c: (True, "ok")):
                        with unittest.mock.patch.object(
                            flexserverctl, "spawn_verified_loop", exploding_spawn
                        ):
                            with unittest.mock.patch.object(
                                flexserverctl,
                                "_resume_old_loop",
                                unittest.mock.MagicMock(return_value=True),
                            ) as resume:
                                rc = flexserverctl.do_user_cutover("https://new.flexserver.tech")
        self.assertEqual(rc, 1)
        self.assertEqual(resume.call_count, 1)
        with open(self.agent_cfg) as fh:
            self.assertEqual(json.load(fh)["backendUrl"], "https://initial.flexserver.tech")

    def test_failed_resume_holds_backup_and_reports_rollback_failed(self):
        with open(self.pid_file, "w") as fh:
            fh.write("77\n")
        original = {
            "pid": "77", "starttime": "77", "argv": [self.agent_bin, "-config", "config.json"],
            "cwd": self.agent_dir,
        }

        def exploding_spawn(exe, config, pid_file, cwd="", argv=None):
            raise RuntimeError("verification failed")

        with unittest.mock.patch.object(flexserverctl, "_health_gate", lambda u: (True, "ok")):
            with unittest.mock.patch.object(
                flexserverctl, "find_managed_processes", lambda b, c: [dict(original)]
            ):
                with unittest.mock.patch.object(flexserverctl, "stop_exact_process",
                                                lambda *a: True):
                    with unittest.mock.patch.object(flexserverctl, "_preflight",
                                                    lambda b, c: (True, "ok")):
                        with unittest.mock.patch.object(flexserverctl, "spawn_verified_loop",
                                                        exploding_spawn):
                            with unittest.mock.patch.object(flexserverctl, "_resume_old_loop",
                                                            lambda *a: False):
                                rc = flexserverctl.do_user_cutover("https://new.flexserver.tech")
        self.assertEqual(rc, 1)
        self.assertTrue(os.path.exists(self.agent_cfg + BAK))
        with open(self.agent_cfg) as fh:
            self.assertEqual(json.load(fh)["backendUrl"], "https://initial.flexserver.tech")

    def test_retained_backup_blocks_a_second_attempt(self):
        """rollback-failed evidence must not be truncated by a retry."""
        with open(self.pid_file, "w") as fh:
            fh.write("77\n")
        original = {
            "pid": "77", "starttime": "77", "argv": [self.agent_bin, "-config", "config.json"],
            "cwd": self.agent_dir,
        }

        def exploding_spawn(exe, config, pid_file, cwd="", argv=None):
            raise RuntimeError("verification failed")

        with unittest.mock.patch.object(flexserverctl, "_health_gate", lambda u: (True, "ok")):
            with unittest.mock.patch.object(
                flexserverctl, "find_managed_processes", lambda b, c: [dict(original)]
            ):
                with unittest.mock.patch.object(flexserverctl, "stop_exact_process",
                                                lambda *a: True):
                    with unittest.mock.patch.object(flexserverctl, "_preflight",
                                                    lambda b, c: (True, "ok")):
                        with unittest.mock.patch.object(flexserverctl, "spawn_verified_loop",
                                                        exploding_spawn):
                            with unittest.mock.patch.object(flexserverctl, "_resume_old_loop",
                                                            lambda *a: False):
                                flexserverctl.do_user_cutover("https://new.flexserver.tech")
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            with self.assertRaises(SystemExit) as ctx:
                flexserverctl.do_user_cutover("https://other.flexserver.tech")
        self.assertEqual(ctx.exception.code, 1)
        self.assertIn("already exists", buf.getvalue())


class TestSpawnedLoopVerification(LinuxGuard):
    """Defect 3: identity must be captured immediately, never leaked."""

    def test_teardown_gated_on_starttime(self):
        spawned = flexserverctl.SpawnedLoop("1", "/bin/x", "/c.json", ["-config", "/c.json"],
                                            "/cwd", "STABLE")

        class Handle:
            def __init__(self):
                self.returncode = None

            def poll(self):
                return self.returncode

        handle = Handle()
        with unittest.mock.patch.object(flexserverctl, "_same_spawn", lambda p, s: s == "STABLE"):
            with unittest.mock.patch("os.kill") as kill:
                # A starttime mismatch must never signal.
                spawned.starttime = ""
                if spawned.starttime and flexserverctl._same_spawn("1", spawned.starttime):
                    os.kill(1, signal.SIGTERM)
                kill.assert_not_called()


class TestCliSurface(LinuxGuard):
    def test_help_exits_zero(self):
        rc = flexserverctl.main(["help"])
        self.assertEqual(rc, 0)

    def test_no_help_prints_help(self):
        rc = flexserverctl.main([])
        self.assertEqual(rc, 0)

    def test_set_backend_url_option(self):
        parser = flexserverctl.build_parser()
        args = parser.parse_args(["set-backend", "--url", "https://flexserver.tech"])
        self.assertEqual(args.url_opt, "https://flexserver.tech")

    def test_parser_supports_go_flag_forms_for_url(self):
        parser = flexserverctl.build_parser()
        args = parser.parse_args(["set-backend", "--url=https://flexserver.tech"])
        self.assertEqual(args.url_opt, "https://flexserver.tech")

    def test_validate_url_updater_flag(self):
        parser = flexserverctl.build_parser()
        args = parser.parse_args(["validate-url", "--updater", "https://flexserver.tech"])
        self.assertTrue(args.updater)

    def test_validate_url_command(self):
        self.assertEqual(flexserverctl.main(["validate-url", "https://flexserver.tech"]), 0)
        self.assertEqual(
            flexserverctl.main(["validate-url", "--updater", "https://flexserver.tech"]), 0
        )

    def test_validate_url_rejects_bad(self):
        self.assertEqual(flexserverctl.main(["validate-url", "http://nonloop.invalid"]), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
