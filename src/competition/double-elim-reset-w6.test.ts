// W6 double elimination: the grand-final reset — when it is owed, and the completion refusal while an owed reset is
// void (rows X-DE-10, X-DE-11, X-DE-12, X-CH-9). Every expected value comes from the W6 rulebook (seazn.club
// rulebook-W6-double-elim.md §3 RB6-D6; §6 RB6-G4 to G11; §7 RB6-F7, F9; §9 RB6-C2 to C5), never from `resetOwed`'s
// own output.
//
// Numbering: rulebook rounds and games count from 1, engine ids from 0. `WB r.i` is `wb-r{r−1}-i{i−1}` and `LB t.p` is
// `lb-r{t−1}-i{p−1}`. GF1 is `gf`, the reset `gf-reset`.
//
// The rig is n = 4 in the generator's shape with the reset on (rounds: WB 0, 1; LB k + L = 2, 3; gf 4; gf-reset 5):
//   wb-r0-i0 W v X → W · wb-r0-i1 L v Y → L · wb-r1-i0 W v L → W (L drops) · lb-r0-i0 X v Y → X ·
//   lb-r1-i0 X v L → L · gf W v L (homeFrom winner of wb-r1-i0, awayFrom winner of lb-r1-i0) ·
//   gf-reset (conditional; homeFrom winner of gf, awayFrom loser of gf).
// W is the WB champion, L the LB champion.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import type { BracketSlotRef } from "../scheduling/bracket.ts";
import {
  bracketTitle,
  completeBracketStage,
  isBracketStageComplete,
  resetOwed,
  type BracketFixture,
  type BracketStage,
} from "./stage.ts";

const winnerOf = (fixtureId: string): BracketSlotRef => ({ fixtureId, side: "winner" });
const loserOf = (fixtureId: string): BracketSlotRef => ({ fixtureId, side: "loser" });
const played = (id: string, bracket: "WB" | "LB", round: number, home: string, away: string, winner: string): BracketFixture => ({
  id,
  bracket,
  round,
  status: "decided",
  home,
  away,
  winner,
  loser: winner === home ? away : home,
});

const stage: BracketStage = { id: "de", kind: "double_elim", entrants: ["W", "L", "X", "Y"] };

type Patch = Partial<BracketFixture> & { omit?: readonly (keyof BracketFixture)[] };
const patched = (row: BracketFixture, patch: Patch | undefined): BracketFixture => {
  if (patch === undefined) return row;
  const { omit = [], ...rest } = patch;
  const next: Record<string, unknown> = { ...row, ...rest };
  for (const key of omit) delete next[key];
  return next as unknown as BracketFixture;
};

// GF1 results, each a patch on the scheduled GF1 row (seats W home, L away).
const GF = {
  scheduled: {},
  wWon: { status: "decided", winner: "W", loser: "L" },
  lWon: { status: "decided", winner: "L", loser: "W" },
} as const satisfies Record<string, Patch>;

/** The rig. `gf` patches GF1's row, `reset` the reset's (null: no reset row at all, the "single match" setting);
 *  `early` replaces earlier rows by id. */
function rig(opts: { gf?: Patch; reset?: Patch | null; early?: Record<string, BracketFixture> } = {}): BracketFixture[] {
  const rows: BracketFixture[] = [
    played("wb-r0-i0", "WB", 0, "W", "X", "W"),
    played("wb-r0-i1", "WB", 0, "L", "Y", "L"),
    { ...played("wb-r1-i0", "WB", 1, "W", "L", "W"), homeFrom: winnerOf("wb-r0-i0"), awayFrom: winnerOf("wb-r0-i1") },
    { ...played("lb-r0-i0", "LB", 2, "X", "Y", "X"), homeFrom: loserOf("wb-r0-i0"), awayFrom: loserOf("wb-r0-i1") },
    { ...played("lb-r1-i0", "LB", 3, "X", "L", "L"), homeFrom: winnerOf("lb-r0-i0"), awayFrom: loserOf("wb-r1-i0") },
  ].map((row) => opts.early?.[row.id] ?? row);
  rows.push(
    patched(
      { id: "gf", bracket: "GF", round: 4, isFinal: true, status: "scheduled", home: "W", away: "L", homeFrom: winnerOf("wb-r1-i0"), awayFrom: winnerOf("lb-r1-i0") },
      opts.gf,
    ),
  );
  if (opts.reset !== null) {
    rows.push(
      patched(
        { id: "gf-reset", bracket: "GF", round: 5, isFinal: true, conditional: true, status: "void", homeFrom: winnerOf("gf"), awayFrom: loserOf("gf") },
        opts.reset,
      ),
    );
  }
  return rows;
}

