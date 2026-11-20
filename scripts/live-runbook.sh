#!/usr/bin/env bash
# live E2E 한 번의 전 과정(SP_ENV=prod · 기본 4570, dry 검증은 SP_DRY_RUN_PORT=4594 가능). 파일로만 실행 — 대화형 shell에 붙여 넣지 않음.
# 필수 env: MODE=live|dry-mock|dry-fake  DATA  OUT
#   live: LEDGER SMOKE_DATA [NET_MAX=12]   dry-*: SCRATCH_ROOT   dry-fake: LEDGER FAKE_BIN STUB_DIR
#   선택: RUN_ARGS("--only O1" 등)  RESUME=1(exit 3 뒤 재개: init·import·test:live를 건너뜀, OUT은 있던 것)
#     재개 규칙: F1을 시작했고(calls/F1.started.json 있음) F1 도중 죽었거나 F1 기록(calls/F1.json)이 없거나 불완전하면 RUN_ARGS="--from F1"로 재개(F1을 다시 보내 판정). F1을 시작하지 않은 run에는 쓰지 않음(--from F1은 F1 앞 호출을 건너뜀). F1r만 다시 보낼 때는 "--only F1r"
#   EVALUATE=1(RESUME=1과 함께): run 대신 live-e2e.ts evaluate — calls/ + DB + 읽기 API로 live_e2e.json만 다시 만듦(LLM 0 · POST 0).
#     post-check를 새로 하지 않고, 판정하는 run(호출을 시작한 마지막 run)의 post_check.<n>.json을 조건 8에 넣음: pass가 아니거나
#     없으면 exit 0이 아님 — 조건 실패는 1, 판정한 run이 멈춘 run(run.<n>.json의 stoppedReason)이면 조건과 무관하게 3.
#     저장된 stoppedReason이 없어도 지금 ledger가 STOP · STOP_REQUESTED면 3(멈춘 ledger는 pass가 되지 않음, 결정 33).
#     마지막 줄에 그 run 번호와 post_check=<그 run의 post-check 결과>
#     (pass · fail · unverified · no_call · no_post_check · none — 공백 · '-' 없는 한 칸. none = 요약 줄을 못 읽음)
# 맨 먼저 check-args(LLM 0 · 요청 0 · 파일 쓰기 0): 모든 MODE와 RESUME에서 build · mkdir · 서버 · log보다 앞
#   선택: RATE_WARNING_OK=0|1(기본 0, INTEGRATION_NOTES 결정 26 — 사용자 승인 예외). 1이면 init에 --allow-rate-warning을 붙여 ledger에
#     ALLOW_RATE_WARNING을 만듦 → rate limit status가 정확히 allowed_warning이면 멈추지 않고 기록(서버 log · ledger의 rate_warnings.jsonl ·
#     live_e2e.json rateLimitWarnings). rejected · 그 밖의 status · terminal rate_limited는 그대로 정지, 호출 상한(25 · 모델별)도 그대로.
#     live · dry-fake만(dry-mock은 exit 2). RESUME 때는 init을 하지 않으므로 값이 ledger의 표시와 같아야 함(다르면 exit 2).
#     RESUME이 아니어도 ledger에 이미 표시가 있는데 값이 0이면 exit 2 — check-args 바로 뒤, OUT · build · init 전(아무것도 만들지 않음).
#     표시 파일은 있는데 유효하지 않으면(손상) RESUME · 값과 무관하게 같은 자리에서 exit 2(새 ledger를 써야 함 — init도 거부하는 상태).
#     마지막 줄의 rate_warning_ok=<0|1>는 ledger에 유효한 표시가 있는지(check-args 통과 전에 끝났거나 dry-mock이면 0)
set -euo pipefail          # 줄마다 한 명령. `a && b`에서 a가 실패해도 set -e는 shell을 끝내지 않으므로 &&로 잇지 않음
: "${MODE:?}" "${DATA:?}" "${OUT:?}"
if [ -n "${EVALUATE:-}" ] && [ -z "${RESUME:-}" ]; then echo "EVALUATE=1 needs RESUME=1 (it judges an existing OUT)" >&2; exit 2; fi
STAGE=setup; PID=
stop_srv() { [ -n "$PID" ] || return 0; kill -INT "$PID" 2>/dev/null || return 0; timeout 60 tail --pid="$PID" -f /dev/null || true; }
latest_run() { ls "$OUT" 2>/dev/null | sed -n 's/^run\.\([0-9][0-9]*\)\.json$/\1/p' | sort -n | tail -1; }   # run.<n>.json of live-e2e.ts run
not_done() { [ -f "$1" ] || { echo none; return 0; }; node -e 'try { const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).callsNotDone; console.log(c.length ? c.length + ":" + c.join(",") : 0) } catch { console.log("unreadable") }' "$1" || echo unreadable; }   # live_e2e의 callsNotDone(run.done이 아닌 계획 호출)
eval_fields() { node -e 'try { const j = JSON.parse(process.argv[1]); const f = (v) => (v === undefined || v === null ? "" : String(v).replace(/[\s-]+/g, "_")) || "none"; console.log([f(j.runIndex), f(j.callsNotDone), f(j.postCheck)].join(" ")) } catch { console.log("none none none") }' "$1" || echo "none none none"; }   # evaluate의 요약 줄(stdout 마지막 줄) → run · callsNotDone · 그 run의 post-check(공백 없는 한 칸씩)
CHECKED=
rate_ok() { if [ -n "$CHECKED" ] && [ "$MODE" != dry-mock ] && [ -n "${LEDGER:-}" ] && [ -d "$LEDGER" ]; then npx tsx scripts/live-ledger.ts allowed "$LEDGER" 2>/dev/null || echo 0; else echo 0; fi; }   # ledger의 ALLOW_RATE_WARNING(결정 26): 1 | 0
on_exit() { local rc=$? n= nd=none pcr= rw=0; stop_srv; rw=$(rate_ok || echo 0); if [ -n "${RUN_BEFORE+x}" ]; then n=$(latest_run || true); fi; if [ "${n:-}" = "${RUN_BEFORE:-}" ]; then n=; fi
  if [ -n "$n" ]; then nd=$(not_done "$OUT/live_e2e.$n.json"); elif [ -n "${EVALUATE:-}" ]; then read -r n nd pcr <<< "$(eval_fields "${EVAL_LINE:-}")"; [ "$n" != none ] || n=; fi
  echo "runbook: stage=$STAGE exit=$rc run=${n:-none} calls_not_done=$nd run_exit=${RC:-none} post_check_exit=${PC:-none} rate_warning_ok=$rw${EVALUATE:+ post_check=${pcr:-none}}" >&2; }
