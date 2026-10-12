/******************************************************************************
 * Copyright 2022 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import { createToken, EmbeddedActionsParser, EOF, IToken, TokenType } from "chevrotain"
import { LLStarLookaheadStrategy } from "./all-star-lookahead"
import { describe, expect, it } from "vitest"

describe("ATN Simulator", () => {

    describe("Outer context LL(1)", () => {
        const A = createToken({ name: "A", pattern: "a" })
        const B = createToken({ name: "B", pattern: "b" })
        const C = createToken({ name: "C", pattern: "c" })

        class UnboundedLookaheadParser extends EmbeddedActionsParser {
            constructor() {
                super([A, B, C], {
                    lookaheadStrategy: new LLStarLookaheadStrategy()
                })
                this.performSelfAnalysis()
            }

            Main = this.RULE("LongRule", () => {
                this.SUBRULE(this.Inner);
                this.CONSUME(B);
                this.CONSUME(A);
            });

            Inner = this.RULE("Inner", () => {
                this.CONSUME(A);
                this.OPTION(() => {
                    // Local lookahead will determine that this is LL(1)
                    // Outer context analysis will identify that it needs LL(*)
                    this.CONSUME(B);
                    this.CONSUME(C);
                });
            });


        }

        it("Should be able to take outer context into account", () => {
            const parser = new UnboundedLookaheadParser()
            parser.input = [
                createRegularToken(A),
                createRegularToken(B),
                createRegularToken(A)
            ]
            parser.Main()
            expect(parser.errors).toHaveLength(0);
        })

        it("Should still parse as expected if all tokens are present", () => {
            const parser = new UnboundedLookaheadParser()
            parser.input = [
                createRegularToken(A),
                createRegularToken(B),
                createRegularToken(C),
                createRegularToken(B),
                createRegularToken(A)
            ]
            parser.Main()
            expect(parser.errors).toHaveLength(0);
        })
    })

    describe("Outer context with erroneous input", () => {
        const Id = createToken({ name: "Id", pattern: "id" })
        const LParen = createToken({ name: "LParen", pattern: "(" })
        const RParen = createToken({ name: "RParen", pattern: ")" })
        const Comma = createToken({ name: "Comma", pattern: "," })
        const Plus = createToken({ name: "Plus", pattern: "+" })

        // Statements are not separated by a delimiter, so `(` and `+` can both
        // continue the current expression and start the next statement
        class CallParser extends EmbeddedActionsParser {
            statements = 0
            ambiguityReports: string[] = []

            constructor() {
                super([Id, LParen, RParen, Comma, Plus], {
                    lookaheadStrategy: new LLStarLookaheadStrategy({
                        logging: (message) => this.ambiguityReports.push(message)
                    })
                })
                this.performSelfAnalysis()
            }

            Program = this.RULE("Program", () => {
                this.MANY(() => {
                    this.ACTION(() => this.statements++)
                    this.SUBRULE(this.Additive)
                })
            })

            Additive = this.RULE("Additive", () => {
                this.SUBRULE(this.Prefix)
                this.MANY(() => {
                    this.CONSUME(Plus)
                    this.SUBRULE2(this.Prefix)
                })
            })

            Prefix = this.RULE("Prefix", () => {
                this.OPTION(() => this.CONSUME(Plus))
                this.SUBRULE(this.Call)
            })

            Call = this.RULE("Call", () => {
                this.SUBRULE(this.Primary)
                this.MANY(() => {
                    this.CONSUME(LParen)
                    this.MANY_SEP({
                        SEP: Comma,
                        DEF: () => this.SUBRULE(this.Additive)
                    })
                    this.CONSUME(RParen)
                })
            })

            Primary = this.RULE("Primary", () => {
                this.OR([
                    { ALT: () => this.CONSUME(Id) },
                    {
                        ALT: () => {
                            this.CONSUME(LParen)
                            this.SUBRULE(this.Additive)
                            this.CONSUME(RParen)
                        }
                    }
                ])
            })
        }

        function parse(...tokens: TokenType[]) {
            const parser = new CallParser()
            parser.input = tokens.map(e => createRegularToken(e))
            parser.Program()
            return {
                statements: parser.statements,
                errors: parser.errors.map(e => `${e.name} in ${e.context.ruleStack.at(-1)}`)
            }
        }

        it("Should parse valid input", () => {
            expect(parse(Id, LParen, Id, Comma, Id, RParen, LParen, RParen)).toEqual({ statements: 1, errors: [] })
            expect(parse(Id, Plus, Id, LParen, Id, RParen, Id)).toEqual({ statements: 2, errors: [] })
        })

        it("Should report every ambiguous alternative once", () => {
            const parser = new CallParser()
            // `id + id (id) id`: Multiple configs of each alternative are part of the conflict
            parser.input = [Id, Plus, Id, LParen, Id, RParen, Id].map(e => createRegularToken(e))
            parser.Program()
            expect(parser.ambiguityReports.length).toBeGreaterThan(0)
            for (const report of parser.ambiguityReports) {
                expect(report).toMatch("<0, 1> in <MANY>")
            }
        })

        it("Should enter an unclosed call", () => {
            expect(parse(Id, LParen)).toEqual({ statements: 1, errors: ["MismatchedTokenException in Call"] })
            expect(parse(Id, LParen, Id)).toEqual({ statements: 1, errors: ["MismatchedTokenException in Call"] })
            expect(parse(Id, LParen, Id, Comma)).toEqual({ statements: 1, errors: ["NoViableAltException in Primary"] })
        })

        it("Should enter an unclosed call followed by further statements", () => {
            expect(parse(Id, LParen, Id, Id, Plus, Id)).toEqual({ statements: 1, errors: ["MismatchedTokenException in Call"] })
        })

        it("Should enter an incomplete binary expression", () => {
            expect(parse(Id, Plus)).toEqual({ statements: 1, errors: ["NoViableAltException in Primary"] })
        })
    })

    describe("Follow conflict in mandatory repetition with separator", () => {
        const Id = createToken({ name: "Id", pattern: "id" })
        const Comma = createToken({ name: "Comma", pattern: "," })
        const Semi = createToken({ name: "Semi", pattern: ";" })

        // The comma both continues the list and starts the optional suffix,
        // so the loop's enter/exit decision conflicts with the outer context
        class ListParser extends EmbeddedActionsParser {
            items = 0

            constructor() {
                super([Id, Comma, Semi], {
                    lookaheadStrategy: new LLStarLookaheadStrategy({ logging: () => {} })
                })
                this.performSelfAnalysis()
            }

            Main = this.RULE("Main", () => {
                this.SUBRULE(this.List)
                this.OPTION(() => {
                    this.CONSUME(Comma)
                    this.CONSUME(Id)
                })
                this.CONSUME(Semi)
            })

            List = this.RULE("List", () => {
                this.AT_LEAST_ONE_SEP({
                    SEP: Comma,
                    DEF: () => {
                        this.ACTION(() => this.items++)
                        this.CONSUME(Id)
                    }
                })
            })
        }

        function parse(...tokens: TokenType[]) {
            const parser = new ListParser()
            parser.input = tokens.map(e => createRegularToken(e))
            parser.Main()
            return { items: parser.items, errors: parser.errors.map(e => e.name) }
        }

        it("Should parse a single item", () => {
            expect(parse(Id, Semi)).toEqual({ items: 1, errors: [] })
        })

        it("Should greedily consume separated items", () => {
            expect(parse(Id, Comma, Id, Semi)).toEqual({ items: 2, errors: [] })
        })

        it("Should report a missing first iteration as an early exit", () => {
            // The exit prediction used to be mistaken for "enter" due to the swapped
            // transition order of separator loops, misplacing the error inside the iteration
            expect(parse(Semi)).toEqual({ items: 0, errors: ["EarlyExitException"] })
        })
    })

    describe("First item token in follow set of mandatory repetition with separator", () => {
        const Id = createToken({ name: "Id", pattern: "id" })
        const Comma = createToken({ name: "Comma", pattern: "," })
        const Semi = createToken({ name: "Semi", pattern: ";" })

        // The first list item is indistinguishable from the exit path when predicting
        // from the loop-back state, since Id is in FOLLOW(List). The first-iteration
        // check must look at the iteration content instead.
        class SuffixParser extends EmbeddedActionsParser {
            items = 0

            constructor() {
                super([Id, Comma, Semi], {
                    lookaheadStrategy: new LLStarLookaheadStrategy({ logging: () => {} })
                })
                this.performSelfAnalysis()
            }

            Main = this.RULE("Main", () => {
                this.SUBRULE(this.List)
                this.OPTION(() => this.CONSUME(Comma))
                this.OPTION2(() => this.CONSUME1(Id))
                this.CONSUME(Semi)
            })

            List = this.RULE("List", () => {
                this.AT_LEAST_ONE_SEP({
                    SEP: Comma,
                    DEF: () => {
                        this.ACTION(() => this.items++)
                        this.CONSUME(Id)
                    }
                })
            })
        }

        function parse(...tokens: TokenType[]) {
            const parser = new SuffixParser()
            parser.input = tokens.map(e => createRegularToken(e))
            parser.Main()
            return { items: parser.items, errors: parser.errors.map(e => e.name) }
        }

        it("Should parse a single item", () => {
            expect(parse(Id, Semi)).toEqual({ items: 1, errors: [] })
        })

        it("Should parse separated items", () => {
            expect(parse(Id, Comma, Id, Semi)).toEqual({ items: 2, errors: [] })
        })

        it("Should exit the repetition before the suffix item", () => {
            expect(parse(Id, Id, Semi)).toEqual({ items: 1, errors: [] })
        })
    })

    describe("Right-recursive rule with follow conflict", () => {
        const Id = createToken({ name: "Id", pattern: "id" })
        const Comma = createToken({ name: "Comma", pattern: "," })
        const Semi = createToken({ name: "Semi", pattern: ";" })

        // Expanding the outer context of the recursive call site must not recurse
        // endlessly; this guards the `visited` set used during closure computation
        class RecursiveParser extends EmbeddedActionsParser {
            constructor() {
                super([Id, Comma, Semi], {
                    lookaheadStrategy: new LLStarLookaheadStrategy({ logging: () => {} })
                })
                this.performSelfAnalysis()
            }

            Main = this.RULE("Main", () => {
                this.SUBRULE(this.R)
                this.OPTION(() => {
                    this.CONSUME(Comma)
                    this.CONSUME(Id)
                })
                this.CONSUME(Semi)
            })

            R = this.RULE("R", () => {
                this.CONSUME(Id)
                this.OPTION(() => {
                    this.CONSUME(Comma)
                    this.SUBRULE(this.R)
                })
            })
        }

        function parse(...tokens: TokenType[]) {
            const parser = new RecursiveParser()
            parser.input = tokens.map(e => createRegularToken(e))
            parser.Main()
            return parser.errors.map(e => e.name)
        }

        it("Should terminate and parse a non-recursive input", () => {
            expect(parse(Id, Semi)).toEqual([])
        })

        it("Should terminate and parse a recursive input", () => {
            expect(parse(Id, Comma, Id, Semi)).toEqual([])
        })
    })

    describe("LL(*) lookahead", () => {
        const A = createToken({ name: "A", pattern: "a" })
        const B = createToken({ name: "B", pattern: "b" })

        class UnboundedLookaheadParser extends EmbeddedActionsParser {
            constructor() {
                super([A, B], {
                    lookaheadStrategy: new LLStarLookaheadStrategy()
                })
                this.performSelfAnalysis()
            }

            LongRule = this.RULE("LongRule", () => {
                return this.OR([
                    {
                        ALT: () => {
                            return 0
                        }
                    },
                    {
                        ALT: () => {
                            this.AT_LEAST_ONE1(() => this.CONSUME1(A))
                            return 1
                        }
                    },
                    {
                        ALT: () => {
                            this.AT_LEAST_ONE2(() => this.CONSUME2(A))
                            this.CONSUME(B)
                            return 2
                        }
                    }
                ])
            })
        }

        it("Should pick longest alternative instead of first #1", () => {
            const parser = new UnboundedLookaheadParser()
            parser.input = [
                createRegularToken(A),
                createRegularToken(A),
                createRegularToken(A)
            ]
            const result = parser.LongRule()
            expect(result).toBe(1);
        })

        it("Should pick longest alternative instead of first #2", () => {
            const parser = new UnboundedLookaheadParser()
            parser.input = [
                createRegularToken(A),
                createRegularToken(A),
                createRegularToken(B)
            ]
            const result = parser.LongRule()
            expect(result).toBe(2);
        })

        it("Should pick shortest fitting alternative", () => {
            const parser = new UnboundedLookaheadParser()
            parser.input = []
            const result = parser.LongRule()
            expect(result).toBe(0);
        })
    })

    describe("Incomplete alternative", () => {
        const A = createToken({ name: "A", pattern: "a" })
        const B = createToken({ name: "B", pattern: "b" })
        const C = createToken({ name: "C", pattern: "c" })

        class IncompleteLookaheadParser extends EmbeddedActionsParser {
            constructor() {
                super([A, B, C], {
                    lookaheadStrategy: new LLStarLookaheadStrategy({
                        incomplete: true
                    })
                })
                this.performSelfAnalysis()
            }

            result = -1;
            Rule = this.RULE("Rule", () => {
                return this.OR([
                    {
                        ALT: () => {
                            this.result = 0;
                            // ONLY A
                            this.CONSUME1(A)
                        }
                    },
                    {
                        ALT: () => {
                            this.result = 1;
                            // A B C
                            this.CONSUME2(A)
                            this.CONSUME1(B)
                            this.CONSUME1(C)
                        }
                    }
                ])
            })
        }

        it("Should pick the longer, but incomplete alternative", () => {
            const parser = new IncompleteLookaheadParser()
            parser.input = [
                createRegularToken(A),
                createRegularToken(B)
            ]
            parser.Rule()
            expect(parser.result).toBe(1);
        })

        it("Should pick shorter alternative when it makes sense", () => {
            const parser = new IncompleteLookaheadParser()
            parser.input = [
                createRegularToken(A),
                createRegularToken(C)
            ]
            parser.Rule()
            expect(parser.result).toBe(0);
        })
    })

    describe("Incomplete options", () => {
        const A = createToken({ name: "A", pattern: "a" })
        const B = createToken({ name: "B", pattern: "b" })
        const C = createToken({ name: "C", pattern: "c" })

        class IncompleteLookaheadParser extends EmbeddedActionsParser {
            constructor() {
                super([A, B, C], {
                    lookaheadStrategy: new LLStarLookaheadStrategy({
                        incomplete: true
                    })
                })
                this.performSelfAnalysis()
            }

            result = -1;
            Rule = this.RULE("Rule", () => {
                this.result = 0;
                this.CONSUME1(A)
                this.OPTION(() => {
                    this.result = 1;
                    this.CONSUME1(B)
                    this.CONSUME1(C)
                });
            })
        }

        it("Should pick the longer, but incomplete option", () => {
            const parser = new IncompleteLookaheadParser()
            parser.input = [
                createRegularToken(A),
                createRegularToken(B)
            ]
            parser.Rule()
            expect(parser.result).toBe(1);
        })

        it("Should not pick the option when no indicator exists", () => {
            const parser = new IncompleteLookaheadParser()
            parser.input = [
                createRegularToken(A),
                // B would be required to pick the option
                createRegularToken(C)
            ]
            parser.Rule()
            expect(parser.result).toBe(0);
        })
    })

    describe("Ambiguity Detection", () => {
        const A = createToken({ name: "A" })
        const B = createToken({ name: "B" })

        class AmbigiousParser extends EmbeddedActionsParser {
            ambiguityReports: string[] = []

            constructor() {
                super([A, B], {
                    lookaheadStrategy: new LLStarLookaheadStrategy({
                        logging: (message) => this.ambiguityReports.push(message)
                    })
                });
                this.performSelfAnalysis()
            }

            OptionRule = this.RULE("OptionRule", () => {
                let usedOption = false
                this.OPTION(() => {
                    this.AT_LEAST_ONE1(() => this.CONSUME1(A))
                    usedOption = true
                })
                this.AT_LEAST_ONE2(() => this.CONSUME2(A))
                return usedOption
            })

            AltRule = this.RULE("AltRule", () => {
                return this.OR([
                    {
                        ALT: () => {
                            this.SUBRULE(this.RuleB)
                            return 0
                        }
                    },
                    {
                        ALT: () => {
                            this.SUBRULE(this.RuleC)
                            return 1
                        }
                    }
                ])
            })

            RuleB = this.RULE("RuleB", () => {
                this.MANY(() => this.CONSUME(A))
            })

            RuleC = this.RULE("RuleC", () => {
                this.MANY(() => this.CONSUME(A))
                this.OPTION(() => this.CONSUME(B))
            })

            AltRuleWithEOF = this.RULE("AltRuleWithEOF", () => {
                return this.OR([
                    {
                        ALT: () => {
                            this.SUBRULE1(this.RuleEOF)
                            return 0
                        }
                    },
                    {
                        ALT: () => {
                            this.SUBRULE2(this.RuleEOF)
                            return 1
                        }
                    }
                ])
            })

            RuleEOF = this.RULE("RuleEOF", () => {
                this.MANY1(() => this.CONSUME(A))
                this.CONSUME(EOF)
            })

            AltRuleWithPred = this.RULE("AltRuleWithPred", (pred?: boolean) => {
                return this.OR([
                    {
                        ALT: () => {
                            this.CONSUME1(A)
                            return 0
                        },
                        GATE: () => (pred === undefined ? true : pred)
                    },
                    {
                        ALT: () => {
                            this.CONSUME2(A)
                            return 1
                        },
                        GATE: () => (pred === undefined ? true : !pred)
                    },
                    {
                        ALT: () => {
                            this.CONSUME(B)
                            return 2
                        }
                    }
                ])
            })

            AltWithOption = this.RULE("AltWithOption", () => {
                const intermediate = this.OR([
                    {
                        ALT: () => {
                            this.CONSUME1(A)
                            return 2
                        }
                    },
                    {
                        ALT: () => {
                            this.CONSUME2(B)
                            return 4
                        }
                    }
                ])
                const option = this.OPTION(() => {
                    this.CONSUME3(A);
                    return 1;
                })
                return (option ?? 0) + intermediate;
            })
        }

        it("Should pick option on ambiguity", () => {
            const parser = new AmbigiousParser()
            parser.input = [
                createRegularToken(A),
                createRegularToken(A),
                createRegularToken(A)
            ]
            const result = parser.OptionRule()
            expect(result).toBeTruthy();
            // The rule nests a `AT_LEAST_ONE` inside and outside the OPTION
            // Both productions produce lookahead ambiguities
            expect(parser.ambiguityReports[0]).toMatch("<0, 1> in <OPTION>")
            expect(parser.ambiguityReports[1]).toMatch("<0, 1> in <AT_LEAST_ONE1>")
        })

        it("Should pick first alternative on ambiguity", () => {
            const parser = new AmbigiousParser()
            parser.input = [
                createRegularToken(A),
                createRegularToken(A),
                createRegularToken(A)
            ]
            const result = parser.AltRule()
            expect(result).toBe(0);
            expect(parser.ambiguityReports[0]).toMatch("<0, 1> in <OR>")
        })

        it("Should pick first alternative on EOF ambiguity", () => {
            const parser = new AmbigiousParser()
            parser.input = []
            const result = parser.AltRuleWithEOF()
            expect(result).toBe(0);
            expect(parser.ambiguityReports[0]).toMatch("<0, 1> in <OR>")
        })

        it("Should pick correct alternative on long prefix", () => {
            const parser = new AmbigiousParser()
            parser.input = [
                createRegularToken(A),
                createRegularToken(A),
                createRegularToken(B)
            ]
            const result = parser.AltRule()
            expect(result).toBe(1);
            expect(parser.ambiguityReports).toHaveLength(0);
        })

        it("Should resolve ambiguity using predicate", () => {
            const parser = new AmbigiousParser()
            parser.input = [createRegularToken(A)]
            const resultAutomatic = parser.AltRuleWithPred(undefined)
            // Automatically resolving the ambiguity should return `0`
            expect(resultAutomatic).toBe(0);
            // It should also create an ambiguity report
            expect(parser.ambiguityReports[0]).toMatch("<0, 1> in <OR>")
            parser.ambiguityReports = []
            parser.input = [createRegularToken(A)]
            const resultTrue = parser.AltRuleWithPred(true)
            expect(resultTrue).toBe(0);
            parser.input = [createRegularToken(A)]
            const resultFalse = parser.AltRuleWithPred(false)
            expect(resultFalse).toBe(1),
            expect(parser.ambiguityReports).toHaveLength(0);
        })

        it("Should pick non-ambigious alternative inside of ambigious, predicated alternation", () => {
            const parser = new AmbigiousParser()
            parser.input = [createRegularToken(B)]
            const result = parser.AltRuleWithPred(undefined)
            expect(result).toBe(2);
            expect(parser.ambiguityReports).toHaveLength(0);
        })

        it("Should work with alternatives followed by optional elements", () => {
            const parser = new AmbigiousParser();
            parser.input = [createRegularToken(B), createRegularToken(A)];
            const result = parser.AltWithOption();
            expect(result).toBe(5);
        })
    })
})

function createRegularToken(
    tokType: TokenType,
    image = "",
    startOffset = 1,
    startLine?: number,
    startColumn?: number,
    endOffset?: number,
    endLine?: number,
    endColumn?: number
): IToken {
    return {
        image: image,
        startOffset: startOffset,
        startLine: startLine,
        startColumn: startColumn,
        endOffset: endOffset,
        endLine: endLine,
        endColumn: endColumn,
        tokenTypeIdx: tokType.tokenTypeIdx!,
        tokenType: tokType
    }
}
