import { describe, expect, it } from "vitest";
import { validateComposeYaml } from "../src/docker-applications/config-policy.js";

describe("managed Compose prevalidation", () => {
  it.each(["include: /etc/passwd\n", "services:\n  web:\n    image: nginx\n    privileged: true\n", "services:\n  web:\n    image: nginx\n    env_file: /etc/shadow\n", "services:\n  web:\n    image: nginx\n    volumes: [\"/var/run/docker.sock:/var/run/docker.sock\"]\n", "services:\n  web:\n    image: nginx\nvolumes:\n  data:\n    driver_opts: {device: /, type: none, o: bind}\n", "services:\n  web:\n    image: nginx\n    image: alpine\n", "services: !unsafe {}\n", "services: {}\n---\nservices: {}\n"])("refuses unsafe or ambiguous document before execution", (source) => {
    expect(() => validateComposeYaml(source)).toThrow();
  });
  it("preserves safe images and project-scoped named volumes", () => {
    expect(validateComposeYaml("services:\n  web:\n    image: nginx:alpine\n    volumes: [data:/data]\nvolumes:\n  data: {}\n")).toEqual({services:{web:{image:"nginx:alpine",volumes:["data:/data"]}},volumes:{data:{}}});
  });
  it("rejects a valid first document followed by another document", () => {
    expect(() => validateComposeYaml("services:\n  web:\n    image: nginx\n---\nservices:\n  other:\n    image: alpine\n")).toThrow();
  });
  it.each([0, -1, 101, 1.5, "2"])("rejects unsupported desired replica count %s", (replicas) => {
    expect(() => validateComposeYaml(`services:\n  web:\n    image: nginx\n    deploy:\n      replicas: ${JSON.stringify(replicas)}\n`)).toThrow();
  });
  it("accepts bounded replicas with healthcheck durations", () => {
    const model = validateComposeYaml("services:\n  web:\n    image: nginx\n    deploy:\n      replicas: 100\n    healthcheck:\n      interval: 10s\n      timeout: 2s\n");
    expect(model.services.web.deploy).toEqual({ replicas: 100 });
    expect(model.services.web.healthcheck).toEqual({ interval: "10s", timeout: "2s" });
  });
  it.each(["${TOKEN}", "${TOKEN:-fallback}", "$TOKEN"])("rejects secret interpolation in visible image identity %s", (reference) => {
    expect(() => validateComposeYaml(`services:\n  web:\n    image: registry.example/app:${reference}\n`, ["TOKEN"])).toThrow();
  });
  it("allows secret references only in protected workload values", () => {
    const source = "services:\n  web:\n    image: nginx\n    environment:\n      TOKEN: ${TOKEN}\n    command: [app, '${TOKEN}']\n    healthcheck:\n      test: [CMD, app, '${TOKEN}']\n";
    expect(validateComposeYaml(source, ["TOKEN"]).services.web.environment).toEqual({ TOKEN: "${TOKEN}" });
  });
  it("does not treat escaped Compose dollar expressions as secret interpolation", () => {
    expect(validateComposeYaml("services:\n  web:\n    image: 'app:$${TOKEN}'\n", ["TOKEN"]).services.web.image).toBe("app:$${TOKEN}");
  });
  it("accepts boolean init/read-only and numeric resource values", () => {
    const model = validateComposeYaml("services:\n  web:\n    image: nginx\n    init: true\n    read_only: false\n    cpus: 1.5\n    mem_limit: 512\n    pids_limit: 128\n    ports:\n      - target: 8080\n        published: 8080\n");
    expect(model.services.web.init).toBe(true);
    expect(model.services.web.cpus).toBe(1.5);
    expect(model.services.web.ports).toEqual([{ target: 8080, published: 8080 }]);
  });
  it.each(["init: yes", "read_only: nope", "cpus: .nan", "cpus: 0", "ports:\n      - target: 65536"])("rejects malformed typed values %s", (fields) => {
    expect(() => validateComposeYaml(`services:\n  web:\n    image: nginx\n    ${fields.replace(/\n/g, "\n    ")}\n`)).toThrow();
  });
  it("rejects nested volume mount options outside the allowlist", () => {
    expect(() => validateComposeYaml("services:\n  web:\n    image: nginx\n    volumes:\n      - type: volume\n        source: data\n        target: /data\n        volume:\n          nocopy: false\n          driver_opts: {device: /}\n")).toThrow();
  });
  it.each([
    "constructor: {}\nservices:\n  web:\n    image: nginx\n",
    "services:\n  web:\n    image: nginx\n    constructor: {}\n",
    "services:\n  web:\n    image: nginx\n    depends_on: [toString]\n",
    "services:\n  web:\n    image: nginx\n    healthcheck:\n      constructor: {}\n",
  ])("rejects inherited object members as configuration fields or dependencies", (source) => {
    expect(() => validateComposeYaml(source)).toThrow();
  });
});