trap on_exit EXIT                                        # 어디서 끝나든 서버를 PID로 내리고, 어느 단계에서 끝났는지 마지막 줄에 남김
if [ "$MODE" = live ] && [ -n "${SP_DRY_RUN_PORT+x}" ]; then echo 'SP_DRY_RUN_PORT applies only to dry runs' >&2; exit 2; fi
PORT=4570
if [ "$MODE" != live ]; then
  PORT=${SP_DRY_RUN_PORT:-4570}
  case "$PORT" in 4570|4594) ;; *) echo 'SP_DRY_RUN_PORT must be 4570 or 4594' >&2; exit 2 ;; esac
fi
BASE=http://127.0.0.1:$PORT
ARGS=(--mode "$MODE" --base-url "$BASE" --data "$DATA" --out "$OUT" --server-log "$OUT/server.log")
CHECK=()
case "$MODE" in
  live)     : "${LEDGER:?}" "${SMOKE_DATA:?}"
            if [ -z "${RESUME:-}" ] && [ -e "$LEDGER" ] && [ -z "${NET_MAX:-}" ]; then   # 다시 하는 live: 앞에서 쓴 arXiv 요청이 12에 들어가야 함
              echo "live: $LEDGER already exists — a run that is not RESUME needs NET_MAX given explicitly" >&2; exit 2
            fi
            NET=${NET_MAX:-12}; if [ -n "${RESUME:-}" ]; then NET=0; fi          # 재개 때는 arXiv 요청이 필요 없음
            SRV=(-u SP_NETWORK -u SP_CLAUDE_BIN SP_LLM=cli SP_LIVE_LEDGER="$LEDGER" SP_NETWORK_MAX_REQUESTS="$NET")
            ARGS+=(--ledger "$LEDGER"); CHECK=(--smoke-data "$SMOKE_DATA") ;;
  dry-mock) : "${SCRATCH_ROOT:?}"
            SRV=(-u SP_LIVE_LEDGER -u SP_CLAUDE_BIN -u SP_NETWORK_MAX_REQUESTS SP_LLM=mock SP_NETWORK=off)
            ARGS+=(--scratch-root "$SCRATCH_ROOT") ;;
  dry-fake) : "${SCRATCH_ROOT:?}" "${LEDGER:?}" "${FAKE_BIN:?}" "${STUB_DIR:?}"
            SRV=(-u SP_NETWORK_MAX_REQUESTS SP_LLM=cli SP_LIVE_LEDGER="$LEDGER" SP_CLAUDE_BIN="$FAKE_BIN" SP_NETWORK=off PATH="$STUB_DIR:$PATH")
            ARGS+=(--scratch-root "$SCRATCH_ROOT" --ledger "$LEDGER") ;;
  *) echo "MODE must be live|dry-mock|dry-fake" >&2; exit 2 ;;
