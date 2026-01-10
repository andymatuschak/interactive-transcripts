#!/usr/bin/env python3
"""
Word-level transcription and alignment script for audio.
Supports WhisperX and stable-ts.

Setup:
    cd python && uv sync

Usage (transcribe):
    uv run align.py --audio path/to/audio.m4a --model tiny

Usage (align with text file):
    uv run align.py --audio path/to/audio.m4a --text-file transcript.txt --model base

Usage (align with inline text):
    uv run align.py --audio path/to/audio.m4a --text "transcript text" --model base

Usage (align subrange):
    uv run align.py --audio path/to/audio.m4a --text "excerpt" --start 15.5 --end 25.75
"""

import argparse
import json
import sys
import tempfile
import os
from typing import Optional


def progress(message: str):
    """Print progress message to stderr."""
    print(f"Progress: {message}", file=sys.stderr, flush=True)


def trim_audio(audio_path: str, start: float, end: Optional[float]) -> tuple[str, callable]:
    """
    Trim audio to the specified time range using ffmpeg.
    Returns (temp_file_path, cleanup_function).
    """
    import subprocess

    # Create a temporary file with the same extension
    ext = os.path.splitext(audio_path)[1] or ".wav"
    temp_fd, temp_path = tempfile.mkstemp(suffix=ext)
    os.close(temp_fd)

    def cleanup():
        try:
            os.unlink(temp_path)
        except OSError:
            pass

    try:
        cmd = [
            "ffmpeg", "-y",
            "-i", audio_path,
            "-ss", str(start),
        ]
        if end is not None:
            cmd.extend(["-to", str(end)])
        cmd.extend([
            "-c", "copy",  # Fast copy without re-encoding
            temp_path
        ])

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
        )

        if result.returncode != 0:
            # Try again with re-encoding (some formats need it for precise seeking)
            cmd = [
                "ffmpeg", "-y",
                "-i", audio_path,
                "-ss", str(start),
            ]
            if end is not None:
                cmd.extend(["-to", str(end)])
            cmd.append(temp_path)

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
            )

            if result.returncode != 0:
                cleanup()
                raise RuntimeError(f"ffmpeg failed: {result.stderr}")

        return temp_path, cleanup

    except Exception:
        cleanup()
        raise


def offset_timestamps(result: dict, offset: float) -> dict:
    """Add offset to all timestamps in the alignment result."""
    for segment in result.get("segments", []):
        segment["start"] = segment.get("start", 0) + offset
        segment["end"] = segment.get("end", 0) + offset
        for word in segment.get("words", []):
            word["start"] = word.get("start", 0) + offset
            word["end"] = word.get("end", 0) + offset
    return result


def align_with_whisperx(
    audio_path: str,
    transcript: str,
    model_name: str = "base",
    language: Optional[str] = None,
) -> dict:
    """Align audio with transcript using WhisperX."""
    try:
        import whisperx
        import torch
    except ImportError:
        raise ImportError("whisperx is not installed. Install with: pip install whisperx")

    device = "cuda" if torch.cuda.is_available() else "cpu"
    compute_type = "float16" if device == "cuda" else "int8"

    progress(f"Loading WhisperX model '{model_name}' on {device}...")

    # Load model
    model = whisperx.load_model(model_name, device, compute_type=compute_type)

    progress("Transcribing audio...")

    # Transcribe to get initial alignment
    audio = whisperx.load_audio(audio_path)
    result = model.transcribe(audio, batch_size=16)

    detected_language = result.get("language", language or "en")
    progress(f"Detected language: {detected_language}")

    progress("Loading alignment model...")

    # Load alignment model
    model_a, metadata = whisperx.load_align_model(
        language_code=detected_language, device=device
    )

    progress("Aligning transcript...")

    # Align with provided transcript
    # WhisperX align expects segments, so we create one segment with the full transcript
    segments_to_align = [{"text": transcript, "start": 0, "end": result["segments"][-1]["end"] if result["segments"] else 0}]

    result = whisperx.align(
        segments_to_align,
        model_a,
        metadata,
        audio,
        device,
        return_char_alignments=False,
    )

    # Format output
    segments = []
    for segment in result.get("segments", []):
        words = []
        for word_info in segment.get("words", []):
            words.append({
                "word": word_info.get("word", ""),
                "start": word_info.get("start", 0),
                "end": word_info.get("end", 0),
                "confidence": word_info.get("score", 1.0),
            })
        segments.append({
            "start": segment.get("start", 0),
            "end": segment.get("end", 0),
            "text": segment.get("text", ""),
            "words": words,
        })

    return {
        "language": detected_language,
        "segments": segments,
        "text": transcript,
    }


