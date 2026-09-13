import { z } from "zod";

export const dispatchCommandSchema = z
  .object({
    command: z.string().trim().min(1, "Command is required").max(8192),
    /** Public device ids to target. */
    deviceIds: z.array(z.string().min(1)).max(500).default([]),
    /** Optional group to broadcast to instead of / in addition to deviceIds. */
    groupId: z.string().min(1).optional().nullable(),
    timeoutMs: z.number().int().min(1_000).max(3_600_000).default(60_000),
    /** Use the group broadcast topic rather than per-device fan-out. */
    useBroadcastTopic: z.boolean().default(false),
  })
  .refine((v) => v.deviceIds.length > 0 || v.groupId, {
    message: "Select at least one device or a group",
    path: ["deviceIds"],
  });

export type DispatchCommandInput = z.infer<typeof dispatchCommandSchema>;
