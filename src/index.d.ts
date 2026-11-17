export type AssistanceProfile = 'manual' | 'conservative' | 'balanced' | 'proactive' | 'custom';

export type TriggerEvent =
  | 'new_task'
  | 'routine_continuation'
  | 'phase_change'
  | 'material_family_change'
  | 'requirements_change'
  | 'repeated_failure'
  | 'delivery'
  | 'manual_request';

export interface AssistanceSettings {
  enabled: boolean;
  profile: AssistanceProfile;
  triggers: {
    newTask: boolean;
    ambiguousNewTask: boolean;
    phaseChange: boolean;
    materialFamilyChange: boolean;
    requirementsChange: boolean;
    repeatedFailure: boolean;
    delivery: boolean;
    smallTalkSkip: boolean;
    simpleTaskSkip: boolean;
    failureThreshold: number;
    deliveryRecheck: boolean;
  };
  budget: { maxAutomaticChecksPerTask: number };
  state: { maxTasks: number };
}

export interface TriggerExplanation {
  schema: 'skill-conductor/trigger/v0.1';
  at: string;
  action: 'trigger' | 'suppress' | 'reuse' | 'pending' | 'disabled';
  event: TriggerEvent;
  reasonCode: string;
  explanation: string;
  profile: AssistanceProfile;
  automatic: boolean;
  taskId?: string | null;
  sessionId?: string | null;
  counters?: Record<string, number> | null;
  budget?: { used: number; limit: number; exhausted: boolean } | null;
  [key: string]: unknown;
}

export interface HostActivity {
  /** Host-provided hint that a specialized skill is justified. Not observed telemetry. */
  needsSkill?: boolean;
  manualRequest?: boolean;
  materialFamily?: string;
  materialFamilies?: string[];
  requirementsKey?: string;
  errorFingerprint?: string;
  errorCount?: number;
  hint?: string;
  phase?: string;
  [key: string]: unknown;
}

export interface Candidate {
  id: string;
  name: string | null;
  description: string;
  score: number;
  confidence: number;
  reasons: string[];
  blocked: boolean;
  blockers: string[];
  recommended: boolean;
  sha256: string;
  sidecarSha256: string | null;
  [key: string]: unknown;
}

export interface PendingChoice {
  runId: string;
  status: string;
  mode: 'ask' | 'auto';
  task: string;
  selector: Record<string, unknown>;
  candidates: Candidate[];
  recommendation: {
    selected: Array<{ id: string; reason: string; confidence: number }>;
    abstainReason: string | null;
    steps: unknown[];
  };
  plan: Record<string, unknown>;
  options: { single: boolean; multiple: boolean; skip: boolean; maxSelection: number };
  planHash: string;
  instruction: string;
}

export interface RunRecord {
  schema: string;
  runId: string;
  createdAt: string;
  updatedAt: string;
  mode: 'ask' | 'auto';
  status: string;
  task: string;
  phase: string | null;
  taskId?: string | null;
  sessionId?: string | null;
  taskKey?: string | null;
  adaptive?: {
    trigger: TriggerExplanation;
    fingerprint?: string | null;
    phase?: string | null;
    materialFamilies?: string[];
    requirementKey?: string | null;
    catalogSignature?: string | null;
    automatic?: boolean;
  } | null;
  sourceRunId?: string | null;
  reused?: boolean;
  executedForThisEvent?: boolean;
  context?: Record<string, unknown> | null;
  instruction?: string;
  candidates: Candidate[];
  recommendation: PendingChoice['recommendation'];
  states: Record<string, boolean | string>;
  decision: null | {
    chosenIds: string[];
    skip: boolean;
    decidedBy: string;
    decidedAt: string;
    decisionHash: string;
    planHash: string;
  };
  activation: null | Record<string, unknown>;
  execution: null | Record<string, unknown>;
  verification: null | Record<string, unknown>;
  [key: string]: unknown;
}

export interface ConductorConfig {
  baseDir: string;
  configPath: string | null;
  roots: Array<{ path: string; namespace: string; trusted: boolean; includeHidden: boolean }>;
  selector: {
    mode: 'lexical' | 'http' | 'opencode';
    maxCandidates: number;
    minScore: number;
    ambiguityGap: number;
    semanticAllThreshold: number;
    semanticPrefilterLimit: number;
    maxSelection: number;
    timeoutMs: number;
    baseURL: string | null;
    model: string | null;
    apiKeyEnv: string;
  };
  policy: { mode: 'ask' | 'auto' };
  capabilities: string[];
  assistance: AssistanceSettings;
  execution: {
    enabled: boolean;
    allowlist: string[];
    trustedSkillIds: string[];
    timeoutMs: number;
    maxOutputBytes: number;
    maxArtifacts: number;
    maxResourceBytes: number;
    stopOnError: boolean;
    captureOutput: boolean;
    runDir: string;
  };
  materials: {
    maxFileBytes: number;
    maxTotalBytes: number;
    maxFiles: number;
    allowRoots: string[];
  };
  mcp: { allowExecution: boolean; maxInputBytes: number };
  fingerprint: string;
  warnings: string[];
  [key: string]: unknown;
}

