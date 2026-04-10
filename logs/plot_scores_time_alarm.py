import argparse
import json
from typing import List, Optional, Sequence, Tuple

import matplotlib.pyplot as plt
from matplotlib.patches import Patch, Rectangle
from matplotlib.transforms import blended_transform_factory


DEFAULT_USER_PATH = "20260320-185220-0001_controller_User-Param-log.txt"
DEFAULT_GLOBAL_PATH = "20260320-184947-0000_server_Global-Param-log.txt"
DEFAULT_OUTPUT = "user_scores_time_alarm.png"
DEFAULT_SYNC_TIME_OFFSET = 0.0
COLLISION_KEYS = ("collide", "collision")


def load_user_series(path: str):
    times: List[float] = []
    score_u0: List[float] = []
    score_u1: List[float] = []
    collision_pairs: List[bool] = []

    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue

            rec = json.loads(line)
            if rec.get("event") != "user-change":
                continue

            users_by_id = {u["id"]: u for u in rec.get("users", []) if "id" in u}
            if 0 not in users_by_id or 1 not in users_by_id:
                continue

            u0 = users_by_id[0]
            u1 = users_by_id[1]

            times.append(float(rec["time"]))
            score_u0.append(float(u0.get("score", 0.0)))
            score_u1.append(float(u1.get("score", 0.0)))

            c0 = next((u0.get(key) for key in COLLISION_KEYS if key in u0), False)
            c1 = next((u1.get(key) for key in COLLISION_KEYS if key in u1), False)
            collision_pairs.append(bool(c0) and bool(c1))

    return times, score_u0, score_u1, collision_pairs



def load_alarm_transitions(path: str, sync_time_offset: float):
    transitions: List[Tuple[float, int]] = []

    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue

            rec = json.loads(line)
            if "alarm" not in rec or "syncTriggerTime" not in rec:
                continue

            transitions.append(
                (float(rec["syncTriggerTime"]) + sync_time_offset, int(rec["alarm"]))
            )

    transitions.sort(key=lambda item: item[0])
    return transitions



def state_samples_to_runs(
    times: Sequence[float],
    states: Sequence[bool],
    plot_end: float,
) -> List[Tuple[float, float]]:
    runs: List[Tuple[float, float]] = []
    active = False
    run_start = None

    for t, state in zip(times, states):
        state = bool(state)
        if state and not active:
            active = True
            run_start = t
        elif not state and active:
            runs.append((run_start, t))
            active = False
            run_start = None

    if active and run_start is not None:
        runs.append((run_start, plot_end))

    return runs



def clip_runs(
    runs: Sequence[Tuple[float, float]],
    plot_start: float,
    plot_end: float,
) -> List[Tuple[float, float]]:
    clipped: List[Tuple[float, float]] = []
    for start, end in runs:
        start = max(start, plot_start)
        end = min(end, plot_end)
        if end > start:
            clipped.append((start, end))
    return clipped



def clip_series_to_window(
    times: Sequence[float],
    score_u0: Sequence[float],
    score_u1: Sequence[float],
    plot_start: float,
    plot_end: float,
):
    window_times: List[float] = []
    window_score_u0: List[float] = []
    window_score_u1: List[float] = []

    for t, s0, s1 in zip(times, score_u0, score_u1):
        if plot_start <= t <= plot_end:
            window_times.append(t)
            window_score_u0.append(s0)
            window_score_u1.append(s1)

    return window_times, window_score_u0, window_score_u1



def transitions_to_segments(
    transitions: Sequence[Tuple[float, int]],
    plot_start: float,
    plot_end: float,
    default_state: int = 0,
) -> List[Tuple[float, float, int]]:
    if plot_end <= plot_start:
        return []

    segments: List[Tuple[float, float, int]] = []
    current_state = int(default_state)
    last_t = plot_start

    for t, state in transitions:
        state = int(bool(state))

        if t <= plot_start:
            current_state = state
            continue
        if t >= plot_end:
            break

        if t > last_t:
            segments.append((last_t, t, current_state))
        current_state = state
        last_t = t

    if last_t < plot_end:
        segments.append((last_t, plot_end, current_state))

    return segments



