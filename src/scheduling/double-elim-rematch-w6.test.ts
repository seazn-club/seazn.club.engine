// W6 double elimination: the losers'-bracket rematch sweep (row X-DE-6). Every expected value comes from the W6
// rulebook (seazn.club rulebook-W6-double-elim.md §2 RB6-E3, E7; §4 RB6-X2, X6, X7, X8 with the worked tables for 4,
// 8 and 16; §5 RB6-B1 to B3), never from generateDoubleElim's own output.
//
// Numbering: rulebook rounds and games count from 1, engine ids from 0. `WB r.i` is `wb-r{r−1}-i{i−1}` and `LB t.p` is
// `lb-r{t−1}-i{p−1}`; a rematch's LB round below is the rulebook's 1-based t.
//
// The bracket is played by the testkit's own player (`playOutBracket`), which resolves an award, a one-dead-seat line
// (a bye, RB6-B2) and a two-dead-seat line (void, RB6-B3) exactly as the app's rows do. This file only reads the
// played rows: a real match is a `decided` row with both seats filled; byes, awards and dead lines are not matches.
// GF1 and the reset are outside the property (RB6-X8), so GF rows are never read.
import { describe, expect, it } from "vitest";
import { mulberry32, shuffle } from "../core/rng.ts";
import type { BracketFixture } from "../competition/stage.ts";
import { playOutBracket } from "../testkit/bracket-play.ts";
import { generateDoubleElim, nextPowerOfTwo } from "./bracket.ts";

// RB6-X6: the earliest LB round in which any pair can meet again, per frame. A field inherits its frame's E.
const E: Readonly<Record<number, number>> = { 4: 2, 8: 3, 16: 4, 32: 5 };

// Entrant `s{t}` has strength t: s1 is the strongest.
const strength = (id: string): number => Number(id.slice(1));
const field = (n: number): string[] => Array.from({ length: n }, (_, i) => `s${i + 1}`);

type Draw = "fully seeded" | "partly seeded";
// Fully seeded: seed = strength. Partly seeded: strengths 1 … 4 keep seeds 1 … 4, strengths 5 … n take seeds 5 … n in
// shuffle(1000 + n) order — the top four on the fold and the rest drawn at random (RB6-X7). At n ≤ 4 the two are equal.
function seedsFor(n: number, draw: Draw): Map<string, number> {
  const seeds = new Map<string, number>();
  for (let t = 1; t <= Math.min(4, n); t++) seeds.set(`s${t}`, t);
  const rest = Array.from({ length: Math.max(0, n - 4) }, (_, i) => i + 5);
  const order = draw === "fully seeded" ? rest : shuffle(1000 + n, rest);
  rest.forEach((t, i) => seeds.set(`s${t}`, order[i] as number));
  return seeds;
}

type Pick = (home: string, away: string) => string;
const SCRIPTS: ReadonlyArray<{ name: string; pick: (n: number) => Pick }> = [
  { name: "favourite", pick: () => (h, a) => (strength(h) < strength(a) ? h : a) },
  { name: "underdog", pick: () => (h, a) => (strength(h) > strength(a) ? h : a) },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((s) => ({
    name: `coin ${s}`,
    pick: (n: number): Pick => {
      const rng = mulberry32(n * 100 + s);
      return (h, a) => (rng() < 0.5 ? h : a);
    },
  })),
];
const DRAWS: readonly Draw[] = ["fully seeded", "partly seeded"];

interface Rematch {
  fixtureId: string;
  lbRound: number; // rulebook 1-based LB round
  pair: string; // the two entrants, sorted, "a v b"
}
interface Played {
  rows: BracketFixture[];
  lbMatches: number;
  rematches: Rematch[];
  pairsMet: number;
}

const pairKey = (a: string, b: string): string => [a, b].sort((x, y) => strength(x) - strength(y)).join(" v ");

