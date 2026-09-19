// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { execSync } from 'node:child_process';

// Stamped into the funnel tracker (src/scripts/track.ts) so every recorded
// session names the exact version of the site that visitor saw. Workers Builds
// provides the SHA; a local build asks git; a build with neither gets the date.
function siteBuild() {
  const ci = process.env.WORKERS_CI_COMMIT_SHA;
  if (ci) return ci.slice(0, 7);
  try {
    const git = (/** @type {string} */ cmd) => execSync(`git ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return git('rev-parse --short=7 HEAD') + (git('status --porcelain') ? '-d' : '');
  } catch {
    return new Date().toISOString().slice(0, 10).replaceAll('-', '');
  }
}

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
  vite: {
    define: { __SITE_BUILD__: JSON.stringify(siteBuild()) },
  },
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'hover',
  },
});
