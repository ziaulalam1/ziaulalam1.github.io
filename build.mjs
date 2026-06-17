/**
 * build.mjs — pre-renders portfolio to fully static HTML.
 *
 * What it does:
 *   1. Reads data.json (single source of truth for stats + projects)
 *   2. Injects stats and mini-projects into index.html as static HTML
 *   3. Writes dist/index.html (deploy dist/ to GitHub Pages)
 *
 * Run: node build.mjs
 * Output: dist/index.html (plus copies of all other assets)
 *
 * Why this exists:
 *   - Stats decoupled from HTML: change data.json, rebuild, never touch markup
 *   - Bottom 7 projects become SEO-visible (no longer JS-rendered)
 *   - CI can run this and deploy dist/ automatically
 */

import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(__dirname, 'data.json'), 'utf8'));

/** Render one mini-project card to static HTML */
function renderMini(p) {
  const demoLink = p.demo
    ? `<a class="demo" href="${p.demo}">Demo</a>`
    : '';
  const tags = p.tags.map(t => `<span class="tag">${t}</span>`).join('');
  return `
    <article class="mini" aria-label="${p.name} project">
      <h3>${p.name}</h3>
      <div class="mini-desc">${p.desc}</div>
      <div class="mini-meta">
        <div class="mini-links">
          <a href="${p.github}" aria-label="${p.name} GitHub repository">GitHub</a>
          ${demoLink}
        </div>
        <span class="metric">${p.metric}</span>
      </div>
      <div class="tags" style="margin-top:10px">${tags}</div>
    </article>`.trim();
}

/** Build the static grid HTML */
function buildGrid() {
  return data.more.map(renderMini).join('\n    ');
}

/** Inject stats into the stats section */
function buildStats() {
  const s = data.stats;
  return `
      <div class="stat"><span class="stat-number">${s.projects}</span><span class="stat-label">Projects</span></div>
      <div class="stat"><span class="stat-number">${s.tests}</span><span class="stat-label">Tests passing</span></div>
      <div class="stat"><span class="stat-number">${s.languages}</span><span class="stat-label">Languages</span></div>
      <div class="stat"><span class="stat-number">${s.liveDemos}</span><span class="stat-label">Live demos</span></div>`.trimStart();
}

// Read source template
let html = readFileSync(join(__dirname, 'index.html'), 'utf8');

// Replace JS-rendered grid with static HTML
// Marker: <div class="grid" id="grid"></div>
html = html.replace(
  '<div class="grid" id="grid"></div>',
  `<div class="grid" id="grid" aria-label="More projects">\n    ${buildGrid()}\n    </div>`
);

// Strip the JS block that rendered the grid (it's now static)
html = html.replace(
  /<script>\s*const more[\s\S]*?<\/script>/,
  `<!-- Grid pre-rendered by build.mjs from data.json -->`
);

// Replace inline stats with data.json values
html = html.replace(
  /<div class="stats">[\s\S]*?<\/div>\s*\n\s*<div class="philosophy">/,
  `<div class="stats">\n      ${buildStats()}\n    </div>\n\n    <div class="philosophy">`
);

// Update footer date
html = html.replace(
  /Last updated \w+ \d+/,
  `Last updated ${new Date(data.lastUpdated).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`
);

// Write output
mkdirSync(join(__dirname, 'dist'), { recursive: true });
writeFileSync(join(__dirname, 'dist/index.html'), html, 'utf8');

// Copy static assets
for (const dir of ['img', 'orderbook', 'monitor', 'dashboard']) {
  try {
    cpSync(join(__dirname, dir), join(__dirname, 'dist', dir), { recursive: true });
  } catch {}
}
for (const file of ['robots.txt', 'sitemap.xml', 'favicon.ico']) {
  try {
    cpSync(join(__dirname, file), join(__dirname, 'dist', file));
  } catch {}
}

console.log(`Built dist/index.html — ${data.stats.projects} projects, ${data.stats.liveDemos} live demos`);