function play(n: number, draw: Draw, pick: Pick, gen = generateDoubleElim({ entrants: field(n), seeds: seedsFor(n, draw) })): Played {
  const rows = playOutBracket(gen, { winner: pick });
  const met = new Set<string>(); // every pair that has met in a real match so far, WB or LB, in play order
  const rematches: Rematch[] = [];
  let lbMatches = 0;
  for (const row of rows) {
    if (row.bracket === "GF") continue; // RB6-X8: GF1 and the reset are outside the property
    if (row.status !== "decided" || row.home === undefined || row.away === undefined) continue; // not a match
    const pair = pairKey(row.home, row.away);
    if (row.bracket === "LB") {
      lbMatches++;
      const lane = /^lb-r(\d+)-i\d+$/.exec(row.id);
      if (lane === null) throw new Error(`rematch sweep: LB row "${row.id}" has no lb-r{L}-i{j} id`);
      if (met.has(pair)) rematches.push({ fixtureId: row.id, lbRound: Number(lane[1]) + 1, pair });
    } else if (row.bracket !== "WB") {
      throw new Error(`rematch sweep: row "${row.id}" has no WB/LB lane`);
    }
    met.add(pair);
  }
  return { rows, lbMatches, rematches, pairsMet: met.size };
}

// The sweep's own run count, asserted in the file's last `it`: a `-t` slice that skips a sweep goes red.
let sweepRuns = 0;

// RB6-D1: k = log2(frame).
const depth = (n: number): number => Math.log2(nextPowerOfTwo(n));

