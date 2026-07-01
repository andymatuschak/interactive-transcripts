# Implementation Guide

This document captures the current architecture of the Transcript plugin. It is a working guide for contributors, not a complete tutorial.

## Runtime Overview

Transcript blocks are Markdown directives:

```markdown
:::transcript[recording.m4a]{start=12.3 end=45.6}
Editable transcript text.
:::
```

The plugin layers several systems on top of that syntax:

- `src/core/` parses and serializes transcript directives and applies timestamp-preserving edit operations.
- `src/editor/` renders CodeMirror widgets, play buttons, skip markers, and edit reducers.
- `src/playback/` owns audio playback, word highlighting, click-to-seek, and floating playback controls.
- `src/alignment/` owns cached alignment data, edit reconciliation, and local transcription requests.
- `python/speechServer.py` is a persistent Python process that runs `parakeet-mlx` and returns word-level timestamps.

## Transcription Flow

1. `alignmentLoaderPlugin` finds transcript directives in the active editor.
2. `AlignmentManager` checks in-memory and persistent caches.
3. Ordinary edits are handled by local reducers or token-diff reconciliation when possible.
4. When transcription is needed, `SpeechEngine` starts `python/speechServer.py` with `uv`.
5. The Python server validates the model path or cached model.
6. If the default model is not cached, the server refuses to download until the TypeScript side shows a consent modal.
7. If the user chooses Download, the server downloads the model with byte progress, loads it, transcribes, and returns alignment data.
8. Alignment is cached under the installed plugin folder, e.g. `.obsidian/plugins/interactive-transcripts/cache/parakeet-v1`.

## Local Dependencies

Runtime transcription needs:

- `uv`, for the Python package environment.
- `ffmpeg`, for audio decoding.
- MLX-compatible hardware for the default local model path.

The plugin preflights missing `uv` and missing `ffmpeg` and shows install modals before attempting transcription.

## Model Handling

The default model is `mlx-community/parakeet-tdt-0.6b-v3`. The first download is about 2.5 GB.

Users may set `Model path` to a local model folder. The folder must contain:

- `config.json`
- `model.safetensors`

The TypeScript side validates this before sending a transcription request. The Python side validates it again before loading the model.

## Editing And Alignment

The plugin should avoid arbitrary acoustic realignment after ordinary edits. Current behavior:

- Formatting, punctuation, whitespace, and small text edits are reconciled against existing alignment where possible.
- Splits and deletions use reducer logic in `src/core/operations.ts`.
- Middle deletions can create skip markers.
- If text diverges too far from cached alignment, the plugin falls back to transcription.

## Testing

Run TypeScript tests:

```bash
bun test
```

Run Python helper tests:

```bash
uv run --project python --with pytest pytest python/test_speechServer.py -q
```

Run the production build:

```bash
bun run build
```

Prepare release files:

```bash
bun run release:prepare
```

The release folder and archive must include `main.js`, `manifest.json`, `styles.css`, and the Python runtime files under `python/`.
