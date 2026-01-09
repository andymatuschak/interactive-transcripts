# Obsidian Transcript Plugin: Implementation Guide

A step-by-step tutorial for building a rich audio transcript plugin for Obsidian.

---

## Background

This plugin transforms audio embeds into interactive transcript blocks:

```markdown
<!-- Before (Obsidian wikilink embed) -->
![[recording.m4a]]

<!-- After -->
:::transcript[recording.m4a]{start=0 end=120}
Hello, this is the transcript text with word-level timing.
:::
```

The directive syntax is:
- `:::transcript` - Opening fence
- `[filename.m4a]` - Audio file path (vault-relative)
- `{start=X end=Y}` - Optional time bounds in seconds
- Content lines - The transcript text
- `:::` - Closing fence

**What it does**:
- Aligns transcript text to audio at the word level using AI (WhisperX)
- Plays audio with real-time word highlighting
- Cmd-click any word to play from that point
- Copy/paste excerpts with preserved audio timestamps
- Split transcripts with automatic timestamp calculation

---

## Prerequisites

Before starting, ensure you have:

1. **Bun** (https://bun.sh) - JavaScript runtime and package manager
2. **Python 3.10+** with pip
3. **Obsidian** installed with a test vault
4. Basic familiarity with TypeScript, CodeMirror 6 concepts, and Obsidian plugin development

---

## Milestone 1: Project Scaffolding

**Goal**: Create a minimal Obsidian plugin that loads and shows in settings.

### Step 1.1: Initialize the project

```bash
mkdir obsidian-transcript
cd obsidian-transcript
bun init -y
```

### Step 1.2: Install dependencies

```bash
bun add -d typescript @types/node @types/bun
bun add obsidian micromark micromark-extension-directive mdast-util-directive mdast-util-from-markdown mdast-util-to-markdown
```

> **Note**: We use `micromark-extension-directive` for proper markdown parsing. This ensures directives inside code blocks or comments are correctly ignored.

### Step 1.3: Create `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": false,
    "lib": ["ES2020", "DOM"]
  },
  "include": ["src/**/*"]
}
```

### Step 1.4: Create `esbuild.config.mjs`

```javascript
import esbuild from 'esbuild';
import { builtinModules } from 'module';

const isProduction = process.argv.includes('production');

// CRITICAL: Mark CodeMirror packages as external to avoid version conflicts
const external = [
  'obsidian',
  'electron',
  '@codemirror/autocomplete',
  '@codemirror/collab',
  '@codemirror/commands',
  '@codemirror/language',
  '@codemirror/lint',
  '@codemirror/search',
  '@codemirror/state',
  '@codemirror/view',
  '@lezer/common',
  '@lezer/highlight',
  '@lezer/lr',
  ...builtinModules.map(m => `node:${m}`),
];

esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'main.js',
  external,
  format: 'cjs',
  platform: 'node',
  target: 'es2020',
  sourcemap: isProduction ? false : 'inline',
  minify: isProduction,
  logLevel: 'info',
}).catch(() => process.exit(1));
```

### Step 1.5: Create `manifest.json`

```json
{
  "id": "obsidian-transcript",
  "name": "Transcript",
  "version": "0.1.0",
  "minAppVersion": "1.4.0",
  "description": "Rich audio transcript editing with word-level alignment",
  "author": "Your Name",
  "isDesktopOnly": true
}
```

### Step 1.6: Create `src/main.ts`

```typescript
import { Plugin } from 'obsidian';

export default class TranscriptPlugin extends Plugin {
  async onload() {
    console.log('Transcript plugin loaded');
  }

  async onunload() {
    console.log('Transcript plugin unloaded');
  }
}
```

### Step 1.7: Add build scripts to `package.json`

```json
{
  "scripts": {
    "dev": "bun run esbuild.config.mjs",
    "build": "bun run esbuild.config.mjs production"
  }
}
```

### Step 1.8: Build and install

```bash
bun run dev
```

Copy `main.js` and `manifest.json` to your test vault's `.obsidian/plugins/obsidian-transcript/` folder.

### Verification

1. Open Obsidian
2. Go to Settings → Community Plugins
3. Enable "Transcript" plugin
4. Open Developer Console (Cmd+Option+I)
5. **Expected**: See "Transcript plugin loaded" in console

---

## Milestone 2: Parse Transcript Directives

**Goal**: Detect and parse `:::transcript` blocks in the editor.

### Step 2.1: Create type definitions

Create `src/types.ts`:

```typescript
export interface TranscriptDirective {
  /** Audio file path from [filename.m4a] */
  audioPath: string;
  /** Optional attributes like start/end times */
  attributes: {
    start?: number;
    end?: number;
  };
  /** The transcript text content */
  content: string;
  /** Start position in document */
  from: number;
  /** End position in document */
  to: number;
}

export interface SkipMarker {
  /** Character offset in transcript content */
  position: number;
  /** Audio start time to skip */
  audioStart: number;
  /** Audio end time to skip to */
  audioEnd: number;
}
```

### Step 2.2: Create the parser

Create `src/core/parser.ts`:

```typescript
/**
 * Parser for transcript directives using micromark/mdast.
 *
 * This properly handles markdown structure, so directives inside
 * code blocks or comments are correctly ignored.
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import { directive } from "micromark-extension-directive";
import { directiveFromMarkdown } from "mdast-util-directive";
import type { Root, RootContent } from "mdast";
import type { ContainerDirective } from "mdast-util-directive";
import type { TranscriptDirective } from "../types";

/**
 * Parse time attributes from directive attributes.
 */
function parseTimeAttributes(attrs: Record<string, string | undefined> | undefined): {
  start?: number;
  end?: number;
} {
  if (!attrs) return {};

  const result: { start?: number; end?: number } = {};

  if (attrs.start !== undefined) {
    const num = parseFloat(attrs.start);
    if (!isNaN(num)) result.start = num;
  }

  if (attrs.end !== undefined) {
    const num = parseFloat(attrs.end);
    if (!isNaN(num)) result.end = num;
  }

  return result;
}

/**
 * Extract plain text content from mdast children nodes.
 */
function extractTextContent(children: RootContent[]): string {
  let text = "";

  for (const child of children) {
    if (child.type === "text") {
      text += child.value;
    } else if (child.type === "paragraph") {
      if ("children" in child) {
        text += extractTextContent(child.children as RootContent[]);
      }
      text += "\n";
    } else if ("children" in child && Array.isArray(child.children)) {
      text += extractTextContent(child.children as RootContent[]);
    } else if ("value" in child && typeof child.value === "string") {
      text += child.value;
    }
  }

  return text.trim();
}

/**
 * Check if a node is a transcript container directive.
 */
function isTranscriptDirective(node: RootContent): node is ContainerDirective {
  return node.type === "containerDirective" &&
         (node as ContainerDirective).name === "transcript";
}

/**
 * Parse all transcript directives from a markdown string.
 *
 * Uses micromark with the directive extension to properly parse markdown,
 * so directives inside code blocks or HTML comments are ignored.
 */
export function parseTranscriptDirectives(markdown: string): TranscriptDirective[] {
  const tree: Root = fromMarkdown(markdown, {
    extensions: [directive()],
    mdastExtensions: [directiveFromMarkdown()],
  });

  const directives: TranscriptDirective[] = [];

  for (const node of tree.children) {
    if (isTranscriptDirective(node)) {
      const containerDirective = node as ContainerDirective;

      // The label [audio.m4a] is stored in a paragraph with directiveLabel data
      let audioPath = "";
      const contentChildren: RootContent[] = [];

      for (const child of containerDirective.children) {
        if (
          child.type === "paragraph" &&
          child.data &&
          (child.data as Record<string, unknown>).directiveLabel === true
        ) {
          audioPath = extractTextContent([child]);
        } else {
          contentChildren.push(child);
        }
      }

      const content = extractTextContent(contentChildren);
      const position = containerDirective.position;

      if (audioPath && position) {
        directives.push({
          audioPath,
          attributes: parseTimeAttributes(
            containerDirective.attributes as Record<string, string | undefined>
          ),
          content,
          from: position.start.offset ?? 0,
          to: position.end.offset ?? markdown.length,
        });
      }
    }
  }

  return directives;
}

/**
 * Parse a single transcript directive from text.
 */
export function parseTranscriptFromText(text: string): TranscriptDirective | null {
  const directives = parseTranscriptDirectives(text);
  return directives[0] ?? null;
}
```

### Step 2.3: Write parser tests

Create `src/core/parser.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { parseTranscriptDirectives } from "./parser";

