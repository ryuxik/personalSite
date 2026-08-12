import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
// `import { z } from 'astro:content'` is deprecated in Astro 7 — use astro/zod.
import { z } from 'astro/zod';

/**
 * A "shoot" is one folder under src/content/shoots/<slug>/ containing an index.md
 * plus its images (001.jpg, 002.jpg, … — filename order = display order).
 * See SPEC.md § Content model. Owned downstream by Agent B.
 */
const shoots = defineCollection({
  loader: glob({ pattern: '*/index.md', base: './src/content/shoots' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      subject: z.string(),
      context: z.enum(['commissioned', 'personal']),
      client: z.string().optional(),
      date: z.coerce.date(),
      location: z.string().optional(),
      genre: z.enum(['portraiture', 'street', 'landscape', 'events', 'other']),
      cover: image(),
      featured: z.number().default(0),
    }),
});

export const collections = { shoots };
