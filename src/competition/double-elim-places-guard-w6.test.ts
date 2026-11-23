// W6 double elimination: the completed-places guard (row X-FR-9; X-FR-1 and X-FR-2 re-proved under their amended text).
// `assertCompletedBracketPlaces` holds a completed double elimination to the title its deciding match declared and to
// the four exit-round relations below it (design §5.1; ruling 297, OWNER 305(d), 306(c), 301): a later exit round ranks
// strictly better, one exit round holds one rank, no rank spans two exit rounds, and every rank is 1 + the entrants
// ranked better. Every expected value comes from the W6 rulebook (seazn.club rulebook-W6-double-elim.md §4 the n = 8
// worked table; §7 RB6-F5, F7, F8; §9 RB6-C4, C5; §10 RB6-R1 to R10 and the place tables), never from `bracketRanks`'
// own output.
//
// Numbering: rulebook rounds and games count from 1, engine ids from 0. `WB r.i` is `wb-r{r−1}-i{i−1}` and `LB t.p` is
// `lb-r{t−1}-i{p−1}`. GF1 is `gf`, the reset `gf-reset`.
//
// The rig (Task 6's shape, copied, not imported): `generateDoubleElim` played out by the testkit's `playOutBracket`
// under a result script, each row then given its generated fixture's feeds and `conditional` — the app's rows.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { generateDoubleElim, generatePagePlayoff, generateSingleElim, generateStepladder, type GeneratedBracket } from "../scheduling/bracket.ts";
import { playOutBracket, type PlayOutOptions } from "../testkit/bracket-play.ts";
import {
  assertCompletedBracketPlaces,
  BRACKET_SHARED_RANKS,
  bracketRanks,
  completeBracketStage,
  resetOwed,
  type BracketFixture,
  type BracketStage,
  type FinalPlace,
} from "./stage.ts";

type Winner = (home: string, away: string) => string;
const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `E${i + 1}`);
const seedsOf = (list: readonly string[]): Map<string, number> => new Map(list.map((id, i) => [id, i + 1]));
const seedNo = (id: string): number => Number(id.slice(1));
const favourite: Winner = (home, away) => (seedNo(away) < seedNo(home) ? away : home);
const underdog: Winner = (home, away) => (seedNo(away) > seedNo(home) ? away : home);
/** A seeded coin: the same salt plays the same results, in the generator's order. */
function coins(salt: number): Winner {
  let state = (salt * 2654435761) >>> 0;
  return (home, away) => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return (state >>> 16) & 1 ? home : away;
  };
}
/** E1 and E2 meet in the WB final, GF1 and the reset: `script[i]` wins their (i + 1)-th meeting; favourite elsewhere. */
function meetings(...script: string[]): Winner {
  let met = 0;
  return (home, away) => ([home, away].sort().join() === "E1,E2" ? (script[met++] ?? "E1") : favourite(home, away));
}

/** Each row with its generated fixture's feeds and `conditional`, as the app's rows carry them. */
function asAppRows(gen: GeneratedBracket, rows: readonly BracketFixture[]): BracketFixture[] {
  const byId = new Map(gen.fixtures.map((f) => [f.id, f]));
  return rows.map((row) => {
    const g = byId.get(row.id);
    return {
      ...row,
      ...(g?.homeFrom === undefined ? {} : { homeFrom: g.homeFrom }),
      ...(g?.awayFrom === undefined ? {} : { awayFrom: g.awayFrom }),
      ...(g?.conditional === true ? { conditional: true } : {}),
    };
  });
}

interface Played {
  stage: BracketStage;
  rows: BracketFixture[];
}
function play(n: number, opts: PlayOutOptions & { reset?: boolean; feeds?: boolean } = {}): Played {
  const { reset = false, feeds = true, ...script } = opts;
  const entrants = ids(n);
  const gen = generateDoubleElim({ entrants, seeds: seedsOf(entrants), bracketReset: reset });
  const played = playOutBracket(gen, { winner: favourite, ...script });
  return { stage: { id: "de", kind: "double_elim", entrants, seeds: seedsOf(entrants) }, rows: feeds ? asAppRows(gen, played) : played };
}

