import json
import matplotlib.pyplot as plt

path = "20260319-141812-0001_controller_User-Param-log_edited.txt"

x = []
score_u0 = []
score_u1 = []
collision_pairs = []
collision_key = {"collide", "collision"}

step = 0
with open(path, "r") as f:
    for line in f:
        rec = json.loads(line)

        if rec.get("event") != "user-change":
            continue

        users_by_id = {u["id"]: u for u in rec["users"]}

        if 0 not in users_by_id or 1 not in users_by_id:
            continue

        x.append(step)
        score_u0.append(users_by_id[0]["score"])
        score_u1.append(users_by_id[1]["score"])

        c0 = next((users_by_id[0].get(k) for k in collision_key if k in users_by_id[0]), False)
        c1 = next((users_by_id[1].get(k) for k in collision_key if k in users_by_id[1]), False)
        collision_pairs.append(bool(c0) and bool(c1))

        step += 1

collision_runs = []
run_start = None
for i, has_collision in enumerate(collision_pairs):
    if has_collision and run_start is None:
        run_start = x[i]
    elif not has_collision and run_start is not None:
        collision_runs.append((run_start, x[i - 1]))
        run_start = None

if run_start is not None and x:
    collision_runs.append((run_start, x[-1]))

collision_events = len(collision_runs)

plt.figure(figsize=(12, 5))
plt.step(x, score_u0, where="post", label="user0")
plt.step(x, score_u1, where="post", label="user1")

for i, (start, end) in enumerate(collision_runs):
    plt.axvspan(
        start,
        end,
        ymin=0.0,
        ymax=1.0,
        color="red",
        alpha=0.18,
        label="both-collision" if i == 0 else None,
    )

plt.ylim(0, 10.5)
plt.xlim(left=0)
plt.xlabel("user-change step")
plt.ylabel("score")
plt.title("Scores and collision events")
plt.legend()
plt.grid(True, alpha=0.3)

plt.text(
    0.99,
    0.02,
    f"collision events: {collision_events}",
    transform=plt.gca().transAxes,
    ha="right",
    va="bottom",
    bbox=dict(boxstyle="round", facecolor="white", alpha=0.85),
)

plt.tight_layout()
plt.savefig("user_scores.png", dpi=200)
plt.show()