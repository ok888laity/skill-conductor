import { SelectorError } from './errors.mjs';

/** Resolve a dependency/conflict reference by exact ID first, then unique name. */
export function resolveReference(catalog, reference) {
  if (catalog.byId.has(reference)) return catalog.byId.get(reference);
  const matches = catalog.skills.filter((skill) => skill.name === reference);
  if (matches.length === 1) return matches[0];
  return null;
}

export function capabilityBlockers(skill, hostCapabilities) {
  const caps = new Set(hostCapabilities);
  return skill.requiredCapabilities.filter((capability) => !caps.has(capability));
}

function topoSort(steps) {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const indegree = new Map(steps.map((step) => [step.id, 0]));
  const dependents = new Map(steps.map((step) => [step.id, []]));
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!byId.has(dependency)) continue;
      indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
      dependents.get(dependency).push(step.id);
    }
  }
  const queue = steps.filter((step) => (indegree.get(step.id) ?? 0) === 0).map((step) => step.id);
  const order = [];
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(byId.get(id));
    for (const next of dependents.get(id) ?? []) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== steps.length) {
    const cyclic = steps.filter((step) => !order.some((ordered) => ordered.id === step.id)).map((step) => step.id);
    throw new SelectorError(`selected steps contain a dependency cycle: ${cyclic.join(', ')}`, {
      code: 'cyclic_steps',
      stepIds: cyclic,
    });
  }
  return order;
}

export { topoSort as topologyOrder };

export function buildSteps(selectedSkills, catalog) {
  const stepBySkill = new Map();
  selectedSkills.forEach((skill, index) => {
    stepBySkill.set(skill.id, { id: `s${index + 1}`, skillId: skill.id, dependsOn: [], source: 'sidecar' });
  });
  const missingDependencies = [];
  const unresolvedDependencies = [];
  for (const skill of selectedSkills) {
    for (const reference of skill.dependencies) {
      const dependency = resolveReference(catalog, reference);
      if (!dependency) {
        unresolvedDependencies.push({ skillId: skill.id, reference });
        continue;
      }
      if (!stepBySkill.has(dependency.id)) {
        missingDependencies.push({ skillId: skill.id, dependencyId: dependency.id, reference });
        continue;
      }
      const step = stepBySkill.get(skill.id);
      const depStep = stepBySkill.get(dependency.id);
      if (!step.dependsOn.includes(depStep.id)) step.dependsOn.push(depStep.id);
    }
  }
  const steps = [...stepBySkill.values()];
  let ordered = steps;
  let cycleError = null;
  try {
    ordered = topoSort(steps);
  } catch (error) {
    cycleError = error;
  }
  return { steps, ordered, missingDependencies, unresolvedDependencies, cycleError };
}

export function validateSteps(steps, selectedIds, catalog) {
  if (!Array.isArray(steps)) throw new SelectorError('steps must be an array');
  if (steps.length > 50) throw new SelectorError('too many steps (max 50)');
  const seen = new Set();
  const normalized = [];
  for (const [index, raw] of steps.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new SelectorError(`steps[${index}] must be an object`);
    }
    const id = raw.id === undefined ? `s${index + 1}` : raw.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(id)) {
      throw new SelectorError(`steps[${index}].id must be a simple identifier`);
    }
    if (seen.has(id)) throw new SelectorError(`duplicate step id: ${id}`);
    seen.add(id);
    if (typeof raw.skillId !== 'string' || !selectedIds.includes(raw.skillId)) {
      throw new SelectorError(`steps[${index}].skillId must reference a selected candidate`, {
        code: 'unknown_step_skill',
        skillId: raw.skillId,
      });
    }
    const dependsOn = raw.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((dep) => typeof dep !== 'string')) {
      throw new SelectorError(`steps[${index}].dependsOn must be an array of step IDs`);
    }
    normalized.push({ id, skillId: raw.skillId, dependsOn: [...new Set(dependsOn)], source: 'selector' });
  }
  const ids = new Set(normalized.map((step) => step.id));
  for (const step of normalized) {
    for (const dep of step.dependsOn) {
      if (!ids.has(dep)) {
        throw new SelectorError(`step ${step.id} depends on missing step ${dep}`, {
          code: 'missing_step_dependency',
        });
      }
      if (dep === step.id) throw new SelectorError(`step ${step.id} depends on itself`, { code: 'cyclic_steps' });
    }
  }
  const covered = new Set(normalized.map((step) => step.skillId));
  for (const id of selectedIds) {
    if (!covered.has(id)) {
      const skill = catalog.byId.get(id);
      normalized.push({
        id: `auto-${normalized.length + 1}`,
        skillId: id,
        dependsOn: [],
        source: 'derived',
      });
    }
  }
  const ordered = topoSort(normalized);
  return { steps: normalized, ordered };
}

