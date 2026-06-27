#!/usr/bin/env python3
"""Generate a spaced-repetition review schedule for a memory palace.

The classic expanding interval (roughly 1h, 1d, 3d, 1w, 2w, 1mo, ~2.5mo) is what
turns a freshly built palace from a party trick into a durable memory: each review
right as you're about to forget pushes the next forgetting point further out.

Usage:
  python review_schedule.py --start "today" --label "Spanish vocab palace"
  python review_schedule.py --start 2026-06-26 --exam 2026-07-10 --label "Anatomy"

With --exam, the schedule is compressed to fit before the deadline so every review
lands on or before exam day.
"""
import argparse
from datetime import datetime, timedelta

# (label, offset) where offset is a timedelta from the build moment.
DEFAULT_INTERVALS = [
    ("Same-day consolidation", timedelta(hours=1)),
    ("Review 1", timedelta(days=1)),
    ("Review 2", timedelta(days=3)),
    ("Review 3", timedelta(days=7)),
    ("Review 4", timedelta(days=14)),
    ("Review 5", timedelta(days=30)),
    ("Long-term lock-in", timedelta(days=75)),
]


def parse_start(value: str) -> datetime:
    if value.strip().lower() in ("today", "now"):
        return datetime.now()
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%d-%m-%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(value.strip(), fmt)
        except ValueError:
            continue
    raise SystemExit(f"Could not parse start date: {value!r}. Use YYYY-MM-DD or 'today'.")


def compress_to_exam(start: datetime, exam: datetime):
    """Spread the same number of reviews evenly (but still expanding) up to the exam."""
    total_days = (exam.date() - start.date()).days
    n = len(DEFAULT_INTERVALS)
    if total_days <= 1:
        # Not much runway: cram a few same-day/next-day passes.
        return [
            ("Cram pass 1", timedelta(hours=1)),
            ("Cram pass 2", timedelta(hours=4)),
            ("Night-before pass", timedelta(hours=12)),
            ("Morning-of pass", max(timedelta(hours=0), exam - start - timedelta(hours=2))),
        ]
    # Expanding fractions of the available window: heavier early, lighter later.
    fractions = [0.02, 0.08, 0.18, 0.33, 0.52, 0.75, 1.0][:n]
    out = []
    for i, frac in enumerate(fractions):
        offset = timedelta(days=round(total_days * frac))
        name = "Final review (exam day)" if frac == 1.0 else f"Review {i+1}"
        out.append((name, offset))
    return out


def main():
    p = argparse.ArgumentParser(description="Spaced-repetition schedule for a memory palace.")
    p.add_argument("--start", default="today", help="Build date: 'today' or YYYY-MM-DD.")
    p.add_argument("--exam", default=None, help="Optional deadline YYYY-MM-DD; compresses the schedule.")
    p.add_argument("--label", default="Memory palace", help="Name of the material being reviewed.")
    args = p.parse_args()

    start = parse_start(args.start)
    if args.exam:
        exam = parse_start(args.exam)
        if exam < start:
            raise SystemExit("Exam date is before the start date.")
        intervals = compress_to_exam(start, exam)
        header = f"Review schedule for: {args.label}  (deadline {exam.date()})"
    else:
        intervals = DEFAULT_INTERVALS
        header = f"Review schedule for: {args.label}"

    print(header)
    print("=" * len(header))
    for name, offset in intervals:
        when = start + offset
        if offset < timedelta(days=1):
            stamp = when.strftime("%a %d %b, %H:%M")
        else:
            stamp = when.strftime("%a %d %b %Y")
        print(f"  [{when.strftime('%Y-%m-%d')}]  {name:<26}  ->  {stamp}")
    print()
    print("Each review: walk the route from memory FIRST, only then peek. Rebuild")
    print("any image you blanked on, making it stranger. Skipped reviews are the")
    print("main reason palaces fade - put these on a calendar.")


if __name__ == "__main__":
    main()
