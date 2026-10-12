/******************************************************************************
 * Copyright 2026 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import { describe, expect, it } from "vitest"
import { ATNConfigSet } from "./dfa.js"
import { ATNState } from "./atn.js"

function state(stateNumber: number): ATNState {
  return { stateNumber } as ATNState
}

function configSet(stackDepth: number, configs: number): ATNConfigSet {
  const set = new ATNConfigSet()
  for (let i = 0; i < configs; i++) {
    const stack: ATNState[] = []
    for (let j = 0; j < stackDepth; j++) {
      stack.push(state(i * stackDepth + j))
    }
    set.add({ state: state(i), alt: i % 3, stack })
  }
  return set
}

describe("ATNConfigSet", () => {
  it("has a short key independent of the config set size (#8)", () => {
    const small = configSet(1, 1)
    const large = configSet(50, 1000)
    expect(large.key.length).toBeLessThan(16)
    expect(large.key).toBe(configSet(50, 1000).key)
    expect(large.key).not.toBe(small.key)
    expect(configSet(50, 999).key).not.toBe(large.key)
  })

  it("compares config sets by content", () => {
    expect(configSet(5, 10).equals(configSet(5, 10))).toBe(true)
    expect(configSet(5, 10).equals(configSet(5, 9))).toBe(false)
    expect(configSet(4, 10).equals(configSet(5, 10))).toBe(false)
  })
})
