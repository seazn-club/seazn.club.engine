// W6 double elimination: fewer than 2 entrants is refused by name; 2 and 3 are offered with their own shapes (row
// X-DE-16). Every expected value comes from the W6 rulebook (seazn.club rulebook-W6-double-elim.md §2 RB6-E1 to RB6-E5,
// §6 the reset), never from generateDoubleElim's own output.
//
// Numbering: rulebook rounds and games count from 1, engine ids from 0. `WB r.i` is `wb-r{r−1}-i{i−1}` and `LB t.p` is
// `lb-r{t−1}-i{p−1}`.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { playOutBracket } from "../testkit/bracket-play.ts";
import { generateDoubleElim, generateSingleElim, type BracketFixtureGen, type BracketSlotRef } from "./bracket.ts";

const field = (n: number): string[] => Array.from({ length: n }, (_, i) => `s${i + 1}`);
const seedsOf = (n: number): Map<string, number> => new Map(field(n).map((id, i) => [id, i + 1]));
const W = (fixtureId: string): BracketSlotRef => ({ fixtureId, side: "winner" });
const L = (fixtureId: string): BracketSlotRef => ({ fixtureId, side: "loser" });
const byId = (fixtures: readonly BracketFixtureGen[]): Map<string, BracketFixtureGen> =>
  new Map(fixtures.map((f) => [f.id, f]));

function refusal(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e instanceof EngineError ? { code: e.code, data: e.data } : e;
  }
  return "no refusal";
}

describe("double elimination below 2 entrants (W6 X-DE-16)", () => {
  // single-sport: double-elimination structure and ranks are sport-agnostic (reads no SportModule)
  // differential: today both return { fixtures: [], rounds: 0 } (bracket.ts:447 at 10.0.4) — no grand final, no refusal.
  for (const n of [0, 1]) {
    it(`X-DE-16 ${n} entrant${n === 1 ? "" : "s"} is refused by name`, () => {
      // RB6-E1 (0), RB6-E2 (1): Generate is refused with a named reason, never an empty bracket.
      for (const bracketReset of [undefined, false, true]) {
        expect(
          refusal(() => generateDoubleElim({ entrants: field(n), ...(bracketReset === undefined ? {} : { bracketReset }) })),
          `bracketReset ${String(bracketReset)}`,
        ).toEqual({ code: "CONFIG_INVALID", data: { reason: "double_elim_needs_two", entrants: n } });
      }
    });
  }

  it("X-DE-16 a second call is refused the same, and a knockout below 2 is unchanged", () => {
    const first = refusal(() => generateDoubleElim({ entrants: field(1) }));
    const second = refusal(() => generateDoubleElim({ entrants: field(1) }));
    expect(second).toEqual(first);
    expect(first).toEqual({ code: "CONFIG_INVALID", data: { reason: "double_elim_needs_two", entrants: 1 } });
    // The knockout's refusal stays the app's (X-SD-1, X-SD-2): the engine answers with the empty bracket.
    for (const n of [0, 1]) expect(generateSingleElim({ entrants: field(n) })).toEqual({ fixtures: [], rounds: 0 });
  });
});

describe("double elimination fields of 2 and 3 (W6 X-DE-16)", () => {
  // single-sport: double-elimination structure and ranks are sport-agnostic (reads no SportModule)
  it("X-DE-16 a field of 2: one WB match, no LB match, the grand final is the same pair", () => {
    // RB6-E3: the WB is one match; its loser is the LB champion; GF1 is the same pair; the reset, when on, is the
    // conditional decider between GF1's winner and loser.
    for (const bracketReset of [false, true]) {
      const gen = generateDoubleElim({ entrants: field(2), seeds: seedsOf(2), bracketReset });
      expect(gen.fixtures.map((f) => f.id), `reset ${bracketReset}`).toEqual(
        bracketReset ? ["wb-r0-i0", "gf", "gf-reset"] : ["wb-r0-i0", "gf"],
      );
      const f = byId(gen.fixtures);
      expect([f.get("gf")?.homeFrom, f.get("gf")?.awayFrom]).toEqual([W("wb-r0-i0"), L("wb-r0-i0")]);
      if (bracketReset) {
        const reset = f.get("gf-reset");
        expect([reset?.conditional, reset?.homeFrom, reset?.awayFrom]).toEqual([true, W("gf"), L("gf")]);
      }
    }
  });

  it("X-DE-16 a field of 3: seed 1 has the bye and LB 1.1 has one dead seat", () => {
    // RB6-E4: frame of 4. WB 1.1 is seed 1's bye, WB 1.2 is 2 v 3 (either seat order, RB6-D6). LB 1.1 = L WB 1.1 (dead:
    // a bye has no loser) v L WB 1.2; the LB final = W LB 1.1 v L WB 2.1. Matches: 2 v 3, WB final, LB final, GF1 —
    // plus one bye line and one LB line with a dead seat: 6 fixtures, 7 with the reset.
    for (const bracketReset of [false, true]) {
      const gen = generateDoubleElim({ entrants: field(3), seeds: seedsOf(3), bracketReset });
      expect(gen.fixtures, `reset ${bracketReset}`).toHaveLength(bracketReset ? 7 : 6);
      const f = byId(gen.fixtures);
      expect(f.get("wb-r0-i0")?.award).toBe("s1");
      expect([f.get("wb-r0-i1")?.home, f.get("wb-r0-i1")?.away].sort()).toEqual(["s2", "s3"]);
      expect([f.get("lb-r0-i0")?.homeFrom, f.get("lb-r0-i0")?.awayFrom]).toEqual([L("wb-r0-i0"), L("wb-r0-i1")]);
      expect([f.get("lb-r1-i0")?.homeFrom, f.get("lb-r1-i0")?.awayFrom]).toEqual([W("lb-r0-i0"), L("wb-r1-i0")]);
      expect([f.get("gf")?.homeFrom, f.get("gf")?.awayFrom]).toEqual([W("wb-r1-i0"), W("lb-r1-i0")]);
    }
  });

  it("X-DE-16 a field of 2 or 3 crowns one champion", () => {
    // RB6-E5: even with no live LB match (n = 2) the bracket has exactly one champion. Played by the testkit player,
    // with the home side winning every match and with the away side winning every match: GF1 seats the WB champion
    // first (homeFrom), so "away wins" is the LB champion taking GF1 and the reset being played. Reset off and on.
    let brackets = 0;
    let resetsPlayed = 0;
    for (const n of [2, 3])
      for (const bracketReset of [false, true])
        for (const awayWins of [false, true]) {
          const seeds = seedsOf(n);
          const gen = generateDoubleElim({ entrants: field(n), seeds, bracketReset });
          const rows = playOutBracket(gen, { winner: (h: string, a: string) => (awayWins ? a : h) });
          const gf = rows.find((r) => r.id === "gf");
          const reset = rows.find((r) => r.id === "gf-reset");
          const where = `n=${n} reset ${bracketReset} awayWins ${awayWins}`;
          expect(gf?.winner, where).toBeDefined();
          // The reset is played exactly when it is on and the LB champion (GF1's away feed) won GF1.
          const resetPlayed = bracketReset && gf?.winner === gf?.away;
          expect(reset === undefined ? "absent" : reset.status, where).toBe(
            !bracketReset ? "absent" : resetPlayed ? "decided" : "void",
          );
          if (resetPlayed) expect(reset?.winner, where).toBeDefined();
          if (reset?.status === "decided") resetsPlayed++;
          brackets++;
        }
    expect(brackets).toBe(8);
    expect(resetsPlayed).toBe(2); // the reset branch was reached, at n = 2 and at n = 3
  });
});
