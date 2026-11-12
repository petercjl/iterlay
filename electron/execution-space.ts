import { AsyncLocalStorage } from "node:async_hooks";
import type { SpaceKind } from "../shared/enterprise.js";

const context = new AsyncLocalStorage<SpaceKind>();
let selected: () => SpaceKind = () => "personal";
export function setSelectedSpaceResolver(resolve: () => SpaceKind) { selected = resolve; }
export function executionSpace() { return context.getStore() ?? selected(); }
/** Capture the task's space before asynchronous work starts. */
export function inExecutionSpace<T>(work: () => T, space?: SpaceKind): T { return context.run(space ?? executionSpace(), work); }
