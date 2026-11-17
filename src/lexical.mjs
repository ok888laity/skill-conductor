import { clamp } from './util.mjs';

const ASCII_STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'i', 'in', 'is', 'it',
  'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'we', 'with', 'you', 'your', 'please',
  'use', 'using', 'can', 'do', 'does', 'my', 'me', 'our', 'skill', 'skills',
]);

const CJK_STOP_BIGRAMS = new Set(['一个', '一下', '这个', '那个', '可以', '需要', '帮我', '请帮', '我的', '我们']);

export function tokenize(value) {
  const text = String(value ?? '').normalize('NFKC').toLowerCase();
  const tokens = [];
  const asciiPattern = /[a-z0-9][a-z0-9_+#.-]*/g;
  let match;
  while ((match = asciiPattern.exec(text)) !== null) {
    const word = match[0].replace(/[._-]+$/, '');
    if (!word || ASCII_STOP.has(word)) continue;
    tokens.push(word);
    if (/[-_]/.test(word) && word.length > 4) {
      for (const part of word.split(/[-_]+/)) {
        if (part.length > 1 && !ASCII_STOP.has(part)) tokens.push(part);
      }
    }
  }
  const cjkPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
  while ((match = cjkPattern.exec(text)) !== null) {
    const run = match[0];
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      const bigram = run.slice(i, i + 2);
      if (!CJK_STOP_BIGRAMS.has(bigram)) tokens.push(bigram);
    }
    if (run.length <= 8) tokens.push(run);
  }
  return tokens;
}