describe("double elimination losers'-bracket rematches (W6 X-DE-6)", () => {
  // single-sport: double-elimination structure and ranks are sport-agnostic (reads no SportModule)
  it("X-DE-6 a field of 2 plays no losers' bracket match and is excluded by name", () => {
    // RB6-E3, E7: at n = 2 there is no LB match at all, so the property is excluded by name, not by an empty pass.
    let runs = 0;
    for (const draw of DRAWS)
      for (const script of SCRIPTS) {
        expect(play(2, draw, script.pick(2)).lbMatches, `${draw} ${script.name}`).toBe(0);
        runs++;
      }
    expect(runs).toBe(20);
    sweepRuns += runs;
  });

  it("X-DE-6 no pair meets again in the losers' bracket before round E(frame), on every draw and every script", () => {
    let runs = 0;
    let lbMatches = 0;
    let pairsMet = 0;
    let rematches = 0;
    for (let n = 3; n <= 32; n++) {
      const bound = E[nextPowerOfTwo(n)] as number;
      for (const draw of DRAWS)
        for (const script of SCRIPTS) {
          const run = play(n, draw, script.pick(n));
          const where = `n=${n} ${draw} ${script.name}`;
          // RB6-D4: every entrant but the two finalists takes two losses, so n − 1 WB matches and n − 2 LB matches.
          expect(run.lbMatches, where).toBe(n - 2);
          for (const r of run.rematches) expect(r.lbRound, `${where} ${r.fixtureId} ${r.pair}`).toBeGreaterThanOrEqual(bound);
          runs++;
          lbMatches += run.lbMatches;
          pairsMet += run.pairsMet;
          rematches += run.rematches.length;
        }
    }
    expect(runs).toBe(600); // 30 sizes × 2 draws × 10 scripts
    expect(lbMatches).toBe(9300); // 20 × Σ(n − 2), n = 3 … 32 = 20 × 465: the rematch checks made
    expect(pairsMet).toBeGreaterThan(0);
    expect(rematches).toBeGreaterThan(0); // the sweep can see a rematch at all
    sweepRuns += runs;
  });

  it("X-DE-6 whatever the results, exhaustively for n = 3 … 8: every result vector on both draws meets the bound", () => {
    // RB6-X6 "on any results", made literal where it is affordable: each of the 2n − 3 WB and LB matches (RB6-D4:
    // n − 1 WB, n − 2 LB) is decided by one bit of the vector, home on 0, away on 1. The player walks the generator's
    // order (every WB row, then LB, then GF), so the first 2n − 3 picks are exactly those matches; GF1 and the reset
    // come after and are outside the property (RB6-X8), so they take home. The sampled sweep above covers 9 … 32.
    let vectors = 0;
    let rematches = 0;
    for (let n = 3; n <= 8; n++) {
      const bound = E[nextPowerOfTwo(n)] as number;
      const matches = 2 * n - 3;
      for (const draw of DRAWS) {
        const gen = generateDoubleElim({ entrants: field(n), seeds: seedsFor(n, draw) });
        for (let v = 0; v < 2 ** matches; v++) {
          let picks = 0;
          const pick: Pick = (h, a) => (picks < matches && ((v >> picks++) & 1) === 1 ? a : h);
          const run = play(n, draw, pick, gen);
          const where = `n=${n} ${draw} vector ${v}`;
          expect(run.lbMatches, where).toBe(n - 2);
          // `picks` saturates at 2n − 3, and GF1 / the reset would take a bit if WB + LB used fewer, so this alone only
          // says the vector was read through. What pins "bit k = the k-th WB or LB match" is the n − 2 LB matches above
          // plus the n − 1 WB matches every field plays (RB6-D4).
          expect(picks, where).toBe(matches);
          for (const r of run.rematches) expect(r.lbRound, `${where} ${r.fixtureId} ${r.pair}`).toBeGreaterThanOrEqual(bound);
          rematches += run.rematches.length;
          vectors++;
        }
      }
    }
    // 2 draws × Σ 2^(2n − 3), n = 3 … 8 = 2 × (8 + 32 + 128 + 512 + 2048 + 8192) = 2 × 10 920.
    expect(vectors).toBe(21840);
    expect(rematches).toBeGreaterThan(0);
  }, 60_000); // 21 840 played brackets: ~1.5 s idle, past the 5 s default on a loaded machine

  it("X-DE-6 on a fully seeded field with the favourite winning there is exactly one rematch, the LB final, seed 3 v seed 2", () => {
    // RB6-X7: fully seeded on the fold, better seed wins every match, n ≥ 3 → exactly one LB rematch, the LB final
    // (LB round 2k − 2), seed 3 v seed 2, who met in the WB semi-final.
    // differential: today 3 rematches at n = 8 and 7 at n = 16 (straight drops, rulebook §4 "Product today").
    // n = 4 cannot tell right from wrong: 1 rematch either way.
    let fields = 0;
    for (let n = 3; n <= 32; n++) {
      const run = play(n, "fully seeded", SCRIPTS[0]!.pick(n));
      expect(run.rematches.map((r) => [r.lbRound, r.pair]), `n=${n}`).toEqual([[2 * depth(n) - 2, "s2 v s3"]]);
      fields++;
    }
    expect(fields).toBe(30);
  });

  it("X-DE-6 exactly one is not claimed for a partly seeded draw", () => {
    // RB6-X7: 2 or 3 rematches in about 28% of such draws at 16. Only RB6-X6's bound holds here.
    // DO NOT add a rematch count to this test: the rulebook claims none for a partly seeded draw.
    let fields = 0;
    for (let n = 3; n <= 32; n++) {
      const bound = E[nextPowerOfTwo(n)] as number;
      for (const r of play(n, "partly seeded", SCRIPTS[0]!.pick(n)).rematches)
        expect(r.lbRound, `n=${n} ${r.fixtureId}`).toBeGreaterThanOrEqual(bound);
      fields++;
    }
    expect(fields).toBe(30);
  });

  // X = home of `wb-r0-i0`, Y = its away (seed 1 and seed n on the fold). X beats Y, X loses its WB match at round
  // index `lossRound`, X and Y win every other match they play, elsewhere home wins.
  function xyScript(n: number, lossRound: number): { run: Played; x: string; y: string } {
    const gen = generateDoubleElim({ entrants: field(n), seeds: seedsFor(n, "fully seeded") });
    const first = gen.fixtures.find((f) => f.id === "wb-r0-i0");
    const x = first?.home;
    const y = first?.away;
    if (x === undefined || y === undefined) throw new Error(`n=${n}: wb-r0-i0 is not a seated match`);
    // X plays WB rounds 0, 1, … in order (seed 1 on a full frame has no bye, and the player walks the generator's
    // order, every WB row before any LB row), so X's (lossRound + 1)-th match is the WB loss. Pinned below.
    let xMatches = 0;
    const pick: Pick = (h, a) => {
      if (h === x || a === x) {
        const other = h === x ? a : h;
        const lose = other !== y && xMatches === lossRound;
        xMatches++;
        return lose ? other : x;
      }
      if (h === y || a === y) return y;
      return h;
    };
    const run = play(n, "fully seeded", pick);
    const loss = run.rows.find((r) => r.id === `wb-r${lossRound}-i0`);
    expect(loss?.loser, `n=${n}: X loses wb-r${lossRound}-i0`).toBe(x);
    return { run, x, y };
  }

  it("X-DE-6 the n = 8 case where crossed and straight drops differ", () => {
    // RB6-X2 worked table n=8: LB 2.2 = W LB 1.2 v L WB 2.1, LB 2.1 = W LB 1.1 v L WB 2.2, LB 3.1 = W LB 2.1 v W LB 2.2.
    // differential: today (straight drops) X meets Y in lb-r1-i0, LB round 2.
    const { run, x, y } = xyScript(8, 1);
    const seats = (id: string): string[] => {
      const r = run.rows.find((row) => row.id === id);
      return [r?.home, r?.away].filter((s): s is string => s !== undefined);
    };
    expect(seats("lb-r1-i1")).toContain(x); // L WB 2.1 lands on LB 2.2
    expect(seats("lb-r1-i0")).toContain(y); // W LB 1.1 (Y lost WB 1.1) plays LB 2.1
    expect(run.rematches.filter((r) => r.lbRound === 2)).toEqual([]);
    expect(run.rematches[0]).toEqual({ fixtureId: "lb-r2-i0", lbRound: 3, pair: pairKey(x, y) });
  });

  it("X-DE-6 a rematch in round E(frame) is reachable at 4, 8, 16 and 32", () => {
    // Rulebook "Earliest possible rematch" under each worked table, and RB6-X2 for 32: the loser of WB 2.1, WB 2.1,
    // WB 3.1, WB 3.1 meets the opponent they beat in WB round 1 in LB round E. So the bound is tight, not "never".
    // Frames 8 and 32 differ from straight drops (rounds 2 and 4 there); 4 and 16 give the same round under both.
    const cases: ReadonlyArray<[frame: number, lossRound: number]> = [[4, 1], [8, 1], [16, 2], [32, 2]];
    let frames = 0;
    for (const [frame, lossRound] of cases) {
      const { run, x, y } = xyScript(frame, lossRound);
      const earliest = Math.min(...run.rematches.map((r) => r.lbRound));
      expect(earliest, `frame ${frame}`).toBe(E[frame]);
      expect(
        run.rematches.filter((r) => r.lbRound === E[frame]).map((r) => r.pair),
        `frame ${frame}`,
      ).toContain(pairKey(x, y));
      frames++;
    }
    expect(frames).toBe(4);
  });

  it("X-DE-6 a one-dead-seat line and a two-dead-seat line are no match (n = 5)", () => {
    // RB6-B2, B3 (frame 8, byes to seeds 1, 2, 3): LB 1.1 is a bye, LB 1.2 is dead, so the loser of WB 2.1 advances by
    // bye from LB 2.2. Three LB lines with a dead seat; n − 2 = 3 LB matches.
    const run = play(5, "fully seeded", SCRIPTS[0]!.pick(5));
    const row = (id: string): BracketFixture | undefined => run.rows.find((r) => r.id === id);
    expect([row("lb-r0-i0")?.status, row("lb-r0-i0")?.loser]).toEqual(["walkover", undefined]);
    expect(row("lb-r0-i1")?.status).toBe("void");
    expect([row("lb-r1-i1")?.status, row("lb-r1-i1")?.loser]).toEqual(["walkover", undefined]);
    expect(run.lbMatches).toBe(3);
  });

  it("X-DE-6 a second pass over one run gives the same counts, and the sweep ran all 620 runs", () => {
    const once = play(13, "partly seeded", SCRIPTS[4]!.pick(13));
    const twice = play(13, "partly seeded", SCRIPTS[4]!.pick(13));
    expect(twice).toEqual(once);
    expect(once.lbMatches).toBe(11); // RB6-D4: n − 2
    // 31 sizes (2 … 32) × 2 draws × 10 scripts.
    expect(sweepRuns).toBe(620);
  });
});
