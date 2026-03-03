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


def load_and_slice_audio(audio_path: str, start: Optional[float], end: Optional[float], skips: list = None):
    """Load audio, slice by start/end, and remove skip regions. Returns numpy array at 16kHz."""
    import whisper
    import numpy as np

    # whisper.load_audio handles ffmpeg internally and resamples to 16kHz
    audio = whisper.load_audio(audio_path)
    sr = 16000  # whisper always uses 16kHz

    # First slice by start/end
    if start is not None and start > 0:
        start_sample = int(start * sr)
        if end is not None:
            end_sample = int(end * sr)
            audio = audio[start_sample:end_sample]
        else:
            audio = audio[start_sample:]
    elif end is not None:
        end_sample = int(end * sr)
        audio = audio[:end_sample]

    # Remove skip regions from the audio
    if skips:
        audio = remove_skip_regions(audio, start or 0.0, skips, sr)

    return audio


def remove_skip_regions(audio, start_offset: float, skips: list, sr: int = 16000):
    """Remove skip regions from audio array.

    Args:
        audio: numpy audio array
        start_offset: the start time offset (what start= was in the request)
        skips: list of {"start": float, "end": float} dicts with absolute timestamps
        sr: sample rate

    Returns:
        audio with skip regions removed
    """
    import numpy as np

    if not skips:
        return audio

    # Sort skips by start time
    sorted_skips = sorted(skips, key=lambda s: s["start"])

    # Convert skip times to sample indices relative to the sliced audio
    # Skip times are absolute, but audio starts at start_offset
    regions_to_remove = []
    for skip in sorted_skips:
        skip_start = skip["start"] - start_offset
        skip_end = skip["end"] - start_offset

        # Only include if skip is within the audio range
        if skip_end > 0 and skip_start < len(audio) / sr:
            start_sample = max(0, int(skip_start * sr))
            end_sample = min(len(audio), int(skip_end * sr))
            if end_sample > start_sample:
                regions_to_remove.append((start_sample, end_sample))

    if not regions_to_remove:
        return audio

    # Build list of regions to keep (inverse of skip regions)
    keep_regions = []
    prev_end = 0
    for start_sample, end_sample in regions_to_remove:
        if start_sample > prev_end:
            keep_regions.append((prev_end, start_sample))
        prev_end = end_sample

    # Add final region after last skip
    if prev_end < len(audio):
        keep_regions.append((prev_end, len(audio)))

    # Concatenate the kept regions
    if keep_regions:
        kept_audio = np.concatenate([audio[start:end] for start, end in keep_regions])
        return kept_audio

    return audio


def adjust_timestamps(result: dict, start_offset: float, skips: list = None) -> dict:
    """Adjust all timestamps in the alignment result.

    Adds start_offset and accounts for removed skip regions.
    When skip regions are removed from audio, the alignment timestamps
    need to be expanded to map back to the original audio timeline.

    Args:
        result: alignment result dict with segments/words
        start_offset: base offset to add (the start= parameter)
        skips: list of {"start": float, "end": float} skip regions

    Returns:
        result with adjusted timestamps
    """
    if not skips:
        skips = []

    # Sort skips by start time for processing
    sorted_skips = sorted(skips, key=lambda s: s["start"])

    def adjust_time(t: float) -> float:
        """Adjust a single timestamp accounting for offset and skips."""
        # Start with the base offset
        adjusted = t + start_offset

        # Account for each skip region that comes before this compressed time
        # Use original t for comparisons, not the modified adjusted value
        cumulative_skip_duration = 0.0
        epsilon = 1e-9  # For floating-point comparison tolerance
        for skip in sorted_skips:
            # The skip's position in compressed timeline, relative to start_offset
            # Skip times are absolute, so subtract start_offset first
            skip_relative_start = skip["start"] - start_offset
            skip_compressed_start = skip_relative_start - cumulative_skip_duration

            # Compare original t against compressed skip position
            # Must be clearly greater (not just floating-point noise)
            if t - skip_compressed_start > epsilon:
                skip_duration = skip["end"] - skip["start"]
                adjusted += skip_duration
                cumulative_skip_duration += skip_duration
            else:
                break

        return adjusted

    # Adjust all timestamps
    for segment in result.get("segments", []):
        segment["start"] = adjust_time(segment.get("start", 0))
        segment["end"] = adjust_time(segment.get("end", 0))
        for word in segment.get("words", []):
            word["start"] = adjust_time(word.get("start", 0))
            word["end"] = adjust_time(word.get("end", 0))

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
        skips = request.get("skips", [])

        time_offset = start if (start is not None and start > 0) else 0.0

        # Load audio (slice by start/end and remove skip regions)
        if time_offset > 0 or skips:
            skip_info = f", skipping {len(skips)} region(s)" if skips else ""
            progress(f"Loading audio from {start or 0}s to {end or 'end'}s{skip_info}...")
        else:
            progress("Loading audio...")
        audio = load_and_slice_audio(audio_path, start, end, skips)

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

        # Adjust timestamps for start offset and skip regions
        if time_offset > 0 or skips:
            output = adjust_timestamps(output, time_offset, skips)

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
