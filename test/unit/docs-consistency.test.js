'use strict';

/**
 * `README.md` and `docs/index.md` must not drift apart.
 *
 * `docs/index.md` is a hand-maintained near-copy of `README.md`: same tables,
 * same measured numbers, with a landing-page intro and a `See also` section of
 * its own (it is the GitHub Pages home page — see `docs/_config.yml` and
 * `.github/workflows/pages.yml`). That is two edit sites for every benchmark
 * re-run, which is exactly the duplication trap this project has already hit
 * once with the `9-11×` headline.
 *
 * Rather than generate one file from the other (which would replace the docs
 * landing page with the README verbatim, losing its intro and See-also), this
 * pins the part that actually matters and that a human reliably forgets: the
 * *facts*. Every markdown table row, and every headline number in the prose,
 * must appear in both files. Prose wording, heading levels, section separators
 * and the intro stay free to differ.
 *
 * Mirrors `tests/test_docs_consistency.py` in the Python port.
 *
 * If this fails after a deliberate change: update the number in both files.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const README = path.join(ROOT, 'README.md');
const DOCS_INDEX = path.join(ROOT, 'docs', 'index.md');

/** Every markdown table row, cells trimmed, `|---|` separator rows dropped. */
function tableRows(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped.startsWith('|') || !stripped.endsWith('|')) continue;
    const cells = stripped.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^[-: ]*$/.test(c))) continue; // the |---|---| separator
    rows.push(cells.join(' | '));
  }
  return rows;
}

// "~28x", "2.5×", "1,686" — the shapes the measured claims take. U+00D7
// MULTIPLICATION SIGN is accepted alongside a latin "x", so a speed-up written
// with one character in one file and the other character in the other still
// compares as the same claim.
const MULTIPLICATION_SIGN = String.fromCharCode(0xd7);
const NUMBER = new RegExp(
  `~?\\d[\\d,]*(?:\\.\\d+)?\\s*(?:x\\b|${MULTIPLICATION_SIGN})|\\b\\d{1,3}(?:,\\d{3})+\\b`,
  'g'
);

function proseNumbers(text) {
  const body = text
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('|'))
    .join('\n');
  return new Set((body.match(NUMBER) || []).map((m) => m.replace(/\s+/g, '')));
}

const read = (p) => fs.readFileSync(p, 'utf8');

/** The page list under `exclude:` in `docs/_config.yml` (not the `plugins:` list above it). */
function excludedPages() {
  const lines = read(path.join(ROOT, 'docs', '_config.yml')).split(/\r?\n/);
  const start = lines.findIndex((l) => /^exclude:\s*$/.test(l));
  if (start === -1) return new Set();
  const out = new Set();
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+-\s/.test(line)) break; // end of the block
    out.add(line.trim().slice(2).trim());
  }
  return out;
}


describe('docs: README.md and docs/index.md agree', () => {
  it('both files exist', () => {
    assert.ok(fs.statSync(README).isFile());
    assert.ok(fs.statSync(DOCS_INDEX).isFile());
  });

  it('has the same table rows in both files', () => {
    const readme = tableRows(read(README));
    const docs = tableRows(read(DOCS_INDEX));
    const onlyReadme = readme.filter((r) => !docs.includes(r));
    const onlyDocs = docs.filter((r) => !readme.includes(r));
    assert.deepStrictEqual(onlyReadme, [], `table rows in README.md but not docs/index.md:\n${onlyReadme.join('\n')}`);
    assert.deepStrictEqual(onlyDocs, [], `table rows in docs/index.md but not README.md:\n${onlyDocs.join('\n')}`);
    assert.strictEqual(readme.length, docs.length, 'the same rows appear a different number of times in each file');
  });

  it('quotes the same headline numbers in both files', () => {
    const readme = proseNumbers(read(README));
    const docs = proseNumbers(read(DOCS_INDEX));
    const onlyReadme = [...readme].filter((n) => !docs.has(n)).sort();
    const onlyDocs = [...docs].filter((n) => !readme.has(n)).sort();
    assert.deepStrictEqual(onlyReadme, [], `numbers in README.md but not docs/index.md: ${onlyReadme.join(', ')}`);
    assert.deepStrictEqual(onlyDocs, [], `numbers in docs/index.md but not README.md: ${onlyDocs.join(', ')}`);
  });

  it('keeps the landing page a Jekyll page with the site title', () => {
    const index = read(DOCS_INDEX);
    assert.match(index, /^---\ntitle: jsonata2js\n---\n/, 'docs/index.md needs Jekyll front matter with a title');
    assert.ok(!/^# /m.test(index.split('---')[2] || ''), 'the theme renders the title; index.md should not repeat an H1');
  });

  // `package.json` declares `"license": "MIT"`, npm ships the file whether or
  // not `files` lists it, and both front doors claim MIT — so the file has to
  // exist, say MIT, and be reachable from each of them. The README links it
  // relatively (GitHub renders that); the landing page has to go through
  // `site.github.repository_url`, since the built site has no LICENSE page.
  it('ships an MIT LICENSE that both front doors link to', () => {
    const license = read(path.join(ROOT, 'LICENSE'));
    assert.match(license, /^MIT License\r?\n/, 'LICENSE should be the MIT text');
    assert.match(license, /Copyright \(c\) \d{4}/, 'LICENSE needs a copyright line');
    const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
    assert.strictEqual(pkg.license, 'MIT', 'package.json must agree with LICENSE');
    assert.match(read(README), /\]\(LICENSE\)/, 'README.md should link the LICENSE file');
    assert.match(
      read(DOCS_INDEX),
      /\]\(\{\{ site\.github\.repository_url \}\}\/blob\/main\/LICENSE\)/,
      'docs/index.md should link LICENSE through site.github.repository_url'
    );
  });

  it('links only to pages the built site actually contains', () => {
    const index = read(DOCS_INDEX);
    // Liquid-derived targets (`{{ site.github.repository_url }}/…`) resolve at
    // build time from the actual repository, so there is nothing to check here.
    const relative = [...index.matchAll(/\]\((?!https?:|#|mailto:|\{\{)([^)#]+)(?:#[^)]*)?\)/g)].map((m) => m[1]);
    const excluded = excludedPages();
    assert.ok(relative.length > 0, 'expected the landing page to link at least one other docs page');
    for (const target of relative) {
      // Jekyll renders `x.md` (front matter required) as `x.html`, so that is
      // the URL the landing page must use — and the source it resolves to.
      const source = target.endsWith('.html') ? `${target.slice(0, -'.html'.length)}.md` : target;
      const onDisk = path.join(ROOT, 'docs', source);
      assert.ok(fs.existsSync(onDisk), `docs/index.md links ${target}; docs/${source} does not exist`);
      assert.ok(!excluded.has(source), `docs/index.md links ${target}, which docs/_config.yml excludes from the build`);
      if (target.endsWith('.html')) {
        assert.match(
          read(onDisk),
          /^---\r?\n/,
          `docs/${source} needs Jekyll front matter, otherwise it is copied verbatim and ${target} 404s`
        );
      }
    }
  });
});
