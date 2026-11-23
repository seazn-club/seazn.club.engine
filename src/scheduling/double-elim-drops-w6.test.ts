// W6 double elimination: losers'-bracket drops cross by the four-step cycle (rows X-DE-2, X-DE-3, X-DE-4, X-DE-5).
// Every expected value comes from the W6 rulebook (seazn.club rulebook-W6-double-elim.md §3 RB6-D1, RB6-D3, RB6-D5 and
// §4 RB6-X1 to RB6-X5 with its worked tables for 4, 8 and 16), never from generateDoubleElim's own output.
//
// Numbering: rulebook rounds and games count from 1, engine ids from 0. `WB r.i` is `wb-r{r−1}-i{i−1}` and `LB t.p` is
// `lb-r{t−1}-i{p−1}`. So rulebook LB round 2(r−1) (the drop of WB round r) is engine `lb-r{2r−3}`, and the index's m is
// r − 2 (m = 0 is WB round 2).
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { generateDoubleElim, lbDropGameRB6X2, type BracketFixtureGen, type BracketSlotRef } from "./bracket.ts";

const field = (n: number): string[] => Array.from({ length: n }, (_, i) => `s${i + 1}`);
const byId = (fixtures: readonly BracketFixtureGen[]): Map<string, BracketFixtureGen> =>
  new Map(fixtures.map((f) => [f.id, f]));
const W = (fixtureId: string): BracketSlotRef => ({ fixtureId, side: "winner" });
const L = (fixtureId: string): BracketSlotRef => ({ fixtureId, side: "loser" });
// RB6-D1: the frame is the smallest 2^k (k ≥ 1) that holds the field.
const frameDepth = (n: number): number => {
  let k = 1;
  while (2 ** k < n) k++;
  return k;
};

// RB6-X2 in its own 1-based form, converted at the edges: the LB game p that takes the loser of WB game i, in a drop
// of G games whose cycle step is c = (r − 2) mod 4.
function rb6x2(c: number, G: number, i0: number): number {
  const i = i0 + 1;
  let p: number;
  if (G === 1) p = 1;
  else if (c === 0) p = G + 1 - i; // reversed
  else if (c === 1) p = i <= G / 2 ? G / 2 + 1 - i : (3 * G) / 2 + 1 - i; // reversed then switched
  else if (c === 2) p = i <= G / 2 ? i + G / 2 : i - G / 2; // switched
  else p = i; // c = 3 regular
  return p - 1;
}