describe("parseTranscriptDirectives", () => {
  test("parses a basic transcript directive", () => {
    const markdown = `:::transcript[audio.m4a]
This is the transcript content.
:::`;
    const result = parseTranscriptDirectives(markdown);

    expect(result).toHaveLength(1);
    expect(result[0]?.audioPath).toBe("audio.m4a");
    expect(result[0]?.content).toBe("This is the transcript content.");
  });

  test("parses transcript with start/end attributes", () => {
    const markdown = `:::transcript[recording.m4a]{start=5.5 end=120.25}
Hello world.
:::`;
    const result = parseTranscriptDirectives(markdown);

    expect(result).toHaveLength(1);
    expect(result[0]?.attributes.start).toBe(5.5);
    expect(result[0]?.attributes.end).toBe(120.25);
  });

  test("ignores directives inside code blocks", () => {
    const markdown = `\`\`\`markdown
:::transcript[example.m4a]
This should NOT be parsed.
:::
\`\`\`

:::transcript[real.m4a]
This SHOULD be parsed.
:::`;
    const result = parseTranscriptDirectives(markdown);

    expect(result).toHaveLength(1);
    expect(result[0]?.audioPath).toBe("real.m4a");
  });

  test("handles multiple directives", () => {
    const markdown = `:::transcript[first.m4a]
First.
:::

:::transcript[second.m4a]
Second.
:::`;
    const result = parseTranscriptDirectives(markdown);

    expect(result).toHaveLength(2);
  });
});
```

Run tests with `bun test` to verify the parser works correctly.

### Step 2.4: Create a StateField

Create `src/editor/state.ts`:

```typescript
import { StateField, EditorState } from '@codemirror/state';
import { TranscriptDirective } from '../types';
import { parseTranscriptDirectives } from '../core/parser';

export interface TranscriptFieldValue {
  directives: TranscriptDirective[];
}

export const transcriptField = StateField.define<TranscriptFieldValue>({
  create(state: EditorState): TranscriptFieldValue {
    // Convert CodeMirror doc to string for micromark parser
    const markdown = state.doc.toString();
    return {
      directives: parseTranscriptDirectives(markdown),
    };
  },

  update(value, transaction): TranscriptFieldValue {
    // Only re-parse if document changed
    if (!transaction.docChanged) {
      return value;
    }
    const markdown = transaction.state.doc.toString();
    return {
      directives: parseTranscriptDirectives(markdown),
    };
  },
});
```

### Step 2.5: Register the extension

Update `src/main.ts`:

```typescript
import { Plugin } from 'obsidian';
import { transcriptField } from './editor/state';

export default class TranscriptPlugin extends Plugin {
  async onload() {
    console.log('Transcript plugin loaded');

    // Register the CodeMirror extension
    this.registerEditorExtension([transcriptField]);
  }

  async onunload() {
    console.log('Transcript plugin unloaded');
  }
}
```

### Step 2.5: Add a command to test parsing

Update `src/main.ts` to add a debug command:

```typescript
import { Plugin, MarkdownView } from 'obsidian';
import { transcriptField } from './editor/state';

export default class TranscriptPlugin extends Plugin {
  async onload() {
    console.log('Transcript plugin loaded');

    this.registerEditorExtension([transcriptField]);

    // Debug command to test parsing
    this.addCommand({
      id: 'debug-parse-transcripts',
      name: 'Debug: Log parsed transcripts',
      editorCallback: (editor, view) => {
        // Access the CodeMirror EditorView
        const cmView = (view as any).editor?.cm;
        if (cmView) {
          const state = cmView.state;
          const fieldValue = state.field(transcriptField);
          console.log('Parsed directives:', fieldValue.directives);
        }
      },
    });
  }

  async onunload() {
    console.log('Transcript plugin unloaded');
  }
}
```

### Verification

1. Build and reload the plugin
2. Create a test note with:
   ```markdown
   # Test

   :::transcript[audio.m4a]{start=5 end=60}
   This is the transcript content.
   It can span multiple lines.
   :::

   Some text in between.

   :::transcript[other.m4a]
   Second transcript.
   :::
   ```
3. Open Command Palette (Cmd+P)
4. Run "Debug: Log parsed transcripts"
5. **Expected**: Console shows array with 2 directives, each with correct `audioPath`, `attributes`, `content`, `from`, and `to` values

---

## Milestone 3: Visual Decorations

**Goal**: Render transcript blocks with distinctive styling and a play button.

### Step 3.1: Create a gutter widget

Create `src/editor/widgets.ts`:

```typescript
import { WidgetType } from '@codemirror/view';
import { TranscriptDirective } from '../types';

export class PlayButtonWidget extends WidgetType {
  constructor(private directive: TranscriptDirective) {
    super();
  }

  toDOM(): HTMLElement {
    const container = document.createElement('span');
    container.className = 'transcript-gutter-widget';

    const button = document.createElement('button');
    button.className = 'transcript-play-button';
    button.setAttribute('aria-label', 'Play');
    button.innerHTML = '▶';
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log('Play clicked for:', this.directive.audioPath);
      // We'll implement actual playback in a later milestone
    });

    container.appendChild(button);
    return container;
  }

  eq(other: PlayButtonWidget): boolean {
    return (
      this.directive.audioPath === other.directive.audioPath &&
      this.directive.from === other.directive.from
    );
  }

  ignoreEvent(): boolean {
    return false; // Allow click events
  }
}
```

### Step 3.2: Create the ViewPlugin

Create `src/editor/view-plugin.ts`:

```typescript
import {
  ViewPlugin,
  ViewUpdate,
  EditorView,
  Decoration,
  DecorationSet,
  WidgetType,
} from '@codemirror/view';
import { Range } from '@codemirror/state';
import { transcriptField } from './state';
import { PlayButtonWidget } from './widgets';

function buildDecorations(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const { directives } = view.state.field(transcriptField);

  for (const directive of directives) {
    // Add line decorations for styling
    const startLine = view.state.doc.lineAt(directive.from);
    const endLine = view.state.doc.lineAt(directive.to);

    // Style the opening fence line
    decorations.push(
      Decoration.line({ class: 'transcript-fence-line' }).range(startLine.from)
    );

    // Style content lines
    for (let lineNum = startLine.number + 1; lineNum < endLine.number; lineNum++) {
      const line = view.state.doc.line(lineNum);
      decorations.push(
        Decoration.line({ class: 'transcript-content-line' }).range(line.from)
      );
    }

    // Style the closing fence line
    decorations.push(
      Decoration.line({ class: 'transcript-fence-line' }).range(endLine.from)
    );

    // Add play button widget at the start
    decorations.push(
      Decoration.widget({
        widget: new PlayButtonWidget(directive),
        side: -1, // Before the line content
      }).range(directive.from)
    );
  }

  // Sort decorations by position (required by CodeMirror)
  decorations.sort((a, b) => a.from - b.from);

  return Decoration.set(decorations);
}

export const transcriptViewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);
```

### Step 3.3: Create styles

Create `src/styles.css`:

```css
/* Transcript block styling */
.transcript-fence-line {
  background-color: var(--background-secondary);
  border-left: 3px solid var(--interactive-accent);
}

.transcript-content-line {
  background-color: var(--background-secondary);
  border-left: 3px solid var(--interactive-accent);
  font-family: var(--font-monospace);
  padding-left: 8px;
}

/* Play button in gutter */
.transcript-gutter-widget {
  display: inline-flex;
  align-items: center;
  margin-right: 8px;
}

.transcript-play-button {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: none;
  background-color: var(--interactive-accent);
  color: var(--text-on-accent);
  cursor: pointer;
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.1s ease;
}

.transcript-play-button:hover {
  transform: scale(1.1);
}

.transcript-play-button:active {
  transform: scale(0.95);
}
```

### Step 3.4: Register the plugin and styles

Update `src/main.ts`:

```typescript
import { Plugin, MarkdownView } from 'obsidian';
import { transcriptField } from './editor/state';
import { transcriptViewPlugin } from './editor/view-plugin';

export default class TranscriptPlugin extends Plugin {
  async onload() {
    console.log('Transcript plugin loaded');

    // Register CodeMirror extensions
    this.registerEditorExtension([transcriptField, transcriptViewPlugin]);

    // Load styles
    this.loadStyles();

    // Debug command
    this.addCommand({
      id: 'debug-parse-transcripts',
      name: 'Debug: Log parsed transcripts',
      editorCallback: (editor, view) => {
        const cmView = (view as any).editor?.cm;
        if (cmView) {
          const state = cmView.state;
          const fieldValue = state.field(transcriptField);
          console.log('Parsed directives:', fieldValue.directives);
        }
      },
    });
  }

  private loadStyles() {
    const style = document.createElement('style');
    style.id = 'transcript-plugin-styles';
    style.textContent = `
      .transcript-fence-line {
        background-color: var(--background-secondary);
        border-left: 3px solid var(--interactive-accent);
      }
      .transcript-content-line {
        background-color: var(--background-secondary);
        border-left: 3px solid var(--interactive-accent);
        font-family: var(--font-monospace);
        padding-left: 8px;
      }
      .transcript-gutter-widget {
        display: inline-flex;
        align-items: center;
        margin-right: 8px;
      }
      .transcript-play-button {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        border: none;
        background-color: var(--interactive-accent);
        color: var(--text-on-accent);
        cursor: pointer;
        font-size: 10px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.1s ease;
      }
      .transcript-play-button:hover {
        transform: scale(1.1);
      }
    `;
    document.head.appendChild(style);

    // Clean up on unload
    this.register(() => style.remove());
  }

