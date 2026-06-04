# Fruitality — music prompts (for Suno / Udio, commercial-licensed)

The engine now supports a real looping track. To wire one in:
1. Generate on **Suno** (suno.com) or **Udio** — both grant commercial use on PAID plans
   (verify your plan's license terms cover game soundtracks).
2. Export **WAV/MP3**, name it `music.mp3`, drop it in `orchard/assets/`.
3. Tell me — I'll set `assets.music: 'assets/music.mp3'` in `games/fruitality.js`.
   (Engine fades it in, ducks it on every FRUITALITY finisher, loops it, and
   falls back to the procedural soundtrack if the file is missing.)

License-clean backstops if you skip AI: **Pixabay Music** (free, commercial OK),
**incompetech.com** (Kevin MacLeod, ~$30/track one-time commercial license),
**FMA** CC0 subset.

## Prompt — main combat loop (the hero track)
> Hyper-catchy mobile arcade brawler theme, 130–138 BPM, driving four-on-the-floor
> kick, punchy syncopated bass, bright plucky synth-marimba hook that loops and
> earworms, playful chiptune-meets-EDM energy, fruit-ninja / Brawl-Stars vibe,
> high-energy but cute, no vocals, seamless loop, mastered loud.

Style tags: `arcade, EDM, chiptune, upbeat, loopable, no vocals, video game`

## Prompt — boss theme (Coconut Titan, wave 4)
> Heavier boss-battle version of a cute arcade brawler theme, 140 BPM, big
> distorted bass, tribal toms, ominous brass stabs over a driving beat, tense
> but still playful/cartoony, builds relentlessly, no vocals, seamless loop.

Style tags: `boss battle, intense, arcade, orchestral-electronic, no vocals, loop`

## Prompt — victory / results sting (one-shot, ~5s)
> Short triumphant fruity arcade victory fanfare, bright major key, rising
> synth-brass + sparkle, 2 seconds, game win jingle, no vocals.

## Optional per-fighter select stinger (~2s each)
> Short quirky fruit-themed select sting matching {fruit} personality (e.g.
> watermelon = juicy bouncy; pineapple = proud brassy; kiwi = fast zippy;
> coconut = deep heavy). No vocals.

Tip: generate 3–5 of the combat loop, pick the catchiest. For a mobile game,
one genuinely sticky 60–90s loop beats many mediocre ones.
