import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `skills/` sits next to `src/` in the repository and next to `dist/` in the
 * published package, so resolving `../skills/` against this module works from
 * both.
 */
const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));
const MODELS_DIR = fileURLToPath(new URL('../skills/models/', import.meta.url));

const GUIDE_SUFFIX = ' Prompt Architecture';

/** One video model guide shipped in `skills/models/`. */
export interface VideoModelGuide {
  /** File name without `.md`, e.g. `google-veo`. */
  readonly slug: string;
  /** Human name from the guide's heading, e.g. `Google Veo`. */
  readonly name: string;
}

export function readSkill(relative: string): string {
  return readFileSync(SKILLS_DIR + relative, 'utf-8');
}

/** Lowercase alphanumerics only, so `Runway Gen-3` and `runway-gen3` compare equal. */
export function compactKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function nameFromGuide(slug: string, text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const heading = firstLine.replace(/^#+\s*/, '').trim();
  const name = heading.endsWith(GUIDE_SUFFIX) ? heading.slice(0, -GUIDE_SUFFIX.length).trim() : heading;
  return name.length > 0 ? name : slug;
}

/** The video models this package has a guide for, sorted by slug. */
export function listVideoModels(): VideoModelGuide[] {
  return readdirSync(MODELS_DIR)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => {
      const slug = file.slice(0, -'.md'.length);
      return { slug, name: nameFromGuide(slug, readFileSync(MODELS_DIR + file, 'utf-8')) };
    });
}

/**
 * The guide matching `videoModel` by slug or human name, or `undefined`.
 * Matching uses the compact key, so `Sora`, `sora`, `OpenAI Sora`,
 * `Runway Gen-3` and `runway-gen3` all resolve. Only names from the directory
 * listing can match, so a path cannot be smuggled in.
 */
export function findVideoModel(videoModel: string): { guide: VideoModelGuide; text: string } | undefined {
  const key = compactKey(videoModel);
  if (key.length === 0) return undefined;
  const guide = listVideoModels().find((m) => compactKey(m.slug) === key || compactKey(m.name) === key);
  if (!guide) return undefined;
  return { guide, text: readSkill(`models/${guide.slug}.md`) };
}
