type RawModel = Record<string, unknown>;

const MIN_UTILITY_CONTEXT_WINDOW = 32_000;

const SPECIAL_PURPOSE_MODEL_PATTERN = /(?:embedding|embed|rerank|moderation|whisper|tts|audio|speech|image-generation|vision|live|deep-research|safety|safeguard|guard|search|transcrib)/i;

const UTILITY_TERMS: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /(?:^|[\s._/-])flash[\s._/-]?lite(?:$|[\s._/-])/, score: 110 },
  { pattern: /(?:^|[\s._/-])nano(?:$|[\s._/-])/, score: 100 },
  { pattern: /(?:^|[\s._/-])mini(?:$|[\s._/-])/, score: 95 },
  { pattern: /(?:^|[\s._/-])haiku(?:$|[\s._/-])/, score: 95 },
  { pattern: /(?:^|[\s._/-])small(?:$|[\s._/-])/, score: 85 },
  { pattern: /(?:^|[\s._/-])fast(?:$|[\s._/-])/, score: 80 },
  { pattern: /(?:^|[\s._/-])spark(?:$|[\s._/-])/, score: 80 },
  { pattern: /(?:^|[\s._/-])instant(?:$|[\s._/-])/, score: 75 },
  { pattern: /(?:^|[\s._/-])lite(?:$|[\s._/-])/, score: 70 },
  { pattern: /(?:^|[\s._/-])flash(?:$|[\s._/-])/, score: 65 },
  { pattern: /(?:^|[\s._/-])(?:7|8)b(?:$|[\s._/-])/, score: 65 },
  { pattern: /(?:^|[\s._/-])(?:12|20)b(?:$|[\s._/-])/, score: 45 },
  { pattern: /(?:^|[\s._/-])32b(?:$|[\s._/-])/, score: 25 },
];

interface UtilityCandidate {
  model: RawModel;
  id: string;
  name: string;
  utilityScore: number;
  recency: Recency;
  costScore: number;
}

/**
 * How new a model is, from its version and its release date, either of
 * which can be missing (0).
 */
interface Recency {
  version: number;
  date: number;
}

/**
 * Versions decide when both models have one: a dated snapshot of an older
 * version (`claude-haiku-4-5-20251001`) must not outrank a newer version
 * that carries no date (`claude-haiku-5-5`). Otherwise dates decide when
 * both have one (`mistral-small-2603`, named "Mistral Small 4" with no
 * dotted version, against `mistral-small-2506`). Otherwise whichever signal
 * exists, as before.
 */
function compareRecency(a: Recency, b: Recency): number {
  if (a.version > 0 && b.version > 0 && a.version !== b.version) return a.version - b.version;
  if (a.date > 0 && b.date > 0 && a.date !== b.date) return a.date - b.date;
  return Math.max(a.version, a.date) - Math.max(b.version, b.date);
}

export function inferUtilityModel(models: readonly RawModel[] | null | undefined): RawModel | null {
  if (!Array.isArray(models)) return null;

  const capable = models
    .map(toUtilityCandidate)
    .filter((candidate): candidate is UtilityCandidate => candidate !== null);

  const utilityCandidates = capable.filter(candidate => candidate.utilityScore > 0);
  if (utilityCandidates.length > 0) {
    return [...utilityCandidates].sort(compareUtilityCandidates)[0]!.model;
  }
  if (capable.length === 0) return null;

  return [...capable].sort(compareFallbackCandidates)[0]!.model;
}

export function inferUtilityModelId(models: readonly RawModel[] | null | undefined): string | null {
  const model = inferUtilityModel(models);
  const id = model?.['id'];
  if (typeof id === 'string') return id;
  const name = model?.['name'];
  return typeof name === 'string' ? name : null;
}

function toUtilityCandidate(model: RawModel): UtilityCandidate | null {
  const id = getString(model['id']) ?? getString(model['name']);
  if (!id) return null;

  const name = getString(model['name']) ?? id;
  const searchable = `${id} ${name}`.toLowerCase();
  if (SPECIAL_PURPOSE_MODEL_PATTERN.test(searchable)) return null;

  if (!supportsText(model)) return null;

  const contextWindow = getNumber(model['contextWindow']) ?? 0;
  if (contextWindow > 0 && contextWindow < MIN_UTILITY_CONTEXT_WINDOW) return null;

  return {
    model,
    id,
    name,
    utilityScore: inferUtilityScore(searchable),
    recency: inferRecency(searchable),
    costScore: inferCostScore(model),
  };
}

function compareUtilityCandidates(a: UtilityCandidate, b: UtilityCandidate): number {
  const recency = compareRecency(b.recency, a.recency);
  if (recency !== 0) return recency;
  if (a.costScore !== b.costScore) return a.costScore - b.costScore;
  if (b.utilityScore !== a.utilityScore) return b.utilityScore - a.utilityScore;
  return a.id.localeCompare(b.id);
}

