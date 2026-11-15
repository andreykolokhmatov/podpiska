import { z } from 'zod';

/** LLM output: postIds are tg_post_id values from the prompt. */
export const digestLlmSchema = z.object({
  items: z.array(
    z.object({
      title: z.string(),
      summary: z.string(),
      importance: z.number().int(),
      topics: z.array(z.string()),
      postIds: z.array(z.number().int()),
    }),
  ),
});

export type DigestLlmOutput = z.infer<typeof digestLlmSchema>;

/** channel_digests.summary_json: postIds are posts.id values. */
export const storedDigestSchema = z.object({
  version: z.literal(1),
  items: z.array(
    z.object({
      title: z.string(),
      summary: z.string(),
      importance: z.number().int().min(1).max(5),
      topics: z.array(z.string()),
      postIds: z.array(z.number().int()).min(1),
    }),
  ),
});

export type StoredDigest = z.infer<typeof storedDigestSchema>;
export type DigestItem = StoredDigest['items'][number];