export type SelectorCallback = (input: {
  task: string;
  phase: string | null;
  materials: unknown;
  candidates: Candidate[];
  catalogHash: string;
}) => Promise<unknown> | unknown;

export type HostExecutor = (input: {
  runId: string;
  task: string;
  phase: string | null;
  skill: { id: string; name: string; body: string; baseDir: string };
  context: Record<string, unknown>;
  step: { id: string; skillId: string; dependsOn: string[] };
  artifactDir: string;
}) => Promise<unknown> | unknown;

export type Verifier = (input: {
  runId: string;
  task: string;
  phase: string | null;
  artifacts: unknown[];
  execution: unknown;
  context: unknown;
}) => Promise<{ verified: boolean; details?: unknown }> | { verified: boolean; details?: unknown };

export function loadConfig(configPath: string, options?: { cwd?: string }): Promise<ConductorConfig>;
export function discoverConfigPath(startDir?: string): Promise<string | null>;
export function normalizeConfig(raw: unknown, options?: { baseDir?: string; configPath?: string | null }): Promise<ConductorConfig>;
export function discoverCatalog(config: ConductorConfig): Promise<Record<string, unknown>>;
export function listSkills(input: { config: ConductorConfig }): Promise<Record<string, unknown>>;

export function prepareTask(input: {
  config: ConductorConfig;
  task: string;
  files?: string[];
  phase?: string | null;
  observations?: string[];
  mode?: 'ask' | 'auto' | null;
  intent?: 'run' | 'route';
  selector?: SelectorCallback | null;
  executor?: HostExecutor | null;
  verifier?: Verifier | null;
  cwd?: string;
  /** Stable host task identity. Without it, documented v0.1 one-shot behavior is preserved. */
  taskId?: string | null;
  sessionId?: string | null;
  event?: TriggerEvent | null;
  /** Host event signals only; no agent-observation telemetry is invented. */
  activity?: HostActivity | null;
}): Promise<{ run: RunRecord; pendingChoice: PendingChoice | null; trigger: TriggerExplanation }>;

export function chooseRun(input: {
  config: ConductorConfig;
  runId: string;
  skills?: string[];
  skip?: boolean;
  decidedBy?: string;
  decisionToken?: string | null;
  intent?: 'run' | 'route';
  executor?: HostExecutor | null;
  verifier?: Verifier | null;
}): Promise<RunRecord>;

export function resumeRun(input: {
  config: ConductorConfig;
  runId: string;
  executor?: HostExecutor | null;
  verifier?: Verifier | null;
  executeAllowed?: boolean;
  claimedBy?: string;
}): Promise<RunRecord>;

export function verifyRun(input: {
  config: ConductorConfig;
  runId: string;
  verified: boolean;
  details?: unknown;
  source?: string;
}): Promise<RunRecord>;

export function getRun(input: { config: ConductorConfig; runId: string }): Promise<RunRecord>;
export function listRuns(input: { config: ConductorConfig }): Promise<Array<Record<string, unknown>>>;
export function loadRunContext(input: { config: ConductorConfig; runId: string }): Promise<Record<string, unknown>>;

export function startMcpServer(input: { config: ConductorConfig }): Promise<void>;

export const ASSISTANCE_PROFILES: readonly AssistanceProfile[];
export const TRIGGER_EVENTS: readonly TriggerEvent[];
export function normalizeAssistance(raw?: unknown): AssistanceSettings;
export function assistanceExplanation(
  assistance?: AssistanceSettings,
): Record<string, unknown>;
export function classifyTask(
  task: string,
  files?: string[],
): { kind: 'empty' | 'smalltalk' | 'simple' | 'specialized' | 'ambiguous'; evidence: string[] };
export function classifyFileFamilies(files?: string[]): string[];
export function catalogSignature(config: ConductorConfig): Promise<string>;
export function loadTaskSession(input: {
  config: ConductorConfig;
  taskId: string;
  sessionId?: string | null;
}): Promise<Record<string, unknown>>;
export function saveTaskSession(input: {
  config: ConductorConfig;
  session: Record<string, unknown>;
}): Promise<Record<string, unknown>>;
export function evaluateAdaptiveTrigger(input: {
  config: ConductorConfig;
  taskId?: string | null;
  sessionId?: string | null;
  task: string;
  files?: string[];
  phase?: string | null;
  event?: TriggerEvent | null;
  activity?: HostActivity | null;
}): Promise<{ action: string; trigger: TriggerExplanation; session: Record<string, unknown> | null }>;