  async onunload() {
    console.log('Transcript plugin unloaded');
  }
}
```

### Verification

1. Build and reload the plugin
2. Open the test note with transcript blocks
3. **Expected**:
   - Transcript blocks have a colored background and left border
   - Content lines use monospace font
   - A circular play button appears at the start of each block
   - Clicking the button logs the audio path to console

---

## Milestone 4: Basic Audio Playback

**Goal**: Click play button to play audio from the vault.

### Step 4.1: Create the AudioManager

> **Note**: Bun is Node-compatible, so we can use Node's `child_process` and other built-in modules.

Create `src/playback/audio-manager.ts`:

```typescript
import { App, TFile } from 'obsidian';
import { TranscriptDirective } from '../types';

export interface PlaybackState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  directive: TranscriptDirective | null;
}

type PlaybackListener = (state: PlaybackState) => void;

/**
 * Singleton manager for audio playback across the vault
 */
export class AudioManager {
  private static instance: AudioManager | null = null;

  private audio: HTMLAudioElement | null = null;
  private currentDirective: TranscriptDirective | null = null;
  private listeners: Set<PlaybackListener> = new Set();
  private app: App;

  private constructor(app: App) {
    this.app = app;
  }

  static getInstance(app?: App): AudioManager {
    if (!AudioManager.instance) {
      if (!app) throw new Error('AudioManager requires App on first call');
      AudioManager.instance = new AudioManager(app);
    }
    return AudioManager.instance;
  }

  static destroy() {
    if (AudioManager.instance) {
      AudioManager.instance.stop();
      AudioManager.instance = null;
    }
  }

  /**
   * Play audio for a transcript directive
   */
  async play(directive: TranscriptDirective, startTime?: number): Promise<void> {
    // Stop any current playback
    this.stop();

    // Resolve audio file path to a URL
    const audioUrl = await this.resolveAudioUrl(directive.audioPath);
    if (!audioUrl) {
      console.error('Could not resolve audio file:', directive.audioPath);
      return;
    }

    // Create new audio element
    this.audio = new Audio(audioUrl);
    this.currentDirective = directive;

    // Set start time
    const effectiveStart = startTime ?? directive.attributes.start ?? 0;
    this.audio.currentTime = effectiveStart;

    // Set up event listeners
    this.audio.addEventListener('timeupdate', this.handleTimeUpdate);
    this.audio.addEventListener('ended', this.handleEnded);
    this.audio.addEventListener('loadedmetadata', () => {
      this.notifyListeners();
    });

    // Start playback
    try {
      await this.audio.play();
      this.notifyListeners();
    } catch (err) {
      console.error('Playback failed:', err);
    }
  }

  /**
   * Pause playback
   */
  pause(): void {
    this.audio?.pause();
    this.notifyListeners();
  }

  /**
   * Resume playback
   */
  resume(): void {
    this.audio?.play();
    this.notifyListeners();
  }

  /**
   * Stop playback and clean up
   */
  stop(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.removeEventListener('timeupdate', this.handleTimeUpdate);
      this.audio.removeEventListener('ended', this.handleEnded);
      this.audio.src = '';
      this.audio = null;
    }
    this.currentDirective = null;
    this.notifyListeners();
  }

  /**
   * Seek to a specific time
   */
  seekTo(time: number): void {
    if (this.audio) {
      this.audio.currentTime = time;
      this.notifyListeners();
    }
  }

  /**
   * Get current playback state
   */
  getState(): PlaybackState {
    return {
      isPlaying: this.audio ? !this.audio.paused : false,
      currentTime: this.audio?.currentTime ?? 0,
      duration: this.audio?.duration ?? 0,
      directive: this.currentDirective,
    };
  }

  /**
   * Subscribe to playback state changes
   */
  subscribe(listener: PlaybackListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private handleTimeUpdate = () => {
    // Check if we've reached the end time
    const endTime = this.currentDirective?.attributes.end;
    if (endTime !== undefined && this.audio && this.audio.currentTime >= endTime) {
      this.stop();
      return;
    }
    this.notifyListeners();
  };

  private handleEnded = () => {
    this.stop();
  };

  private notifyListeners(): void {
    const state = this.getState();
    this.listeners.forEach((listener) => listener(state));
  }

  /**
   * Resolve a vault-relative audio path to a playable URL
   */
  private async resolveAudioUrl(audioPath: string): Promise<string | null> {
    // Try to find the file in the vault
    const file = this.app.vault.getAbstractFileByPath(audioPath);

    if (file instanceof TFile) {
      // Get the resource path that Obsidian uses
      return this.app.vault.getResourcePath(file);
    }

    // Try with different extensions or locations
    console.warn('Audio file not found:', audioPath);
    return null;
  }
}
```

### Step 4.2: Update the widget to use AudioManager

Update `src/editor/widgets.ts`:

```typescript
import { WidgetType, EditorView } from '@codemirror/view';
import { TranscriptDirective } from '../types';
import { AudioManager } from '../playback/audio-manager';

export class PlayButtonWidget extends WidgetType {
  constructor(
    private directive: TranscriptDirective,
    private audioManager: AudioManager
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const container = document.createElement('span');
    container.className = 'transcript-gutter-widget';

    const button = document.createElement('button');
    button.className = 'transcript-play-button';
    button.setAttribute('aria-label', 'Play');
    button.innerHTML = '▶';

    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const state = this.audioManager.getState();

      // If this directive is already playing, pause/resume
      if (state.directive?.from === this.directive.from) {
        if (state.isPlaying) {
          this.audioManager.pause();
          button.innerHTML = '▶';
        } else {
          this.audioManager.resume();
          button.innerHTML = '⏸';
        }
      } else {
        // Play this directive
        this.audioManager.play(this.directive);
        button.innerHTML = '⏸';
      }
    });

    // Subscribe to state changes to update button icon
    const unsubscribe = this.audioManager.subscribe((state) => {
      if (state.directive?.from === this.directive.from && state.isPlaying) {
        button.innerHTML = '⏸';
      } else {
        button.innerHTML = '▶';
      }
    });

    // Note: Widgets don't have a destroy lifecycle, so we can't cleanly unsubscribe
    // In a production app, we'd need a more sophisticated approach

    container.appendChild(button);
    return container;
  }

  eq(other: PlayButtonWidget): boolean {
    return (
      this.directive.audioPath === other.directive.audioPath &&
      this.directive.from === other.directive.from
    );
  }

  ignoreEvent(): boolean {
    return false;
  }
}
```

### Step 4.3: Update ViewPlugin to pass AudioManager

Update `src/editor/view-plugin.ts`:

```typescript
import {
  ViewPlugin,
  ViewUpdate,
  EditorView,
  Decoration,
  DecorationSet,
} from '@codemirror/view';
import { Range } from '@codemirror/state';
import { transcriptField } from './state';
import { PlayButtonWidget } from './widgets';
import { AudioManager } from '../playback/audio-manager';

export function createTranscriptViewPlugin(audioManager: AudioManager) {
  function buildDecorations(view: EditorView): DecorationSet {
    const decorations: Range<Decoration>[] = [];
    const { directives } = view.state.field(transcriptField);

    for (const directive of directives) {
      const startLine = view.state.doc.lineAt(directive.from);
      const endLine = view.state.doc.lineAt(directive.to);

      // Style the opening fence line
      decorations.push(
        Decoration.line({ class: 'transcript-fence-line' }).range(startLine.from)
      );

      // Style content lines
      for (let lineNum = startLine.number + 1; lineNum < endLine.number; lineNum++) {
        const line = view.state.doc.line(lineNum);
        decorations.push(
          Decoration.line({ class: 'transcript-content-line' }).range(line.from)
        );
      }

      // Style the closing fence line
      decorations.push(
        Decoration.line({ class: 'transcript-fence-line' }).range(endLine.from)
      );

      // Add play button widget
      decorations.push(
        Decoration.widget({
          widget: new PlayButtonWidget(directive, audioManager),
          side: -1,
        }).range(directive.from)
      );
    }

    decorations.sort((a, b) => a.from - b.from);
    return Decoration.set(decorations);
  }

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildDecorations(update.view);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}
```

### Step 4.4: Update main.ts

Update `src/main.ts`:

```typescript
import { Plugin } from 'obsidian';
import { transcriptField } from './editor/state';
import { createTranscriptViewPlugin } from './editor/view-plugin';
import { AudioManager } from './playback/audio-manager';

export default class TranscriptPlugin extends Plugin {
  private audioManager!: AudioManager;

  async onload() {
    console.log('Transcript plugin loaded');

    // Initialize AudioManager
    this.audioManager = AudioManager.getInstance(this.app);

    // Register CodeMirror extensions
    this.registerEditorExtension([
      transcriptField,
      createTranscriptViewPlugin(this.audioManager),
    ]);

    // Load styles
    this.loadStyles();
  }

  private loadStyles() {
    const style = document.createElement('style');
    style.id = 'transcript-plugin-styles';
    style.textContent = `
      .transcript-fence-line {
        background-color: var(--background-secondary);
        border-left: 3px solid var(--interactive-accent);
      }
      .transcript-content-line {
        background-color: var(--background-secondary);
        border-left: 3px solid var(--interactive-accent);
        font-family: var(--font-monospace);
        padding-left: 8px;
      }
      .transcript-gutter-widget {
        display: inline-flex;
        align-items: center;
        margin-right: 8px;
      }
      .transcript-play-button {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        border: none;
        background-color: var(--interactive-accent);
        color: var(--text-on-accent);
        cursor: pointer;
        font-size: 10px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.1s ease;
      }
      .transcript-play-button:hover {
        transform: scale(1.1);
      }
    `;
    document.head.appendChild(style);
    this.register(() => style.remove());
  }

