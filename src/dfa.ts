/******************************************************************************
 * Copyright 2022 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import map from "lodash-es/map.js"
import { Rule } from "chevrotain"
import { ATNState, DecisionState } from "./atn.js"

export interface DFA {
  start?: DFAState
  states: Record<string, DFAState>
  decision: number
  atnStartState: DecisionState
  // If set, configs which leave the rule of the decision continue at the call sites of that rule
  callers?: Map<Rule, ATNState[]>
}

export interface DFAState {
  configs: ATNConfigSet
  edges: Record<number, DFAState>
  isAcceptState: boolean
  prediction: number
}

export const DFA_ERROR = {} as DFAState

export interface ATNConfig {
  state: ATNState
  alt: number
  stack: ATNState[]
}

export class ATNConfigSet {
  private map: Record<string, number> = {}
  private configs: ATNConfig[] = []

  uniqueAlt: number | undefined

  get size(): number {
    return this.configs.length
  }

  finalize(): void {
    // Empties the map to free up memory
    this.map = {}
  }

  add(config: ATNConfig): void {
    const key = getATNConfigKey(config)
    // Only add configs which don't exist in our map already
    // While this does not influence the actual algorithm, adding them anyway would massively increase memory consumption
    if (!(key in this.map)) {
      this.map[key] = this.configs.length
      this.configs.push(config)
    }
  }

  get elements(): readonly ATNConfig[] {
    return this.configs
  }

  get alts(): number[] {
    // Multiple configs can belong to the same alternative
    return Array.from(new Set(map(this.configs, (e) => e.alt))).sort((a, b) => a - b)
  }

  // FNV-1a hash over all config keys.
  // Collisions are resolved in `addDFAState` using `equals`
  get key(): string {
    let hash = 0x811c9dc5
    for (const k in this.map) {
      for (let i = 0; i < k.length; i++) {
        hash = Math.imul(hash ^ k.charCodeAt(i), 0x01000193)
      }
    }
    return (hash >>> 0).toString(36)
  }

  equals(other: ATNConfigSet): boolean {
    if (this.configs.length !== other.configs.length) {
      return false
    }
    for (let i = 0; i < this.configs.length; i++) {
      const a = this.configs[i]
      const b = other.configs[i]
      if (a.alt !== b.alt || a.state.stateNumber !== b.state.stateNumber || a.stack.length !== b.stack.length) {
        return false
      }
      for (let j = 0; j < a.stack.length; j++) {
        if (a.stack[j].stateNumber !== b.stack[j].stateNumber) {
          return false
        }
      }
    }
    return true
  }
}

export function getATNConfigKey(config: ATNConfig, alt = true) {
  return `${alt ? `a${config.alt}` : ""}s${
    config.state.stateNumber
  }:${config.stack.map((e) => e.stateNumber.toString()).join("_")}`
}
