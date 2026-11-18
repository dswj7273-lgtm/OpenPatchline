#!/usr/bin/env python3
"""性能基准退化检测（v0.8 / 8.3 验收：退化 > 20% 报警）。

用法：
  python3 scripts/check-perf.py --report src-tauri/target/perf-report.json
  python3 scripts/check-perf.py --report ... --update   # 刷新基线（性能有意变更后）

基线存于 scripts/perf-baseline.json；所有指标为耗时（ms），越低越好。
缺失指标视为新增，仅提示不失败；首跑（无基线）自动落盘并放行。
"""

import argparse
import json
import sys
from pathlib import Path

TOLERANCE = 1.20  # 允许 +20% 波动


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", required=True, help="perf-report.json 路径")
    ap.add_argument("--baseline", default=str(Path(__file__).parent / "perf-baseline.json"))
    ap.add_argument("--update", action="store_true", help="用本次结果刷新基线")
    ap.add_argument("--tolerance", type=float, default=TOLERANCE)
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

    baseline = json.loads(baseline_path.read_text())
    regressions = []
    for key, value in sorted(current.items()):
        base = baseline.get(key)
        if base is None:
            print(f"::notice::{key} 为新增指标（{value:.1f} ms），仅记录。")
            continue
        if value > base * args.tolerance:
            regressions.append((key, base, value))

    for key in baseline:
        if key not in current:
            print(f"::notice::{key} 已从基准中移除。")

    if regressions:
        for key, base, value in regressions:
            print(
                f"::error::性能退化 {key}: 基线 {base:.1f} ms → 本次 {value:.1f} ms "
                f"(+{(value / base - 1) * 100:.0f}%，容忍 +{(args.tolerance - 1) * 100:.0f}%)"
            )
        print("如属有意变更，请运行 check-perf.py --update 刷新基线并随提交说明。")
        return 1

    print(f"性能守卫通过：{len(current)} 项指标均在基线 ±{(args.tolerance - 1) * 100:.0f}% 内。")
    if args.update:
        baseline_path.write_text(json.dumps(current, indent=2, sort_keys=True) + "\n")
        print("基线已刷新。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
