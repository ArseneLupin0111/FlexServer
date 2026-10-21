import { z } from "zod";

const metadata = z.string().min(1).max(128).refine((value) => !/[\x00-\x1f\x7f]/u.test(value) && value.trim() === value);
const opaque = z.string().regex(/^[A-Za-z0-9_-]{32}$/u);
const replica = z.object({ containerKey: opaque, slot: z.number().int().min(-1).max(1000000), state: z.string().max(64), status: z.string().max(255), health: z.string().max(32).optional(), image: z.string().max(512).optional(), oneoff: z.boolean().optional(), createdAt: z.string().datetime({ offset: true }) }).strict();
const service = z.object({ service: metadata, occupiedSlots: z.array(z.number().int()).max(100), maxSlot: z.number().int().nonnegative(), replicas: z.array(replica).max(100), health: z.string().max(32), isOneoff: z.boolean(), configHash: z.string().max(128) }).strict();
const project = z.object({ project: metadata, services: z.array(service).max(64), replicaTotal: z.number().int().min(0).max(500) }).strict();
const capability = z.object({ protocolVersion: z.literal("applications-v1"), os: z.string().max(32), arch: z.string().max(32), agentVersion: z.string().max(128), dockerAvailable: z.boolean(), dockerVersion: z.string().max(128).optional(), composeMode: z.string().max(32), composeVersion: z.string().max(128).optional(), installState: z.enum(["missing", "cli_only", "plugin", "unknown"]), managementGate: z.boolean(), features: z.array(z.string().max(64)).max(32), reasons: z.array(z.string().max(255)).max(16) }).strict();
export const applicationsInventorySchema = z.object({
  protocolVersion: z.literal("applications-v1"), agentInstanceId: opaque,
  daemonEpoch: z.number().int().safe().nonnegative(), inventorySequence: z.number().int().safe().positive(), collectedAt: z.string().datetime({ offset: true }), completeness: z.boolean(), completionReason: z.string().max(64), containerTotal: z.number().int().min(0).max(500), projectTotal: z.number().int().min(0).max(100), replicaTotal: z.number().int().min(0).max(500), projects: z.array(project).max(100), capability,
}).strict().superRefine((value, ctx) => {
  const projects = new Set<string>();
  const keys = new Set<string>();
  let total = 0;
  for (const p of value.projects) {
    if (projects.has(p.project)) ctx.addIssue({ code: "custom", message: "duplicate project" });
    projects.add(p.project);
    const services = new Set<string>();
    let projectTotal = 0;
    for (const s of p.services) {
      if (services.has(s.service)) ctx.addIssue({ code: "custom", message: "duplicate service" });
      services.add(s.service);
      for (const r of s.replicas) {
        if (keys.has(r.containerKey)) ctx.addIssue({ code: "custom", message: "duplicate container identity" });
        keys.add(r.containerKey);
      }
      projectTotal += s.replicas.length;
    }
    if (projectTotal !== p.replicaTotal) ctx.addIssue({ code: "custom", message: "project count mismatch" });
    total += projectTotal;
  }
  if (value.projectTotal !== value.projects.length || total !== value.replicaTotal || total > value.containerTotal) ctx.addIssue({ code: "custom", message: "inventory count mismatch" });
  if (value.completeness && value.completionReason !== "") ctx.addIssue({ code: "custom", message: "complete inventory cannot have failure reason" });
});
export type ApplicationsInventory = z.infer<typeof applicationsInventorySchema>;
// StoredApplicationsInventory carries persistence envelope additions, not part
// of the agent wire schema: acceptedPayloadDigest fingerprints the raw accepted
// payload and is never replaced by the incomplete-replay retention projection,
// so a later incomplete observation replaying the same agent sequence cannot
// silently make its retained projection look like the original evidence
// digest. evidenceReceivedAt records when the retained evidence
// (projects/counters and the digest) was accepted — deliberately NOT the
// incomplete replay's receivedAt, so consumers never mistake retained evidence
// for fresh coverage.
export type AcceptedInventoryMetadata = { acceptedPayloadDigest?: string; evidenceReceivedAt?: string };
export type StoredApplicationsInventory = AcceptedInventoryMetadata & ApplicationsInventory & { vpsId: string; receivedAt: string };
