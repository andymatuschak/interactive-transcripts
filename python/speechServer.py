#!/usr/bin/env python3
"""
Persistent Parakeet transcription server.

Communicates over stdin/stdout using one JSON object per line.

Request format:
    {"action": "transcribe", "audio": "path", "model": "...", ...}
    {"action": "shutdown"}

Response format:
    {"status": "ok", "result": {...}}
    {"status": "error", "message": "..."}

Progress is reported to stderr.
"""

from __future__ import annotations

import json
import math
import re
import subprocess
import sys
import tempfile
import wave
from pathlib import Path
from typing import Any, Optional


SAMPLE_RATE = 16_000
SAMPLE_WIDTH = 2
DEFAULT_MODEL = "mlx-community/parakeet-tdt-0.6b-v3"
DEFAULT_MODEL_SIZE_BYTES = 2_508_288_736


def progress(message: str) -> None:
    """Print progress message to stderr."""
    print(f"Progress: {message}", file=sys.stderr, flush=True)


class ModelDownloadRequired(Exception):
    def __init__(self, model_name: str, size_bytes: int = DEFAULT_MODEL_SIZE_BYTES) -> None:
        super().__init__("Model download required")
        self.model_name = model_name
        self.size_bytes = size_bytes


class DownloadProgressBar:
    """Small tqdm-compatible progress reporter for Hugging Face downloads."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.total = int(kwargs.get("total") or 0)
        self.n = int(kwargs.get("initial") or 0)
        self.disable = bool(kwargs.get("disable"))
        self.last_percent = -1
        self._emit(force=True)

    def __enter__(self) -> "DownloadProgressBar":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    def update(self, amount: int | float = 1) -> None:
        self.n += int(amount)
        self._emit()

    def close(self) -> None:
        self._emit(force=True)

    def _emit(self, force: bool = False) -> None:
        if self.disable:
            return
        if self.total <= 0:
            percent = 0
        else:
            percent = min(100, max(0, int((self.n / self.total) * 100)))

        if force or percent != self.last_percent:
            self.last_percent = percent
            progress(f"Downloading model: {percent}%")


def cached_model_path(model_name: str, cache_dir: str | None = None) -> str | None:
    """Return a local snapshot/path if the required model files are already present."""
    local_path = Path(model_name).expanduser()
    if (local_path / "config.json").exists() and (local_path / "model.safetensors").exists():
        return str(local_path)

    try:
        from huggingface_hub import hf_hub_download

        config_path = hf_hub_download(
            model_name,
            "config.json",
            cache_dir=cache_dir,
            local_files_only=True,
        )
        weight_path = hf_hub_download(
            model_name,
            "model.safetensors",
            cache_dir=cache_dir,
            local_files_only=True,
        )
    except Exception:
        return None

    snapshot_dir = Path(weight_path).parent
    if (snapshot_dir / "config.json").exists():
        return str(snapshot_dir)

    return str(Path(config_path).parent)


def validate_model_path(model_path: str) -> str:
    path = Path(model_path).expanduser()
    if not path.is_dir():
        raise RuntimeError("Model path must be a folder")
    if not (path / "config.json").is_file() or not (path / "model.safetensors").is_file():
        raise RuntimeError("Model path must contain config.json and model.safetensors")
    return str(path)


def resolve_model_path(
    model_name: str,
    model_path: str | None = None,
    cache_dir: str | None = None,
    allow_download: bool = False,
) -> str:
    if model_path:
        return validate_model_path(model_path)

    cached_path = cached_model_path(model_name, cache_dir=cache_dir)
    if cached_path is not None:
        return cached_path

    if not allow_download:
        raise ModelDownloadRequired(model_name)

    return download_model_with_progress(model_name, cache_dir=cache_dir)


def download_model_with_progress(model_name: str, cache_dir: str | None = None) -> str:
    """Download the Parakeet model if needed and return a local snapshot path."""
    from huggingface_hub import hf_hub_download
    import huggingface_hub.file_download as hf_file_download

    progress("Downloading model: 0%")
    config_path = hf_hub_download(model_name, "config.json", cache_dir=cache_dir)

    original_tqdm = hf_file_download.tqdm
    hf_file_download.tqdm = DownloadProgressBar
    try:
        weight_path = hf_hub_download(model_name, "model.safetensors", cache_dir=cache_dir)
    finally:
        hf_file_download.tqdm = original_tqdm

    progress("Downloading model: 100%")
    snapshot_dir = Path(weight_path).parent
    if (snapshot_dir / "config.json").exists():
        return str(snapshot_dir)
    return str(Path(config_path).parent)


def decode_audio_pcm(
    audio_path: str,
    start: Optional[float],
    end: Optional[float],
    sr: int = SAMPLE_RATE,
) -> bytes:
    """Decode audio to mono signed 16-bit PCM using ffmpeg."""
    cmd = [
        "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        audio_path,
        "-vn",
    ]

    if start is not None and start > 0:
        cmd.extend(["-ss", f"{start:.6f}"])

    if end is not None:
        duration = end - (start or 0.0)
        if duration <= 0:
            return b""
        cmd.extend(["-t", f"{duration:.6f}"])

    cmd.extend([
        "-ac",
        "1",
        "-ar",
        str(sr),
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "-",
    ])

    try:
        return subprocess.run(cmd, check=True, capture_output=True).stdout
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.decode(errors="replace")
        raise RuntimeError(f"Failed to load audio with ffmpeg: {stderr}") from exc


def remove_skip_regions(
    pcm: bytes,
    start_offset: float,
    skips: list[dict[str, float]],
    sr: int = SAMPLE_RATE,
) -> bytes:
    """Remove absolute-time skip regions from sliced PCM audio."""
    if not skips:
        return pcm

    total_samples = len(pcm) // SAMPLE_WIDTH
    duration = total_samples / sr
    regions_to_remove: list[tuple[int, int]] = []

    for skip in sorted(skips, key=lambda s: s["start"]):
        skip_start = float(skip["start"]) - start_offset
        skip_end = float(skip["end"]) - start_offset
        if skip_end <= 0 or skip_start >= duration:
            continue

        start_sample = max(0, int(skip_start * sr))
        end_sample = min(total_samples, int(skip_end * sr))
        if end_sample > start_sample:
            regions_to_remove.append((start_sample, end_sample))

    if not regions_to_remove:
        return pcm

    chunks: list[bytes] = []
    prev_end = 0
    for start_sample, end_sample in regions_to_remove:
        if start_sample > prev_end:
            chunks.append(pcm[prev_end * SAMPLE_WIDTH:start_sample * SAMPLE_WIDTH])
        prev_end = max(prev_end, end_sample)

    if prev_end < total_samples:
        chunks.append(pcm[prev_end * SAMPLE_WIDTH:])

    return b"".join(chunks)


def write_wav(path: Path, pcm: bytes, sr: int = SAMPLE_RATE) -> None:
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(SAMPLE_WIDTH)
        out.setframerate(sr)
        out.writeframes(pcm)


def adjust_timestamps(result: dict[str, Any], start_offset: float, skips: list[dict[str, float]] | None = None) -> dict[str, Any]:
    """Expand timestamps from a sliced/skip-compressed file onto the original timeline."""
    sorted_skips = sorted(skips or [], key=lambda s: s["start"])

    def adjust_time(t: float) -> float:
        adjusted = t + start_offset
        cumulative_skip_duration = 0.0
        epsilon = 1e-9

        for skip in sorted_skips:
            skip_relative_start = float(skip["start"]) - start_offset
            skip_compressed_start = skip_relative_start - cumulative_skip_duration
            if t - skip_compressed_start > epsilon:
                skip_duration = float(skip["end"]) - float(skip["start"])
                adjusted += skip_duration
                cumulative_skip_duration += skip_duration
            else:
                break

        return adjusted

    for segment in result.get("segments", []):
        segment["start"] = adjust_time(float(segment.get("start", 0)))
        segment["end"] = adjust_time(float(segment.get("end", 0)))
        for word in segment.get("words", []):
            word["start"] = adjust_time(float(word.get("start", 0)))
            word["end"] = adjust_time(float(word.get("end", 0)))

    return result


WORD_RE = re.compile(r"[A-Za-z0-9']+")


def word_tokens(text: str) -> list[str]:
    return WORD_RE.findall(text)


def confidence_mean(values: list[float]) -> float:
    if not values:
        return 1.0
    return float(math.exp(sum(math.log(max(1e-10, v)) for v in values) / len(values)))


def parakeet_sentence_words(sentence: Any) -> list[dict[str, Any]]:
    """Group Parakeet subword tokens into plugin word dictionaries."""
    words: list[dict[str, Any]] = []
    current_text = ""
    current_start = 0.0
    current_end = 0.0
    current_confidences: list[float] = []

    def flush_current() -> None:
        nonlocal current_text, current_start, current_end, current_confidences
        if not current_text or not word_tokens(current_text):
            current_text = ""
            current_confidences = []
            return

        words.append({
            "word": current_text,
            "start": float(current_start),
            "end": float(current_end),
            "confidence": confidence_mean(current_confidences),
        })
        current_text = ""
        current_confidences = []

    for token in getattr(sentence, "tokens", []):
        piece = str(getattr(token, "text", "") or "")
        if not piece:
            continue

        stripped = piece.strip()
        is_word_piece = bool(word_tokens(stripped))
        starts_new_word = piece[:1].isspace() and is_word_piece
        token_start = float(getattr(token, "start", 0.0))
        token_end = float(getattr(token, "end", token_start))
        token_confidence = float(getattr(token, "confidence", 1.0))

        if starts_new_word or (not current_text and is_word_piece):
            flush_current()
            current_text = stripped
            current_start = token_start
            current_end = token_end
            current_confidences = [token_confidence]
        elif current_text:
            current_text += stripped
            current_end = token_end
            current_confidences.append(token_confidence)
        elif is_word_piece:
            current_text = stripped
            current_start = token_start
            current_end = token_end
            current_confidences = [token_confidence]

    flush_current()
    return words


def word_duration_cap(word: str) -> float:
    letter_count = len("".join(word_tokens(word)))
    return min(1.2, max(0.25, 0.12 * letter_count + 0.15))


def clamp_word_ends(segments: list[dict[str, Any]], epsilon: float = 0.01) -> None:
    """Clamp implausibly long word ends without moving starts."""
    all_words = [word for segment in segments for word in segment.get("words", [])]
    all_words.sort(key=lambda word: float(word["start"]))

    for index, word in enumerate(all_words):
        start = float(word["start"])
        end = float(word["end"])
        max_end = start + word_duration_cap(str(word.get("word", "")))

        next_word = all_words[index + 1] if index + 1 < len(all_words) else None
        if next_word is not None:
            next_start = float(next_word["start"])
            if next_start > start:
                max_end = min(max_end, max(start + 0.05, next_start - epsilon))

        word["end"] = max(start + 0.05, min(end, max_end))

    for segment in segments:
        words = segment.get("words", [])
        if not words:
            continue
        segment["start"] = float(words[0]["start"])
        segment["end"] = float(words[-1]["end"])


def text_with_paragraph_breaks(segments: list[dict[str, Any]], paragraph_break_gap: float) -> str:
    if not segments:
        return ""

    parts = [str(segments[0].get("text", "")).strip()]
    for previous, current in zip(segments, segments[1:]):
        gap = float(current.get("start", 0.0)) - float(previous.get("end", 0.0))
        separator = "\n\n" if paragraph_break_gap > 0 and gap >= paragraph_break_gap else " "
        parts.append(separator + str(current.get("text", "")).strip())

    return "".join(parts).strip()


def result_to_alignment(result: Any, clamp_ends: bool = True, paragraph_break_gap: float = 2.0) -> dict[str, Any]:
    segments: list[dict[str, Any]] = []

    for sentence in getattr(result, "sentences", []):
        words = parakeet_sentence_words(sentence)
        if not words:
            continue
        segments.append({
            "start": float(words[0]["start"]),
            "end": float(words[-1]["end"]),
            "text": " ".join(word["word"] for word in words),
            "words": words,
        })

    if clamp_ends:
        clamp_word_ends(segments)

    text = text_with_paragraph_breaks(segments, paragraph_break_gap)
    if not text:
        text = str(getattr(result, "text", "") or "").strip()

    return {
        "language": "en",
        "segments": segments,
        "text": text,
    }


class SpeechServer:
    def __init__(self) -> None:
        self.model = None
        self.model_name: str | None = None
        self.dtype_name = "bf16"

    def ensure_model(
        self,
        model_name: str,
        fp32: bool = False,
        cache_dir: str | None = None,
        model_path: str | None = None,
        allow_download: bool = False,
    ) -> None:
        import mlx.core as mx
        import parakeet_mlx

        dtype_name = "fp32" if fp32 else "bf16"
        model_key = model_path or model_name
        if self.model is not None and self.model_name == model_key and self.dtype_name == dtype_name:
            return

        dtype = mx.float32 if fp32 else mx.bfloat16
        resolved_model_path = resolve_model_path(
            model_name,
            model_path=model_path,
            cache_dir=cache_dir,
            allow_download=allow_download,
        )
        progress("Loading transcription model...")
        self.model = parakeet_mlx.from_pretrained(resolved_model_path, dtype=dtype, cache_dir=cache_dir)
        self.model_name = model_key
        self.dtype_name = dtype_name

    def prepare_audio(self, request: dict[str, Any]) -> tuple[str, float, list[dict[str, float]], tempfile.TemporaryDirectory[str] | None]:
        audio_path = request["audio"]
        start = request.get("start")
        end = request.get("end")
        skips = request.get("skips") or []

        if not skips and start is None and end is None:
            return audio_path, 0.0, [], None

        start_offset = float(start or 0.0)
        progress("Preparing audio range...")
        pcm = decode_audio_pcm(audio_path, start, end)
        pcm = remove_skip_regions(pcm, start_offset, skips)

        if not pcm:
            raise RuntimeError("Selected audio range is empty")

        temp_dir = tempfile.TemporaryDirectory(prefix="interactive-transcripts-parakeet-")
        wav_path = Path(temp_dir.name) / "audio.wav"
        write_wav(wav_path, pcm)
        return str(wav_path), start_offset, skips, temp_dir

    def transcribe(self, request: dict[str, Any]) -> dict[str, Any]:
        from parakeet_mlx import DecodingConfig, Greedy, SentenceConfig

        model_name = request.get("model") or DEFAULT_MODEL
        model_path = request.get("modelPath")
        allow_download = bool(request.get("allowModelDownload", False))
        fp32 = bool(request.get("fp32", False))
        cache_dir = request.get("cacheDir")
        chunk_duration = request.get("chunkDuration", 120)
        overlap_duration = request.get("overlapDuration", 15)
        paragraph_break_gap = float(request.get("paragraphBreakGap", 2.0))
        clamp_ends = request.get("clampWordEnds", True)

        self.ensure_model(
            model_name,
            fp32=fp32,
            cache_dir=cache_dir,
            model_path=model_path,
            allow_download=allow_download,
        )
        assert self.model is not None

        audio_path, start_offset, skips, temp_dir = self.prepare_audio(request)

        sentence_config = SentenceConfig(
            max_words=request.get("maxWords"),
            silence_gap=request.get("silenceGap"),
            max_duration=request.get("maxDuration"),
        )
        decoding_config = DecodingConfig(decoding=Greedy(), sentence=sentence_config)

        def chunk_callback(current: int, total: int) -> None:
            if total > 0:
                percent = min(99, max(0, int((current / total) * 100)))
                progress(f"Transcribing: {percent}%")

        try:
            progress("Transcribing: 0%")
            result = self.model.transcribe(
                audio_path,
                decoding_config=decoding_config,
                chunk_duration=chunk_duration if chunk_duration and chunk_duration > 0 else None,
                overlap_duration=float(overlap_duration),
                chunk_callback=chunk_callback,
            )
            progress("Post-processing timestamps...")

            output = result_to_alignment(
                result,
                clamp_ends=bool(clamp_ends),
                paragraph_break_gap=paragraph_break_gap,
            )
            if start_offset > 0 or skips:
                output = adjust_timestamps(output, start_offset, skips)

            return output
        finally:
            if temp_dir is not None:
                temp_dir.cleanup()

    def handle_request(self, request: dict[str, Any]) -> dict[str, Any]:
        action = request.get("action")

        if action == "shutdown":
            return {"status": "shutdown"}

        if action == "transcribe":
            try:
                result = self.transcribe(request)
                return {"status": "ok", "result": result}
            except ModelDownloadRequired as exc:
                return {
                    "status": "error",
                    "code": "model_download_required",
                    "message": str(exc),
                    "modelSizeBytes": exc.size_bytes,
                }
            except Exception as exc:
                return {"status": "error", "message": str(exc)}

        return {"status": "error", "message": f"Unknown action: {action}"}

    def run(self) -> None:
        progress("Server ready")

        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue

            try:
                request = json.loads(line)
            except json.JSONDecodeError as exc:
                print(json.dumps({"status": "error", "message": f"Invalid JSON: {exc}"}), flush=True)
                continue

            response = self.handle_request(request)
            print(json.dumps(response), flush=True)

            if response.get("status") == "shutdown":
                break


def main() -> None:
    progress("Initializing...")
    server = SpeechServer()
    server.run()


if __name__ == "__main__":
    main()
