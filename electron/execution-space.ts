import { AsyncLocalStorage } from "node:async_hooks";
import type { SpaceKind } from "../shared/enterprise.js";

export interface ExecutionContext { silent?: boolean; pluginCompany?: unknown; space: SpaceKind; workspace?: string; account?: string; storage?: {kind:"nas"|"local";url?:string} }
const context = new AsyncLocalStorage<ExecutionContext>();
let selected: () => SpaceKind = () => "personal";
let details: () => Omit<ExecutionContext, "space"> = () => ({});
export function setSelectedSpaceResolver(resolve: () => SpaceKind) { selected = resolve; }
export function setExecutionDetailsResolver(resolve: typeof details) { details = resolve; }
export function executionContext(): ExecutionContext { return context.getStore() ?? {space: selected(), ...details()}; }
export function executionSpace() { return executionContext().space; }
/** Capture the task's space before asynchronous work starts. */
export function inExecutionSpace<T>(work: () => T, space?: SpaceKind): T {
  const current = executionContext();
  return context.run({...current, space: space ?? current.space}, work);
}

/** Explicit trusted main-process scope, independent from selected renderer account. */
export function storedExecutionContext() { return context.getStore(); }
export function inExecutionContext<T>(value: ExecutionContext, work: () => T): T { return context.run(value, work); }
