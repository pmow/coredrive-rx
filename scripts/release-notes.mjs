// Assembles a GitHub Release body from docs/releases/vX.Y.Z.md, newest first.
//
// AGENTS.md requires every tag to carry its own "What's new" plus every earlier
// release's, so the latest tag always tells the full story. That rule was a human
// convention and it was missed on nine tags in a row, which left v1.5.0 as the last
// release anyone could read while region discovery landed unannounced. Here the rule is
// mechanical: the workflow calls this before publishing, so a tag whose notes file is
// missing fails the job instead of shipping a body that is only a changelog link.
//
// Usage: node scripts/release-notes.mjs v1.12.0 > RELEASE_BODY.md
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const SEPARATOR = '\n\n---\n\n';

// compareTags orders tags newest first. Ordering by string puts v1.9.1 above v1.10.0,
// which is the one mistake that would silently drop a release out of the middle of a
// body, so the comparison is on the numeric components.
export function compareTags(a, b) {
  const na = a.replace(/^v/, '').split('.').map(Number);
  const nb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (nb[i] || 0) - (na[i] || 0);
    if (d) return d;
  }
  return 0;
}

// assembleBody returns the body for `tag`: its own section plus every OLDER one, newest
// first. Newer sections are excluded so that re-publishing an old tag stays truthful
// about what that release contained.
export function assembleBody(entries, tag) {
  if (!entries.some((e) => e.tag === tag)) {
    throw new Error('no release notes for ' + tag + ' — expected docs/releases/' + tag + '.md');
  }
  return entries
    .filter((e) => compareTags(e.tag, tag) >= 0)
    .sort((x, y) => compareTags(x.tag, y.tag))
    .map((e) => e.text.trim())
    .join(SEPARATOR) + '\n';
}

export function readEntries(dir) {
  return readdirSync(dir)
    .filter((f) => /^v\d+\.\d+\.\d+\.md$/.test(f))
    .map((f) => ({ tag: f.replace(/\.md$/, ''), text: readFileSync(join(dir, f), 'utf8') }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const tag = process.argv[2];
  if (!tag) { console.error('usage: node scripts/release-notes.mjs <tag>'); process.exit(2); }
  const dir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'docs', 'releases');
  try {
    process.stdout.write(assembleBody(readEntries(dir), tag));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