const rowIn = (rows: readonly BracketFixture[], id: string): BracketFixture => {
  const row = rows.find((r) => r.id === id);
  if (row === undefined) throw new Error(`no row ${id}`);
  return row;
};
const replacing = (rows: readonly BracketFixture[], id: string, swap: (row: BracketFixture) => BracketFixture): BracketFixture[] =>
  rows.map((row) => (row.id === id ? swap(row) : row));
const ranked = (...pairs: readonly (readonly [string, number])[]): FinalPlace[] => pairs.map(([entrantId, rank]) => ({ entrantId, rank }));
/** Places by seed: the i-th rank belongs to E(i+1). */
const bySeed = (...ranks: number[]): FinalPlace[] => ranks.map((rank, i) => ({ entrantId: `E${i + 1}`, rank }));

/** The engine refusal a call throws; a call that returns instead fails the test. */
function refusalOf(run: () => unknown): { code: string; data: Record<string, unknown> } {
  try {
    run();
  } catch (e) {
    if (e instanceof EngineError) return { code: e.code, data: e.data as Record<string, unknown> };
    throw e;
  }
  throw new Error("expected a refusal, the call returned");
}
const reasonOf = (run: () => unknown): string => {
  const { code, data } = refusalOf(run);
  return `${code} ${String(data.reason)}`;
};

/** Completes the stage and returns its places; the guard runs inside `completeBracketStage` (and once more here). */
function completed({ stage, rows }: Played): FinalPlace[] {
  const { finalRanks } = completeBracketStage(stage, rows);
  expect(() => assertCompletedBracketPlaces(stage, rows, finalRanks)).not.toThrow();
  return finalRanks;
}