esac
RWOK=${RATE_WARNING_OK:-0}; INIT_ARGS=()
if [ "$RWOK" != 0 ] && [ "$RWOK" != 1 ]; then echo "RATE_WARNING_OK must be 0 or 1" >&2; exit 2; fi
if [ "$RWOK" = 1 ] && [ "$MODE" = dry-mock ]; then echo "RATE_WARNING_OK=1: live or dry-fake only (dry-mock has no ledger)" >&2; exit 2; fi
if [ "$RWOK" = 1 ]; then INIT_ARGS=(--allow-rate-warning); fi    # 결정 26: 이 값일 때만, 그 밖에는 절대 붙이지 않음
STAGE=check-args
npx tsx scripts/live-e2e.ts check-args "${ARGS[@]}" "${CHECK[@]}" ${RUN_ARGS:-}   # 거부 = exit 2 → 아무것도 만들거나 띄우지 않음
CHECKED=1
if [ "$MODE" != dry-mock ]; then                         # 결정 26: RATE_WARNING_OK와 ledger의 표시가 어긋나면 OUT · build 전에 exit 2
  HAS=$(npx tsx scripts/live-ledger.ts allowed "$LEDGER")
  if [ "$HAS" = 0 ] && [ -e "$LEDGER/ALLOW_RATE_WARNING" ]; then echo "$LEDGER has a damaged approval (ALLOW_RATE_WARNING) — use a new ledger (nothing made)" >&2; exit 2; fi
  if [ -n "${RESUME:-}" ] && [ "$HAS" != "$RWOK" ]; then echo "RESUME: RATE_WARNING_OK=$RWOK but the ledger approval (ALLOW_RATE_WARNING) is $HAS — resume with the value of the run being resumed" >&2; exit 2; fi
  if [ -z "${RESUME:-}" ] && [ "$HAS" = 1 ] && [ "$RWOK" = 0 ]; then echo "RATE_WARNING_OK=0 but $LEDGER already carries the approval (ALLOW_RATE_WARNING) — give RATE_WARNING_OK=1 or use a new ledger (nothing made)" >&2; exit 2; fi
fi
STAGE=setup
if [ -z "${RESUME:-}" ]; then
  test ! -e "$OUT"
  mkdir -p "$OUT"
  npm run build
  if [ "$MODE" != dry-mock ]; then npx tsx scripts/live-e2e.ts init "${ARGS[@]}" "${INIT_ARGS[@]}"; fi   # 표시가 있는데 flag가 없으면 init도 거부(두 번째 guard)
