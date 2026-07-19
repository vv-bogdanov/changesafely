# ChangeSafely Risk Suite report

> Custom pilot study; not universal or statistically significant proof.

## tenant-leak (comparison-4b088e3edba1a8eb)

- Measurement: `development`
- Model: `gpt-5.3-codex-spark`
- Effort: `medium`
- Paired: yes

| Mode | Outcome | Safe task | Scope | Mutation | Time | Turns | Tokens (cached) | Diff |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| direct | safe_success | yes | yes | 1/2 (50%) | 19911 ms | 1 | 75,394 (61,696) | +64/-1 |
| changesafely | safe_success | yes | yes | 2/2 (100%) | 103138 ms | 12 | 552,461 (342,912) | +94/-1 |

### direct: tenant-leak-direct-20260719153314861-1cfee783

- Candidate tests: 1 file, +55/-0
- Production diff: 1 file, +9
- Protected tests: Direct mode has no ChangeSafely protected harness.
- Tokens: 75,394 total; 72,590 input; 61,696 cached (85.0%); 10,894 non-cached; 2,804 output; 1,403 reasoning
- Evidence manifest: `9e73a49b7daec30fa9fcb71feb21af32cdece084f2250b74a04778dc6d6c2086`
- Analysis: `d84f11e4461be5b56d4496470b0ebf1567c6b7902ac0789e2fe5dd999db301af`

### changesafely: tenant-leak-changesafely-20260719153505353-e2c443ab

- Candidate tests: 1 file, +85/-0
- Production diff: 1 file, +9
- Protected tests: All protected test hashes match the final snapshot.
- Tokens: 552,461 total; 515,704 input; 342,912 cached (66.5%); 172,792 non-cached; 36,757 output; 24,758 reasoning
- Active model time: 127128 ms (parallel turns may overlap)
- Deterministic commands: 2; failures: 1; timeouts: 0; time: 687 ms
- Tool calls: n/a; failures: n/a; artifact bytes: n/a
- Evidence manifest: `3b7c951d04b757392e57c171273cb6c6cd180ac9cde502a7dfb58e3ed4b25d69`
- Analysis: `e5c9ac6671cdae9705a5d24552c4bee9c53f47a65db65502912f77f347bc5b3d`

| Phase | Role | Status | Time | Input | Cached | Output | Tools | Artifact bytes |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| discovery | discovery | completed | 20041 ms | 68,414 | 55,040 | 3,016 | n/a | n/a |
| contract | contract | completed | 9571 ms | 14,627 | 2,176 | 3,668 | n/a | n/a |
| planners | planner:plan-1 | completed | 7997 ms | 17,005 | 2,176 | 3,356 | n/a | n/a |
| planners | planner:plan-2 | completed | 11331 ms | 17,005 | 2,176 | 3,830 | n/a | n/a |
| planners | planner-correction:plan-1 | completed | 3620 ms | 20,927 | 16,896 | 1,639 | n/a | 0 |
| planners | planner:plan-3 | completed | 14528 ms | 17,005 | 2,176 | 3,403 | n/a | n/a |
| planners | planner-correction:plan-2 | completed | 4494 ms | 21,394 | 16,896 | 2,468 | n/a | 0 |
| planners | planner-correction:plan-3 | completed | 5250 ms | 21,200 | 16,896 | 2,194 | n/a | 0 |
| judge | judge | completed | 5042 ms | 21,216 | 2,176 | 1,148 | n/a | n/a |
| test-author | test-author | completed | 13009 ms | 86,640 | 63,744 | 4,037 | n/a | n/a |
| implementer | implementer | completed | 22583 ms | 164,805 | 139,904 | 4,337 | n/a | n/a |
| verifier | verifier | completed | 9662 ms | 45,466 | 22,656 | 3,661 | n/a | n/a |

## restart-storm (comparison-a205cff3cb89a343)

- Measurement: `development`
- Model: `gpt-5.3-codex-spark`
- Effort: `medium`
- Paired: yes

| Mode | Outcome | Safe task | Scope | Mutation | Time | Turns | Tokens (cached) | Diff |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| direct | unsafe_green | no | yes | 1/2 (50%) | 27728 ms | 1 | 117,160 (103,168) | +9/-1 |
| changesafely | safe_success | yes | yes | 2/2 (100%) | 84936 ms | 10 | 511,971 (355,328) | +37/-1 |

### direct: restart-storm-direct-20260719154714179-ec0b7c86

- Candidate tests: 1 file, +8/-0
- Production diff: 1 file, +1
- Protected tests: Direct mode has no ChangeSafely protected harness.
- Tokens: 117,160 total; 114,492 input; 103,168 cached (90.1%); 11,324 non-cached; 2,668 output; 1,594 reasoning
- Evidence manifest: `cb5f0c4282c3b1684914d7ff499b77cefb478daf5ba2b00bac6530ab7a905af2`
- Analysis: `75a71956df1a98b009de523d3c3f3972889781d20ace3646b4115f48cec563b5`

### changesafely: restart-storm-changesafely-20260719154846674-ac381eee

- Candidate tests: 1 file, +27/-0
- Production diff: 1 file, +10
- Protected tests: All protected test hashes match the final snapshot.
- Tokens: 511,971 total; 486,859 input; 355,328 cached (73.0%); 131,531 non-cached; 25,112 output; 17,425 reasoning
- Active model time: 95589 ms (parallel turns may overlap)
- Deterministic commands: 3; failures: 1; timeouts: 0; time: 926 ms
- Tool calls: n/a; failures: n/a; artifact bytes: n/a
- Evidence manifest: `eddebb37ce7416cf3ce2781b92a31f0f6691a261f124285d3764cc7394be8eb8`
- Analysis: `2e4801c3a7b94d7d651686a0a09779392151727a5dd7d28eca48a2f4e2c28754`

| Phase | Role | Status | Time | Input | Cached | Output | Tools | Artifact bytes |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| discovery | discovery | completed | 22184 ms | 80,372 | 68,096 | 2,691 | n/a | n/a |
| contract | contract | completed | 6478 ms | 14,575 | 2,176 | 2,584 | n/a | n/a |
| planners | planner:plan-2 | completed | 4543 ms | 16,519 | 9,472 | 1,957 | n/a | n/a |
| planners | planner:plan-3 | completed | 6916 ms | 16,519 | 9,472 | 2,445 | n/a | n/a |
| planners | planner:plan-1 | completed | 6970 ms | 16,519 | 2,176 | 3,728 | n/a | n/a |
| planners | planner-correction:plan-2 | completed | 4358 ms | 20,095 | 16,384 | 2,753 | n/a | 0 |
| judge | judge | completed | 4243 ms | 20,180 | 2,176 | 999 | n/a | n/a |
| test-author | test-author | completed | 14249 ms | 118,021 | 98,432 | 2,793 | n/a | n/a |
| implementer | implementer | completed | 19980 ms | 164,875 | 144,768 | 3,114 | n/a | n/a |
| verifier | verifier | completed | 5668 ms | 19,184 | 2,176 | 2,048 | n/a | n/a |

## Limitations

- This is a custom pilot suite, not universal or statistically significant proof.
- Each registered comparison permits one attempt per mode.
- Mutation kill rate covers only the scenario's declared mutants.
- Unavailable runtime usage remains null and is never estimated.