/** The engine refusal a call throws; a call that returns instead fails the test. */
function refusalOf(run: () => unknown): { code: string; data: unknown } {
  try {
    run();
  } catch (e) {
    if (e instanceof EngineError) return { code: e.code, data: e.data };
    throw e;
  }
  throw new Error("expected a refusal, the call returned");
}

const top2 = (rows: readonly BracketFixture[]): [string, number][] =>
  completeBracketStage(stage, rows).finalRanks.slice(0, 2).map((p) => [p.entrantId, p.rank]);
const RESET_OWED = { stageId: "de", reason: "reset_owed", reset: "gf-reset", grandFinal: "gf" };

describe("double elimination: when the reset is owed (W6 X-DE-11)", () => {
  // single-sport: double-elimination structure and ranks are sport-agnostic (reads no SportModule)
  it("X-DE-11 no fixtures, and a bracket with no conditional row, owe nothing", () => {
    expect(resetOwed([])).toBe(false);
    // The "single match" setting: no reset row at all, the LB champion won GF1.
    expect(resetOwed(rig({ gf: GF.lWon, reset: null }))).toBe(false);
    // Review Focus 3: the app's rows before PR B carry a reset row with no `conditional`. It owes nothing, and the
    // stage completes as today: the void reset decides nothing, so GF1's winner is champion.
    const unflagged = rig({ gf: GF.lWon, reset: { omit: ["conditional"] } });
    expect(unflagged.find((r) => r.id === "gf-reset")?.conditional).toBeUndefined();
    expect(resetOwed(unflagged)).toBe(false);
    expect(isBracketStageComplete(stage, unflagged)).toBe(true);
    expect(completeBracketStage(stage, unflagged).title).toEqual({ kind: "champion", champion: "L" });
  });

  it("X-DE-11 the shapes of GF1 (counted)", () => {
    // RB6-G11: owed exactly when GF1 is settled with a winner, that winner is the LB champion, and GF1 has a loser, the
    // WB champion, still in the stage. RB6-D6: seat order is not ruled, so swapping GF1's seats changes nothing.
    // F7 shape: the WB final was a double walkover (RB6-F7), both out, so lb-r1-i0's dropped seat is dead and X walks
    // over it; GF1's WB seat is empty and X takes GF1 by walkover with no loser.
    const f7 = {
      "wb-r1-i0": { id: "wb-r1-i0", bracket: "WB", round: 1, status: "walkover", home: "W", away: "L", walkedOver: "both", homeFrom: winnerOf("wb-r0-i0"), awayFrom: winnerOf("wb-r0-i1") },
      "lb-r1-i0": { id: "lb-r1-i0", bracket: "LB", round: 3, status: "walkover", home: "X", winner: "X", homeFrom: winnerOf("lb-r0-i0"), awayFrom: loserOf("wb-r1-i0") },
    } satisfies Record<string, BracketFixture>;
    const table: ReadonlyArray<{ gf1: string; gf: Patch; owed: boolean; title?: unknown; early?: Record<string, BracketFixture> }> = [
      { gf1: "scheduled", gf: GF.scheduled, owed: false }, // RB6-G8
      { gf1: "decided, W won", gf: GF.wWon, owed: false, title: { kind: "champion", champion: "W" } }, // RB6-G6
      { gf1: "decided, L won", gf: GF.lWon, owed: true }, // RB6-G11
      { gf1: "decided, L won, seats swapped", gf: { ...GF.lWon, home: "L", away: "W" }, owed: true }, // RB6-D6
      { gf1: "decided, W won, seats swapped", gf: { ...GF.wWon, home: "L", away: "W" }, owed: false, title: { kind: "champion", champion: "W" } }, // RB6-D6
      { gf1: "joint winners", gf: { status: "decided", jointWinners: true }, owed: false, title: { kind: "joint", winners: ["W", "L"] } }, // RB6-G11, C5
      { gf1: "double walkover", gf: { status: "walkover", walkedOver: "both" }, owed: false, title: { kind: "vacant" } }, // RB6-C4
      // RB6-C2: W withdrew before GF1, out of the stage — the forfeit the app marks walkedOver "loser".
      { gf1: "walkover, L won, W out", gf: { status: "walkover", winner: "L", loser: "W", walkedOver: "loser" }, owed: false, title: { kind: "champion", champion: "L" } },
      // RB6-F7, G11: GF1 settled with no loser.
      { gf1: "walkover, no loser (WB-final double walkover)", gf: { status: "walkover", omit: ["home"], away: "X", winner: "X" }, owed: false, title: { kind: "champion", champion: "X" }, early: f7 },
    ];
    let checked = 0;
    for (const row of table) {
      const rows = rig({ gf: row.gf, ...(row.early === undefined ? {} : { early: row.early }) });
      expect(resetOwed(rows), row.gf1).toBe(row.owed);
      if (row.owed) {
        expect(refusalOf(() => completeBracketStage(stage, rows)), row.gf1).toEqual({ code: "STAGE_NOT_READY", data: RESET_OWED });
      } else if (row.gf1 === "scheduled") {
        expect(refusalOf(() => completeBracketStage(stage, rows)), row.gf1).toEqual({
          code: "STAGE_NOT_READY",
          data: { stageId: "de", reason: "fixtures_undecided", undecided: ["gf"] },
        });
      } else {
        // Not owed: the reset does not exist (RB6-G6), so its void row is settled and the stage completes.
        expect(isBracketStageComplete(stage, rows), row.gf1).toBe(true);
        expect(completeBracketStage(stage, rows).title, row.gf1).toEqual(row.title);
      }
      checked++;
    }
    expect(checked).toBe(9);
    expect(table.filter((r) => r.owed)).toHaveLength(2); // the answer is not a constant over the table
  });

  it("X-DE-11 a forfeit in GF1 by the WB champion earns the reset; by the LB champion it does not", () => {
    // RB6-F9: a one-loss forfeit is a plain loss (a walkover with a winner and a loser, no walkedOver).
    const byW = rig({ gf: { status: "walkover", winner: "L", loser: "W" } });
    expect(resetOwed(byW)).toBe(true);
    // RB6-F9 with the reset on: the reset is earned and RB6-G7 applies — a void reset refuses completion.
    expect(refusalOf(() => completeBracketStage(stage, byW))).toEqual({ code: "STAGE_NOT_READY", data: RESET_OWED });
    // By the LB champion: their second loss, the WB champion is champion and no reset exists (the GF1 walkover won by
    // the WB side), so the void reset row settles nothing and the stage completes.
    const byL = rig({ gf: { status: "walkover", winner: "W", loser: "L" } });
    expect(resetOwed(byL)).toBe(false);
    expect(completeBracketStage(stage, byL).title).toEqual({ kind: "champion", champion: "W" });
  });

  it("X-DE-11 GF1 void, or naming a loser and no winner, owes nothing", () => {
    // RB6-G11: owed only when GF1 "is settled with a winner". A void GF1 decided nothing: no reset, and with the reset
    // void too nothing crowned anyone, so completion is the existing no-title wiring refusal.
    const voidGf = rig({ gf: { status: "void" } });
    expect(resetOwed(voidGf)).toBe(false);
    expect(refusalOf(() => completeBracketStage(stage, voidGf))).toEqual({ code: "CONFIG_INVALID", data: { reason: "no_title", stageId: "de" } });
    // A row naming a loser (W) but no winner, with the LB final void (it delivered nobody): the winner term is what
    // stops `undefined === undefined` reading as "the LB champion won".
    const lbFinalVoid = { id: "lb-r1-i0", bracket: "LB", round: 3, status: "void", homeFrom: winnerOf("lb-r0-i0"), awayFrom: loserOf("wb-r1-i0") } satisfies BracketFixture;
    expect(resetOwed(rig({ gf: { status: "decided", loser: "W", omit: ["away"] }, early: { "lb-r1-i0": lbFinalVoid } }))).toBe(false);
  });

  it("X-DE-11 a reset row still scheduled: owed, it is a match to play; not owed, completion still refuses it", () => {
    // RB6-G10: owed ⇒ the stage is not complete until the reset is decided, walked over or settled.
    const owed = rig({ gf: GF.lWon, reset: { status: "scheduled", home: "L", away: "W" } });
    expect(resetOwed(owed)).toBe(true);
    expect(refusalOf(() => completeBracketStage(stage, owed))).toEqual({ code: "STAGE_NOT_READY", data: { stageId: "de", reason: "fixtures_undecided", undecided: ["gf-reset"] } });
    // RB6-G6 says a reset that is not owed does not exist; the engine does not void it for the caller
    // (undecidedBracketFixtures is unchanged), so a scheduled one still refuses: app PR B's settleReset must void the
    // reset the moment resetOwed turns false. Pinned so that contract is visible.
    const notOwed = rig({ gf: GF.wWon, reset: { status: "scheduled" } });
    expect(resetOwed(notOwed)).toBe(false);
    expect(refusalOf(() => completeBracketStage(stage, notOwed))).toEqual({ code: "STAGE_NOT_READY", data: { stageId: "de", reason: "fixtures_undecided", undecided: ["gf-reset"] } });
  });

  it("X-DE-11 n = 2: the LB champion is the WB final's loser", () => {
    // RB6-E3 (Review Focus 5): GF1 is the WB final's pair again; its LB feed is the loser of wb-r0-i0.
    const n2 = (gfWinner: "W" | "L"): BracketFixture[] => [
      played("wb-r0-i0", "WB", 0, "W", "L", "W"),
      { id: "gf", bracket: "GF", round: 1, isFinal: true, status: "decided", home: "W", away: "L", winner: gfWinner, loser: gfWinner === "W" ? "L" : "W", homeFrom: winnerOf("wb-r0-i0"), awayFrom: loserOf("wb-r0-i0") },
      { id: "gf-reset", bracket: "GF", round: 2, isFinal: true, conditional: true, status: "void", homeFrom: winnerOf("gf"), awayFrom: loserOf("gf") },
    ];
    expect(resetOwed(n2("L"))).toBe(true);
    expect(resetOwed(n2("W"))).toBe(false);
    const two: BracketStage = { id: "de", kind: "double_elim", entrants: ["W", "L"] };
    expect(refusalOf(() => completeBracketStage(two, n2("L")))).toEqual({ code: "STAGE_NOT_READY", data: RESET_OWED });
  });

  it("X-DE-11 the reading refuses a broken wiring", () => {
    const configInvalid = (rows: BracketFixture[]): unknown => {
      const e = refusalOf(() => resetOwed(rows));
      return { code: e.code, reason: (e.data as { reason: string }).reason };
    };
    const cases: ReadonlyArray<[what: string, rows: BracketFixture[], reason: string]> = [
      ["two conditional rows", [...rig(), { id: "gf-reset-2", bracket: "GF", round: 6, isFinal: true, conditional: true, status: "void", homeFrom: winnerOf("gf"), awayFrom: loserOf("gf") }], "reset_not_unique"],
      ["a reset with no awayFrom", rig({ reset: { omit: ["awayFrom"] } }), "reset_feed_invalid"],
      ["a reset with no homeFrom", rig({ reset: { omit: ["homeFrom"] } }), "reset_feed_invalid"],
      ["a reset whose feeds name two fixtures", rig({ reset: { awayFrom: loserOf("lb-r1-i0") } }), "reset_feed_invalid"],
      ["a reset whose feeds are both winners", rig({ reset: { awayFrom: winnerOf("gf") } }), "reset_feed_invalid"],
      ["a reset fed by a fixture not in the list", rig({ reset: { homeFrom: winnerOf("gone"), awayFrom: loserOf("gone") } }), "reset_feed_invalid"],
      ["GF1 with no homeFrom", rig({ gf: { omit: ["homeFrom"] } }), "grand_final_feed_invalid"],
      ["GF1 with no awayFrom", rig({ gf: { omit: ["awayFrom"] } }), "grand_final_feed_invalid"],
      ["GF1 with both feeds from LB rows", rig({ gf: { homeFrom: winnerOf("lb-r0-i0") } }), "grand_final_feed_invalid"],
      ["GF1 with both feeds WB winners", rig({ gf: { awayFrom: winnerOf("wb-r0-i0") } }), "grand_final_feed_invalid"],
      ["GF1 fed by a fixture not in the list", rig({ gf: { awayFrom: winnerOf("gone") } }), "grand_final_feed_invalid"],
    ];
    let checked = 0;
    for (const [what, rows, reason] of cases) {
      expect(configInvalid(rows), what).toEqual({ code: "CONFIG_INVALID", reason });
      checked++;
    }
    expect(checked).toBe(11);
    // The data names the fixture(s) whose wiring is wrong.
    expect(refusalOf(() => resetOwed(cases[0]![1])).data).toEqual({ reason: "reset_not_unique", fixtureIds: ["gf-reset", "gf-reset-2"] });
    expect(refusalOf(() => resetOwed(rig({ reset: { omit: ["awayFrom"] } }))).data).toEqual({ reason: "reset_feed_invalid", fixtureId: "gf-reset" });
    expect(refusalOf(() => resetOwed(rig({ gf: { omit: ["homeFrom"] } }))).data).toEqual({ reason: "grand_final_feed_invalid", fixtureId: "gf" });
    // Every reader of a settled bracket reads the same answer, so every one refuses the same wiring.
    const broken = rig({ gf: { ...GF.lWon, omit: ["homeFrom"] } });
    for (const read of [() => isBracketStageComplete(stage, broken), () => completeBracketStage(stage, broken), () => bracketTitle(broken)]) {
      expect(refusalOf(read)).toMatchObject({ code: "CONFIG_INVALID", data: { reason: "grand_final_feed_invalid" } });
    }
  });

  it("X-DE-10 two malformed states: an owed reset settled with no result crowns nobody; broken wiring throws before an unsettled final", () => {
    // Task 6 review m9, plan's call: undefined, not GF1's champion. RB6 §9: once the reset is owed the deciding match is the
    // reset, and RB6-C6: an unplayed deciding match is never decided by anything else, so GF1's winner L is not champion.
    // Before Task 6 this state answered L. Completion then refuses the settled stage as a wiring bug (no_title).
    const noResult = rig({ gf: GF.lWon, reset: { status: "decided", home: "L", away: "W" } });
    expect(resetOwed(noResult), "premise: owed").toBe(true);
    expect(bracketTitle(noResult)).toBeUndefined();
    expect(refusalOf(() => completeBracketStage(stage, noResult))).toEqual({ code: "CONFIG_INVALID", data: { reason: "no_title", stageId: "de" } });
    // The wiring is read first, whatever the finals say: with GF1 still scheduled (a final unsettled) a GF1 with no feed is
    // refused, where before Task 6 bracketTitle returned undefined for the unsettled final without reading it.
    const brokenOpen = rig({ gf: { omit: ["homeFrom"] } });
    expect(refusalOf(() => bracketTitle(brokenOpen))).toMatchObject({ code: "CONFIG_INVALID", data: { reason: "grand_final_feed_invalid", fixtureId: "gf" } });
  });

  it("X-DE-11 a second call answers the same and changes nothing; correcting GF1 flips the answer each time", () => {
    const rows = rig({ gf: GF.lWon });
    const before = structuredClone(rows);
    expect(resetOwed(rows)).toBe(true);
    expect(resetOwed(rows)).toBe(true);
    expect(rows).toEqual(before);
    // RB6-G9: read from GF1's current result every time — corrected, corrected back, and undone.
    const flips = [GF.scheduled, GF.lWon, GF.wWon, GF.lWon, GF.scheduled].map((gf) => resetOwed(rig({ gf })));
    expect(flips).toEqual([false, true, false, true, false]);
  });
});

