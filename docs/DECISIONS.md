# Decisions

## Backend Runtime

Use Node for the local backend. This avoids relying on a system Python install and lets the app bundle ffmpeg and ffprobe through npm packages.

## Filesystem Safety

The app can browse arbitrary local paths entered by the user, but create/delete operations are restricted to the `ShortClipper` project folder in v1.

## Clip Output

Each segment is re-encoded to H.264/AAC before concatenation. This is slower than stream-copy cutting, but it is more reliable for iPhone videos and non-keyframe cuts.

## Timestamp Format

Premiere-style `HH:MM:SS:FF` timestamps are interpreted as frame-based timecodes using the source video's probed frame rate. Decimal timestamps like `HH:MM:SS.mmm` are also supported.

## Transcription

Use `@huggingface/transformers` with Whisper models in the local Node backend. The first run may download model files. ShortClipper transcribes larger audio windows with `return_timestamps: "word"`, then derives sentence-level ranges from the word timings.

Default model:
- `Xenova/whisper-tiny.en`

Supported v1 audio window options:
- 15 seconds
- 30 seconds
- 45 seconds

Generated transcript artifacts:
- sentence prompt text
- sentence JSON
- word timing text
- word timing JSON
- SRT
- VTT

## Ending CTA Cards

Use ffmpeg `drawtext` over either a generated black clip or a sampled source-video still frame. This keeps CTA rendering local and avoids adding a browser screenshot dependency before the template system needs it.

The CTA clip is generated at the source video's probed width, height, and frame rate, then appended through the same concat path as the selected clip pieces.

Default style:
- `poster`: source still frame, grayscale, dark overlay, orange/white text, CTA panel

Fallback style:
- `minimal`: black background with centered white text

## Cut Smoothing

Sentence and word timestamps are too exact to use as final edit points. V1 render smoothing supports three edit styles:

- `smooth`: default for reflective content; preserves continuous thought arcs
- `precise`: sentence-level cuts with modest padding
- `jump`: tight social-style jump cuts

Default smooth values:

- start padding: 0.75 seconds
- end padding: 0 seconds
- merge gap: 15 seconds

This keeps clips from ending on the last phoneme of a sentence and avoids jump cuts between moments that belong to the same thought arc.