def format_mmss(x, pos):
    x = max(0, float(x))
    minutes = int(x // 60)
    seconds = int(x % 60)
    return f"{minutes}:{seconds:02d}"


def plot_scores_with_alarm(
    user_path: str,
    global_path: str,
    output_path: str,
    sync_time_offset: float = DEFAULT_SYNC_TIME_OFFSET,
    time_begin: Optional[float] = None,
    time_end: Optional[float] = None,
):
    times, score_u0, score_u1, collision_pairs = load_user_series(user_path)
    if not times:
        raise RuntimeError("No user-change events with both user0 and user1 were found.")

    available_start = times[0]
    available_end = times[-1]
    plot_start = available_start if time_begin is None else float(time_begin)
    plot_end = available_end if time_end is None else float(time_end)

    if plot_start < available_start:
        plot_start = available_start
    if plot_end > available_end:
        plot_end = available_end
    if plot_end <= plot_start:
        raise RuntimeError(
            f"Invalid plot window: [{plot_start}, {plot_end}] after clipping to available time range "
            f"[{available_start}, {available_end}]."
        )

    window_times, window_score_u0, window_score_u1 = clip_series_to_window(
        times, score_u0, score_u1, plot_start, plot_end
    )
    if not window_times:
        raise RuntimeError(
            f"No user-change samples found in the requested time window [{plot_start}, {plot_end}]."
        )

    full_collision_runs = state_samples_to_runs(times, collision_pairs, available_end)
    collision_runs = clip_runs(full_collision_runs, plot_start, plot_end)
    collision_count = len(collision_runs)

    # shift everything so the x-axis starts at 0:00
    base_time = plot_start
    window_times = [t - base_time for t in window_times]
    collision_runs = [(start - base_time, end - base_time) for start, end in collision_runs]
    plot_end_rel = plot_end - base_time

    fig, ax = plt.subplots(figsize=(13, 6))

    for i, (start, end) in enumerate(collision_runs):
        ax.axvspan(
            start,
            end,
            ymin=0.0,
            ymax=1.0,
            color="red",
            alpha=0.14,
            label="collisions" if i == 0 else None,
            zorder=0,
        )

    ax.step(window_times, window_score_u0, where="post", label="Player 1", zorder=3)
    ax.step(window_times, window_score_u1, where="post", label="Player 2", zorder=3)

    ymax = max(max(window_score_u0, default=0.0), max(window_score_u1, default=0.0))
    ax.set_ylim(0, max(10.5, ymax + 0.5))
    ax.set_xlim(left=0, right=plot_end_rel)
    ax.set_xlabel("time (m:ss)")
    ax.set_ylabel("score")
    ax.xaxis.set_major_formatter((format_mmss))
    ax.set_title("Scores and collision events")
    ax.grid(True, alpha=0.3)

    duration = plot_end - plot_start
    minutes = int(duration // 60)
    seconds = int(duration % 60)
    ax.text(
        0.995,
        0.98,
        f"collision events: {collision_count}\nduration: {minutes:02d}:{seconds:02d}",
        transform=ax.transAxes,
        ha="right",
        va="baseline",
        fontsize=9,
        bbox={"facecolor": "white", "alpha": 0.85, "edgecolor": "0.8", "pad": 3},
    )

    ax.legend()

    fig.tight_layout()
    fig.savefig(output_path, dpi=200)
    plt.show()



def build_arg_parser():
    parser = argparse.ArgumentParser(
        description=(
            "Plot user0/user1 scores against event time, highlight collision runs from the "
            "user log, and overlay alarm on/off segments from the global log."
        )
    )
    parser.add_argument("--user-path", default=DEFAULT_USER_PATH)
    parser.add_argument("--global-path", default=DEFAULT_GLOBAL_PATH)
    parser.add_argument("--output", default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--sync-time-offset",
        type=float,
        default=DEFAULT_SYNC_TIME_OFFSET,
        help="Offset added to syncTriggerTime before comparing it with user event time.",
    )
    parser.add_argument(
        "--time-begin",
        type=float,
        default=None,
        help="Start time of the plotted window in user-event time units.",
    )
    parser.add_argument(
        "--time-end",
        type=float,
        default=None,
        help="End time of the plotted window in user-event time units.",
    )
    return parser


if __name__ == "__main__":
    args = build_arg_parser().parse_args()
    plot_scores_with_alarm(
        user_path=args.user_path,
        global_path=args.global_path,
        output_path=args.output,
        sync_time_offset=args.sync_time_offset,
        time_begin=args.time_begin,
        time_end=args.time_end,
    )
