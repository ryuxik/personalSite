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
  // `cover` is a plain relative path, NOT the image() schema: stream images bypass
  // astro:assets (HDR gain maps — see SPEC.md § HDR pipeline), and image() made Astro
  // emit an unreferenced full-size copy of every cover into dist/_astro/.
  schema: z.object({
    title: z.string(),
    subject: z.string(),
    context: z.enum(['commissioned', 'personal']),
    client: z.string().optional(),
    date: z.coerce.date(),
    location: z.string().optional(),
    genre: z.enum(['portraiture', 'street', 'landscape', 'events', 'other']),
    cover: z.string(),
    featured: z.number().default(0),
    // Which gallery the shoot lives in: the people-first Overview (default) or
    // the Diary of travel, still life, and experiments (/diary).
    section: z.enum(['overview', 'diary']).default('overview'),
    // Per-image alt text, keyed by bare filename ("001.jpg"). Optional and partial:
    // src/lib/photos.ts prefers alts[file] and falls back to a derived string for any
    // frame that has no entry yet, so a half-written map never breaks the stream.
    // Two arguments, not one: astro/zod is zod 4, whose `record` types require an
    // explicit key schema. The 1-arg form still validates at runtime but infers
    // `{}` for the value, which loses the string type at every call site.
    alts: z.record(z.string(), z.string()).optional(),
  }),
});

export const collections = { shoots };
