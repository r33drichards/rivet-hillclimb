# Hillclimb: an event-driven agent

Eight Manim scenes explain the feedback loop, durable actors, GitHub Actions, sleep/wake conditions, conflicts, PR commands, and cancellation. Geometric animation uses a charcoal background with blue, yellow, violet, green, and red accents. Narration uses ElevenLabs' premade George voice; no voice cloning is used.

## Generate narration

ElevenLabs onboarding stores the API key in the ignored `.env.local`. The SDK reads it from the environment; it is never embedded in source or sent to the hillclimb worker.

```sh
npm ci
npm run video:narrate
```

`scenes.json` contains the narration and measured timing. Generated MP3 files are cached in ignored `video/audio/`; rerunning with identical text, voice, and model reuses them. Environment overrides: `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`. The defaults are George and `eleven_v4`.

## Render

Use Python 3.12 or another version supported by Manim. Install Cairo/Pango system dependencies if needed (see https://docs.manim.community/en/stable/installation.html). FFmpeg/ffprobe must be on PATH for narration timing and export checks.

```sh
python3.12 -m venv .local/manim-venv
.local/manim-venv/bin/pip install -r video/requirements.txt
.local/manim-venv/bin/manim -qh --fps 30 --media_dir video/media video/hillclimb.py HillclimbExplainer
```

The scene reads audio paths relative to this directory, and writes `render-timing.json` for synchronization checks. Media and timing output stay out of Git. The project uses Nix for any Rust dependencies/Cargo; this video uses Python and Node, with no Rust compilation.