  async onunload() {
    AudioManager.destroy();
    console.log('Transcript plugin unloaded');
  }
}
```

### Verification

1. Add an audio file (e.g., `test-audio.m4a`) to your test vault
2. Create a transcript block pointing to it:
   ```markdown
   :::transcript[test-audio.m4a]
   This is the transcript.
   :::
   ```
3. Click the play button
4. **Expected**:
   - Audio starts playing
   - Button icon changes to pause (⏸)
   - Clicking again pauses
   - Audio stops at end time if specified

---

## Milestone 5: Floating Playback Controls

**Goal**: Show a floating control bar during playback.

### Step 5.1: Create FloatingControls component

Create `src/playback/floating-controls.ts`:

```typescript
import { App } from 'obsidian';
import { AudioManager, PlaybackState } from './audio-manager';

export class FloatingControls {
  private container: HTMLElement;
  private playPauseBtn: HTMLButtonElement;
  private scrubber: HTMLInputElement;
  private timeDisplay: HTMLElement;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private app: App,
    private audioManager: AudioManager
  ) {
    this.container = this.createContainer();
    document.body.appendChild(this.container);

    // Subscribe to playback state
    this.unsubscribe = this.audioManager.subscribe((state) => {
      this.updateUI(state);
    });
  }

  private createContainer(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'transcript-floating-controls';
    container.style.display = 'none';

    // Play/Pause button
    this.playPauseBtn = document.createElement('button');
    this.playPauseBtn.className = 'control-btn play-pause';
    this.playPauseBtn.innerHTML = '▶';
    this.playPauseBtn.addEventListener('click', () => this.togglePlayPause());
    container.appendChild(this.playPauseBtn);

    // Time display
    this.timeDisplay = document.createElement('span');
    this.timeDisplay.className = 'time-display';
    this.timeDisplay.textContent = '0:00 / 0:00';
    container.appendChild(this.timeDisplay);

    // Scrubber
    this.scrubber = document.createElement('input');
    this.scrubber.type = 'range';
    this.scrubber.className = 'scrubber';
    this.scrubber.min = '0';
    this.scrubber.max = '100';
    this.scrubber.value = '0';
    this.scrubber.addEventListener('input', () => {
      const state = this.audioManager.getState();
      const time = (parseFloat(this.scrubber.value) / 100) * state.duration;
      this.audioManager.seekTo(time);
    });
    container.appendChild(this.scrubber);

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'control-btn close';
    closeBtn.innerHTML = '×';
    closeBtn.addEventListener('click', () => this.close());
    container.appendChild(closeBtn);

    return container;
  }

  private togglePlayPause(): void {
    const state = this.audioManager.getState();
    if (state.isPlaying) {
      this.audioManager.pause();
    } else {
      this.audioManager.resume();
    }
  }

  private close(): void {
    this.audioManager.stop();
  }

  private updateUI(state: PlaybackState): void {
    // Show/hide based on whether we have an active directive
    if (state.directive) {
      this.container.style.display = 'flex';
    } else {
      this.container.style.display = 'none';
      return;
    }

    // Update play/pause icon
    this.playPauseBtn.innerHTML = state.isPlaying ? '⏸' : '▶';

    // Update scrubber
    if (state.duration > 0) {
      const progress = (state.currentTime / state.duration) * 100;
      this.scrubber.value = String(progress);
    }

    // Update time display
    this.timeDisplay.textContent = `${this.formatTime(state.currentTime)} / ${this.formatTime(state.duration)}`;
  }

  private formatTime(seconds: number): string {
    if (isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  destroy(): void {
    this.unsubscribe?.();
    this.container.remove();
  }
}
```

### Step 5.2: Add styles for floating controls

Update the `loadStyles()` method in `src/main.ts` to add:

```css
.transcript-floating-controls {
  position: fixed;
  bottom: 20px;
  right: 20px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 1000;
}

.transcript-floating-controls .control-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.transcript-floating-controls .control-btn.close {
  background: transparent;
  color: var(--text-muted);
  font-size: 20px;
}

.transcript-floating-controls .control-btn.close:hover {
  color: var(--text-normal);
}

.transcript-floating-controls .scrubber {
  width: 150px;
  cursor: pointer;
}

.transcript-floating-controls .time-display {
  font-size: 12px;
  font-family: var(--font-monospace);
  color: var(--text-muted);
  min-width: 80px;
}
```

### Step 5.3: Initialize FloatingControls in main.ts

Update `src/main.ts`:

```typescript
import { Plugin } from 'obsidian';
import { transcriptField } from './editor/state';
import { createTranscriptViewPlugin } from './editor/view-plugin';
import { AudioManager } from './playback/audio-manager';
import { FloatingControls } from './playback/floating-controls';

export default class TranscriptPlugin extends Plugin {
  private audioManager!: AudioManager;
  private floatingControls!: FloatingControls;

  async onload() {
    console.log('Transcript plugin loaded');

    // Initialize AudioManager
    this.audioManager = AudioManager.getInstance(this.app);

    // Initialize floating controls
    this.floatingControls = new FloatingControls(this.app, this.audioManager);

    // Register CodeMirror extensions
    this.registerEditorExtension([
      transcriptField,
      createTranscriptViewPlugin(this.audioManager),
    ]);

    // Load styles
    this.loadStyles();
  }

  private loadStyles() {
    const style = document.createElement('style');
    style.id = 'transcript-plugin-styles';
    style.textContent = `
      /* ... previous styles ... */

      .transcript-floating-controls {
        position: fixed;
        bottom: 20px;
        right: 20px;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        background: var(--background-primary);
        border: 1px solid var(--background-modifier-border);
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        z-index: 1000;
      }
      /* ... rest of floating controls styles ... */
    `;
    document.head.appendChild(style);
    this.register(() => style.remove());
  }

  async onunload() {
    this.floatingControls.destroy();
    AudioManager.destroy();
    console.log('Transcript plugin unloaded');
  }
}
```

### Verification

1. Build and reload
2. Click play on a transcript block
3. **Expected**:
   - Floating controls appear at bottom-right
   - Time updates as audio plays
   - Scrubber moves with playback
   - Can drag scrubber to seek
   - Close button stops playback and hides controls

---

## Milestone 6: Python Alignment Setup

**Goal**: Set up Python environment and create alignment script.

### Step 6.1: Create Python directory and requirements

Create `python/requirements.txt`:

```
stable-ts>=2.15.0
torch>=2.0.0
```

> **Note**: We're using stable-ts instead of WhisperX because it's simpler to install and has fewer dependencies. You can switch to WhisperX later for better accuracy.

### Step 6.2: Create alignment script

Create `python/align.py`:

```python
#!/usr/bin/env python3
"""
Audio-to-text alignment script for obsidian-transcript plugin.
Uses stable-ts for word-level alignment.
"""

import argparse
import json
import sys
import hashlib
import time
from pathlib import Path


def hash_file(path: str) -> str:
    """Generate SHA256 hash of file contents."""
    with open(path, 'rb') as f:
        return f'sha256:{hashlib.sha256(f.read()).hexdigest()}'


def hash_text(text: str) -> str:
    """Generate SHA256 hash of text."""
    return f'sha256:{hashlib.sha256(text.encode()).hexdigest()}'


def align_audio(
    audio_path: str,
    transcript_path: str | None = None,
    model_name: str = 'base',
    language: str | None = None
) -> dict:
    """
    Perform word-level alignment using stable-ts.

    Args:
        audio_path: Path to audio file
        transcript_path: Optional path to existing transcript for forced alignment
        model_name: Whisper model to use
        language: Language code (auto-detected if not specified)

    Returns:
        Alignment data dictionary
    """
    import stable_whisper

    print(f"Loading model '{model_name}'...", file=sys.stderr)
    model = stable_whisper.load_model(model_name)

    if transcript_path:
        # Forced alignment with existing transcript
        print(f"Aligning transcript to audio...", file=sys.stderr)
        transcript_text = Path(transcript_path).read_text().strip()
        result = model.align(audio_path, transcript_text, language=language)
    else:
        # Transcribe and align
        print(f"Transcribing audio...", file=sys.stderr)
        result = model.transcribe(audio_path, language=language)

    # Convert to our format
    segments = []
    for segment in result.segments:
        words = []
        for word in segment.words:
            words.append({
                'word': word.word.strip(),
                'start': round(word.start, 3),
                'end': round(word.end, 3),
            })

        segments.append({
            'start': round(segment.start, 3),
            'end': round(segment.end, 3),
            'text': segment.text.strip(),
            'words': words,
        })

    # Read transcript for hash
    if transcript_path:
        transcript_text = Path(transcript_path).read_text().strip()
    else:
        transcript_text = result.text.strip()

    return {
        'audioHash': hash_file(audio_path),
        'transcriptHash': hash_text(transcript_text),
        'language': result.language or language or 'en',
        'tool': 'stable-ts',
        'createdAt': int(time.time() * 1000),
        'segments': segments,
        'text': transcript_text,
    }


def main():
    parser = argparse.ArgumentParser(description='Align audio to transcript')
    parser.add_argument('--audio', required=True, help='Path to audio file')
    parser.add_argument('--transcript', help='Path to transcript file (optional)')
    parser.add_argument('--model', default='base', help='Whisper model name')
    parser.add_argument('--language', help='Language code')

    args = parser.parse_args()

    try:
        result = align_audio(
            audio_path=args.audio,
            transcript_path=args.transcript,
            model_name=args.model,
            language=args.language,
        )

        # Output JSON to stdout
        print(json.dumps(result, indent=2))

    except Exception as e:
        print(json.dumps({'error': str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
```

### Step 6.3: Test the Python script manually

```bash
cd python

# Create virtual environment
python3 -m venv venv
source venv/bin/activate  # or `venv\Scripts\activate` on Windows

# Install dependencies
pip install -r requirements.txt

# Test alignment (replace with your audio file path)
python align.py --audio /path/to/test-audio.m4a --model tiny
```

### Verification

1. Run the script with a test audio file
2. **Expected**: JSON output with segments containing word-level timestamps:
   ```json
   {
     "audioHash": "sha256:abc...",
     "transcriptHash": "sha256:def...",
     "language": "en",
     "tool": "stable-ts",
     "segments": [
       {
         "start": 0.0,
         "end": 2.5,
         "text": "Hello world",
         "words": [
           {"word": "Hello", "start": 0.0, "end": 0.8},
           {"word": "world", "start": 0.9, "end": 2.5}
         ]
       }
     ]
   }
   ```

---

## Milestone 7: Alignment Integration

**Goal**: Call Python from Obsidian, cache results.

### Step 7.1: Create subprocess runner

Create `src/alignment/subprocess.ts`:

```typescript
import { spawn } from 'child_process';

export interface SubprocessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function runPython(
  pythonPath: string,
  scriptPath: string,
  args: string[],
  onProgress?: (message: string) => void
): Promise<SubprocessResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonPath, [scriptPath, ...args]);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
    });

    proc.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      if (onProgress) {
        onProgress(text);
      }
    });

    proc.on('close', (code: number | null) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 0,
      });
    });

    proc.on('error', (err: Error) => {
      reject(err);
    });
  });
}
```

### Step 7.2: Create alignment types

Add to `src/types.ts`:

```typescript
export interface AlignedWord {
  word: string;
  start: number;
  end: number;
}