describe("double elimination structure (W6 X-DE-2)", () => {
  // single-sport: double-elimination structure and ranks are sport-agnostic (reads no SportModule)
  it("X-DE-2 a field of 2 has no losers' bracket row", () => {
    // RB6-E3: n = 2 is one WB match; the WB loser is the LB champion, so no LB match exists.
    const { fixtures } = generateDoubleElim({ entrants: field(2) });
    expect(fixtures.length).toBeGreaterThan(0);
    expect(fixtures.filter((f) => f.bracket === "LB")).toEqual([]);
  });

  it("X-DE-2 the frame, the round counts and the game counts", () => {
    let sizes = 0;
    for (let n = 2; n <= 32; n++) {
      const k = frameDepth(n); // RB6-D1
      const { fixtures, rounds } = generateDoubleElim({ entrants: field(n) });
      expect(rounds).toBe(k);
      const wb = fixtures.filter((f) => f.bracket === "WB");
      // RB6-D1: a single elimination of k rounds, 2^(k−r) games in WB round r.
      expect(new Set(wb.map((f) => f.round)).size).toBe(k);
      for (let r = 1; r <= k; r++) expect(wb.filter((f) => f.round === r - 1).length).toBe(2 ** (k - r));
      const lb = fixtures.filter((f) => f.bracket === "LB");
      const lbRounds = [...new Set(lb.map((f) => f.round))].sort((a, b) => a - b);
      expect(lbRounds.length).toBe(2 * (k - 1)); // RB6-D3
      // RB6-D3: LB rounds 2r−3 and 2r−2 hold 2^(k−r) games each, r = 2 … k.
      for (let r = 2; r <= k; r++) {
        for (const t of [2 * r - 3, 2 * r - 2]) {
          expect(fixtures.filter((f) => f.id.startsWith(`lb-r${t - 1}-`)).length).toBe(2 ** (k - r));
        }
      }
      // RB6-D4: an entrant is out at the second loss. A WB loser (a first loss) feeds exactly one later seat; an LB
      // loser (a second loss) feeds none; with the reset on, the grand final's loser feeds only the conditional reset.
      const withReset = generateDoubleElim({ entrants: field(n), bracketReset: true }).fixtures;
      const seats: Array<[string, BracketSlotRef]> = withReset.flatMap((f) =>
        [f.homeFrom, f.awayFrom].filter((s): s is BracketSlotRef => s !== undefined).map((s): [string, BracketSlotRef] => [f.id, s]),
      );
      const feeds = seats.map(([, s]) => s);
      const lbIds = new Set(lb.map((f) => f.id));
      expect(feeds.filter((s) => s.side === "loser" && lbIds.has(s.fixtureId))).toEqual([]);
      for (const w of wb) {
        const takers = feeds.filter((s) => s.side === "loser" && s.fixtureId === w.id).length;
        expect(takers, w.id).toBe(1); // a bye's loser seat is wired too (RB6-X5: the frame)
      }
      expect(seats.filter(([, s]) => s.side === "loser" && s.fixtureId === "gf").map(([id]) => id)).toEqual(["gf-reset"]);
      sizes++;
    }
    expect(sizes).toBe(31);
  });
});

describe("losers' bracket round 1 (W6 X-DE-3)", () => {
  // single-sport: double-elimination structure and ranks are sport-agnostic (reads no SportModule)
  it("X-DE-3 LB round 1 pairs adjacent WB round-1 losers in order", () => {
    let games = 0;
    for (const frame of [4, 8, 16, 32]) {
      const fx = byId(generateDoubleElim({ entrants: field(frame) }).fixtures);
      for (let j = 0; j < frame / 4; j++) {
        // RB6-X1: LB 1.j = L WB 1.(2j−1) v L WB 1.(2j), 1-based.
        const g = fx.get(`lb-r0-i${j}`);
        expect(g?.homeFrom).toEqual(L(`wb-r0-i${2 * j}`));
        expect(g?.awayFrom).toEqual(L(`wb-r0-i${2 * j + 1}`));
        games++;
      }
    }
    expect(games).toBe(15);
  });
});