/**
 * Validate selected skills, sidecar dependencies/conflicts, host capabilities and
 * the selector-provided DAG. Missing capability is a visible blocker, not a
 * prompt to invent tools that a host does not have.
 */
export function analyzePlan({ catalog, selectedIds, steps, hostCapabilities }) {
  const selected = selectedIds.map((id) => catalog.byId.get(id)).filter(Boolean);
  if (selected.length !== selectedIds.length) {
    const unknown = selectedIds.filter((id) => !catalog.byId.has(id));
    throw new SelectorError(`selection references unknown skill ids: ${unknown.join(', ')}`, {
      code: 'unknown_skill',
      ids: unknown,
    });
  }
  const missingCapabilities = [];
  for (const skill of selected) {
    for (const capability of capabilityBlockers(skill, hostCapabilities)) {
      missingCapabilities.push({ skillId: skill.id, capability });
    }
  }
  const conflicts = [];
  for (let i = 0; i < selected.length; i += 1) {
    for (let j = i + 1; j < selected.length; j += 1) {
      const a = selected[i];
      const b = selected[j];
      const aConflicts = a.conflicts.some((ref) => {
        const resolved = resolveReference(catalog, ref);
        return resolved?.id === b.id;
      });
      const bConflicts = b.conflicts.some((ref) => {
        const resolved = resolveReference(catalog, ref);
        return resolved?.id === a.id;
      });
      if (aConflicts || bConflicts) conflicts.push({ a: a.id, b: b.id });
    }
  }
  let plan;
  if (Array.isArray(steps) && steps.length > 0) {
    plan = validateSteps(steps, selectedIds, catalog);
    const sidecar = buildSteps(selected, catalog);
    if (sidecar.cycleError) throw sidecar.cycleError;
    plan.missingDependencies = sidecar.missingDependencies;
    plan.unresolvedDependencies = sidecar.unresolvedDependencies;
    // Sidecar dependency edges are mandatory. Merge them into selector steps so
    // a selector cannot place a report before its data dependency or omit a
    // declared edge. Multiple steps for the same skill receive the same edges.
    for (const skill of selected) {
      for (const reference of skill.dependencies) {
        const dependency = resolveReference(catalog, reference);
        if (!dependency || !selectedIds.includes(dependency.id)) continue;
        const dependentSteps = plan.steps.filter((step) => step.skillId === skill.id);
        const dependencySteps = plan.steps.filter((step) => step.skillId === dependency.id);
        for (const dependent of dependentSteps) {
          for (const required of dependencySteps) {
            if (!dependent.dependsOn.includes(required.id)) dependent.dependsOn.push(required.id);
          }
        }
      }
    }
    plan.ordered = topoSort(plan.steps);
  } else {
    plan = buildSteps(selected, catalog);
    if (plan.cycleError) throw plan.cycleError;
  }
  if (plan.cycleError) throw plan.cycleError;
  const blockers = [
    ...missingCapabilities.map((item) => ({
      code: 'missing_capability',
      message: `${item.skillId} requires capability ${item.capability}`,
      ...item,
    })),
    ...(plan.missingDependencies ?? []).map((item) => ({
      code: 'missing_dependency',
      message: `${item.skillId} requires selected dependency ${item.dependencyId}`,
      ...item,
    })),
    ...(plan.unresolvedDependencies ?? []).map((item) => ({
      code: 'unresolved_dependency',
      message: `${item.skillId} dependency is not in the catalog: ${item.reference}`,
      ...item,
    })),
    ...conflicts.map((item) => ({
      code: 'conflict',
      message: `selected skills conflict: ${item.a} <-> ${item.b}`,
      ...item,
    })),
  ];
  return {
    ok: blockers.length === 0,
    selected: selected.map((skill) => skill.id),
    missingCapabilities,
    conflicts,
    missingDependencies: plan.missingDependencies ?? [],
    unresolvedDependencies: plan.unresolvedDependencies ?? [],
    steps: plan.steps ?? plan.ordered ?? [],
    orderedSteps: plan.ordered ?? [],
    blockers,
  };
}