export interface AlignedSegment {
  start: number;
  end: number;
  text: string;
  words: AlignedWord[];
}

export interface AlignmentData {
  audioHash: string;
  transcriptHash: string;
  language: string;
  tool: string;
  createdAt: number;
  segments: AlignedSegment[];
  text: string;
}
```

### Step 7.3: Create cache manager

Create `src/alignment/cache.ts`:

```typescript
import { App, TFile, TFolder } from 'obsidian';
import { AlignmentData } from '../types';
import { createHash } from 'crypto';

export class AlignmentCache {
  private cacheDir = '.obsidian/plugins/obsidian-transcript/cache';

  constructor(private app: App) {}

  /**
   * Get cached alignment if it exists and is valid
   */
  async get(audioPath: string, transcriptText: string): Promise<AlignmentData | null> {
    const key = this.getCacheKey(audioPath, transcriptText);
    const cachePath = `${this.cacheDir}/${key}.json`;

    try {
      const file = this.app.vault.getAbstractFileByPath(cachePath);
      if (file instanceof TFile) {
        const content = await this.app.vault.read(file);
        return JSON.parse(content) as AlignmentData;
      }
    } catch (e) {
      // Cache miss or invalid
    }

    return null;
  }

  /**
   * Store alignment in cache
   */
  async set(audioPath: string, alignment: AlignmentData): Promise<void> {
    // Ensure cache directory exists
    await this.ensureCacheDir();

    const key = this.getCacheKey(audioPath, alignment.text);
    const cachePath = `${this.cacheDir}/${key}.json`;
    const content = JSON.stringify(alignment, null, 2);

    const existingFile = this.app.vault.getAbstractFileByPath(cachePath);
    if (existingFile instanceof TFile) {
      await this.app.vault.modify(existingFile, content);
    } else {
      await this.app.vault.create(cachePath, content);
    }
  }

  private getCacheKey(audioPath: string, transcriptText: string): string {
    const hash = createHash('sha256');
    hash.update(audioPath);
    hash.update(transcriptText);
    return hash.digest('hex').slice(0, 16);
  }

  private async ensureCacheDir(): Promise<void> {
    const parts = this.cacheDir.split('/');
    let current = '';

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const folder = this.app.vault.getAbstractFileByPath(current);
      if (!folder) {
        await this.app.vault.createFolder(current);
      }
    }
  }
}
```

### Step 7.4: Create AlignmentService

Create `src/alignment/service.ts`:

```typescript
import { App, TFile, Notice } from 'obsidian';
import { TranscriptDirective, AlignmentData } from '../types';
import { AlignmentCache } from './cache';
import { runPython } from './subprocess';
import * as path from 'path';

export interface AlignmentSettings {
  pythonPath: string;
  model: string;
}

export class AlignmentService {
  private cache: AlignmentCache;

  constructor(
    private app: App,
    private settings: AlignmentSettings
  ) {
    this.cache = new AlignmentCache(app);
  }

  /**
   * Get or create alignment for a transcript directive
   */
  async getAlignment(directive: TranscriptDirective): Promise<AlignmentData | null> {
    // Check cache first
    const cached = await this.cache.get(directive.audioPath, directive.content);
    if (cached) {
      console.log('Using cached alignment');
      return cached;
    }

    // Need to run alignment
    return this.runAlignment(directive);
  }

  /**
   * Force re-alignment, ignoring cache
   */
  async runAlignment(directive: TranscriptDirective): Promise<AlignmentData | null> {
    const notice = new Notice('Aligning transcript...', 0);

    try {
      // Resolve paths
      const vaultPath = (this.app.vault.adapter as any).basePath;
      const audioFile = this.app.vault.getAbstractFileByPath(directive.audioPath);

      if (!(audioFile instanceof TFile)) {
        throw new Error(`Audio file not found: ${directive.audioPath}`);
      }

      const audioAbsPath = path.join(vaultPath, audioFile.path);

      // Get the align.py script path
      // In production, this would be bundled with the plugin
      const pluginDir = path.join(vaultPath, '.obsidian/plugins/obsidian-transcript');
      const scriptPath = path.join(pluginDir, 'python/align.py');

      // Write transcript to temp file
      const tempTranscriptPath = path.join(vaultPath, '.obsidian/plugins/obsidian-transcript/temp-transcript.txt');
      await this.app.vault.adapter.write(
        '.obsidian/plugins/obsidian-transcript/temp-transcript.txt',
        directive.content
      );

      // Run alignment
      const result = await runPython(
        this.settings.pythonPath,
        scriptPath,
        [
          '--audio', audioAbsPath,
          '--transcript', tempTranscriptPath,
          '--model', this.settings.model,
        ],
        (msg) => {
          notice.setMessage(`Aligning: ${msg.trim()}`);
        }
      );

      if (result.exitCode !== 0) {
        throw new Error(`Alignment failed: ${result.stderr}`);
      }

      const alignment = JSON.parse(result.stdout) as AlignmentData;

      // Cache the result
      await this.cache.set(directive.audioPath, alignment);

      notice.setMessage('Alignment complete!');
      setTimeout(() => notice.hide(), 2000);

      return alignment;

    } catch (error) {
      notice.hide();
      new Notice(`Alignment failed: ${error}`);
      console.error('Alignment error:', error);
      return null;
    }
  }
}
```

### Step 7.5: Add settings

Create `src/settings.ts`:

```typescript
import { App, PluginSettingTab, Setting } from 'obsidian';
import TranscriptPlugin from './main';

export interface TranscriptSettings {
  pythonPath: string;
  model: string;
  highlightColor: string;
}

export const DEFAULT_SETTINGS: TranscriptSettings = {
  pythonPath: 'python3',
  model: 'base',
  highlightColor: 'var(--text-accent)',
};