describe("double elimination: the completed-places guard passes the places a double walkover leaves (W6 X-FR-9)", () => {
  // single-sport: double-elimination structure and ranks are sport-agnostic (reads no SportModule)
  it("X-FR-9 a completed field of 2 passes the guard", () => {
    // Empty first. RB6-E3, E5: no LB match; the deciding match's winner 1st and loser 2nd, reset off and on (RB6-R4).
    let checked = 0;
    for (const reset of [false, true]) {
      expect(completed(play(2, { reset })), `reset ${reset}`).toEqual(bySeed(1, 2));
      checked++;
    }
    // The reset earned and played: E2 (the LB champion at n = 2 is the WB final's loser) wins GF1 and the reset.
    expect(completed(play(2, { reset: true, winner: meetings("E1", "E2", "E2") }))).toEqual(ranked(["E2", 1], ["E1", 2]));
    checked++;
    expect(checked).toBe(3);
    // No fixtures at all: no deciding match, so no title, and every entrant at 1 (bracketRanks' provisional read, Task 6
    // review m5) is not a completed double elimination's shape.
    const bare: BracketStage = { id: "de", kind: "double_elim", entrants: ids(8) };
    expect(refusalOf(() => assertCompletedBracketPlaces(bare, [], bracketRanks(bare, [])))).toEqual({
      code: "CONFIG_INVALID",
      data: { reason: "title_shape", stageId: "de", title: "none", rankOne: ids(8) },
    });
    // No title and nobody at 1 is still no title: refused title_shape, not read as a ranking with 1st left empty.
    expect(refusalOf(() => assertCompletedBracketPlaces(bare, [], bySeed(2, 2, 2, 2, 2, 2, 2, 2))).data).toMatchObject({ reason: "title_shape", title: "none", rankOne: [] });
  });

  it("X-FR-9 n = 4, a double walkover in LB 1.1: two at 3=, nobody 4th, and the stage completes", () => {
    // RB6-R10: both out in LB round 1; the WB final's loser E2 walks over the LB final, which nobody loses.
    // differential: on origin/main the two are split 3rd and 4th by seed (stage.ts:1010-1017).
    const walked = play(4, { doubleWalkover: new Set(["lb-r0-i0"]) });
    expect(rowIn(walked.rows, "lb-r1-i0"), "premise: LB 2.1 a walkover nobody loses").toMatchObject({ status: "walkover", winner: "E2" });
    expect(rowIn(walked.rows, "lb-r1-i0").loser).toBeUndefined();
    expect(completed(walked)).toEqual(bySeed(1, 2, 3, 3));
  });

  it("X-FR-9 n = 8, a double walkover in LB 2.1: three at 4=", () => {
    // RB6-R10: lb-r1-i0 (E5 v E3) both out in LB round 2 with E6 (lost LB 2.2); LB 3.1 a walkover nobody loses; E4 loses
    // the LB final → 3rd; the three 4=, nobody 5th or 6th; the LB round-1 losers 7=.
    const walked = play(8, { doubleWalkover: new Set(["lb-r1-i0"]) });
    const want = ranked(["E1", 1], ["E2", 2], ["E4", 3], ["E3", 4], ["E5", 4], ["E6", 4], ["E7", 7], ["E8", 7]);
    expect(completed(walked)).toEqual(want);
    // The same places on the same rows read as a knockout: refused, "at most two" (stage.ts, `more_than_two`). The
    // refusal the design feared is real for the other kinds and gone for this one.
    const ko: BracketStage = { ...walked.stage, kind: "knockout" };
    expect(refusalOf(() => assertCompletedBracketPlaces(ko, walked.rows, want))).toMatchObject({ code: "CONFIG_INVALID", data: { reason: "more_than_two", rank: 4 } });
  });

  it("X-FR-9 n = 8, a double walkover in WB 2.1: both out, three at 4=", () => {
    // OWNER 301, RB6-F7, R10: wb-r1-i0 (E1 v E4) both out, neither drops; they vacate LB 2.2's seat (RB6-X2 c=0). The WB
    // final (E2 walks over) and then the LB final (E3 walks over) are walkovers nobody loses. E6, the loser of lb-r2-i0
    // (LB 3.1), 3rd; E1, E4 and E5 (lost lb-r1-i0, LB 2.1) 4=; the LB round-1 losers 7=.
    const walked = play(8, { doubleWalkover: new Set(["wb-r1-i0"]) });
    expect([rowIn(walked.rows, "wb-r2-i0").loser, rowIn(walked.rows, "lb-r3-i0").loser], "premise: both walkovers nobody loses").toEqual([undefined, undefined]);
    expect(completed(walked)).toEqual(ranked(["E2", 1], ["E3", 2], ["E6", 3], ["E1", 4], ["E4", 4], ["E5", 4], ["E7", 7], ["E8", 7]));
  });

  it("X-FR-9 n = 8, a double walkover in the WB final: the LB champion 1st, the two 2=, nobody 3rd", () => {
    // RB6-R10, G11: wb-r2-i0 (E1 v E2) both out; the LB final and GF1 each settled with nobody losing. E3 1st, E1 and E2
    // 2=, nobody 3rd, E4 (lost lb-r2-i0) 4th, then 5=, 5=, 7=, 7=. With the reset on it is not owed (GF1 has no loser).
    const want = ranked(["E3", 1], ["E1", 2], ["E2", 2], ["E4", 4], ["E5", 5], ["E6", 5], ["E7", 7], ["E8", 7]);
    let checked = 0;
    for (const reset of [false, true]) {
      const walked = play(8, { reset, doubleWalkover: new Set(["wb-r2-i0"]) });
      expect(resetOwed(walked.rows), `reset ${reset}: nothing owed`).toBe(false);
      expect(completed(walked), `reset ${reset}`).toEqual(want);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("X-FR-9 n = 8, a double walkover in the LB final: the two share 2nd", () => {
    // Review Focus 2. RB6-R3 and design call 12: whoever went out last ranks next; OWNER 306(c): two at 2nd, shared.
    // lb-r3-i0 (E3 v E2) both out; GF1 a walkover to E1 with no loser → 1, 2, 2, 4, 5, 5, 7, 7.
    let checked = 0;
    for (const reset of [false, true]) {
      const walked = play(8, { reset, doubleWalkover: new Set(["lb-r3-i0"]) });
      expect(rowIn(walked.rows, "gf"), "premise: GF1 a walkover to E1").toMatchObject({ status: "walkover", winner: "E1" });
      expect(completed(walked), `reset ${reset}`).toEqual(bySeed(1, 2, 2, 4, 5, 5, 7, 7));
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("X-FR-9 a double walkover in the LB puts both out and nobody drops", () => {
    // RB6-F5: lb-r1-i1 (LB 2.2: E6, the winner of LB 1.2, v E4, the loser of WB 2.1 by RB6-X2 c=0) both out in LB round 2
    // with E5 (lost LB 2.1 to E3). Neither is seated again; LB 3.1 is E3's walkover; E3 loses the LB final to E2 → 3rd.
    const walked = play(8, { doubleWalkover: new Set(["lb-r1-i1"]) });
    expect([rowIn(walked.rows, "lb-r1-i1").home, rowIn(walked.rows, "lb-r1-i1").away].sort(), "premise: E4 v E6").toEqual(["E4", "E6"]);
    const later = walked.rows.filter((r) => r.round > rowIn(walked.rows, "lb-r1-i1").round);
    expect(later.flatMap((r) => [r.home, r.away]).filter((id) => id === "E4" || id === "E6"), "nobody drops").toEqual([]);
    expect(completed(walked)).toEqual(bySeed(1, 2, 3, 4, 4, 4, 7, 7));
  });

  it("X-FR-9 no double walkover refuses the stage: every real WB and LB match, n = 8 and n = 16", () => {
    // RB6-R1 (OWNER 305(d)): a stage is never refused completion because a place has no holder or has several. Each real
    // match under the favourite script walked over in turn, the rest played out by the rig (vacated seats walked over),
    // reset on. The grand final is excluded by name (RB6-F8: refused upstream).
    const tried: Record<number, number> = {};
    for (const n of [8, 16]) {
      const real = play(n, { reset: true }).rows.filter(
        (r) => (r.bracket === "WB" || r.bracket === "LB") && r.status === "decided" && r.home !== undefined && r.away !== undefined,
      );
      tried[n] = 0;
      for (const { id } of real) {
        const places = completed(play(n, { reset: true, doubleWalkover: new Set([id]) }));
        expect(places.map((p) => p.entrantId).sort(), `n=${n} ${id}: every entrant once`).toEqual(ids(n).sort());
        tried[n] = (tried[n] ?? 0) + 1;
      }
    }
    // 2n − 3 real matches: n − 1 in the WB and n − 2 in the LB (no byes at 8 or 16).
    expect(tried).toEqual({ 8: 13, 16: 29 });
  });

  it("X-FR-9 the engine's own places pass the guard: n = 2 … 32 × 4 scripts × reset {off, on} × feeds {app, none}", () => {
    // The positive pair of every refusal below. Feeds "none" is the simulation's row shape (testkit simulation.ts): a
    // fully played bracket, every exit an LB or GF loss, so its places are readable without the WB loser feeds.
    let runs = 0;
    let entrantsRanked = 0;
    for (let n = 2; n <= 32; n++) {
      const scripts: [string, () => Winner][] = [
        ["favourite", () => favourite],
        ["underdog", () => underdog],
        ["coins 1", () => coins(100 + n)],
        ["coins 2", () => coins(200 + n)],
      ];
      for (const [, winner] of scripts) {
        for (const reset of [false, true]) {
          for (const feeds of [true, false]) {
            const played = play(n, { reset, feeds, winner: winner() });
            // The guard accepts the engine's own output (completion runs it; `completed` runs it once more). The places'
            // independence from the engine is double-elim-ranks-w6's `placesByR3` sweep, not this one.
            const places = completed(played);
            entrantsRanked += places.length;
            runs++;
          }
        }
      }
    }
    expect(runs, "31 sizes × 4 scripts × 2 × 2").toBe(496);
    expect(entrantsRanked, "Σ n (2 … 32) × 16 = 527 × 16").toBe(8432);
  });
});

describe("double elimination: the title shapes (W6 X-FR-1)", () => {
  // single-sport: double-elimination structure and ranks are sport-agnostic (reads no SportModule)
  it("X-FR-1 the title shapes in a double elimination", () => {
    // RB6-R8, C5, C4: joint winners on GF1 → 1, 1, 3, 4, 5, 5, 7, 7 (nobody 2nd); a vacant title (both finalists out at
    // GF1) → 2, 2, 3, 4, 5, 5, 7, 7 and nobody 1st. Both complete, reset off and on (neither owes a reset, RB6-G11).
    let checked = 0;
    for (const reset of [false, true]) {
      expect(completed(play(8, { reset, jointFinal: true })), `joint, reset ${reset}`).toEqual(bySeed(1, 1, 3, 4, 5, 5, 7, 7));
      const vacant = completed(play(8, { reset, doubleWalkover: new Set(["gf"]) }));
      expect(vacant, `vacant, reset ${reset}`).toEqual(bySeed(2, 2, 3, 4, 5, 5, 7, 7));
      expect(vacant.some((p) => p.rank === 1), "nobody 1st").toBe(false);
      checked += 2;
    }
    expect(checked).toBe(4);
  });
});

describe("double elimination: the completed-places guard refuses a wrong shape (W6 X-FR-9)", () => {
  // single-sport: double-elimination structure and ranks are sport-agnostic (reads no SportModule)
  // The n = 8 full bracket to seed: RB6 place table n = 8 → E1 1, E2 2, E3 3 (lost LB 4.1), E4 4 (LB 3.1), E5 and E6 5=
  // (LB round 2), E7 and E8 7= (LB round 1).
  const full = (): Played => play(8);
  const RIGHT = bySeed(1, 2, 3, 4, 5, 5, 7, 7);

  it("X-FR-9 the guard refuses a wrong order", () => {
    // differential: on Task 6's code the guard is structural only for a double elimination, so every row here passes.
    const { stage, rows } = full();
    expect(() => assertCompletedBracketPlaces(stage, rows, RIGHT), "premise: the right places pass").not.toThrow();
    const guard = (places: FinalPlace[], fixtures: readonly BracketFixture[] = rows) => () => assertCompletedBracketPlaces(stage, fixtures, places);
    // X-FR-8 (b) of Task 6, with LB 2.1's loser feed dropped: E3 withdrew at WB 2.2 and no row says where that seat was.
    const withdrawn = play(8, { withdraw: new Map([["wb-r1-i1", "E3"]]) });
    const noFeed = replacing(withdrawn.rows, "lb-r1-i0", ({ awayFrom: _a, ...row }) => row);
    const WB_WITHDRAWAL = ranked(["E1", 1], ["E2", 2], ["E4", 3], ["E5", 4], ["E3", 5], ["E6", 5], ["E7", 7], ["E8", 7]);
    expect(() => assertCompletedBracketPlaces(withdrawn.stage, withdrawn.rows, WB_WITHDRAWAL), "premise: with the feed, it passes").not.toThrow();
    const cases: [string, () => void, string][] = [
      ["two exit rounds swapped (E4, out in LB 3, written 3; E3, out in LB 4, written 4)",
        guard(ranked(["E1", 1], ["E2", 2], ["E4", 3], ["E3", 4], ["E5", 5], ["E6", 5], ["E7", 7], ["E8", 7])), "exit_round_order"],
      ["the two 5= written 5 and 6", guard(bySeed(1, 2, 3, 4, 5, 6, 7, 7)), "exit_round_split"],
      ["a 5= and a 7= both written 5 (strict: equal is refused)", guard(bySeed(1, 2, 3, 4, 5, 5, 5, 8)), "exit_round_order"],
      // A rank shared across two exit rounds, three wide: the LB round-3 loser E4 written 5 with the LB round-2 losers.
      // The order check runs over every place before the competition check, so this is an order refusal, not the
      // 4-is-missing one.
      ["the LB round-3 loser written 5 with the two LB round-2 losers", guard(bySeed(1, 2, 3, 5, 5, 5, 7, 7)), "exit_round_order"],
      ["1, 2, 3, 4, 6, 6, 7, 7", guard(bySeed(1, 2, 3, 4, 6, 6, 7, 7)), "not_competition_ranking"],
      ["two entrants at 1 with no joint final", guard(bySeed(1, 1, 3, 4, 5, 5, 7, 7)), "title_shape"],
      ["a row with no bracket", guard(RIGHT, replacing(rows, "lb-r2-i0", ({ bracket: _b, ...row }) => row)), "lane_missing"],
      ["a walked-out WB entrant whose loser feed no row carries", () => assertCompletedBracketPlaces(withdrawn.stage, noFeed, WB_WITHDRAWAL), "exit_round_unreadable"],
    ];
    let refused = 0;
    for (const [what, run, reason] of cases) {
      expect(reasonOf(run), what).toBe(`CONFIG_INVALID ${reason}`);
      refused++;
    }
    expect(refused, "refusals").toBe(8);
    // The data names who and where.
    expect(refusalOf(cases[6]![1]).data).toEqual({ reason: "lane_missing", stageId: "de", fixtureId: "lb-r2-i0" });
    expect(refusalOf(cases[7]![1]).data).toEqual({ reason: "exit_round_unreadable", stageId: "de", entrantId: "E3", fixtureId: "wb-r1-i1" });
    expect(refusalOf(cases[0]![1]).data).toEqual({ reason: "exit_round_order", stageId: "de", entrantId: "E4", rank: 3, laterEntrantId: "E3", laterRank: 4 });
    expect(refusalOf(cases[1]![1]).data).toEqual({ reason: "exit_round_split", stageId: "de", entrantId: "E5", rank: 5, sameRoundEntrantId: "E6", sameRoundRank: 6 });
    expect(refusalOf(cases[4]![1]).data).toEqual({ reason: "not_competition_ranking", stageId: "de", entrantId: "E5", rank: 6, expected: 5 });
    expect(refusalOf(cases[5]![1]).data).toEqual({ reason: "title_shape", stageId: "de", title: "champion", rankOne: ["E1", "E2"] });
    // The plan's "non-neighbour" listing (E4 at 5, then the LB-final loser at 3, then the LB round-2 losers at 5) cannot
    // reach any relation: ranks that go down the list are refused first by the structural check.
    expect(reasonOf(guard(ranked(["E1", 1], ["E2", 2], ["E4", 5], ["E3", 3], ["E5", 5], ["E6", 5], ["E7", 7], ["E8", 7])))).toBe("CONFIG_INVALID rank_order");
  });

  it("X-FR-9 the deciding match's loser is 2nd by exit round: its exit is later than every LB round", () => {
    // RB6-R2: 2nd is the deciding match's loser. GF1's loser went out at the grand final, after every LB round, so ranking
    // the LB-final loser above them is an order refusal, and so is sharing 2nd with them.
    const { stage, rows } = full();
    const guard = (places: FinalPlace[]) => () => assertCompletedBracketPlaces(stage, rows, places);
    expect(refusalOf(guard(ranked(["E1", 1], ["E3", 2], ["E2", 3], ["E4", 4], ["E5", 5], ["E6", 5], ["E7", 7], ["E8", 7]))).data).toEqual({
      reason: "exit_round_order", stageId: "de", entrantId: "E3", rank: 2, laterEntrantId: "E2", laterRank: 3,
    });
    expect(reasonOf(guard(bySeed(1, 2, 2, 4, 5, 5, 7, 7)))).toBe("CONFIG_INVALID exit_round_order");
    // With the reset played, the reset's loser is the one out at the grand final's lane: E2 wins GF1, E1 the reset.
    const reset = play(8, { reset: true, winner: meetings("E1", "E2", "E1") });
    expect(completed(reset)).toEqual(RIGHT);
    expect(reasonOf(() => assertCompletedBracketPlaces(reset.stage, reset.rows, ranked(["E1", 1], ["E3", 2], ["E2", 3], ["E4", 4], ["E5", 5], ["E6", 5], ["E7", 7], ["E8", 7]))))
      .toBe("CONFIG_INVALID exit_round_order");
  });

  it("X-FR-9 the title shapes are refused when they do not match the deciding match", () => {
    // RB6-R8: joint winners are exactly the two at 1; a vacant title is nobody at 1 and the two at 2.
    const joint = play(8, { jointFinal: true });
    const vacant = play(8, { doubleWalkover: new Set(["gf"]) });
    const cases: [string, Played, FinalPlace[]][] = [
      ["joint winners written as a champion and a runner-up", joint, RIGHT],
      ["a vacant title written as a champion and a runner-up", vacant, RIGHT],
      ["a vacant title with a 1st (the LB-final loser written 1st above the two)", vacant,
        ranked(["E3", 1], ["E1", 2], ["E2", 2], ["E4", 4], ["E5", 5], ["E6", 5], ["E7", 7], ["E8", 7])],
      ["a champion title written as joint winners", full(), bySeed(1, 1, 3, 4, 5, 5, 7, 7)],
    ];
    let refused = 0;
    for (const [what, { stage, rows }, places] of cases) {
      expect(reasonOf(() => assertCompletedBracketPlaces(stage, rows, places)), what).toBe("CONFIG_INVALID title_shape");
      refused++;
    }
    expect(refused).toBe(4);
  });

  it("X-FR-9 a double elimination with no lanes is refused, never ranked strict", () => {
    // The W4 file's lane-less 4-draw (DRAW4's shape: S1 > S4, S2 > S3, S1 > S2, no play-off), rebuilt here, read as a
    // double elimination. The guard refuses it (no row says which lane it is in); the read path never refuses: the
    // semi-final losers have no lane, so no exit round, and share last (Task 6's fallback).
    const decided = (id: string, round: number, home: string, away: string, winner: string, extra: Partial<BracketFixture> = {}): BracketFixture => ({
      id, round, status: "decided", home, away, winner, loser: winner === home ? away : home, ...extra,
    });
    const draw4 = [decided("sf1", 0, "S1", "S4", "S1"), decided("sf2", 0, "S2", "S3", "S2"), decided("fin", 1, "S1", "S2", "S1", { isFinal: true })];
    const stage: BracketStage = { id: "de", kind: "double_elim", entrants: ["S1", "S2", "S3", "S4"] };
    expect(refusalOf(() => completeBracketStage(stage, draw4))).toEqual({ code: "CONFIG_INVALID", data: { reason: "lane_missing", stageId: "de", fixtureId: "sf1" } });
    expect(bracketRanks(stage, draw4)).toEqual(ranked(["S1", 1], ["S2", 2], ["S3", 3], ["S4", 3]));
  });
});

describe("the other three bracket kinds keep their guard (W6 X-FR-2)", () => {
  // single-sport: double-elimination structure and ranks are sport-agnostic (reads no SportModule)
  it("X-FR-2 the other three kinds still refuse a shared 5th", () => {
    // RB4-R2 (ruling 273): a knockout, a stepladder and a page playoff are strict below their declared shared places, and
    // BRACKET_SHARED_RANKS keeps its value. Each kind's own played rows, six declared entrants, places 1, 2, 3, 4, 5, 5.
    expect([...BRACKET_SHARED_RANKS]).toEqual([1, 2, 3, 4]);
    const kinds: [BracketStage["kind"], GeneratedBracket][] = [
      ["knockout", generateSingleElim({ entrants: ids(6), seeds: seedsOf(ids(6)) })],
      ["stepladder", generateStepladder({ entrants: ids(6), seeds: seedsOf(ids(6)) })],
      ["page_playoff", generatePagePlayoff({ entrants: ids(4), seeds: seedsOf(ids(4)) })],
    ];
    let checked = 0;
    for (const [kind, gen] of kinds) {
      const stage: BracketStage = { id: "s", kind, entrants: ids(6), seeds: seedsOf(ids(6)) };
      const rows = playOutBracket(gen, { seeds: seedsOf(ids(6)) });
      expect(refusalOf(() => assertCompletedBracketPlaces(stage, rows, bySeed(1, 2, 3, 4, 5, 5))), kind).toMatchObject({
        code: "CONFIG_INVALID",
        data: { reason: "not_a_shared_rank", rank: 5 },
      });
      checked++;
    }
    expect(checked, "kinds").toBe(3);
  });
});

describe("double elimination: the guard in sequence (W6 X-FR-9)", () => {
  // single-sport: double-elimination structure and ranks are sport-agnostic (reads no SportModule)
  it("X-FR-9 a second call passes again; a corrected result re-ranks, and the stale places are refused", () => {
    const walked = play(4, { doubleWalkover: new Set(["lb-r0-i0"]) });
    const shared = completed(walked);
    expect(shared).toEqual(bySeed(1, 2, 3, 3));
    expect(() => assertCompletedBracketPlaces(walked.stage, walked.rows, shared), "a second call").not.toThrow();
    // Undone and played (RB6-R2, n = 4: 4th is the loser of LB 1.1): the same row ids, now 1, 2, 3, 4.
    const corrected = play(4);
    expect(corrected.rows.map((r) => r.id)).toEqual(walked.rows.map((r) => r.id));
    expect(rowIn(corrected.rows, "lb-r0-i0")).toMatchObject({ status: "decided", loser: "E4" });
    expect(completed(corrected)).toEqual(bySeed(1, 2, 3, 4));
    // The places from before the correction no longer fit the rows: E3 now went out later than E4.
    expect(reasonOf(() => assertCompletedBracketPlaces(corrected.stage, corrected.rows, shared))).toBe("CONFIG_INVALID exit_round_order");
  });

  it("X-FR-9 while a reset is owed nothing is completed, and the provisional places have no title to pass", () => {
    // RB6-G7, §9: E2 (the LB champion) won GF1, so the reset is owed; void, completion refuses it (reset_owed); its
    // provisional places (both finalists in play) are refused by the guard (title_shape: no deciding match has decided).
    const owed = play(8, { reset: true, winner: meetings("E1", "E2"), voided: new Set(["gf-reset"]) });
    expect(resetOwed(owed.rows), "premise: owed").toBe(true);
    expect(refusalOf(() => completeBracketStage(owed.stage, owed.rows))).toMatchObject({ code: "STAGE_NOT_READY", data: { reason: "reset_owed" } });
    expect(refusalOf(() => assertCompletedBracketPlaces(owed.stage, owed.rows, bracketRanks(owed.stage, owed.rows))).data).toMatchObject({
      reason: "title_shape",
      title: "none",
    });
    // Played: E2 wins the reset too and the stage completes, E2 1st.
    expect(completed(play(8, { reset: true, winner: meetings("E1", "E2", "E2") }))).toEqual(ranked(["E2", 1], ["E1", 2], ["E3", 3], ["E4", 4], ["E5", 5], ["E6", 5], ["E7", 7], ["E8", 7]));
  });
});
