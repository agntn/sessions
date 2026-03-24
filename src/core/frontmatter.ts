const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const FIELD_RE = /^(\w+):\s*(.+)$/;

export interface Frontmatter {
  [key: string]: string;
}

export function parseFrontmatter(content: string): { meta: Frontmatter; body: string } {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { meta: {}, body: content };

  const meta: Frontmatter = {};
  for (const line of match[1].split("\n")) {
    const field = line.match(FIELD_RE);
    if (field) meta[field[1]] = field[2].trim();
  }
  return { meta, body: match[2].trim() };
}