export class TranscriptSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: TranscriptPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Transcript Plugin Settings' });

    new Setting(containerEl)
      .setName('Python path')
      .setDesc('Path to Python executable with stable-ts installed')
      .addText((text) =>
        text
          .setPlaceholder('/usr/bin/python3')
          .setValue(this.plugin.settings.pythonPath)
          .onChange(async (value) => {
            this.plugin.settings.pythonPath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Whisper model')
      .setDesc('Model to use for transcription/alignment')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('tiny', 'Tiny (fastest)')
          .addOption('base', 'Base')
          .addOption('small', 'Small')
          .addOption('medium', 'Medium')
          .addOption('large', 'Large (most accurate)')
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
```

### Step 7.6: Update main.ts with settings and alignment command

Update `src/main.ts`:

```typescript
import { Plugin, MarkdownView } from 'obsidian';
import { transcriptField } from './editor/state';
import { createTranscriptViewPlugin } from './editor/view-plugin';
import { AudioManager } from './playback/audio-manager';
import { FloatingControls } from './playback/floating-controls';
import { AlignmentService } from './alignment/service';
import { TranscriptSettings, DEFAULT_SETTINGS, TranscriptSettingTab } from './settings';

export default class TranscriptPlugin extends Plugin {
  settings!: TranscriptSettings;
  private audioManager!: AudioManager;
  private floatingControls!: FloatingControls;
  private alignmentService!: AlignmentService;

  async onload() {
    console.log('Transcript plugin loaded');

    // Load settings
    await this.loadSettings();
    this.addSettingTab(new TranscriptSettingTab(this.app, this));

    // Initialize services
    this.audioManager = AudioManager.getInstance(this.app);
    this.floatingControls = new FloatingControls(this.app, this.audioManager);
    this.alignmentService = new AlignmentService(this.app, {
      pythonPath: this.settings.pythonPath,
      model: this.settings.model,
    });

    // Register CodeMirror extensions
    this.registerEditorExtension([
      transcriptField,
      createTranscriptViewPlugin(this.audioManager),
    ]);

    // Add commands
    this.addCommand({
      id: 'align-transcript',
      name: 'Align transcript at cursor',
      editorCallback: async (editor, view) => {
        const cmView = (view as any).editor?.cm;
        if (!cmView) return;

        const cursor = cmView.state.selection.main.head;
        const { directives } = cmView.state.field(transcriptField);

        // Find directive at cursor
        const directive = directives.find(
          (d: any) => cursor >= d.from && cursor <= d.to
        );

        if (directive) {
          const alignment = await this.alignmentService.runAlignment(directive);
          if (alignment) {
            console.log('Alignment result:', alignment);
          }
        } else {
          console.log('No transcript at cursor');
        }
      },
    });

    // Load styles
    this.loadStyles();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private loadStyles() {
    // ... same as before ...
  }

  async onunload() {
    this.floatingControls.destroy();
    AudioManager.destroy();
    console.log('Transcript plugin unloaded');
  }
}
```

### Verification

1. Copy the `python/` directory to your plugin folder in the vault
2. Configure Python path in settings
3. Place cursor inside a transcript block
4. Run command "Align transcript at cursor"
5. **Expected**:
   - Notice shows "Aligning transcript..."
   - After completion, alignment JSON is logged to console
   - Cache file appears in `.obsidian/plugins/obsidian-transcript/cache/`

---

## Milestone 8: Word Highlighting During Playback

**Goal**: Highlight the currently playing word in real-time.

### Step 8.1: Create highlight StateEffect

Update `src/editor/state.ts`:

```typescript
import { StateField, StateEffect, EditorState } from '@codemirror/state';
import { TranscriptDirective } from '../types';
import { parseTranscriptDirectives } from '../core/parser';

export interface TranscriptFieldValue {
  directives: TranscriptDirective[];
  highlightedWord: {
    directiveFrom: number;
    wordIndex: number;
  } | null;
}

// Effect to update word highlight
export const setHighlightedWord = StateEffect.define<{
  directiveFrom: number;
  wordIndex: number;
} | null>();

export const transcriptField = StateField.define<TranscriptFieldValue>({
  create(state: EditorState): TranscriptFieldValue {
    return {
      directives: parseTranscriptDirectives(state.doc),
      highlightedWord: null,
    };
  },

  update(value, transaction): TranscriptFieldValue {
    let newValue = value;

    // Check for highlight effect
    for (const effect of transaction.effects) {
      if (effect.is(setHighlightedWord)) {
        newValue = { ...newValue, highlightedWord: effect.value };
      }
    }

    // Re-parse if document changed
    if (transaction.docChanged) {
      newValue = {
        ...newValue,
        directives: parseTranscriptDirectives(transaction.state.doc),
      };
    }

    return newValue;
  },
});
```

### Step 8.2: Create HighlightSync

Create `src/playback/highlight-sync.ts`:

```typescript
import { EditorView } from '@codemirror/view';
import { setHighlightedWord, transcriptField } from '../editor/state';
import { AudioManager, PlaybackState } from './audio-manager';
import { AlignmentData, TranscriptDirective } from '../types';

export class HighlightSync {
  private rafId: number | null = null;
  private currentAlignment: AlignmentData | null = null;
  private currentDirective: TranscriptDirective | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private getEditorView: () => EditorView | null,
    private audioManager: AudioManager,
    private getAlignment: (directive: TranscriptDirective) => Promise<AlignmentData | null>
  ) {
    this.unsubscribe = this.audioManager.subscribe((state) => {
      this.handleStateChange(state);
    });
  }

  private async handleStateChange(state: PlaybackState): Promise<void> {
    if (state.isPlaying && state.directive) {
      // Load alignment if needed
      if (this.currentDirective?.from !== state.directive.from) {
        this.currentDirective = state.directive;
        this.currentAlignment = await this.getAlignment(state.directive);
      }

      // Start update loop
      if (!this.rafId) {
        this.scheduleUpdate();
      }
    } else {
      // Stop update loop and clear highlight
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      this.clearHighlight();
    }
  }

  private scheduleUpdate(): void {
    this.rafId = requestAnimationFrame(() => {
      this.updateHighlight();
      if (this.audioManager.getState().isPlaying) {
        this.scheduleUpdate();
      }
    });
  }

  private updateHighlight(): void {
    const view = this.getEditorView();
    if (!view || !this.currentAlignment || !this.currentDirective) return;

    const currentTime = this.audioManager.getState().currentTime;
    const wordIndex = this.findWordAtTime(currentTime);

    view.dispatch({
      effects: setHighlightedWord.of(
        wordIndex >= 0
          ? { directiveFrom: this.currentDirective.from, wordIndex }
          : null
      ),
    });
  }

  private clearHighlight(): void {
    const view = this.getEditorView();
    if (!view) return;

    view.dispatch({
      effects: setHighlightedWord.of(null),
    });
  }

  private findWordAtTime(time: number): number {
    if (!this.currentAlignment) return -1;

    let globalIndex = 0;
    for (const segment of this.currentAlignment.segments) {
      for (const word of segment.words) {
        if (time >= word.start && time <= word.end) {
          return globalIndex;
        }
        globalIndex++;
      }
    }
    return -1;
  }

  destroy(): void {
    this.unsubscribe?.();
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
    }
  }
}
```

### Step 8.3: Update ViewPlugin with word decorations

Update `src/editor/view-plugin.ts` to add word highlighting:

```typescript
import {
  ViewPlugin,
  ViewUpdate,
  EditorView,
  Decoration,
  DecorationSet,
} from '@codemirror/view';
import { Range } from '@codemirror/state';
import { transcriptField } from './state';
import { PlayButtonWidget } from './widgets';
import { AudioManager } from '../playback/audio-manager';
import { TranscriptDirective, AlignmentData } from '../types';

export function createTranscriptViewPlugin(
  audioManager: AudioManager,
  getAlignment?: (directive: TranscriptDirective) => AlignmentData | null
) {
  function buildDecorations(view: EditorView): DecorationSet {
    const decorations: Range<Decoration>[] = [];
    const { directives, highlightedWord } = view.state.field(transcriptField);

    for (const directive of directives) {
      const startLine = view.state.doc.lineAt(directive.from);
      const endLine = view.state.doc.lineAt(directive.to);

      // Line decorations (same as before)
      decorations.push(
        Decoration.line({ class: 'transcript-fence-line' }).range(startLine.from)
      );
      for (let lineNum = startLine.number + 1; lineNum < endLine.number; lineNum++) {
        const line = view.state.doc.line(lineNum);
        decorations.push(
          Decoration.line({ class: 'transcript-content-line' }).range(line.from)
        );
      }
      decorations.push(
        Decoration.line({ class: 'transcript-fence-line' }).range(endLine.from)
      );

      // Play button widget
      decorations.push(
        Decoration.widget({
          widget: new PlayButtonWidget(directive, audioManager),
          side: -1,
        }).range(directive.from)
      );

      // Word highlight
      if (
        highlightedWord &&
        highlightedWord.directiveFrom === directive.from &&
        getAlignment
      ) {
        const alignment = getAlignment(directive);
        if (alignment) {
          const wordPos = getWordPosition(
            directive,
            alignment,
            highlightedWord.wordIndex,
            view
          );
          if (wordPos) {
            decorations.push(
              Decoration.mark({
                class: 'transcript-word-highlight',
              }).range(wordPos.from, wordPos.to)
            );
          }
        }
      }
    }

    decorations.sort((a, b) => a.from - b.from);
    return Decoration.set(decorations);
  }

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
      }

      update(update: ViewUpdate) {
        // Rebuild on doc change, viewport change, or highlight change
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.transactions.some((tr) =>
            tr.effects.some((e) => e.is(setHighlightedWord))
          )
        ) {
          this.decorations = buildDecorations(update.view);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}

/**
 * Calculate document position for a word by index
 */
function getWordPosition(
  directive: TranscriptDirective,
  alignment: AlignmentData,
  wordIndex: number,
  view: EditorView
): { from: number; to: number } | null {
  // Get content start position (after the opening fence line)
  const startLine = view.state.doc.lineAt(directive.from);
  const contentStart = startLine.to + 1; // +1 for newline

  // Find the word in the alignment
  let currentIndex = 0;
  let textOffset = 0;

  for (const segment of alignment.segments) {
    for (const word of segment.words) {
      if (currentIndex === wordIndex) {
        // Find this word in the content
        const content = directive.content;
        const wordStart = content.indexOf(word.word, textOffset);

        if (wordStart >= 0) {
          return {
            from: contentStart + wordStart,
            to: contentStart + wordStart + word.word.length,
          };
        }
      }

      textOffset = directive.content.indexOf(word.word, textOffset);
      if (textOffset >= 0) {
        textOffset += word.word.length;
      }

      currentIndex++;
    }
  }

  return null;
}
```

### Step 8.4: Add highlight styles

Add to the styles:

```css
.transcript-word-highlight {
  background-color: var(--text-accent);
  color: var(--text-on-accent);
  border-radius: 2px;
  padding: 0 2px;
}
```

### Verification

1. Ensure you have a cached alignment for a transcript
2. Play the transcript
3. **Expected**: The current word is highlighted with accent color as audio plays

---

## Milestone 9: Cmd-Click to Play From Word

**Goal**: Cmd-click (or Ctrl-click) any word to start playback from that point.

### Step 9.1: Create click handler

Create `src/editor/handlers.ts`:

```typescript
import { EditorView } from '@codemirror/view';
import { transcriptField } from './state';
import { AudioManager } from '../playback/audio-manager';
import { AlignmentData, TranscriptDirective } from '../types';

export function createClickHandler(
  audioManager: AudioManager,
  getAlignment: (directive: TranscriptDirective) => Promise<AlignmentData | null>
) {
  return EditorView.domEventHandlers({
    async click(event: MouseEvent, view: EditorView) {
      // Check for Cmd (Mac) or Ctrl (Windows/Linux)
      if (!event.metaKey && !event.ctrlKey) {
        return false;
      }

      // Get click position in document
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;

      // Find directive at position
      const { directives } = view.state.field(transcriptField);
      const directive = directives.find((d) => pos >= d.from && pos <= d.to);
      if (!directive) return false;

      // Get alignment
      const alignment = await getAlignment(directive);
      if (!alignment) return false;

      // Find word at click position
      const startLine = view.state.doc.lineAt(directive.from);
      const contentStart = startLine.to + 1;
      const clickOffset = pos - contentStart;

      if (clickOffset < 0) return false;

      // Find which word was clicked
      const word = findWordAtOffset(directive.content, alignment, clickOffset);
      if (!word) return false;

      // Play from this word's start time
      event.preventDefault();
      audioManager.play(directive, word.start);
      return true;
    },
  });
}

function findWordAtOffset(
  content: string,
  alignment: AlignmentData,
  offset: number
): { word: string; start: number; end: number } | null {
  let textOffset = 0;

  for (const segment of alignment.segments) {
    for (const word of segment.words) {
      const wordStart = content.indexOf(word.word, textOffset);
      if (wordStart < 0) continue;

      const wordEnd = wordStart + word.word.length;
      textOffset = wordEnd;

      if (offset >= wordStart && offset <= wordEnd) {
        return word;
      }
    }
  }

  return null;
}
```

### Step 9.2: Register the click handler

Update the extension registration in `main.ts`:

```typescript
// In onload(), after initializing alignmentService:

this.registerEditorExtension([
  transcriptField,
  createTranscriptViewPlugin(this.audioManager, (directive) =>
    this.alignmentCache.get(directive) // You'll need to expose this
  ),
  createClickHandler(this.audioManager, (directive) =>
    this.alignmentService.getAlignment(directive)
  ),
]);
```

### Verification

1. With an aligned transcript, Cmd-click (Mac) or Ctrl-click (Windows) on any word
2. **Expected**: Audio starts playing from that word's timestamp

---

## Milestone 10: Copy/Paste with Timestamps

**Goal**: Copying transcript text includes audio reference with timestamps.

### Step 10.1: Create serializer

Create `src/core/serializer.ts`:

```typescript
import { TranscriptDirective } from '../types';

/**
 * Serialize a transcript directive to markdown
 */
export function serializeDirective(directive: TranscriptDirective): string {
  const attrs: string[] = [];

  if (directive.attributes.start !== undefined) {
    attrs.push(`start=${directive.attributes.start}`);
  }
  if (directive.attributes.end !== undefined) {
    attrs.push(`end=${directive.attributes.end}`);
  }

  const attrStr = attrs.length > 0 ? `{${attrs.join(' ')}}` : '';

  return `:::transcript[${directive.audioPath}]${attrStr}
${directive.content}
:::`;
}

/**
 * Create a new directive for a selection with timestamps
 */
export function createExcerptDirective(
  original: TranscriptDirective,
  selectedContent: string,
  audioStart: number,
  audioEnd: number
): TranscriptDirective {
  return {
    audioPath: original.audioPath,
    attributes: {
      start: audioStart,
      end: audioEnd,
    },
    content: selectedContent,
    from: 0, // Will be set when inserted
    to: 0,
  };
}
```

### Step 10.2: Create copy handler

Add to `src/editor/handlers.ts`:

```typescript
export function createCopyHandler(
  getAlignment: (directive: TranscriptDirective) => Promise<AlignmentData | null>
) {
  return EditorView.domEventHandlers({
    async copy(event: ClipboardEvent, view: EditorView) {
      const selection = view.state.selection.main;
      if (selection.empty) return false;

      // Check if selection is within a transcript
      const { directives } = view.state.field(transcriptField);
      const directive = directives.find(
        (d) => selection.from >= d.from && selection.to <= d.to
      );

      if (!directive) return false;

      // Get alignment
      const alignment = await getAlignment(directive);
      if (!alignment) return false;

      // Calculate content offsets
      const startLine = view.state.doc.lineAt(directive.from);
      const contentStart = startLine.to + 1;
      const selectionStartOffset = selection.from - contentStart;
      const selectionEndOffset = selection.to - contentStart;

      // Find audio timestamps for selection
      const { startTime, endTime } = findTimestampsForRange(
        directive.content,
        alignment,
        selectionStartOffset,
        selectionEndOffset
      );

      // Get selected text
      const selectedText = view.state.sliceDoc(selection.from, selection.to);

      // Create excerpt directive
      const excerpt = createExcerptDirective(
        directive,
        selectedText,
        startTime,
        endTime
      );

      // Set clipboard
      event.preventDefault();
      event.clipboardData?.setData('text/plain', serializeDirective(excerpt));

      return true;
    },
  });
}

function findTimestampsForRange(
  content: string,
  alignment: AlignmentData,
  startOffset: number,
  endOffset: number
): { startTime: number; endTime: number } {
  let startTime = 0;
  let endTime = 0;
  let textOffset = 0;
  let foundStart = false;

  for (const segment of alignment.segments) {
    for (const word of segment.words) {
      const wordStart = content.indexOf(word.word, textOffset);
      if (wordStart < 0) continue;
      const wordEnd = wordStart + word.word.length;
      textOffset = wordEnd;

      // Check if this word overlaps with selection
      if (!foundStart && wordEnd > startOffset) {
        startTime = word.start;
        foundStart = true;
      }

      if (wordStart < endOffset) {
        endTime = word.end;
      }
    }
  }

  return { startTime, endTime };
}
```

### Verification

1. Select a portion of transcript text
2. Copy (Cmd+C / Ctrl+C)
3. Paste in another document
4. **Expected**: Pasted text is a complete transcript directive with start/end timestamps matching the selection

---

## Milestone 11: Split Transcripts

**Goal**: Split a transcript into two with double-return or command.

### Step 11.1: Create split operation

Add to `src/core/operations.ts`:

```typescript
import { TranscriptDirective, AlignmentData } from '../types';
import { serializeDirective } from './serializer';

export interface SplitResult {
  beforeMarkdown: string;
  afterMarkdown: string;
}

export function splitTranscript(
  directive: TranscriptDirective,
  alignment: AlignmentData,
  splitOffset: number // Offset within content
): SplitResult {
  // Split content
  const beforeContent = directive.content.slice(0, splitOffset).trim();
  const afterContent = directive.content.slice(splitOffset).trim();

  // Find split timestamp
  const splitTime = findTimestampAtOffset(directive.content, alignment, splitOffset);

  // Create two new directives
  const before: TranscriptDirective = {
    ...directive,
    content: beforeContent,
    attributes: {
      start: directive.attributes.start,
      end: splitTime,
    },
  };

  const after: TranscriptDirective = {
    ...directive,
    content: afterContent,
    attributes: {
      start: splitTime,
      end: directive.attributes.end,
    },
  };

  return {
    beforeMarkdown: serializeDirective(before),
    afterMarkdown: serializeDirective(after),
  };
}

function findTimestampAtOffset(
  content: string,
  alignment: AlignmentData,
  offset: number
): number {
  let textOffset = 0;
  let lastEnd = 0;

  for (const segment of alignment.segments) {
    for (const word of segment.words) {
      const wordStart = content.indexOf(word.word, textOffset);
      if (wordStart < 0) continue;
      const wordEnd = wordStart + word.word.length;
      textOffset = wordEnd;

      if (wordStart >= offset) {
        return word.start;
      }
      lastEnd = word.end;
    }
  }

  return lastEnd;
}
```

### Step 11.2: Create split command

Add to `main.ts`:

```typescript
this.addCommand({
  id: 'split-transcript',
  name: 'Split transcript at cursor',
  hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'Enter' }],
  editorCallback: async (editor, view) => {
    const cmView = (view as any).editor?.cm;
    if (!cmView) return;

    const cursor = cmView.state.selection.main.head;
    const { directives } = cmView.state.field(transcriptField);

    const directive = directives.find(
      (d: TranscriptDirective) => cursor >= d.from && cursor <= d.to
    );
    if (!directive) return;

    // Get alignment
    const alignment = await this.alignmentService.getAlignment(directive);
    if (!alignment) {
      new Notice('No alignment available. Run alignment first.');
      return;
    }

    // Calculate split offset
    const startLine = cmView.state.doc.lineAt(directive.from);
    const contentStart = startLine.to + 1;
    const splitOffset = cursor - contentStart;

    if (splitOffset <= 0 || splitOffset >= directive.content.length) {
      new Notice('Cannot split at this position');
      return;
    }

    // Perform split
    const { beforeMarkdown, afterMarkdown } = splitTranscript(
      directive,
      alignment,
      splitOffset
    );

    // Replace directive with split result
    const replacement = `${beforeMarkdown}\n\n${afterMarkdown}`;

    cmView.dispatch({
      changes: {
        from: directive.from,
        to: directive.to,
        insert: replacement,
      },
    });
  },
});
```

### Step 11.3: Auto-split on double Enter (optional)

Create a transaction filter in `src/editor/handlers.ts`:

```typescript
import { EditorState } from '@codemirror/state';

