// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://ryuxik.io',
  output: 'static',
  trailingSlash: 'ignore',
  integrations: [sitemap()],
  image: {
    // Site-wide default widths for astro:assets. Agent B may still pass an explicit
    // `widths={[480, 800, 1200, 1600]}` per <Image>/<Picture>; these are the defaults
    // used when a responsive layout is in play.
    breakpoints: [480, 800, 1200, 1600],
    layout: 'constrained',
    responsiveStyles: true,
  },
  build: {
    inlineStylesheets: 'auto',
  },
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'hover',
  },
});
