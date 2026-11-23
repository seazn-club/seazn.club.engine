---
"@seazn-club/seazn-engine": patch
---

Faster Swiss standings: `rankStandings` (and so `completeTableStage` and every refold of a Swiss stage) now indexes the Swiss ledger once per call and reads each entrant's Buchholz, Buchholz Cut-1, Sonneborn-Berger and opponents' goal difference once, instead of re-indexing the whole ledger on every comparison of the tie-break sort. The same applies to Sonneborn-Berger on a round-robin pool. The output is byte-identical (order, columns, tie-break traces, lots), so no fold moves and `FOLD_EPOCH` is unchanged. `buchholz`, `buchholzCut1`, `sonnebornBerger` and `opponentsDiff` keep their signatures and results. At 500 entrants, ranking a Swiss stage is 17-55x faster and the whole `completeTableStage` 6-25x (engine bench, median; e.g. badminton after round 7 of 7: rank 1.9 s -> 36 ms, stage 2.3 s -> 189 ms). Nothing to change in the app beyond taking the version.