export function createDoubleEnterFilter(
  getAlignment: (directive: TranscriptDirective) => AlignmentData | null
) {
  let lastEnterTime = 0;
  let lastEnterPos = -1;

  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) return tr;

    // Check if this is an Enter key insertion
    let isEnter = false;
    tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      if (inserted.toString() === '\n') {
        isEnter = true;
      }
    });

    if (!isEnter) {
      lastEnterTime = 0;
      return tr;
    }

    const now = Date.now();
    const cursor = tr.state.selection.main.head;

    // Check for double-enter (within 500ms, same position)
    if (now - lastEnterTime < 500 && Math.abs(cursor - lastEnterPos) <= 2) {
      // Check if we're in a transcript
      const { directives } = tr.startState.field(transcriptField);
      const directive = directives.find(
        (d) => cursor >= d.from && cursor <= d.to
      );

      if (directive) {
        const alignment = getAlignment(directive);
        if (alignment) {
          // Perform split instead of inserting newlines
          // ... (implementation similar to split command)
          // This is complex because we need to modify the transaction
          // For simplicity, you might just trigger the split command instead
        }
      }
    }

    lastEnterTime = now;
    lastEnterPos = cursor;

    return tr;
  });
}
```

### Verification

1. Place cursor in middle of transcript content
2. Press Cmd+Shift+Enter (or run "Split transcript at cursor" command)
3. **Expected**: Single transcript becomes two, with appropriate start/end timestamps

---

## Milestone 12: Reading View Support

**Goal**: Render transcripts nicely in Obsidian's reading view.

### Step 12.1: Create reading view renderer

Create `src/reading-view/renderer.ts`:

```typescript
import { MarkdownRenderChild, App } from 'obsidian';
import { TranscriptDirective, AlignmentData } from '../types';
import { AudioManager } from '../playback/audio-manager';

