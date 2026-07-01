# Claude Code Project Guidelines

## File Naming

Use **camelCase** for TypeScript files, not kebab-case:
- `viewPlugin.ts` (correct)
- `view-plugin.ts` (incorrect)

## Project Structure

- `src/alignment/` - Local timestamped transcription, cache, and edit reconciliation
- `src/core/` - Editor-agnostic utilities (parser, hash)
- `src/editor/` - CodeMirror 6 extensions and state
- `src/playback/` - Audio playback and sync
- `python/` - Persistent Python speech server using `parakeet-mlx`

## Key Patterns

### Singletons
`AudioManager` and `AlignmentManager` are singletons initialized in `main.ts` via `initialize(...)`. They must be destroyed in `onunload()`.

### CodeMirror Extensions
All CM6 extensions are registered in `main.ts`. Because several ViewPlugins access singletons during construction, initialize `AudioManager` and `AlignmentManager` before calling `registerEditorExtension`.

### Alignment Flow
1. `alignmentLoaderPlugin` detects transcript directives
2. `AlignmentManager` loads cached timings, reconciles ordinary text edits, and queues transcription when needed
3. `SpeechEngine` starts the Python speech server via `uv`
4. `python/speechServer.py` validates/downloads the local model, transcribes with `parakeet-mlx`, and returns word timestamps
5. Results are stored in `AlignmentCache` (persistent) and `alignmentStore` (in-memory)

### Local Dependencies
Runtime transcription requires:
- `uv` on the user's machine
- `ffmpeg` on the user's machine
- a local model cache or a user-approved model download

The plugin surfaces modals for missing `uv`, missing `ffmpeg`, and the first large model download. Keep those preflight paths friendly and explicit.

## Testing

Run tests with:
```bash
bun test
```

Test files use the `.test.ts` suffix and live alongside their source files.

### Unit Testing Guidelines

**Always include unit tests for pure functions**, especially in:
- `src/core/` - Parser, serializer, operations (split, delete, transform)
- Any function that takes data in and returns data out without side effects

**CodeMirror state is testable directly.** `@codemirror/state` is pure - you can construct real `EditorState` and `Transaction` objects in tests:

```typescript
import { EditorState } from "@codemirror/state";

const state = EditorState.create({ doc: "Hello world" });
const tr = state.update({ changes: { from: 0, to: 5, insert: "" } });
// Now test functions that take Transaction as input
```

For very simple logic (string classification, range checks), extract to pure functions. For transaction-specific logic, test with real CM state objects.

### Browser Test Harness

The `test-harness/` directory contains an HTML page for testing CodeMirror extensions in isolation.

```bash
bun run harness        # Build and serve (http://localhost:8765)
bun run harness:build  # Build bundle only
bun run harness:serve  # Serve only (if bundle already built)
```

Use Chrome MCP to automate browser testing. The harness imports real extensions from the bundled code, so rebuild after making changes.