export function normalizedPhrase(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function countTokens(text) {
  const counts = new Map();
  for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function addField(doc, field, text, weight) {
  const counts = countTokens(text);
  doc.length += [...counts.values()].reduce((sum, count) => sum + count, 0) * weight;
  for (const [token, count] of counts) {
    doc.terms.set(token, (doc.terms.get(token) ?? 0) + count * weight);
    if (!doc.fields.has(token)) doc.fields.set(token, new Set());
    doc.fields.get(token).add(field);
  }
}

function buildDocument(skill) {
  const doc = { terms: new Map(), fields: new Map(), length: 0 };
  addField(doc, 'name', skill.name ?? '', 4);
  addField(doc, 'id', skill.id, 1);
  addField(doc, 'tags', skill.tags.join(' '), 2.5);
  addField(doc, 'triggers', skill.triggers.join(' '), 3);
  addField(doc, 'description', skill.description, 1);
  addField(doc, 'whenToUse', skill.whenToUse ?? '', 1.5);
  return doc;
}

function phraseInQuery(queryNorm, phrase) {
  const norm = normalizedPhrase(phrase);
  if (norm.length < 2) return false;
  if (queryNorm.includes(norm)) return true;
  if (norm.length <= 2) return false;
  const tokens = tokenize(phrase);
  if (tokens.length === 0) return false;
  const queryTokens = new Set(tokenize(queryNorm));
  return tokens.every((token) => queryTokens.has(token));
}

/**
 * Lexical BM25-like ranking over discovery metadata only. This is explicitly
 * lexical; multilingual character bigrams support Chinese without pretending
 * to be a semantic model.
 */
export function rankLexical({
  skills,
  query,
  hostCapabilities = [],
  minScore = 0.8,
  maxCandidates = 20,
  ambiguityGap = 0.12,
  smallCatalogAll = false,
  smallCatalogLimit = 40,
}) {
  const queryTokens = [...new Set(tokenize(query))];
  const queryNorm = normalizedPhrase(query);
  const valid = skills.filter((skill) => skill.valid && skill.name);
  const docs = new Map(valid.map((skill) => [skill.id, buildDocument(skill)]));
  const lengths = [...docs.values()].map((doc) => Math.max(doc.length, 1));
  const avgLength = lengths.reduce((sum, value) => sum + value, 0) / Math.max(lengths.length, 1);
  const documentFrequency = new Map();
  for (const token of queryTokens) {
    let count = 0;
    for (const doc of docs.values()) if (doc.terms.has(token)) count += 1;
    documentFrequency.set(token, count);
  }
  const N = valid.length;
  const k1 = 1.2;
  const b = 0.75;
  const capabilities = new Set(hostCapabilities);
  const scored = [];
  const suppressed = [];

  for (const skill of valid) {
    const doc = docs.get(skill.id);
    const matchedTerms = new Set();
    const matchedFields = new Set();
    let score = 0;
    for (const token of queryTokens) {
      const tf = doc.terms.get(token);
      if (!tf) continue;
      const df = documentFrequency.get(token) ?? 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / Math.max(avgLength, 1))));
      matchedTerms.add(token);
      for (const field of doc.fields.get(token) ?? []) matchedFields.add(field);
    }
    const nameNorm = normalizedPhrase(skill.name ?? '');
    if (nameNorm.length >= 3 && queryNorm.includes(nameNorm)) {
      score += 2;
      matchedFields.add('name-phrase');
    }
    let triggerPhrase = null;
    for (const trigger of skill.triggers) {
      if (phraseInQuery(queryNorm, trigger)) {
        score += 1.5;
        triggerPhrase = trigger;
        matchedFields.add('trigger-phrase');
        break;
      }
    }
    const avoidHits = skill.avoidTriggers.filter((trigger) => phraseInQuery(queryNorm, trigger));
    const missingCapabilities = skill.requiredCapabilities.filter((capability) => !capabilities.has(capability));
    if (avoidHits.length > 0) {
      suppressed.push({ id: skill.id, name: skill.name, avoidHits });
      continue;
    }
    const reasons = [];
    if (matchedFields.size > 0) {
      reasons.push(`lexical match in ${[...matchedFields].sort().join(', ')}`);
    }
    if (triggerPhrase) reasons.push(`trigger phrase: ${triggerPhrase}`);
    if (matchedTerms.size > 0 && reasons.length < 3) {
      reasons.push(`tokens: ${[...matchedTerms].slice(0, 8).join(', ')}`);
    }
    if (avoidHits.length > 0) reasons.push(`avoid trigger: ${avoidHits.join(', ')}`);
    if (score <= 0) continue;
    scored.push({
      skill,
      score,
      matchedFields: [...matchedFields].sort(),
      matchedTerms: [...matchedTerms].sort(),
      reasons,
      blocked: missingCapabilities.length > 0,
      blockers: missingCapabilities.map((capability) => `missing capability: ${capability}`),
      missingCapabilities,
    });
  }

  scored.sort((a, b2) => b2.score - a.score || a.skill.id.localeCompare(b2.skill.id));
  const topScore = scored[0]?.score ?? 0;
  let considered = scored;
  const offerAll = smallCatalogAll && valid.length <= smallCatalogLimit;
  if (offerAll) {
    const known = new Set(scored.map((item) => item.skill.id));
    for (const skill of valid) {
      if (known.has(skill.id)) continue;
      const missingCapabilities = skill.requiredCapabilities.filter((capability) => !capabilities.has(capability));
      scored.push({
        skill,
        score: 0,
        matchedFields: [],
        matchedTerms: [],
        reasons: ['offered because the catalog is small; lexical score is zero'],
        blocked: missingCapabilities.length > 0,
        blockers: missingCapabilities.map((capability) => `missing capability: ${capability}`),
        missingCapabilities,
      });
    }
    considered = scored;
  }
  // A small-catalog roster must really reach the semantic selector in full:
  // "offerAll" cannot still be clipped by the default lexical maxCandidates.
  const candidateLimit = offerAll ? Math.max(maxCandidates, considered.length) : maxCandidates;
  const candidates = considered.slice(0, candidateLimit).map((item) => ({
    id: item.skill.id,
    name: item.skill.name,
    description: item.skill.description,
    tags: item.skill.tags,
    triggers: item.skill.triggers,
    avoidTriggers: item.skill.avoidTriggers,
    whenToUse: item.skill.whenToUse,
    score: Number(item.score.toFixed(4)),
    confidence: Number(clamp(item.score / (item.score + 3), 0, 0.99).toFixed(4)),
    matchedFields: item.matchedFields,
    matchedTokens: item.matchedTerms.slice(0, 12),
    reasons: item.reasons,
    blocked: item.blocked,
    blockers: item.blockers,
    missingCapabilities: item.missingCapabilities,
    requiredCapabilities: item.skill.requiredCapabilities,
    dependencies: item.skill.dependencies,
    conflicts: item.skill.conflicts,
    resources: item.skill.resources,
    executable: item.skill.executable ? { name: item.skill.executable.name } : null,
    rootTrusted: item.skill.rootTrusted,
    sha256: item.skill.sha256,
    sidecarSha256: item.skill.sidecarSha256,
    ambiguousName: item.skill.ambiguousName,
    offeredBecause: offerAll && item.score === 0 ? 'small-catalog' : 'lexical-evidence',
  }));

  let abstainReason = null;
  if (!offerAll && topScore < minScore) {
    abstainReason = `no lexical evidence above minScore ${minScore} (labels: lexical, not semantic)`;
  }
  const eligible = scored.filter((item) => !item.blocked && item.score > 0);
  let ambiguous = false;
  let ambiguity = null;
  if (!abstainReason && eligible.length > 1) {
    const first = eligible[0];
    const second = eligible[1];
    const relativeGap = (first.score - second.score) / Math.max(first.score, 0.0001);
    if (relativeGap <= ambiguityGap) {
      ambiguous = true;
      ambiguity = {
        ids: [first.skill.id, second.skill.id],
        scores: [Number(first.score.toFixed(4)), Number(second.score.toFixed(4))],
        relativeGap: Number(relativeGap.toFixed(4)),
        note: 'close lexical scores; explicit choice is safer than guessing',
      };
    }
  }
  return {
    mode: 'lexical',
    label: 'lexical',
    semantic: false,
    queryTokens,
    topScore: Number(topScore.toFixed(4)),
    candidates,
    suppressed,
    abstainReason,
    ambiguous,
    ambiguity,
    offeredAll: offerAll,
    diagnostics: {
      catalogSize: valid.length,
      scored: scored.length,
      candidateCount: candidates.length,
      note: 'Lexical BM25-like metadata matching; this is not semantic understanding.',
    },
  };
}