describe("losers' bracket drops cross (W6 X-DE-4)", () => {
  // single-sport: double-elimination structure and ranks are sport-agnostic (reads no SportModule)
  it("X-DE-4 the worked tables for 4, 8 and 16", () => {
    // [n, LB game (engine id), the WB game whose loser it takes] — typed from the rulebook §4 worked tables.
    const tables: Array<[number, string, string]> = [
      [4, "lb-r1-i0", "wb-r1-i0"], // RB6-X2 n=4: LB 2.1 = W LB 1.1 v L WB 2.1
      // differential: today lb-r1-i0 ← wb-r1-i0 and lb-r1-i1 ← wb-r1-i1 (bracket.ts:486)
      [8, "lb-r1-i0", "wb-r1-i1"], // RB6-X2 n=8: LB 2.1 = W LB 1.1 v L WB 2.2
      [8, "lb-r1-i1", "wb-r1-i0"], // RB6-X2 n=8: LB 2.2 = W LB 1.2 v L WB 2.1
      [8, "lb-r3-i0", "wb-r2-i0"], // RB6-X4 n=8: LB 4.1 = W LB 3.1 v L WB 3.1
      [16, "lb-r1-i0", "wb-r1-i3"], // RB6-X2 n=16: LB 2.1 = W LB 1.1 v L WB 2.4
      [16, "lb-r1-i1", "wb-r1-i2"], // RB6-X2 n=16: LB 2.2 = W LB 1.2 v L WB 2.3
      [16, "lb-r1-i2", "wb-r1-i1"], // RB6-X2 n=16: LB 2.3 = W LB 1.3 v L WB 2.2
      [16, "lb-r1-i3", "wb-r1-i0"], // RB6-X2 n=16: LB 2.4 = W LB 1.4 v L WB 2.1
      [16, "lb-r3-i0", "wb-r2-i0"], // RB6-X2 n=16: LB 4.1 = W LB 3.1 v L WB 3.1
      [16, "lb-r3-i1", "wb-r2-i1"], // RB6-X2 n=16: LB 4.2 = W LB 3.2 v L WB 3.2
      [16, "lb-r5-i0", "wb-r3-i0"], // RB6-X4 n=16: LB 6.1 = W LB 5.1 v L WB 4.1
    ];
    let checked = 0;
    for (const [n, lbId, wbId] of tables) {
      const fx = byId(generateDoubleElim({ entrants: field(n) }).fixtures);
      const g = fx.get(lbId);
      const [, round, game] = /^lb-r(\d+)-i(\d+)$/.exec(lbId) as RegExpExecArray;
      expect(g?.awayFrom, `${n} ${lbId}`).toEqual(L(wbId));
      expect(g?.homeFrom, `${n} ${lbId}`).toEqual(W(`lb-r${Number(round) - 1}-i${game}`));
      checked++;
    }
    expect(checked).toBe(11);
  });

  it("X-DE-4 the generator walks the whole cycle on 32, 64 and 128", () => {
    // Named games, worked by hand from RB6-X2 and §4's "Which order each size uses" (r = WB round, G its game count):
    // [frame, LB game, the WB game whose loser it takes].
    const named: Array<[number, string, string]> = [
      // 32, r=2, G=8, c=0 reversed: WB 2.1 → LB 2.8, WB 2.8 → LB 2.1
      [32, "lb-r1-i7", "wb-r1-i0"], [32, "lb-r1-i0", "wb-r1-i7"],
      // 32, r=3, G=4, c=1 reversed then switched: WB 3.1→2, 3.2→1, 3.3→4, 3.4→3
      [32, "lb-r3-i0", "wb-r2-i1"], [32, "lb-r3-i1", "wb-r2-i0"], [32, "lb-r3-i2", "wb-r2-i3"], [32, "lb-r3-i3", "wb-r2-i2"],
      // 32, r=4, G=2, c=2 switched (two games: a swap): WB 4.1 → LB 6.2, WB 4.2 → LB 6.1
      [32, "lb-r5-i0", "wb-r3-i1"], [32, "lb-r5-i1", "wb-r3-i0"],
      // 32, r=5, G=1: the WB final's loser lands in the one-game LB final
      [32, "lb-r7-i0", "wb-r4-i0"],
      // 64, r=3, G=8, c=1: WB 3.4 → LB 4.1, 3.1 → 4.4, 3.8 → 4.5, 3.5 → 4.8
      [64, "lb-r3-i0", "wb-r2-i3"], [64, "lb-r3-i3", "wb-r2-i0"], [64, "lb-r3-i4", "wb-r2-i7"], [64, "lb-r3-i7", "wb-r2-i4"],
      // 64, r=4, G=4, c=2 switched: WB 4.3 → LB 6.1, 4.4 → 6.2, 4.1 → 6.3, 4.2 → 6.4
      [64, "lb-r5-i0", "wb-r3-i2"], [64, "lb-r5-i1", "wb-r3-i3"], [64, "lb-r5-i2", "wb-r3-i0"], [64, "lb-r5-i3", "wb-r3-i1"],
      // 64, r=5, G=2, c=3 regular
      [64, "lb-r7-i0", "wb-r4-i0"], [64, "lb-r7-i1", "wb-r4-i1"],
      // 64, r=6, G=1
      [64, "lb-r9-i0", "wb-r5-i0"],
      // 128, r=5, G=4, c=3 regular: WB 5.3 → LB 8.3
      [128, "lb-r7-i2", "wb-r4-i2"],
      // 128, r=6, G=2, c=0 again (the cycle wraps): reversed, WB 6.1 → LB 10.2
      [128, "lb-r9-i0", "wb-r5-i1"], [128, "lb-r9-i1", "wb-r5-i0"],
      // 128, r=7, G=1
      [128, "lb-r11-i0", "wb-r6-i0"],
    ];
    const frames = new Map([32, 64, 128].map((f) => [f, byId(generateDoubleElim({ entrants: field(f) }).fixtures)]));
    for (const [frame, lbId, wbId] of named) {
      expect(frames.get(frame)?.get(lbId)?.awayFrom, `${frame} ${lbId}`).toEqual(L(wbId));
    }
    expect(named.length).toBe(24);
    // And every drop game of those frames against the test's own 1-based RB6-X2 (rb6x2), never the engine's index.
    let drops = 0;
    for (const [frame, fx] of frames) {
      const k = frameDepth(frame);
      for (let r = 2; r <= k; r++) {
        const G = 2 ** (k - r);
        for (let i = 0; i < G; i++) {
          const p = rb6x2((r - 2) % 4, G, i);
          expect(fx.get(`lb-r${2 * r - 3}-i${p}`)?.awayFrom, `${frame} WB ${r}.${i + 1}`).toEqual(L(`wb-r${r - 1}-i${i}`));
          drops++;
        }
      }
    }
    expect(drops).toBe(15 + 31 + 63);
  });

  it("X-DE-4 the four steps of the cycle, by the rule's own formula", () => {
    // RB6-X2, one literal row per step at G = 8, i = 0 … 7.
    const literal: number[][] = [
      [7, 6, 5, 4, 3, 2, 1, 0], // c = 0 reversed
      [3, 2, 1, 0, 7, 6, 5, 4], // c = 1 reversed then switched
      [4, 5, 6, 7, 0, 1, 2, 3], // c = 2 switched
      [0, 1, 2, 3, 4, 5, 6, 7], // c = 3 regular
    ];
    let compared = 0;
    for (let c = 0; c < 4; c++) {
      for (const m of [c, c + 4]) {
        expect(Array.from({ length: 8 }, (_, i) => lbDropGameRB6X2(m, 8, i))).toEqual(literal[c]);
        for (const G of [2, 4, 8, 16]) {
          for (let i = 0; i < G; i++) {
            expect(lbDropGameRB6X2(m, G, i), `m=${m} G=${G} i=${i}`).toBe(rb6x2(c, G, i));
            compared++;
          }
        }
        expect(lbDropGameRB6X2(m, 1, 0)).toBe(0); // RB6-X2: when G = 1, p = 1
      }
    }
    // 8 values of m × (2 + 4 + 8 + 16) indices.
    expect(compared).toBe(8 * 30);
  });

  it("X-DE-4 every step is its own inverse and a bijection", () => {
    let triples = 0;
    for (let m = 0; m < 8; m++) {
      for (let G = 1; G <= 128; G *= 2) {
        const image = new Set<number>();
        for (let i = 0; i < G; i++) {
          const p = lbDropGameRB6X2(m, G, i);
          expect(lbDropGameRB6X2(m, G, p), `m=${m} G=${G} i=${i}`).toBe(i);
          image.add(p);
          triples++;
        }
        expect([...image].sort((a, b) => a - b)).toEqual(Array.from({ length: G }, (_, i) => i));
      }
    }
    expect(triples).toBe(2040);
  });

  it("X-DE-4 every losers' bracket seat is fed exactly once", () => {
    let seats = 0;
    let expectedSeats = 0;
    for (const frame of [4, 8, 16, 32, 64]) {
      const { fixtures } = generateDoubleElim({ entrants: field(frame) });
      const lb = fixtures.filter((f) => f.bracket === "LB");
      const lbIds = new Set(lb.map((f) => f.id));
      const all = fixtures.flatMap((f) => [f.homeFrom, f.awayFrom]).filter((s): s is BracketSlotRef => s !== undefined);
      const lbSeats = lb.flatMap((f) => [f.homeFrom, f.awayFrom]);
      for (const s of lbSeats) expect(s).toBeDefined();
      // Each WB fixture's loser feeds exactly one seat.
      for (const w of fixtures.filter((f) => f.bracket === "WB")) {
        expect(all.filter((s) => s.side === "loser" && s.fixtureId === w.id).length, w.id).toBe(1);
      }
      // Each LB fixture's winner feeds exactly one seat (the last one's feeds the grand final); no LB loser is fed.
      for (const g of lb) {
        expect(all.filter((s) => s.side === "winner" && s.fixtureId === g.id).length, g.id).toBe(1);
        expect(all.filter((s) => s.side === "loser" && s.fixtureId === g.id).length, g.id).toBe(0);
      }
      // No LB seat is named twice.
      const keys = lbSeats.map((s) => `${s?.side}:${s?.fixtureId}`);
      expect(new Set(keys).size).toBe(keys.length);
      expect(lbIds.size).toBe(frame - 2);
      seats += lbSeats.length;
      expectedSeats += 2 * (frame - 2);
    }
    expect(seats).toBe(expectedSeats);
    expect(seats).toBe(2 * (2 + 6 + 14 + 30 + 62));
  });

  it("X-DE-4 byes do not move a drop", () => {
    // RB6-X5: the pattern is defined on the frame; byes change which seats are live, never where a loser lands.
    const feedsOf = (n: number): Map<string, [BracketSlotRef | undefined, BracketSlotRef | undefined]> =>
      new Map(
        generateDoubleElim({ entrants: field(n) })
          .fixtures.filter((f) => f.homeFrom !== undefined || f.awayFrom !== undefined)
          .map((f) => [f.id, [f.homeFrom, f.awayFrom]]),
      );
    const eight = feedsOf(8);
    let compared = 0;
    for (const n of [5, 6, 7]) {
      const got = feedsOf(n);
      expect([...got.keys()]).toEqual([...eight.keys()]);
      for (const [id, feeds] of eight) {
        expect(got.get(id), `${n} ${id}`).toEqual(feeds);
        compared++;
      }
    }
    // 10 fed fixtures at a frame of 8 (wb-r1 ×2, wb-r2, 6 LB, gf), three fields.
    expect(compared).toBe(30);
  });

  it("X-DE-4 the index refuses a bad call", () => {
    const refusal = (m: number, games: number, i: number): unknown => {
      try {
        lbDropGameRB6X2(m, games, i);
      } catch (e) {
        return e instanceof EngineError ? { code: e.code, data: e.data } : e;
      }
      return "answered";
    };
    const bad: Array<[number, number, number]> = [
      [0, 3, 0], // games not a power of two
      [0, 4, -1], // i below 0
      [0, 4, 4], // i = games
      [-1, 4, 0], // m below 0
      [0.5, 4, 0], // m not an integer
      [0, 4, 0.5], // i not an integer
      [0, 2.5, 0], // games not an integer (2.5 & 1.5 is 0, so the power-of-two test alone would pass it)
      [0, 0, 0], // games below 1: refused by the i range, which is why games ≥ 1 has no term of its own
    ];
    for (const [m, games, i] of bad) {
      expect(refusal(m, games, i)).toEqual({ code: "CONFIG_INVALID", data: { reason: "drop_game_invalid", m, games, i } });
    }
    expect(bad.length).toBe(8);
    expect(refusal(0, 4, 3)).toBe("answered");
  });

  it("X-DE-4 a second call is deep-equal and the ids at n = 8 are unchanged", () => {
    const once = generateDoubleElim({ entrants: field(8), bracketReset: true });
    expect(generateDoubleElim({ entrants: field(8), bracketReset: true })).toEqual(once);
    // The ids of origin/main (10.0.4), so no stored ext_key moves.
    expect(generateDoubleElim({ entrants: field(8) }).fixtures.map((f) => f.id)).toEqual([
      "wb-r0-i0", "wb-r0-i1", "wb-r0-i2", "wb-r0-i3", "wb-r1-i0", "wb-r1-i1", "wb-r2-i0",
      "lb-r0-i0", "lb-r0-i1", "lb-r1-i0", "lb-r1-i1", "lb-r2-i0", "lb-r3-i0",
      "gf",
    ]);
  });
});

