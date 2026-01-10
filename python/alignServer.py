#!/usr/bin/env python3
"""
Persistent alignment server that keeps the model loaded between requests.
Communicates via stdin/stdout JSON.

Request format (one JSON object per line):
    {"action": "align", "audio": "path", "text": "...", "tool": "stable-ts", "model": "base", ...}
    {"action": "shutdown"}

Response format:
    {"status": "ok", "result": {...}}
    {"status": "error", "message": "..."}

Progress is reported to stderr.
"""

import json
import sys
import os
from typing import Optional


def progress(message: str):
    """Print progress message to stderr."""
    print(f"Progress: {message}", file=sys.stderr, flush=True)


def load_and_slice_audio(audio_path: str, start: Optional[float], end: Optional[float]):
    """Load audio and optionally slice it. Returns numpy array at 16kHz."""
    import whisper

    # whisper.load_audio handles ffmpeg internally and resamples to 16kHz
    audio = whisper.load_audio(audio_path)
    sr = 16000  # whisper always uses 16kHz

    if start is not None and start > 0:
        start_sample = int(start * sr)
        if end is not None:
            end_sample = int(end * sr)
            audio = audio[start_sample:end_sample]
        else:
            audio = audio[start_sample:]

    return audio


def offset_timestamps(result: dict, offset: float) -> dict:
    """Add offset to all timestamps in the alignment result."""
    for segment in result.get("segments", []):
        segment["start"] = segment.get("start", 0) + offset
        segment["end"] = segment.get("end", 0) + offset
        for word in segment.get("words", []):
            word["start"] = word.get("start", 0) + offset
            word["end"] = word.get("end", 0) + offset
    return result


class AlignmentServer:
    def __init__(self):
        self.model = None
        self.model_name = None
        self.device = None

    def get_device(self) -> str:
        """Get the best available device for inference."""
        import torch
        if torch.cuda.is_available():
            return "cuda"
        elif torch.backends.mps.is_available():
            return "mps"
        return "cpu"

    def ensure_model(self, model_name: str, for_alignment: bool = False):
        """Load model if not already loaded or if model name changed."""
        import stable_whisper

        device = self.get_device()
        # MPS has issues with float64 in alignment, use CPU for alignment
        if for_alignment and device == "mps":
            device = "cpu"

        if self.model is None or self.model_name != model_name or self.device != device:
            progress(f"Loading stable-ts model '{model_name}' on {device}...")
            self.model = stable_whisper.load_model(model_name, device=device)
            self.model_name = model_name
            self.device = device

    def align(self, request: dict) -> dict:
        """Perform alignment based on request."""
        audio_path = request["audio"]
        transcript = request.get("text")
        model_name = request.get("model", "base")
        language = request.get("language")
        start = request.get("start")
        end = request.get("end")

        time_offset = start if (start is not None and start > 0) else 0.0

        # Load audio (and slice if needed)
        if time_offset > 0:
            progress(f"Loading audio from {start}s to {end or 'end'}s...")
        else:
            progress("Loading audio...")
        audio = load_and_slice_audio(audio_path, start, end)

        # Load model (or reuse cached)
        self.ensure_model(model_name, for_alignment=bool(transcript))

        if transcript:
            progress("Aligning transcript...")
            result = self.model.align(
                audio,
                transcript,
                language=language or "en",
            )
        else:
            progress("Transcribing audio...")
            result = self.model.transcribe(
                audio,
                language=language,
            )

        # Format output
        segments = []
        full_text = []
        for segment in result.segments:
            words = []
            for word in segment.words:
                words.append({
                    "word": word.word,
                    "start": word.start,
                    "end": word.end,
                    "confidence": getattr(word, "probability", 1.0),
                })
            segments.append({
                "start": segment.start,
                "end": segment.end,
                "text": segment.text,
                "words": words,
            })
            full_text.append(segment.text)

        output = {
            "language": language or getattr(result, "language", "en") or "en",
            "segments": segments,
            "text": transcript or " ".join(full_text),
        }

        # Add time offset if we sliced
        if time_offset > 0:
            output = offset_timestamps(output, time_offset)

        return output

    def handle_request(self, request: dict) -> dict:
        """Handle a single request and return response."""
        action = request.get("action")

        if action == "shutdown":
            return {"status": "shutdown"}

        if action == "align":
            try:
                result = self.align(request)
                return {"status": "ok", "result": result}
            except Exception as e:
                return {"status": "error", "message": str(e)}

        return {"status": "error", "message": f"Unknown action: {action}"}

    def run(self):
        """Main server loop - read requests from stdin, write responses to stdout."""
        progress("Server ready")

        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue

            try:
                request = json.loads(line)
            except json.JSONDecodeError as e:
                response = {"status": "error", "message": f"Invalid JSON: {e}"}
                print(json.dumps(response), flush=True)
                continue

            response = self.handle_request(request)
            print(json.dumps(response), flush=True)

            if response.get("status") == "shutdown":
                break


def main():
    # Print ready message immediately
    progress("Initializing...")

    # Import heavy dependencies
    import stable_whisper  # noqa: F401

    server = AlignmentServer()
    server.run()


if __name__ == "__main__":
    main()
