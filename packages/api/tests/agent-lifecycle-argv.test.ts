import { describe, expect, it } from "vitest";
import {
  buildLifecycleLockAcquireCommand,
  buildLifecycleLockReleaseCommand,
  buildManagedProcessInspectCommand,
  buildManagedProcessStopCommand,
  buildTransactionalStartCommand,
  buildServiceUninstallCommand,
  buildSystemdUnitContent,
  classifyManagedProcessInspection,
  systemdEscapeExecArg,
  systemdEscapeValue,
  getAgentServiceName,
  getAgentServiceUnitPath,
  getAgentLockPath,
  getAgentTmpfilesPath,
  type ManagedProcessOptions,
} from "../src/agents/agent-lifecycle-remote.js";

describe("agent-lifecycle-argv behavioral tests", () => {
  const binary = "/home/deploy/.vps-manager-agent/vps-agent";
  const config = "/home/deploy/.vps-manager-agent/config.json";
  const pidFile = "/home/deploy/.vps-manager-agent/vps-agent.pid";

  it("derives deterministic unit names and system paths per VPS ID", () => {
    const vpsId = "vps-test-42";
    const serviceName = getAgentServiceName(vpsId);
    expect(serviceName).toMatch(/^vps-agent-[a-f0-9]{64}\.service$/);
    expect(getAgentServiceUnitPath(vpsId)).toBe(`/etc/systemd/system/${serviceName}`);
    expect(getAgentLockPath(vpsId)).toMatch(/^\/run\/vps-manager-agent\/vps-agent-[a-f0-9]{64}\.lock$/);
    expect(getAgentTmpfilesPath(vpsId)).toMatch(/^\/etc\/tmpfiles\.d\/vps-agent-[a-f0-9]{64}\.conf$/);
  });

  it("classifies managed process inspection states accurately", () => {
    expect(classifyManagedProcessInspection(2, null, { exists: true, content: "123" }, () => true)).toBe("ambiguous");
    expect(classifyManagedProcessInspection(0, null, { exists: false }, () => false)).toBe("none");
    expect(classifyManagedProcessInspection(1, { pid: "123", starttime: "456" }, { exists: false }, () => true)).toBe("ambiguous");
    expect(classifyManagedProcessInspection(0, null, { exists: true, content: "not-a-number" }, () => false)).toBe("invalid");
    expect(classifyManagedProcessInspection(0, null, { exists: true, content: "123" }, () => true)).toBe("mismatch");
    expect(classifyManagedProcessInspection(0, null, { exists: true, content: "123" }, () => false)).toBe("none");
    expect(classifyManagedProcessInspection(1, { pid: "123", starttime: "456" }, { exists: true, content: "123" }, () => true)).toBe("owned:123:456");
    expect(classifyManagedProcessInspection(1, { pid: "999", starttime: "456" }, { exists: true, content: "123" }, () => true)).toBe("mismatch");
  });

  it("enforces complete required context on buildTransactionalStartCommand", () => {
    expect(() =>
      buildTransactionalStartCommand(binary, config, pidFile, {
        vpsId: "vps-test-42",
        user: "",
        homeDir: "/home/deploy",
      }),
    ).toThrow("buildTransactionalStartCommand requires complete context");

    expect(() =>
      buildTransactionalStartCommand(binary, config, pidFile, {
        vpsId: "vps-test-42",
        user: "deploy",
        homeDir: "",
      }),
    ).toThrow("buildTransactionalStartCommand requires complete context");

    expect(() =>
      buildTransactionalStartCommand(binary, config, pidFile, undefined),
    ).toThrow("buildTransactionalStartCommand requires complete context");
  });

  it("enforces complete required context on buildSystemdUnitContent", () => {
    expect(() =>
      buildSystemdUnitContent({
        vpsId: "",
        user: "deploy",
        homeDir: "/home/deploy",
        binary,
        config,
      }),
    ).toThrow("buildSystemdUnitContent requires complete context");

    expect(() =>
      buildSystemdUnitContent({
        vpsId: "vps-test-42",
        user: "",
        homeDir: "/home/deploy",
        binary,
        config,
      }),
    ).toThrow("buildSystemdUnitContent requires complete context");

    expect(() =>
      buildSystemdUnitContent({
        vpsId: "vps-test-42",
        user: "deploy",
        homeDir: "",
        binary,
        config,
      }),
    ).toThrow("buildSystemdUnitContent requires complete context");
  });

  it("escapes $ and % in systemdExecArg and systemdValue without quiet newline corruption", () => {
    expect(systemdEscapeValue("my%val")).toBe("my%%val");
    expect(() => systemdEscapeValue("bad\nval")).toThrow("must not contain newline characters");
    expect(() => systemdEscapeValue("bad\rval")).toThrow("must not contain newline characters");

    expect(systemdEscapeExecArg("/bin/app$var")).toBe("/bin/app$$var");
    expect(systemdEscapeExecArg("/bin/app%u")).toBe("/bin/app%%u");
    expect(systemdEscapeExecArg("/bin/app$foo%bar")).toBe("/bin/app$$foo%%bar");
    expect(systemdEscapeExecArg("/bin/app with spaces$dir%foo")).toBe('"/bin/app with spaces$$dir%%foo"');
    expect(systemdEscapeExecArg('/bin/app"quote\\slash')).toBe('"/bin/app\\"quote\\\\slash"');
    expect(() => systemdEscapeExecArg("/bin/app\nnewline")).toThrow("must not contain newline characters");
    expect(() => systemdEscapeExecArg("/bin/app\rnewline")).toThrow("must not contain newline characters");
  });

  it("builds valid systemd unit content escaping $, % and preserving paths", () => {
    const unitContent = buildSystemdUnitContent({
      vpsId: "vps-test$42%spec",
      user: "deploy",
      homeDir: "/home/deploy",
      binary: "/opt/app$special%var/vps-agent",
      config: "/opt/app/my%conf$dir/config.json",
    });
    expect(unitContent).toContain("Description=VPS Manager Agent (vps-test$42%%spec)");
    expect(unitContent).toContain("User=deploy");
    expect(unitContent).toContain("WorkingDirectory=/home/deploy");
    expect(unitContent).toContain(
      "ExecStart=/opt/app$$special%%var/vps-agent -config /opt/app/my%%conf$$dir/config.json -state /opt/app/my%%conf$$dir/state.json",
    );
    expect(unitContent).toContain("Restart=always");
  });

  it("rejects newline injection in systemd unit fields", () => {
    expect(() =>
      buildSystemdUnitContent({
        vpsId: "vps-test",
        user: "deploy\nExecStartPre=/bin/sh -c 'evil'",
        homeDir: "/home/deploy",
        binary: "/usr/local/bin/vps-agent",
        config: "/home/deploy/config.json",
      }),
    ).toThrow("user must not contain newline characters");

    expect(() =>
      buildSystemdUnitContent({
        vpsId: "vps-test",
        user: "deploy",
        group: "deploy\nPermissionsStartOnly=true",
        homeDir: "/home/deploy",
        binary: "/usr/local/bin/vps-agent",
        config: "/home/deploy/config.json",
      }),
    ).toThrow("group must not contain newline characters");

    expect(() =>
      buildSystemdUnitContent({
        vpsId: "vps-test\nAfter=evil.target",
        user: "deploy",
        homeDir: "/home/deploy",
        binary: "/usr/local/bin/vps-agent",
        config: "/home/deploy/config.json",
      }),
    ).toThrow("vpsId must not contain newline characters");
  });

  it("rejects newlines in command builders", () => {
    expect(() =>
      buildTransactionalStartCommand(binary, "config\n.json", pidFile, {
        vpsId: "vps-test-42",
        user: "deploy",
        homeDir: "/home/deploy",
      }),
    ).toThrow("config must not contain newline characters");

    expect(() =>
      buildManagedProcessInspectCommand(binary, "config\n.json", pidFile),
    ).toThrow("config must not contain newline characters");

    expect(() =>
      buildManagedProcessStopCommand(binary, "config\n.json"),
    ).toThrow("config must not contain newline characters");

    expect(() =>
      buildServiceUninstallCommand("remote\ndir", "vps-test-42"),
    ).toThrow("remoteDir must not contain newline characters");
  });

  it("generates atomic lifecycle lock acquire and release commands", () => {
    const lock = "/home/deploy/.vps-manager-agent/lifecycle.lock";
    expect(buildLifecycleLockAcquireCommand(lock)).toBe(
      `if mkdir -- '${lock}' 2>/dev/null; then echo acquired; else echo conflict; fi`,
    );
    expect(buildLifecycleLockReleaseCommand(lock)).toBe(`rmdir -- '${lock}'`);
  });
});
