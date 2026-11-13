/**
 * Extra environment for an agent group's containers, contributed by modules. A module registers a
 * contributor at import time; buildContainerArgs (container-runner.ts) asks every contributor about
 * the agent group it spawns and passes what they return as `-e` args. A module that is not
 * configured registers nothing, and a contributor that throws is logged and skipped.
 *
 * The hub module uses it to give NANOCLAW_HUB=1 only to the agent groups the hub serves. Host-runtime
 * agents do not go through here: they inherit the host process's environment.
 */
import { log } from './log.js';
import type { AgentGroup } from './types.js';

export type ContainerEnvContributor = (agentGroup: AgentGroup) => Record<string, string> | undefined;

const contributors: ContainerEnvContributor[] = [];

export function registerContainerEnv(contributor: ContainerEnvContributor): void {
  contributors.push(contributor);
}

/** Every contributor's variables for this agent group; a later contributor wins a clash. */
export function containerEnvFor(agentGroup: AgentGroup): Record<string, string> {
  const env: Record<string, string> = {};
  for (const contributor of contributors) {
    try {
      Object.assign(env, contributor(agentGroup) ?? {});
    } catch (err) {
      log.warn('container env contributor failed, skipped', { agentGroupId: agentGroup.id, err: String(err) });
    }
  }
  return env;
}
