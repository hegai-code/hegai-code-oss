import { z } from 'zod';

/**
 * Отчёты — HTML pages published to the hub (`/api/reports`, server-rs
 * `reports.rs`). The page itself is served from `/api/reports/<id>/content`
 * under a CSP sandbox; these are only its metadata.
 */
export const ReportMeta = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  sizeBytes: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  ownerUserId: z.string(),
  ownerName: z.string(),
  ownerEmail: z.string(),
  /** Project folder, one per project; '' = Hegai Code itself. */
  folder: z.string().default(''),
  /** Key an external sync job pairs the report with; absent when unset. */
  syncRef: z.string().optional(),
  url: z.string().optional(),
});
export type ReportMeta = z.infer<typeof ReportMeta>;

export const ReportList = z.object({
  reports: z.array(ReportMeta),
  admin: z.boolean(),
});
export type ReportList = z.infer<typeof ReportList>;
