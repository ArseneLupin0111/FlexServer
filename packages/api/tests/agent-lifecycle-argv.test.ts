import { describe, expect, it } from "vitest";
import {
  buildManagedProcessInspectCommand,
  buildManagedProcessStopCommand,
  buildTransactionalStartCommand,
  EXACT_ARGV,
  type ManagedProcessOptions,
} from "../src/agents/agent-lifecycle-remote.js";

describe("agent-lifecycle-argv remote command generation", () => {
  const binary = "/home/deploy/.vps-manager-agent/vps-agent";
  const config = "/home/deploy/.vps-manager-agent/config.json";
  const pidFile = "/home/deploy/.vps-manager-agent/vps-agent.pid";

  it("builds inspect command supporting canonical and Docker-state loops", () => {
    const cmd = buildManagedProcessInspectCommand(binary, config, pidFile);
    expect(cmd).toContain("_st_path=");
    expect(cmd).toContain("_id_path=");
    expect(cmd).toContain("_rk_path=");
    expect(cmd).toContain("_uid_val=");
    expect(cmd).toContain("_bdir=$(dirname \"$_bin\")");
    expect(cmd).toContain("_cwd=$(readlink -f \"/proc/$_pid/cwd\" 2>/dev/null || true)");
    expect(cmd).toContain("-docker-identity-path");
    expect(cmd).toContain("-docker-runtime-keys-path");
    expect(cmd).toContain("-docker-runtime-owner-uid");
    expect(cmd).toContain("echo ambiguous");
    expect(cmd).toContain("echo mismatch");
    expect(cmd).toContain("echo invalid");
    expect(cmd).toContain("echo none");
  });

  it("builds stop command revalidating identity before signaling", () => {
    const cmd = buildManagedProcessStopCommand(binary, config, "1234", "5678");
    expect(cmd).toContain("_pid='1234'");
    expect(cmd).toContain("_start='5678'");
    expect(cmd).toContain("kill -TERM");
    expect(cmd).toContain("kill -KILL");
    expect(cmd).toContain("_cwd=$(readlink -f \"/proc/$_pid/cwd\" 2>/dev/null || true)");
    expect(cmd).toContain("-docker-identity-path");
  });

  it("builds transactional start command checking Docker runtime files", () => {
    const cmd = buildTransactionalStartCommand(binary, config, pidFile);
    // When no explicit options are passed, checks file existence dynamically
    expect(cmd).toContain('if [ -f "$_id_path" ] && [ -f "$_rk_path" ]; then nohup "$_bin" -config "$_cfg" -state "$_st_path" -docker-identity-path "$_id_path" -docker-runtime-keys-path "$_rk_path" -docker-runtime-owner-uid "$_uid_val"');
    expect(cmd).toContain('else nohup "$_bin" -config "$_cfg"');
    expect(cmd).toContain("trap 'cleanup' EXIT");
    expect(cmd).toContain("mv -- \"$_tmp\" \"$_pf\"");
  });

  it("builds transactional start command with explicit Docker options", () => {
    const options: ManagedProcessOptions = {
      statePath: "/custom/state.json",
      dockerIdentityPath: "/custom/docker-identity.json",
      dockerRuntimeKeysPath: "/custom/runtime-keys.json",
      dockerRuntimeOwnerUid: 1000,
    };
    const cmd = buildTransactionalStartCommand(binary, config, pidFile, options);
    expect(cmd).toContain("_st_path='/custom/state.json'");
    expect(cmd).toContain("_id_path='/custom/docker-identity.json'");
    expect(cmd).toContain("_rk_path='/custom/runtime-keys.json'");
    expect(cmd).toContain("_uid_val='1000'");
    expect(cmd).toContain('nohup "$_bin" -config "$_cfg" -state "$_st_path" -docker-identity-path "$_id_path" -docker-runtime-keys-path "$_rk_path" -docker-runtime-owner-uid "$_uid_val" >/dev/null 2>&1 & _pid=$!;');
    expect(cmd).not.toContain('else nohup "$_bin" -config "$_cfg"');
  });

  it("safely quotes paths containing spaces and single quotes", () => {
    const funnyBinary = "/home/user with spaces/it's cool/vps-agent";
    const funnyConfig = "/home/user with spaces/it's cool/config.json";
    const funnyPid = "/home/user with spaces/it's cool/vps-agent.pid";
    const cmd = buildManagedProcessInspectCommand(funnyBinary, funnyConfig, funnyPid);
    expect(cmd).toContain("'" + "/home/user with spaces/it'\"'\"'s cool/vps-agent" + "'");
    expect(cmd).toContain("'" + "/home/user with spaces/it'\"'\"'s cool/config.json" + "'");
  });
});
