import { z } from "zod";

export const createVpsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  displayName: z.string().trim().min(1).max(80).optional(),
  host: z.string().trim().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1).max(64),
  provider: z.string().trim().min(1).max(80).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  status: z.enum(["unknown", "healthy", "warning", "unreachable"]).optional(),
  notes: z.string().trim().max(1000).optional(),
  password: z.string().min(1).max(4096).optional(),
}).strict();

export const updateVpsSchema = createVpsSchema
  .omit({ password: true })
  .partial()
  .extend({
    dockerMetricsEnabled: z.boolean().optional(),
    dockerManagementEnabled: z.boolean().optional(),
    composeManagementEnabled: z.boolean().optional(),
    sftpEnabled: z.boolean().optional(),
  });

/** Strict schema for local/system-managed VPS: only feature toggles allowed. */
export const updateLocalVpsSchema = z
  .object({
    dockerMetricsEnabled: z.boolean().optional(),
    dockerManagementEnabled: z.boolean().optional(),
    composeManagementEnabled: z.boolean().optional(),
    sftpEnabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.dockerMetricsEnabled !== undefined || value.dockerManagementEnabled !== undefined || value.composeManagementEnabled !== undefined || value.sftpEnabled !== undefined, {
    message: "At least one feature toggle must be provided",
  });

export const provisionKeySchema = z.object({
  password: z.string().min(1).max(4096),
});

export const installAgentSchema = z.object({
  password: z.string().min(1).max(4096).optional(),
});
