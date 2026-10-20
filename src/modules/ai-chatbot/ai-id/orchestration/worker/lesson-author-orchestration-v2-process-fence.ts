export interface OrchestrationV2ProcessFenceInput {
  node_env?: string;
  exec_argv?: readonly string[];
  argv?: readonly string[];
}

function isTypescriptRuntimeArgument(value: string): boolean {
  const normalized = value.replaceAll('\\', '/').toLowerCase();
  return normalized.endsWith('.ts')
    || normalized.endsWith('.tsx')
    || normalized.includes('/tsx/dist/')
    || normalized.includes('/tsx/cli');
}

/**
 * Production V2 consumers must run the compiled artifact managed by PM2.
 * This prevents an old local TSX process from silently competing for the
 * production Rabbit queue after a deployment or terminal restart.
 */
export function assertOrchestrationV2ProductionProcessFence(
  input: OrchestrationV2ProcessFenceInput = {},
): void {
  const nodeEnv = input.node_env ?? process.env.NODE_ENV;
  if (nodeEnv !== 'production') return;

  const runtimeArguments = [
    ...(input.exec_argv ?? process.execArgv),
    ...(input.argv ?? process.argv),
  ];
  if (!runtimeArguments.some(isTypescriptRuntimeArgument)) return;

  throw new Error('LESSON_AUTHOR_ORCHESTRATION_V2_PRODUCTION_SOURCE_RUNTIME_FORBIDDEN');
}