describe("double elimination: an earned reset cannot be voided (W6 X-DE-12)", () => {
  // single-sport: double-elimination structure and ranks are sport-agnostic (reads no SportModule)
  it("X-DE-12 an earned reset that is void refuses completion", () => {
    // RB6-G7, G10: L won GF1, so the reset is owed; a void reset row does not settle it.
    // differential: today it completes and ranks GF1's winner 1st (stage.ts:283-287, :825-834).
    const rows = rig({ gf: GF.lWon });
    expect(refusalOf(() => completeBracketStage(stage, rows))).toEqual({ code: "STAGE_NOT_READY", data: RESET_OWED });
    expect(isBracketStageComplete(stage, rows)).toBe(false);
    expect(bracketTitle(rows)).toBeUndefined();
    let message = "";
    try {
      completeBracketStage(stage, rows);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe('bracket stage "de" owes a grand-final reset ("gf-reset") that is void');
  });

  it("X-DE-11 the pair: the WB champion won GF1, the reset is void, the stage completes", () => {
    // RB6-G6: the reset does not exist, so its void row is no refusal. W 1st, L 2nd.
    const rows = rig({ gf: GF.wWon });
    expect(isBracketStageComplete(stage, rows)).toBe(true);
    expect(bracketTitle(rows)).toEqual({ kind: "champion", champion: "W" });
    expect(top2(rows)).toEqual([["W", 1], ["L", 2]]);
  });

  it("X-DE-12 the owed-and-void rows, with the reset then played, complete", () => {
    // Sequence: refused while void; the same rows with the reset decided complete (RB6-G10).
    const owed = rig({ gf: GF.lWon });
    expect(isBracketStageComplete(stage, owed)).toBe(false);
    const playedOut = rig({ gf: GF.lWon, reset: { status: "decided", home: "L", away: "W", winner: "L", loser: "W" } });
    expect(resetOwed(playedOut)).toBe(true); // still owed: owed is GF1's answer, settled is the reset row's
    expect(isBracketStageComplete(stage, playedOut)).toBe(true);
    expect(completeBracketStage(stage, playedOut).title).toEqual({ kind: "champion", champion: "L" });
  });
});

describe("double elimination: the deciding match (W6 X-DE-10)", () => {
  // single-sport: double-elimination structure and ranks are sport-agnostic (reads no SportModule)
  it("X-DE-10 reset played: the LB champion must win twice", () => {
    // RB6-G4: L won GF1, so the reset is played and its winner is champion.
    const lTwice = rig({ gf: GF.lWon, reset: { status: "decided", home: "L", away: "W", winner: "L", loser: "W" } });
    expect(bracketTitle(lTwice)).toEqual({ kind: "champion", champion: "L" });
    expect(top2(lTwice)).toEqual([["L", 1], ["W", 2]]);
    const wBack = rig({ gf: GF.lWon, reset: { status: "decided", home: "L", away: "W", winner: "W", loser: "L" } });
    expect(bracketTitle(wBack)).toEqual({ kind: "champion", champion: "W" });
    expect(top2(wBack)).toEqual([["W", 1], ["L", 2]]);
  });

  it("X-DE-10 single match: GF1 decides", () => {
    // RB6-G5: no reset row; L won GF1 and is champion, W (one loss) is 2nd.
    const rows = rig({ gf: GF.lWon, reset: null });
    expect(bracketTitle(rows)).toEqual({ kind: "champion", champion: "L" });
    expect(top2(rows)).toEqual([["L", 1], ["W", 2]]);
  });
});

describe("double elimination: a finalist out on an earned reset (W6 X-CH-9)", () => {
  // single-sport: double-elimination structure and ranks are sport-agnostic (reads no SportModule)
  it("X-CH-9 a finalist out between GF1 and an earned reset: the reset is a walkover and settles it", () => {
    // RB6-C3: W withdrew after losing GF1; the reset is a walkover L wins, "walked over" under RB6-G7.
    const rows = rig({ gf: GF.lWon, reset: { status: "walkover", home: "L", away: "W", winner: "L", loser: "W", walkedOver: "loser" } });
    expect(resetOwed(rows)).toBe(true);
    expect(isBracketStageComplete(stage, rows)).toBe(true);
    expect(completeBracketStage(stage, rows).title).toEqual({ kind: "champion", champion: "L" });
  });

  it("X-CH-9 both out on the reset: vacant title", () => {
    // RB6-C4: both finalists out between GF1 and the reset — the title is vacant.
    const rows = rig({ gf: GF.lWon, reset: { status: "walkover", home: "L", away: "W", walkedOver: "both" } });
    expect(isBracketStageComplete(stage, rows)).toBe(true);
    expect(completeBracketStage(stage, rows).title).toEqual({ kind: "vacant" });
  });

  it("X-CH-9 joint winners declared on an earned reset settle it: both finalists 1st", () => {
    // RB6-C5: "Declared on an earned reset, it settles the reset for RB6-G7"; both finalists rank 1st.
    const rows = rig({ gf: GF.lWon, reset: { status: "decided", home: "L", away: "W", jointWinners: true } });
    expect(resetOwed(rows)).toBe(true);
    expect(isBracketStageComplete(stage, rows)).toBe(true);
    const done = completeBracketStage(stage, rows);
    expect(done.title.kind).toBe("joint");
    expect(done.title.kind === "joint" ? [...done.title.winners].sort() : []).toEqual(["L", "W"]);
    expect(top2(rows).sort()).toEqual([["L", 1], ["W", 1]]);
  });
});
