import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig } from '../src/config.mjs';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const tmpRoot = path.join(projectRoot, '.tmp-tests');

export async function makeTempDir(t, label = 'case') {
  const dir = path.join(tmpRoot, `${label}-${crypto.randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  t.after(async () => {
    const abs = path.resolve(dir);
    if (abs.startsWith(path.resolve(tmpRoot) + path.sep)) await fs.rm(abs, { recursive: true, force: true });
  });
  return dir;
}

export async function writeSkill(dir, {
  name,
  description = `${name} fixture description`,
  triggers = [name],
  tags = [],
  dependencies = [],
  conflicts = [],
  requiredCapabilities = [],
  script = null,
  scriptName = 'run.mjs',
  resources = [],
} = {}) {
  const skillDir = path.join(dir, 'skills', name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    skillDir + path.sep + 'SKILL.md',
    `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\ntags: [${tags.join(', ')}]\n---\n\n# ${name}\n\nFixture instruction body for ${name}.\n`,
    'utf8',
  );
  const sidecar = {
    triggers,
    tags,
    ...(dependencies.length ? { dependencies } : {}),
    ...(conflicts.length ? { conflicts } : {}),
    ...(requiredCapabilities.length ? { requiredCapabilities } : {}),
    ...(resources.length ? { resources } : {}),
  };
  if (script !== null) {
    await fs.mkdir(path.join(skillDir, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(skillDir, 'scripts', scriptName), script, 'utf8');
    sidecar.executable = { name: `${name}-script`, entry: `scripts/${scriptName}`, runtime: 'node' };
  }
  await fs.writeFile(path.join(skillDir, 'conductor.json'), JSON.stringify(sidecar, null, 2), 'utf8');
  for (const resource of resources) {
    await fs.writeFile(path.join(skillDir, resource), `resource for ${name}: ${resource}\n`, 'utf8');
  }
  return skillDir;
}

export async function makeConfig(dir, {
  skills = [],
  auto = false,
  executionEnabled = true,
  trusted = null,
  allowlist = null,
  capabilities = ['filesystem.read', 'filesystem.write'],
  selector = { mode: 'lexical' },
  timeoutMs = 5000,
  mcpAllowExecution = false,
  stopOnError = true,
  assistance = null,
} = {}) {
  const ids = skills.map((skill) => `fixture:${skill}`);
  const raw = {
    roots: [{ path: path.join(dir, 'skills'), namespace: 'fixture', trusted: true }],
    includeHidden: false,
    selector,
    policy: { mode: auto ? 'auto' : 'ask' },
    capabilities,
    ...(assistance ? { assistance } : {}),
    execution: {
      enabled: executionEnabled,
      allowlist: allowlist ?? ids,
      trustedSkillIds: trusted ?? ids,
      timeoutMs,
      maxOutputBytes: 65536,
      maxArtifacts: 20,
      maxResourceBytes: 262144,
      stopOnError,
      captureOutput: true,
      runDir: path.join(dir, 'runs'),
    },
    materials: {
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 4 * 1024 * 1024,
      maxFiles: 16,
      allowRoots: [dir],
    },
    mcp: { allowExecution: mcpAllowExecution, maxInputBytes: 1024 * 1024 },
  };
  const config = await normalizeConfig(raw, { baseDir: dir });
  return { config, raw };
}

export async function writeConfigFile(dir, raw) {
  const file = path.join(dir, 'config.json');
  await fs.writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return file;
}

export function firstEligible(candidates) {
  return candidates.find((candidate) => !candidate.blocked) ?? candidates[0];
}
