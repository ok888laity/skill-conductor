import { validateSteps } from './capabilities.mjs';
import { SelectorError } from './errors.mjs';

/** Extract a balanced JSON object containing a "selected" key from model text. */
export function extractSelectionJson(text) {
  const source = String(text ?? '');
  const candidates = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      if (depth > 0) depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = source.slice(start, i + 1);
        if (/"selected"\s*:/.test(candidate)) candidates.push(candidate);
        start = -1;
      }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(candidates[i]);
    } catch {
      // try the previous balanced object
    }
  }
  return null;
}

/**
 * Validate a semantic-selector response. Selection is only a recommendation:
 * the sanitised output contains IDs, short reasons and confidence, never paths,
 * commands, scripts or new skill bodies supplied by the model.
 */
export function validateSelection(raw, { candidates, maxSelection = 3, catalog, label = 'semantic-callback' }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SelectorError('selector output must be a JSON object', { label });
  }
  const allowedTop = new Set(['selected', 'abstainReason', 'steps', 'notes', 'reasoning']);
  const ignoredKeys = Object.keys(raw).filter((key) => !allowedTop.has(key));
  const selectedRaw = raw.selected;
  if (!Array.isArray(selectedRaw)) {
    throw new SelectorError('selector output.selected must be an array', { label });
  }
  if (selectedRaw.length > maxSelection) {
    throw new SelectorError(`selector returned ${selectedRaw.length} skills; maxSelection is ${maxSelection}`, {
      label,
      maxSelection,
    });
  }
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const seen = new Set();
  const selected = [];
  const ignoredFields = [];
  for (const [index, entry] of selectedRaw.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new SelectorError(`selected[${index}] must be an object`, { label });
    }
    for (const key of Object.keys(entry)) {
      if (!['id', 'reason', 'confidence'].includes(key)) ignoredFields.push(`selected[${index}].${key}`);
    }
    if (typeof entry.id !== 'string' || !candidateIds.has(entry.id)) {
      throw new SelectorError(`selected[${index}] references an unknown candidate id`, {
        code: 'unknown_skill',
        id: entry.id,
        allowed: [...candidateIds],
        label,
      });
    }
    if (seen.has(entry.id)) throw new SelectorError(`duplicate selected id: ${entry.id}`, { label });
    seen.add(entry.id);
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      throw new SelectorError(`selected[${index}].reason must be a non-empty string`, { label });
    }
    if (entry.reason.length > 1000) throw new SelectorError(`selected[${index}].reason is too long`, { label });
    if (typeof entry.confidence !== 'number' || !Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1) {
      throw new SelectorError(`selected[${index}].confidence must be a number from 0 to 1`, { label });
    }
    const candidate = byId.get(entry.id);
    if (candidate.blocked) {
      throw new SelectorError(`selector chose a blocked skill: ${entry.id}`, {
        code: 'blocked_skill',
        id: entry.id,
        blockers: candidate.blockers,
        label,
      });
    }
    selected.push({ id: entry.id, reason: entry.reason.trim(), confidence: entry.confidence });
  }
  let abstainReason = null;
  if (raw.abstainReason !== undefined && raw.abstainReason !== null) {
    if (typeof raw.abstainReason !== 'string' || raw.abstainReason.trim() === '') {
      throw new SelectorError('abstainReason must be a non-empty string or null', { label });
    }
    if (raw.abstainReason.length > 1000) throw new SelectorError('abstainReason is too long', { label });
    abstainReason = raw.abstainReason.trim();
  }
  if (selected.length === 0 && !abstainReason) {
    throw new SelectorError('selector returned no selection and no abstainReason', { label });
  }
  if (selected.length > 0 && abstainReason) {
    throw new SelectorError('selector cannot both select skills and abstain', { label });
  }
  let steps = [];
  if (raw.steps !== undefined) {
    if (!Array.isArray(raw.steps)) throw new SelectorError('selector output.steps must be an array', { label });
    const normalized = validateSteps(raw.steps, selected.map((item) => item.id), catalog);
    steps = normalized.steps;
  }
  return {
    label,
    selected,
    abstainReason,
    steps,
    ignoredKeys: [...new Set(ignoredKeys)],
    ignoredFields: [...new Set(ignoredFields)],
    sanitized: true,
  };
}

/** Convert lexical ranking into the same recommendation shape as a semantic selector. */
export function lexicalRecommendation(ranking) {
  if (ranking.abstainReason || ranking.candidates.length === 0) {
    return {
      label: 'lexical',
      selected: [],
      abstainReason: ranking.abstainReason || 'no candidate skills in catalog',
      steps: [],
      ignoredKeys: [],
      ignoredFields: [],
      ambiguous: ranking.ambiguous,
      ambiguity: ranking.ambiguity,
    };
  }
  const eligible = ranking.candidates.filter((candidate) => !candidate.blocked);
  if (eligible.length === 0) {
    return {
      label: 'lexical',
      selected: [],
      abstainReason: 'all lexical candidates are blocked by missing capabilities',
      steps: [],
      ignoredKeys: [],
      ignoredFields: [],
      ambiguous: false,
      ambiguity: null,
    };
  }
  const top = eligible[0];
  return {
    label: 'lexical',
    selected: [
      {
        id: top.id,
        reason: `lexical recommendation: ${top.reasons.join('; ') || 'metadata match'}`,
        confidence: top.confidence,
      },
    ],
    abstainReason: null,
    steps: [],
    ignoredKeys: [],
    ignoredFields: [],
    ambiguous: ranking.ambiguous,
    ambiguity: ranking.ambiguity,
  };
}
