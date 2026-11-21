/**
 * Testing a machines hook (ADR 0347): `@catamorphic/work-server/testing`.
 * The contract kit runs a hook against a simulated Work with a fake clock;
 * `SimulatedWork` is that simulation, for a host's own scenarios.
 */
export {
  type ContractFacts,
  checkMachineProvisioner,
  checkMachinesHook,
  type MachineProvisioner,
  MachinesContractError,
  MemoryCloud,
  type MemoryCloudMachine,
  machinesHook,
  type PlatformProbe,
} from "./machines/contract-kit.js";
export {
  quietSummary,
  type SimulatedCall,
  SimulatedWork,
  type SimulatedWorkOptions,
} from "./machines/simulation.js";
