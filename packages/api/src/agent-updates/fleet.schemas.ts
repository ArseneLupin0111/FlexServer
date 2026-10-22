import { z } from "zod";


export const createRolloutSchema = z.object({
  releaseId: z.string().min(1),
  group: z.string().min(1).optional(),
  vpsIds: z.array(z.string().min(1)).optional(),
  confirmed: z.literal(true),
  irreversibleConsent: z.boolean().optional(),
});

export const controlRolloutSchema = z.object({
  action: z.enum(["pause", "resume", "retry"]),
});
