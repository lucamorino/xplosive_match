import argparse
import json
from typing import Iterable, List, Sequence, Tuple

import matplotlib.pyplot as plt
from matplotlib.patches import Patch, Rectangle
from matplotlib.transforms import blended_transform_factory


DEFAULT_USER_PATH = "20260320-185220-0001_controller_User-Param-log.txt"
DEFAULT_GLOBAL_PATH = "20260320-184947-0000_server_Global-Param-log.txt"
DEFAULT_OUTPUT = "user_scores_time_alarm.png"
DEFAULT_SYNC_TIME_OFFSET = 134.26575425 #0.0
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



def plot_scores_with_alarm(
    user_path: str,
    global_path: str,
    output_path: str,
    sync_time_offset: float = DEFAULT_SYNC_TIME_OFFSET,
):
    times, score_u0, score_u1, collision_pairs = load_user_series(user_path)
    if not times:
        raise RuntimeError("No user-change events with both user0 and user1 were found.")

    plot_start = times[0]
    plot_end = times[-1]
    collision_runs = state_samples_to_runs(times, collision_pairs, plot_end)
    alarm_transitions = load_alarm_transitions(global_path, sync_time_offset)
    alarm_segments = transitions_to_segments(alarm_transitions, plot_start, plot_end)

    fig, ax = plt.subplots(figsize=(13, 6))

    # Collision spans in the full plot area.
    for i, (start, end) in enumerate(collision_runs):
        if end <= start:
            continue
        ax.axvspan(
            start,
            end,
            ymin=0.0,
            ymax=1.0,
            color="red",
            alpha=0.14,
            label="collision" if i == 0 else None,
            zorder=0,
        )

    # Alarm state band in axis coordinates so it always stays visible.
    band_y = 0.02
    band_h = 0.06
    trans = blended_transform_factory(ax.transData, ax.transAxes)
    band_labels_used = set()
    for start, end, state in alarm_segments:
        if end <= start:
            continue
        label = None
        if state == 1 and "alarm-on" not in band_labels_used:
            label = "alarm-on"
            band_labels_used.add(label)
        elif state == 0 and "alarm-off" not in band_labels_used:
            label = "alarm-off"
            band_labels_used.add(label)

        rect = Rectangle(
            (start, band_y),
            end - start,
            band_h,
            transform=trans,
            facecolor="tab:green" if state == 1 else "lightgray",
            edgecolor="none",
            alpha=0.35 if state == 1 else 0.6,
            label=label,
            zorder=1,
        )
        ax.add_patch(rect)

    ax.step(times, score_u0, where="post", label="user0", zorder=3)
    ax.step(times, score_u1, where="post", label="user1", zorder=3)

    ymax = max(max(score_u0, default=0.0), max(score_u1, default=0.0))
    ax.set_ylim(0, max(10.5, ymax + 0.5))
    ax.set_xlim(left=plot_start, right=plot_end)
    ax.set_xlabel("time")
    ax.set_ylabel("score")
    ax.set_title(
        f"Scores vs time with collision events and alarm segments (syncTriggerTime offset={sync_time_offset})"
    )
    ax.grid(True, alpha=0.3)
    ax.text(
        0.005,
        band_y + band_h / 2,
        "alarm",
        transform=ax.transAxes,
        ha="left",
        va="center",
        fontsize=9,
        bbox={"facecolor": "white", "alpha": 0.75, "edgecolor": "none", "pad": 1.5},
    )

    handles, labels = ax.get_legend_handles_labels()
    if "alarm-on" not in labels:
        handles.append(Patch(facecolor="tab:green", alpha=0.35, label="alarm-on"))
        labels.append("alarm-on")
    if "alarm-off" not in labels:
        handles.append(Patch(facecolor="lightgray", alpha=0.6, label="alarm-off"))
        labels.append("alarm-off")
    ax.legend(handles, labels)

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
    return parser


if __name__ == "__main__":
    args = build_arg_parser().parse_args()
    plot_scores_with_alarm(
        user_path=args.user_path,
        global_path=args.global_path,
        output_path=args.output,
        sync_time_offset=args.sync_time_offset,
    )