function compareFallbackCandidates(a: UtilityCandidate, b: UtilityCandidate): number {
  if (a.costScore !== b.costScore) return a.costScore - b.costScore;
  const recency = compareRecency(b.recency, a.recency);
  if (recency !== 0) return recency;
  return a.id.localeCompare(b.id);
}

function supportsText(model: RawModel): boolean {
  const input = model['input'];
  if (!Array.isArray(input)) return true;
  return input.includes('text');
}

function inferUtilityScore(searchable: string): number {
  let score = 0;
  for (const term of UTILITY_TERMS) {
    if (term.pattern.test(searchable)) {
      score = Math.max(score, term.score);
    }
  }
  return score;
}

function inferRecency(searchable: string): Recency {
  return { version: inferVersionScore(searchable), date: inferDateScore(searchable) };
}

function inferDateScore(searchable: string): number {
  let score = 0;

  for (const match of searchable.matchAll(/20\d{6}/g)) {
    const value = Number(match[0]);
    if (isValidDateScore(value)) {
      score = Math.max(score, value);
    }
  }

  for (const match of searchable.matchAll(/(20\d{2})[-_/](0[1-9]|1[0-2])/g)) {
    score = Math.max(score, Number(match[1]) * 10_000 + Number(match[2]) * 100);
  }

  for (const match of searchable.matchAll(/(0[1-9]|1[0-2])[-_/](20\d{2})/g)) {
    score = Math.max(score, Number(match[2]) * 10_000 + Number(match[1]) * 100);
  }

  for (const match of searchable.matchAll(/(?:^|[^\d])(\d{4})(?:$|[^\da-z])/g)) {
    const raw = match[1]!;
    const year = Number(raw.slice(0, 2));
    const month = Number(raw.slice(2, 4));
    if (year >= 20 && year <= 40 && month >= 1 && month <= 12) {
      score = Math.max(score, 20_000_000 + year * 10_000 + month * 100);
    }
  }

  return score;
}

function inferVersionScore(searchable: string): number {
  const scrubbed = searchable
    .replace(/20\d{6}/g, ' ')
    .replace(/(20\d{2})[-_/](0[1-9]|1[0-2])/g, ' ')
    .replace(/(0[1-9]|1[0-2])[-_/](20\d{2})/g, ' ')
    .replace(/(?:^|[^\d])(\d{4})(?:$|[^\da-z])/g, ' ')
    .replace(/\b\d+(?:\.\d+)?b\b/g, ' ');

  let score = 0;
  for (const match of scrubbed.matchAll(/\d+(?:\.\d+)+/g)) {
    score = Math.max(score, scoreVersionParts(match[0]!.split('.').map(Number)));
  }

  // Runs of numeric tokens, such as `haiku-4-5` (4.5). Only whole runs
  // count: a run's tail (the `5` of `4-5`) is not a version. A lone number
  // is not one either: it is as often a size or a date's day as a major.
  const tokens = scrubbed.split(/[^a-z0-9]+/).filter(Boolean);
  const isNumber = (token: string | undefined): boolean => token !== undefined && /^\d+$/.test(token);
  for (let i = 0; i < tokens.length; i++) {
    if (!isNumber(tokens[i]) || isNumber(tokens[i - 1])) continue;
    const parts: number[] = [];
    for (let j = i; j < tokens.length && isNumber(tokens[j]) && parts.length < 4; j++) {
      parts.push(Number(tokens[j]));
    }
    if (parts.length >= 2) {
      score = Math.max(score, scoreVersionParts(parts));
    }
  }

  return score;
}

function scoreVersionParts(parts: number[]): number {
  const weights = [1_000_000, 10_000, 100, 1];
  return parts.slice(0, weights.length).reduce((score, part, index) => (
    Number.isFinite(part) ? score + part * weights[index]! : score
  ), 0);
}

function inferCostScore(model: RawModel): number {
  const cost = model['cost'] ?? model['pricing'];
  if (!cost || typeof cost !== 'object') return Number.MAX_SAFE_INTEGER;

  const rawCost = cost as RawModel;
  const input = getNumber(rawCost['input']) ?? 0;
  const output = getNumber(rawCost['output']) ?? 0;
  if (input === 0 && output === 0) return Number.MAX_SAFE_INTEGER - 1;
  return input + output * 3;
}

function isValidDateScore(value: number): boolean {
  const year = Math.floor(value / 10_000);
  const month = Math.floor((value % 10_000) / 100);
  const day = value % 100;
  return year >= 2020 && year <= 2040 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function getNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
