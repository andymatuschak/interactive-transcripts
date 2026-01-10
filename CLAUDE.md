# Claude Code Project Guidelines

## File Naming

Use **camelCase** for TypeScript files, not kebab-case:
- `viewPlugin.ts` (correct)
- `view-plugin.ts` (incorrect)

## Project Structure

- `src/alignment/` - Audio-to-text alignment via Python subprocess
- `src/core/` - Editor-agnostic utilities (parser, hash)
- `src/editor/` - CodeMirror 6 extensions and state
- `src/playback/` - Audio playback and sync
- `python/` - Python alignment script using stable-ts

## Key Patterns

### Singletons
`AudioManager` and `AlignmentManager` are singletons initialized in `main.ts` via `getInstance(app)`. They must be destroyed in `onunload()`.

### CodeMirror Extensions
All CM6 extensions are registered in `main.ts`. ViewPlugins may be created before the plugin's `onload()` runs, so singletons accessed in ViewPlugins must handle uninitialized state gracefully.

### Alignment Flow
1. `alignmentLoaderPlugin` detects transcript directives
2. `AlignmentManager` debounces, queues, and manages alignment generation
3. `Aligner` runs the Python subprocess via `uv`
4. Results are stored in `AlignmentCache` (persistent) and `alignmentStore` (in-memory)

## Testing

Run tests with:
```bash
bun test
```

Test files use the `.test.ts` suffix and live alongside their source files.
