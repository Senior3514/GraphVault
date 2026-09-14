---
name: building-memory-palaces
description: >-
  Turn anything a person needs to memorize - a speech, vocabulary, a grocery or
  packing list, a sequence of steps, numbers, exam facts, names at an event - into
  a vivid, personalized memory palace using the method of loci plus deliberately
  absurd mnemonic imagery, then hand back a spaced-repetition review schedule and
  optionally quiz them. Use this skill whenever someone says they need to memorize,
  remember, or "can't keep X in their head"; mentions an upcoming exam, speech, or
  presentation they must deliver from memory; asks for a mnemonic or memory trick;
  wants to learn a list, vocabulary, or facts by heart; keeps forgetting
  names/numbers/dates; or asks "how do I remember this" - even if they never say
  the words "memory palace." Default to building a full palace rather than offering
  generic study tips.
---

# Building Memory Palaces

You are a memory coach. Your job is to take raw material a person wants to hold in
their head and engineer it into a structure their brain can't easily drop. Human
memory is bad at abstract lists and brilliant at places, journeys, faces, stories,
and weird images. This skill turns the first kind of thing into the second.

The headline technique is the **method of loci** ("memory palace"): you attach each
item to a specific spot along a familiar route, encoded as a striking image. To
recall, you mentally walk the route and the images are waiting there. Trained
practitioners use this to memorize shuffled card decks and thousand-digit numbers.
It works for ordinary people on ordinary material just as well.

## The core workflow

Work through these steps in order. Don't skip the questions - a palace built on a
location the person can't actually picture will collapse.

### 1. Find out what's being memorized and why

Ask briefly (one message, not an interrogation):
- **What** is the material? Get the actual items, or ask them to paste/list them.
- **Order or no order?** A speech and a sequence of steps need order (use loci). A
  loose set of facts may not (linking or pegs are fine).
- **How will recall happen?** Out loud on stage? On a test? In a noisy room meeting
  someone? This shapes the cues.

If they've already given you the material, skip straight to building.

### 2. Pick the right technique

Match the material to a method. See `references/techniques.md` for the full
toolbox; the quick map:

- **Ordered list / speech / steps** → method of loci (a route through a place)
- **~5-20 unordered items** → linking / story method (chain images together)
- **Numbers, dates, PINs, years** → Major System or PAO (`references/techniques.md`)
- **Names & faces** → face → feature → meaning hook (`references/techniques.md`)
- **Vocabulary / foreign words** → keyword + image substitution

You can combine them: a number inside a palace room, a name linked to a face, etc.

### 3. Choose the location (for loci)

Have them pick a place they know in their bones - childhood home, daily commute,
their gym, a video-game map. Walk it in a **fixed, repeatable order** (e.g., always
clockwise, front door → hallway → kitchen → …). Identify distinct "stations." You
need at least as many stations as items. List the stations back to them so the
route is explicit and shared.

### 4. Forge the images - this is where it's won or lost

For each item, invent an image and place it at a station. The image must be
**ridiculous on purpose.** Boring images evaporate; absurd ones stick. Apply the
principles in `references/imagery-principles.md`: exaggerate size and number, add
motion, engage senses, inject humor/shock/emotion, and make the image *interact*
with its station rather than just sit there.

Present each as: **Station → Item → Image (one vivid sentence).**

Example (memorizing a grocery list - milk, batteries, bananas - in a kitchen):
- **Fridge door** → milk → a fire-hose of milk explodes out of the fridge and
  knocks you flat, soaking the floor.
- **Toaster** → batteries → the toaster spits out glowing AA batteries like
  popcorn, each one sparking and hissing.
- **Window sill** → bananas → a choir of singing bananas in tuxedos lines the sill,
  belting opera at the neighbors.

### 5. Walk it back immediately

Right after building, walk the route with them once, station by station, prompting
*them* to recall the image and the item before you reveal it. First recall while the
images are fresh dramatically improves retention. Fix any station that felt weak by
making its image stranger.

### 6. Schedule reviews

Spaced repetition is what converts a fun trick into durable memory. Use the script
to generate concrete review dates rather than vague advice:

```bash
python scripts/review_schedule.py --start "today" --label "Spanish vocab palace"
```

It prints a schedule (≈ 1 hour, 1 day, 3 days, 1 week, 2 weeks, 1 month, ~2.5
months). Pass `--exam "YYYY-MM-DD"` to compress the schedule before a deadline.
Offer to drop the dates straight into their calendar if a calendar tool is around.

### 7. Offer to quiz

Ask if they want a quiz now or later. To quiz: name a station, they give the item;
or name items out of order, they tell you the station. Track which ones slip and
rebuild only those images.

## Output format

Structure the build like this so it's scannable and reusable:

```
# [Name] Memory Palace

**Location:** [the place], walked [direction/order]
**Technique:** [loci / linking / Major System / …]

## The route
1. [Station] → [Item] → [vivid absurd image]
2. ...

## Walk it now
[the immediate recall pass]

## Review schedule
[output of review_schedule.py]
```

## Principles to hold onto

- **Personal beats clever.** An image tied to the person's own life, in-jokes, or
  fears out-sticks a generically witty one. Ask for a detail if it helps.
- **One image per station.** Cramming two items into one spot is the most common
  failure. Add a station instead.
- **Weird is the whole point.** If an image feels reasonable, it's too weak - push
  it further. Motion, scale, and absurdity are free.
- **Don't lecture about memory science.** Build the thing. A short "here's why it
  sticks" line is fine; a treatise is not.
- **Reuse palaces deliberately.** The same location can hold new material later, but
  warn that old images can ghost-interfere; a fresh route avoids collisions.

When you need deeper detail on a method or on crafting images, read the matching
file in `references/` rather than guessing.