export class TranscriptRenderer extends MarkdownRenderChild {
  constructor(
    containerEl: HTMLElement,
    private directive: TranscriptDirective,
    private audioManager: AudioManager,
    private getAlignment: () => Promise<AlignmentData | null>
  ) {
    super(containerEl);
  }

  async onload() {
    this.render();
  }

  private async render() {
    const container = this.containerEl;
    container.empty();
    container.addClass('transcript-reading-view');

    // Header
    const header = container.createDiv({ cls: 'transcript-header' });

    const playBtn = header.createEl('button', { cls: 'transcript-play-btn' });
    playBtn.innerHTML = '▶';
    playBtn.addEventListener('click', () => {
      this.audioManager.play(this.directive);
    });

    header.createSpan({ cls: 'transcript-label', text: this.directive.audioPath });

    // Content
    const content = container.createDiv({ cls: 'transcript-content' });

    const alignment = await this.getAlignment();
    if (alignment) {
      this.renderAlignedContent(content, alignment);
    } else {
      content.setText(this.directive.content);
    }
  }

  private renderAlignedContent(container: HTMLElement, alignment: AlignmentData) {
    for (const segment of alignment.segments) {
      for (const word of segment.words) {
        const span = container.createSpan({
          cls: 'transcript-word',
          text: word.word + ' ',
        });
        span.dataset.start = String(word.start);
        span.dataset.end = String(word.end);

        span.addEventListener('click', (e) => {
          if (e.metaKey || e.ctrlKey) {
            this.audioManager.play(this.directive, word.start);
          }
        });
      }
    }
  }
}
```

### Step 12.2: Create post-processor

Create `src/reading-view/post-processor.ts`:

```typescript
import { MarkdownPostProcessorContext, App } from 'obsidian';
import { parseTranscriptFromText } from '../core/parser';
import { TranscriptRenderer } from './renderer';
import { AudioManager } from '../playback/audio-manager';
import { AlignmentService } from '../alignment/service';

export function createPostProcessor(
  app: App,
  audioManager: AudioManager,
  alignmentService: AlignmentService
) {
  return (element: HTMLElement, context: MarkdownPostProcessorContext) => {
    // Find code blocks that might be our directive
    // Note: Obsidian renders unknown fenced blocks as code blocks
    const codeBlocks = element.querySelectorAll('pre > code');

    for (const codeBlock of Array.from(codeBlocks)) {
      const text = codeBlock.textContent || '';

      if (text.startsWith(':::transcript')) {
        const directive = parseTranscriptFromText(text);
        if (directive) {
          const container = document.createElement('div');
          const renderer = new TranscriptRenderer(
            container,
            directive,
            audioManager,
            () => alignmentService.getAlignment(directive)
          );
          context.addChild(renderer);

          // Replace the code block with our renderer
          const pre = codeBlock.parentElement;
          pre?.replaceWith(container);
        }
      }
    }
  };
}
```

### Step 12.3: Add parser helper

Add to `src/core/parser.ts`:

```typescript
/**
 * Parse a transcript directive from raw text (for reading view)
 */
export function parseTranscriptFromText(text: string): TranscriptDirective | null {
  const lines = text.split('\n');
  if (lines.length < 2) return null;

  const openMatch = lines[0].match(OPEN_REGEX);
  if (!openMatch) return null;

  // Find closing fence
  let contentLines: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (CLOSE_REGEX.test(lines[i])) {
      break;
    }
    contentLines.push(lines[i]);
  }

  return {
    audioPath: openMatch[1],
    attributes: parseAttributes(openMatch[2]),
    content: contentLines.join('\n'),
    from: 0,
    to: 0,
  };
}
```

### Step 12.4: Register post-processor

Add to `main.ts`:

```typescript
// In onload():
this.registerMarkdownPostProcessor(
  createPostProcessor(this.app, this.audioManager, this.alignmentService)
);
```

### Step 12.5: Add reading view styles

```css
.transcript-reading-view {
  background: var(--background-secondary);
  border-radius: 8px;
  padding: 16px;
  margin: 16px 0;
}

.transcript-reading-view .transcript-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--background-modifier-border);
}

.transcript-reading-view .transcript-content {
  font-family: var(--font-monospace);
  line-height: 1.6;
}

.transcript-reading-view .transcript-word {
  cursor: pointer;
}

.transcript-reading-view .transcript-word:hover {
  background: var(--background-modifier-hover);
}
```

### Verification

1. Switch to Reading View (Cmd+E)
2. **Expected**: Transcript blocks render with styled header, play button, and content
3. Cmd-click words to play from that point

---

## Summary

You've now built a fully functional transcript plugin with:

1. **Directive parsing** - Recognizes `:::transcript` blocks
2. **Visual decorations** - Styled blocks with play buttons
3. **Audio playback** - Play, pause, seek with floating controls
4. **Word-level alignment** - Python integration with caching
5. **Real-time highlighting** - Current word highlighted during playback
6. **Cmd-click navigation** - Jump to any word
7. **Copy/paste with timestamps** - Excerpts preserve audio references
8. **Split transcripts** - Divide blocks with correct timestamps
9. **Reading view support** - Full rendering in preview mode

## Next Steps

To complete the full spec, you would add:

- **Deletion handling** with `:skip` markers
- **Continuous playback** across transcript blocks
- **Scroll follow** during playback
- **Settings UI** for all options
- **Convert audio embed** command
- **Error handling** and edge cases
- **Unit tests** for core functions
