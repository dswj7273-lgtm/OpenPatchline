#!/usr/bin/env python3
"""性能基准退化检测（v0.8 / 8.3 验收：退化 > 20% 报警）。

用法：
  python3 scripts/check-perf.py --report src-tauri/target/perf-report.json
  python3 scripts/check-perf.py --report ... --update   # 刷新基线（性能有意变更后）

基线存于 scripts/perf-baseline.json；所有指标为耗时（ms），越低越好。
缺失指标视为新增，仅提示不失败；首跑（无基线）自动落盘并放行。

review 修复：
- --update 移到退化判定**之前**——原实现放在 return 1 之后，有退化时
  永远执行不到，错误信息里指的恢复路径是死路；
- 阈值加绝对余量（--slack-ms，默认 20ms）：基线来自开发机，共享 CI
  runner 上亚百毫秒指标的抖动常超 ±20%，纯百分比会误伤。
"""

import argparse
import json
import sys
from pathlib import Path

TOLERANCE = 1.20  # 允许 +20% 波动
SLACK_MS = 20.0  # 绝对余量（吸收短指标在共享 runner 上的抖动）


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", required=True, help="perf-report.json 路径")
    ap.add_argument("--baseline", default=str(Path(__file__).parent / "perf-baseline.json"))
    ap.add_argument("--update", action="store_true", help="用本次结果刷新基线（不做退化判定）")
    ap.add_argument("--tolerance", type=float, default=TOLERANCE)
    ap.add_argument("--slack-ms", type=float, default=SLACK_MS, help="绝对余量（ms）")
    args = ap.parse_args()

    report_path = Path(args.report)
    if not report_path.exists():
        print(f"::error::未找到基准报告 {report_path}（bench 未产出）")
        return 1
    current = json.loads(report_path.read_text())

    baseline_path = Path(args.baseline)
    if not baseline_path.exists():
        baseline_path.write_text(json.dumps(current, indent=2, sort_keys=True) + "\n")
        print("首跑：已写入性能基线，本次放行。")
        return 0

    # 有意变更：直接刷新基线放行（必须在退化判定之前执行）。
    if args.update:
        baseline_path.write_text(json.dumps(current, indent=2, sort_keys=True) + "\n")
        print("基线已刷新。")
        return 0

    baseline = json.loads(baseline_path.read_text())
    regressions = []
    for key, value in sorted(current.items()):
        base = baseline.get(key)
        if base is None:
            print(f"::notice::{key} 为新增指标（{value:.1f} ms），仅记录。")
            continue
        # 阈值 = max(base × 容差, base + 绝对余量)
        limit = max(base * args.tolerance, base + args.slack_ms)
        if value > limit:
            regressions.append((key, base, value))

    for key in baseline:
        if key not in current:
            print(f"::notice::{key} 已从基准中移除。")

    if regressions:
        for key, base, value in regressions:
            print(
                f"::error::性能退化 {key}: 基线 {base:.1f} ms → 本次 {value:.1f} ms "
                f"(+{(value / base - 1) * 100:.0f}%，容忍 +{(args.tolerance - 1) * 100:.0f}% "
                f"或 +{args.slack_ms:.0f}ms)"
            )
        print("如属有意变更，请运行 check-perf.py --update 刷新基线并随提交说明。")
        return 1

    print(
        f"性能守卫通过：{len(current)} 项指标均在基线 "
        f"+{(args.tolerance - 1) * 100:.0f}% / +{args.slack_ms:.0f}ms 内。"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