def get_device() -> str:
    """Get the best available device for inference."""
    import torch
    if torch.cuda.is_available():
        return "cuda"
    elif torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def align_with_stable_ts(
    audio_path: str,
    transcript: Optional[str],
    model_name: str = "base",
    language: Optional[str] = None,
) -> dict:
    """Align audio with transcript using stable-ts. If no transcript, transcribe first."""
    try:
        import stable_whisper
    except ImportError:
        raise ImportError("stable-ts is not installed. Install with: pip install stable-ts")

    device = get_device()

    # MPS has issues with float64 in alignment, so use CPU for alignment
    # but MPS works fine for transcription
    if transcript and device == "mps":
        progress(f"Loading stable-ts model '{model_name}' on cpu (alignment requires cpu)...")
        model = stable_whisper.load_model(model_name, device="cpu")
    else:
        progress(f"Loading stable-ts model '{model_name}' on {device}...")
        model = stable_whisper.load_model(model_name, device=device)

    if transcript:
        progress("Aligning transcript...")
        # Use align method for forced alignment with provided transcript
        # Language is required for alignment, default to English
        result = model.align(
            audio_path,
            transcript,
            language=language or "en",
        )
    else:
        progress("Transcribing audio...")
        # Transcribe and get word-level timestamps
        result = model.transcribe(
            audio_path,
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

    return {
        "language": language or getattr(result, "language", "en") or "en",
        "segments": segments,
        "text": transcript or " ".join(full_text),
    }


def main():
    parser = argparse.ArgumentParser(description="Transcribe or align audio with transcript text")
    parser.add_argument("--audio", required=True, help="Path to audio file")
    parser.add_argument("--text", help="Transcript text to align")
    parser.add_argument("--text-file", help="Path to transcript text file")
    parser.add_argument(
        "--tool",
        choices=["whisperx", "stable-ts"],
        default="stable-ts",
        help="Alignment tool to use",
    )
    parser.add_argument("--model", default="base", help="Whisper model size")
    parser.add_argument("--language", help="Language code (e.g., 'en')")
    parser.add_argument("--start", type=float, help="Start time in seconds (for subrange alignment)")
    parser.add_argument("--end", type=float, help="End time in seconds (for subrange alignment)")

    args = parser.parse_args()

    # Print immediately so the UI shows activity during slow imports
    progress("Initializing...")

    cleanup_func = None
    audio_path = args.audio
    time_offset = 0.0

    try:
        # Get transcript from --text or --text-file
        transcript = args.text
        if args.text_file:
            expanded = os.path.expanduser(args.text_file)
            with open(expanded, "r", encoding="utf-8") as f:
                transcript = f.read().strip()

        # If start/end specified, trim audio first
        if args.start is not None and args.start > 0:
            progress(f"Trimming audio from {args.start}s to {args.end or 'end'}s...")
            audio_path, cleanup_func = trim_audio(args.audio, args.start, args.end)
            time_offset = args.start

        if args.tool == "whisperx":
            if not transcript:
                raise ValueError("whisperx requires --text or --text-file for alignment")
            result = align_with_whisperx(
                audio_path, transcript, args.model, args.language
            )
        else:
            result = align_with_stable_ts(
                audio_path, transcript, args.model, args.language
            )

        # Add time offset to all timestamps if we trimmed
        if time_offset > 0:
            result = offset_timestamps(result, time_offset)

        # Output JSON to stdout
        print(json.dumps(result, indent=2))

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    finally:
        if cleanup_func:
            cleanup_func()


if __name__ == "__main__":
    main()