else
  test -d "$OUT"                                         # 재개: OUT만 있으면 됨(run이 첫 호출 전에 끝났으면 calls/가 없음)
fi
STAGE=server
( exec env -u SP_E2E -u SP_LIVE -u SP_ARXIV_OFFLINE_DIR -u SP_MOCK_CHUNK_DELAY_MS "${SRV[@]}" SP_ENV=prod SP_PORT="$PORT" \
    SP_DATA_DIR="$DATA" SP_CONFIG_PATH="$DATA-config/no-config.json" SP_SECRETS_DIR="$DATA-secrets" node --import tsx apps/server/src/index.ts ) >> "$OUT/server.log" 2>&1 &
PID=$!
up=0
for _ in $(seq 120); do                                  # 최대 60 s: pid 파일(listen 뒤에 쓰임)과 health 응답을 기다림
  kill -0 "$PID"                                         # 서버가 죽었으면(포트 사용 중 등) 여기서 끝
  if [ -f "$DATA/run/server.pid" ] && curl -s -o /dev/null --max-time 2 "$BASE/api/health"; then up=1; break; fi
  sleep 0.5
done
test "$up" = 1
test "$(cat "$DATA/run/server.pid")" = "$PID"
if [ "$MODE" = live ] && [ -z "${RESUME:-}" ]; then
  STAGE=import
  npx tsx scripts/live-e2e.ts import "${ARGS[@]}"        # arXiv ≤ NET(서버가 강제) · LLM 0. 선행 조건 실패 = exit 2 → 여기서 끝(아래 호출 0)
  STAGE=test-live
  test -d "$SMOKE_DATA/claude-cwd"                       # 없으면 smoke-live가 spawn 없이 끝남
  test -f "$SMOKE_DATA/fixtures/2209.15397v2.pdf"        # 없으면 smoke-live가 exit 0으로 건너뜀(호출 0인데 성공처럼 보임)
  env -u SP_CLAUDE_BIN SP_LIVE=1 SP_LIVE_LEDGER="$LEDGER" SP_DATA_DIR="$SMOKE_DATA" SP_CONFIG_PATH="$SMOKE_DATA.no-config.json" npm run test:live   # haiku 3. 0이 아니면 여기서 끝 — run을 하지 않음
fi
if [ -n "${EVALUATE:-}" ]; then
  STAGE=evaluate; RC=0; EVAL_LINE=
  EV=$(npx tsx scripts/live-e2e.ts evaluate "${ARGS[@]}") || RC=$?       # LLM 0: 호출을 시작한 마지막 run의 판정만 다시(그 run의 post-check 포함)
  printf '%s\n' "$EV"
  EVAL_LINE=$(printf '%s\n' "$EV" | tail -n 1)                      # 요약 줄: runIndex · callsNotDone · postCheck
  stop_srv
  STAGE=done
  exit "$RC"
fi
STAGE=run; RC=0; RUN_BEFORE=$(latest_run || true)          # 마지막 줄의 run=<n>: 이번 run이 만든 run.<n>.json(없으면 none)
npx tsx scripts/live-e2e.ts run "${ARGS[@]}" ${RUN_ARGS:-} || RC=$?   # live: 시작할 때 ledger used = haiku 3을 확인(아니면 exit 2)
STAGE=post-check
stop_srv
if kill -0 "$PID" 2>/dev/null; then echo "server $PID still alive" >&2; exit 1; fi
PC=0
npx tsx scripts/live-e2e.ts post-check --out "$OUT" || PC=$?          # 종료 후 child 0 · 시작한 호출은 모두 기록이 있음
if [ "$MODE" != dry-mock ]; then npx tsx scripts/live-ledger.ts read "$LEDGER" || RC=3; fi
STAGE=done
if [ "$RC" -ne 0 ]; then exit "$RC"; fi
exit "$PC"
