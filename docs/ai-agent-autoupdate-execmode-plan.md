# Agent auto-update bộ AI + Settings card "Agent" + chế độ thực thi privileged

Status: **đã duyệt qua grilling (Q1–Q8, 2026-10-25) — implemented and verified offline (2026-10-25)**

Ngày: 2026-10-25 · Nhánh: `feat/agent-autoupdate-execmode` (stacked trên `fix/codex-oauth-di-config`, PR #37)

## Mục tiêu

1. Sau mỗi deploy FlexServer, agent **và bộ AI components** trên mọi VPS tự hội tụ về bản đi kèm API image.
2. Trang Settings per-VPS có card **Agent**: toggle AI, toggle lệnh shell, chế độ thực thi, phiên bản/trạng thái, nút cài/cập nhật bộ AI, hiển thị lý do sandbox không khả dụng.
3. AI shell chạy **sandbox** (mặc định) hoặc **privileged** — root broker chạy trực tiếp với quyền root trên host, không confinement, bỏ qua yêu cầu cgroup v2 (khắc phục `sandbox_unavailable` trên VPS thiếu cgroup v2 / chưa cài bộ AI).

## Quyết định đã chốt

| # | Quyết định |
|---|---|
| Q1 | Auto-install bộ AI lần đầu qua kênh SSH/updater (installer `--install-ai`, artifacts bundled trong API image); sau đó auto-update theo từng deploy như binary chính |
| Q2 | Card "Agent" trong trang Settings per-VPS; gate chi tiết (read/scopes/egress) giữ trong Assistant modal |
| Q3 | `execMode` trên AiPolicy: `sandbox` \| `privileged` (mặc định sandbox). Privileged = root broker op mới, không namespace/cgroup/rootfs, bỏ qua kiểm tra supported/cgroup v2 |
| Q4 | Giữ toàn bộ rào khi bỏ confinement: plan + duyệt tay từng lệnh, protected targets, digest preconditions, audit/evidence, redaction; ack rủi ro 1 lần (lưu who/when); banner cảnh báo trong chat; docs/security.md phơi bày root-RCE surface |
| Q5 | AI OFF = chỉ disable (chặn task + agent ngừng AI worker), không gỡ bộ cài |
| Q6 | Toggle `shellEnabled` chuyển vào card Agent (Assistant modal policy tab bỏ toggle này) |
| Q7 | Đã cài bộ AI thì luôn converge phiên bản theo deploy, kể cả khi AI đang OFF |
| Q8 | Auto-install lần đầu chỉ chạy theo hành động chủ đích: bật AI (off→on), bật shell, đổi execMode, hoặc nút "Cài/Cập nhật bộ AI" — tránh SSH hàng loạt do `aiEnabled` mặc định true |

## Hợp đồng shape (các slice phải tuân thủ đúng tên trường)

### API / TypeScript

- `AiPolicy` (`packages/api/src/ai/ai.models.ts`) thêm:
  - `execMode: "sandbox" | "privileged"` — default `"sandbox"`; bản ghi cũ thiếu trường → đọc là `"sandbox"`.
  - `privilegedAcknowledgedAt: string | null`, `privilegedAcknowledgedBy: string | null`.
- `updateAiPolicySchema` (`ai.schemas.ts`) chấp nhận `execMode`, `acknowledgePrivileged?: boolean`.
  - PATCH chuyển sang `privileged` yêu cầu `acknowledgePrivileged === true` **hoặc** policy đã có ack hợp lệ. Server ghi `By` = danh tính admin từ session, `At` = now. Chuyển về sandbox không xoá ack (bật lại không cần ack lần nữa).
- `AiCapability` thêm `privilegedSupported: boolean` (default false) + `privilegedUnsupportedReason?: string`. `hostCapabilitiesSchema` (claim) chấp nhận trường này (optional, default false).
- Shell plan step `args` + `AiHostCommand` shell payload thêm `execMode: "sandbox" | "privileged"`.
- Pre-dispatch check nhánh shell (`ai-task.service.ts`, chỗ `isCapabilityFresh`/`activeInstanceId`):
  - `sandbox`: giữ nguyên — capability fresh **và** `supported === true` **và** có `activeInstanceId`.
  - `privileged`: capability fresh (claim còn sống) **và** `privilegedSupported === true` **và** có `activeInstanceId`. KHÔNG yêu cầu `supported`/cgroup v2/rootfs.
- Approve/dispatch: nếu `policy.execMode !== plan.execMode` đã đóng dấu → `stale_plan` (fail-closed; policyRevision CAS đã bao trùm, kiểm tra bổ sung này để chặn plan cũ chạy sai mode).
- Auto-read (`ai-agent.service.ts`) không đổi (không dùng shell).

### Go agent + helper

- `HostCapabilities` thêm `PrivilegedSupported bool` JSON `"privilegedSupported"` — probe lúc worker start: helper socket trả lời op privileged ping thì true; helper cũ/thiếu → false (fail-closed).
- `ShellPayload` thêm `ExecMode string` (rỗng = `"sandbox"`).
- `Worker.dispatchShell`: `execMode == "privileged"` → nếu `!PrivilegedSupported` fail `ErrCodeSandboxUnavailable` kèm msg "privileged execution unavailable (helper missing or outdated)"; ngược lại gọi helper op privileged. Còn lại đi đường sandbox hiện tại (yêu cầu `Supported && CgroupV2` như cũ).
- Helper (`packages/agent/cmd/ai-host-helper/`) op mới `ExecutePrivileged`: chạy script qua `/bin/sh -c` với quyền root, timeout ≤ 120s, stream output qua cùng output callback + ChunkRedactor, audit log op. **Ranh giới an toàn được tuyên bố rõ**: không namespace/cgroup/deny-list path ở helper — rào thật là duyệt tay từng lệnh + redaction + audit + protected targets phía API (ghi rõ trong docs/security.md).
- Claim payload gửi thêm `privilegedSupported` (additive, không bump ProtocolVersion, parsing khoan dung cả 2 chiều).

### Install/update orchestration (API)

- Artifacts trong API image tại `/app/agent/ai/`:
  - `ai-executor-linux-{amd64,arm64}`, `ai-host-helper-linux-{amd64,arm64}` (build trong Dockerfile agent-builder stage như các binary khác).
  - `rootfs-linux-{amd64,arm64}.tar.gz` + `.manifest.json` — CI chạy `scripts/agent/build-rootfs.mjs` (cần Docker trên runner, không chạy được trong Dockerfile) trước `docker build`, xuất vào build context.
  - `profiles/` (copy từ `packages/agent/profiles`), `install-local-agent.sh` (copy từ `scripts/install/`).
- Route mới: `POST /api/vps/:id/ai/bundle/install` (admin, idempotent theo job đang chạy), `GET /api/vps/:id/ai/bundle` → `{ installed, bundleId, lastJob: {state, error, at}, capability: {supported, reason, agentVersion, privilegedSupported} }`.
- Job runner: SSH bằng credentials đã lưu (tái dụng cơ chế bootstrap SSH của `AgentConvergenceService`), chọn arch theo agent system info, upload artifacts vào thư mục tạm trên host, chạy `install-local-agent.sh --install-ai --ai-executor-binary … --ai-host-helper-binary … --ai-rootfs-tar … --ai-rootfs-manifest … --ai-profiles-dir …`; job success xác nhận qua capability claim mới sau cài (có rootfsDigest/profilesDigest hoặc privilegedSupported). Persist job trong store của AiRepository (JSON store hiện tại).
- Trigger chủ đích (Q8): trong `updatePolicy` sau khi persist — nếu `aiEnabled` off→on, `shellEnabled` false→true, hoặc `execMode` đổi, và bundle chưa installed → schedule install job. Nút cài trên card gọi cùng route.
- Convergence: tick hiện tại mở rộng — với VPS có capability report (AI worker đang chạy = đã cài), so `bundleId` bundled (digest tất cả artifacts) với `lastInstalledBundleId`; lệch → schedule update job. Quy tắc Q7: luôn converge nếu đã cài, bất kể aiEnabled.

### Web

- `ai-api.ts`: `AiPolicy` + execMode/ack fields; `getAiBundle`, `installAiBundle`; PATCH policy thêm execMode/acknowledgePrivileged.
- `SettingsPanel.tsx`: card "Agent" — toggle AI, toggle Lệnh shell, segmented execMode + modal ack rủi ro lần đầu (checkbox, mô tả root-RCE), dòng phiên bản agent (version/buildId/fresh từ agent-update view), dòng bộ AI (installed/bundleId/job state + nút Cài/Cập nhật + reason capability), tuân thủ design hiện tại (Tailwind, zero radius tokens, focus ring lime).
- `AssistantPanel.tsx`: banner cảnh báo khi `policy.execMode === "privileged"` đang bật ("Lệnh shell chạy root không sandbox; mỗi lệnh vẫn cần duyệt tay").
- `AssistantSettingsModal.tsx` tab policy: bỏ toggle shellEnabled (đã chuyển sang card).

## Ràng buộc bất biến

- Mọi test/verification **offline**: không SSH VPS thật, không network thật; installer/dry-run zero-network giữ nguyên; stub/fake runner cho test install job.
- `check-no-docker-socket.sh` và các opt-in security scan không đổi hành vi.
- Sandbox mode giữ nguyên hành vi fail-closed hiện tại — privileged là nhánh riêng, không nới lỏng sandbox.
- Policy revision CAS + revalidateForDispatch bao trùm execMode (task đang chạy fail-closed khi đổi mode).

## Slices triển khai

1. **API policy/dispatch** — models, schemas, routes (policy PATCH + ack), pre-dispatch branch, plan execMode stamp, stale_plan guard, tests.
2. **Go agent/helper** — capability probe, worker routing, ExecutePrivileged op + ping, claim payload, Go tests (linux + fail-closed non-linux).
3. **CI/image + orchestration** — build-rootfs CI step, Dockerfile bundling, ai-bundle service + routes + SSH runner + convergence mở rộng, tests với fake SSH/artifacts.
4. **Web** — card Agent, banner, modal cleanup, ai-api.ts, tests.
5. **Docs + verification** — docs/security.md (privileged section), README, docs/local-agent-upgrade-operations.md (AI bundle convergence), chạy toàn bộ kiểm tra offline.

## Kết quả triển khai

Đã triển khai đầy đủ 5 slice trên nhánh `feat/agent-autoupdate-execmode` (chưa commit tại thời điểm xác minh):

- **Slice 1 — API policy/dispatch:** `AiPolicy.execMode` + `privilegedAcknowledgedAt/By`, `AiCapability.privilegedSupported` + reason, PATCH ack, pre-dispatch branch (sandbox giữ nguyên, privileged fail-closed theo capability), plan execMode stamp + `stale_plan` guard. **22 test policy mới** + **84 test** trong các suite chịu ảnh hưởng.
- **Slice 2 — Go agent/helper:** probe `privileged_probe` lúc worker start, `Worker.dispatchShell` route theo `execMode`, helper op `privileged_execute` (`/bin/sh -c` root, timeout clamp ≤ 120s, ChunkRedactor dùng chung), claim gửi `privilegedSupported`. **29 test** trong `internal/ai`, **17 packages** pass; build `GOOS=linux` cho **amd64 + arm64** (tách blocklist seccomp per-arch để arm64 compile).
- **Slice 3a — CI/image:** CI step `ai-rootfs` build rootfs pinned (digest-verified) vào build context trước `docker build`; Dockerfile bundle `/app/agent/ai/` (binaries 2 arch, rootfs tar+manifest, profiles, installer); sửa seccomp arm64 (SYS_SYSFS/SYS_IOPL/SYS_IOPERM chuyển vào per-arch list).
- **Slice 3b — Orchestration:** `AiBundleInstallService` + `AiBundleService` (SSH installer job, idempotent), routes install/status, convergence mở rộng (converge mỗi deploy khi đã cài, bất kể `aiEnabled`). **28 test bundle** (13 routes + 8 install + 7 convergence).
- **Slice 4 — Web:** card "Agent" trong Settings (toggle AI, toggle shell chuyển từ Assistant modal, segmented execMode + ack modal, phiên bản agent, hàng bundle + nút cài/cập nhật), banner chat privileged, `ai-api.ts`. **294 test web** pass, trong đó **11 test mới**.
- **Integration fix:** `scripts/install/install.sh` + `prepare-agent-updater.sh` đọc layout `/app/agent/ai/` mới (fallback cho image cũ), `fleet-provisioning.service.ts` đồng bộ artifact paths.
- **Slice 5 — Xác minh offline (2026-10-25, Windows):** typecheck API + web pass. Vitest API: 113 file — 99 pass, 6 skip (Postgres không chạy), 8 file fail ở lần chạy full; chạy lại từng file: toàn bộ suite AI pass (ai-compaction-flow 11, ai-multi-provider 7, ai-persistence 37, ai-execmode-dispatch 8 — timeout 5000ms do tải máy + rmdir ENOTEMPTY trên Windows, không phải lỗi logic); các failure còn lại là flake Windows có sẵn từ trước (EPERM rename `json-file.ts` trong files/ và local-updater.routes; `spawn flock ENOENT` trong fleet-provisioning — không có util-linux flock trên Windows; service chỉ thêm 1 dòng path candidate AI). Vitest web: **18 file, 319/319 pass**. Go: `go vet` sạch, `go test ./... -count=1` **17 packages ok** (29 test `internal/ai`), build `GOOS=linux` **amd64 + arm64** OK. Hygiene CI: `check-no-docker-socket.sh` **25/25**, `check:docs` PASS (39 links), `test-installer-docker-access.sh` 10 pass/0 fail (live checks skip — không root), smoke `--help` 2 script exit 0, `test-updater.sh` 49 pass / 3 fail — 3 failure giống hệt khi chạy lại ở HEAD trong worktree tạm (python3 Store stub + Docker daemon tắt) → pre-existing, không do feature. Không chạy docker build, không gọi network.