describe("survivor rounds and the grand final (W6 X-DE-5)", () => {
  // single-sport: double-elimination structure and ranks are sport-agnostic (reads no SportModule)
  it("X-DE-5 survivor rounds pair neighbours and the LB final feeds the grand final", () => {
    let games = 0;
    for (const frame of [4, 8, 16, 32, 64]) {
      const k = frameDepth(frame);
      const fx = byId(generateDoubleElim({ entrants: field(frame) }).fixtures);
      // RB6-X3: LB (2r−1).j = W LB (2r−2).(2j−1) v W LB (2r−2).(2j), r = 2 … k−1; engine L = 2r−2 (even, ≥ 2).
      for (let r = 2; r <= k - 1; r++) {
        const Le = 2 * r - 2;
        for (let j = 0; j < 2 ** (k - r - 1); j++) {
          const g = fx.get(`lb-r${Le}-i${j}`);
          expect(g?.homeFrom).toEqual(W(`lb-r${Le - 1}-i${2 * j}`));
          expect(g?.awayFrom).toEqual(W(`lb-r${Le - 1}-i${2 * j + 1}`));
          games++;
        }
      }
      // RB6-X4: the LB final (round 2k−2, engine lb-r{2k−3}-i0) feeds GF1 against the WB champion (WB k.1).
      expect(fx.get("gf")?.awayFrom).toEqual(W(`lb-r${2 * k - 3}-i0`));
      expect(fx.get("gf")?.homeFrom).toEqual(W(`wb-r${k - 1}-i0`));
      games++;
    }
    // Survivor games 0 + 1 + (2+1) + (4+2+1) + (8+4+2+1) = 26, plus five grand finals.
    expect(games).toBe(26 + 5);
  });

  it("X-DE-5 the losers' bracket is not seeded", () => {
    // RB6-D5: who meets whom in the LB is fixed by §4 alone, so a different seed map moves no LB or GF feed.
    const lbFeeds = (seeds?: ReadonlyMap<string, number>): unknown =>
      generateDoubleElim({ entrants: field(16), ...(seeds === undefined ? {} : { seeds }) })
        .fixtures.filter((f) => f.bracket !== "WB")
        .map((f) => [f.id, f.homeFrom, f.awayFrom]);
    const reversed = new Map(field(16).map((e, i) => [e, 16 - i]));
    const plain = lbFeeds() as unknown[];
    expect(plain.length).toBe(14 + 1);
    expect(lbFeeds(reversed)).toEqual(plain);
    // The positive pair: the seed map really moves the winners'-bracket draw, so "moves no LB feed" is not vacuous.
    const wbSeats = (seeds?: ReadonlyMap<string, number>): unknown =>
      generateDoubleElim({ entrants: field(16), ...(seeds === undefined ? {} : { seeds }) })
        .fixtures.filter((f) => f.id.startsWith("wb-r0-"))
        .map((f) => [f.home, f.away]);
    expect(wbSeats(reversed)).not.toEqual(wbSeats());
  });
});
