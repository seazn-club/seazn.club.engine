---
"@seazn-club/seazn-engine": minor
---

Football's FIFA 2026 tie-break order now re-applies the head-to-head criteria to the teams still level, as FIFA World Cup 26 Regulations Art. 13 step 2 requires (owner approval 2026-11-23). Before, it applied them once and went on to overall goal difference.

**HEADS UP: EXISTING FOOTBALL STANDINGS WITH THREE OR MORE TEAMS LEVEL ON POINTS CAN REORDER ON READ.** Any football table ranked at read time by football's default order or by the `fifa2026` preset (no stored or pinned order of its own) is ranked by the new order on this version. A tie of two teams never moves: their own match is the whole head-to-head, so re-applying it decides nothing new.

- **The order.** `FOOTBALL_TIEBREAKERS.fifa2026` is now `points, h2h_points, h2h_diff, h2h_for, h2h_reapply, diff, for, fair_play, lots`. Before, it was the same without `h2h_reapply`. It follows Art. 13: step 1 a) to c) are head-to-head points, goal difference and goals among the teams concerned. Step 2 applies a) to c) again "to the matches between the remaining teams only". Then come d) overall goal difference, e) overall goals and f) team conduct (`fair_play`: yellow −1, indirect red −3, direct red −4, yellow and direct red −5). Step 3 is FIFA's world ranking, which the product does not have, so a drawing of lots stands in for it (deviation RB2B-4, unchanged). Once d) to f) start, nothing goes back to head-to-head, as Art. 13 says: "the second step of the ranking does not restart".
- **The default moves with it.** Football's `defaultTiebreakers` for league, group and americano reads that same list, so a new football division follows FIFA. It still drops `fair_play` when the division does not track fair play (FB-TB-4). The Swiss default (FB-TB-5), the `uefa` and `classic` presets, and the cross-group order (`points, diff, for, fair_play, lots`) are unchanged. `fifa2026` and `uefa` now hold the same keys.
- **What reorders.** A tie of three or more teams where step 1 separates some of them and leaves two or more still level. Those teams are now ranked on the matches among themselves only, before overall goal difference. Example: X, Y and Z have 6 points each. The mini-league puts Z first and leaves X and Y level, and X beat Y. X now ranks above Y, even when Y has the better overall goal difference. Before, Y was above X.
- **What does not reorder.** These cases rank exactly as before:
  - a tie that step 1 settles;
  - a tie of two;
  - `h2hScope: "overall"`;
  - an incomplete mini-schedule (`partialSchedule`);
  - any order a division or stage stores itself, and any pinned order.
  In seazn.club a stage pins its order when it starts, so a started stage keeps the order it was pinned with. Only pending and new stages take this one, with one exception: when an organiser clears the own order of an active stage that has no score yet, `repinStageOwnRules` re-reads the live default and re-pins it, so that stage takes this order too.
- **The mechanism is the existing `h2h_reapply` modifier** (UEFA 20.01(d), IIHF). It reruns the block on each smaller subset left level, among that subset's own matches, until no subset shrinks. With four or more teams level, a re-application that itself splits the group is applied once more to the remainder.
- **No fold change.** `FOLD_EPOCH` and `FOLD_MINOR` are unchanged. Ranking a table is not part of a match's fold, and no golden stream, state, outcome, summary or standings delta moves.
- **Rules.** FB-TB-1 (`rules/football.md`) now states step 2 and cites Art. 13. FB-TB-2 says that `uefa` and FIFA 2026 now share an order. The status stays `deviation 197 2026-10-24`, because the owner's 2026-11-23 approval has no ruling number. The citation column cites it instead.
