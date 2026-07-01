#!/usr/bin/env python3
"""
Long-silence ASR timestamp evaluation harness.

This is meant to catch the failure mode common in reading/commentary
recordings: 15-30 minute files with sparse speech islands and long silences.

Examples:
  python scripts/asr_long_silence_eval.py make-fixture --out-dir /tmp/asr-eval
  python scripts/asr_long_silence_eval.py score --manifest /tmp/asr-eval/long_silence_comments.manifest.json --provider-json result.json --provider deepgram
  DEEPGRAM_API_KEY=... python scripts/asr_long_silence_eval.py run-deepgram --manifest /tmp/asr-eval/long_silence_comments.manifest.json
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import wave
from typing import Any


DEFAULT_OUT_DIR = pathlib.Path(tempfile.gettempdir()) / "markdown-audio-transcripts-asr-eval" / "long-silence-fixture"
SAMPLE_RATE = 16_000

PHRASES = [
    "Opening note. I am starting this reading session with one short comment about the introduction.",
    "Quote marker. We already feel the effects of living in this blank space. This line should appear after a long quiet interval.",
    "A reaction. The author seems worried that culture now rewards familiarity more than invention.",
    "Question for later. What would count as genuine novelty if every platform optimizes for proven patterns?",
    "A small aside. I am turning the page now and pausing for a while before the next thought.",
    "Quote marker. Though only three years older than Eddie Vedder, Solomon had little allegiance to the punk ethos.",
    "Commentary. This example makes the generational boundary feel softer than the usual story suggests.",
    "Observation. The argument depends on distribution systems as much as on individual artistic taste.",
    "Question. Is the blank space caused by audience preference, business risk, or recommendation systems?",
    "Note to self. Compare this passage with the older essay about memory and cultural defaults.",
    "Another quote marker. Where society once encouraged reinvention, the incentives now seem to favor repetition.",
    "Closing thought. I want to preserve these comments with accurate timestamps even though most of the recording is silence.",
]

# Intentional long gaps; with phrase durations and trailing silence this yields
# about 23 minutes of audio, roughly 95% silence.
GAPS_SECONDS = [25, 95, 130, 70, 160, 110, 85, 145, 105, 75, 135, 90]
TRAILING_SILENCE_SECONDS = 105


def word_tokens(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", text.lower())


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True)


def make_fixture(out_dir: pathlib.Path, voice: str) -> pathlib.Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    utterances = []

    for index, text in enumerate(PHRASES):
        aiff_path = out_dir / f"utterance_{index:02d}.aiff"
        wav_path = out_dir / f"utterance_{index:02d}.wav"
        if not wav_path.exists():
            run(["say", "-v", voice, "-o", str(aiff_path), text])
            run([
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(aiff_path),
                "-ac",
                "1",
                "-ar",
                str(SAMPLE_RATE),
                "-sample_fmt",
                "s16",
                str(wav_path),
            ])
            aiff_path.unlink(missing_ok=True)

        with wave.open(str(wav_path), "rb") as wav:
            if wav.getframerate() != SAMPLE_RATE or wav.getnchannels() != 1 or wav.getsampwidth() != 2:
                raise RuntimeError(f"Unexpected WAV format: {wav_path}")
            frames = wav.readframes(wav.getnframes())
            duration = wav.getnframes() / SAMPLE_RATE
        utterances.append((text, frames, duration))

    fixture_path = out_dir / "long_silence_comments.wav"
    manifest_path = out_dir / "long_silence_comments.manifest.json"
    manifest: dict[str, Any] = {
        "sample_rate": SAMPLE_RATE,
        "audio": str(fixture_path),
        "phrases": [],
        "transcript": "\n".join(PHRASES),
    }

    with wave.open(str(fixture_path), "wb") as out_wav:
        out_wav.setnchannels(1)
        out_wav.setsampwidth(2)
        out_wav.setframerate(SAMPLE_RATE)
        cursor = 0.0

        for index, (text, frames, duration) in enumerate(utterances):
            gap = GAPS_SECONDS[index]
            out_wav.writeframes(b"\x00\x00" * int(gap * SAMPLE_RATE))
            cursor += gap
            start = cursor
            out_wav.writeframes(frames)
            cursor += duration
            end = cursor
            manifest["phrases"].append({
                "index": index,
                "start": round(start, 3),
                "end": round(end, 3),
                "duration": round(duration, 3),
                "text": text,
                "tokens": word_tokens(text),
            })

        out_wav.writeframes(b"\x00\x00" * int(TRAILING_SILENCE_SECONDS * SAMPLE_RATE))
        cursor += TRAILING_SILENCE_SECONDS

    speech_duration = sum(item[2] for item in utterances)
    manifest["duration"] = round(cursor, 3)
    manifest["speech_duration"] = round(speech_duration, 3)
    manifest["silence_duration"] = round(cursor - speech_duration, 3)
    manifest["silence_ratio"] = round((cursor - speech_duration) / cursor, 4)
    manifest_path.write_text(json.dumps(manifest, indent=2))
    return manifest_path


def levenshtein(a: list[str], b: list[str]) -> int:
    previous = list(range(len(b) + 1))
    for i, left in enumerate(a, 1):
        current = [i]
        for j, right in enumerate(b, 1):
            current.append(min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + (left != right),
            ))
        previous = current
    return previous[-1]


def alignment_pairs(a: list[str], b: list[str]) -> list[tuple[int | None, int | None]]:
    """Return Levenshtein alignment pairs between expected and predicted tokens."""
    rows = len(a) + 1
    cols = len(b) + 1
    costs = [[0] * cols for _ in range(rows)]

    for i in range(1, rows):
        costs[i][0] = i
    for j in range(1, cols):
        costs[0][j] = j

    for i in range(1, rows):
        for j in range(1, cols):
            substitution = costs[i - 1][j - 1] + (a[i - 1] != b[j - 1])
            deletion = costs[i - 1][j] + 1
            insertion = costs[i][j - 1] + 1
            costs[i][j] = min(substitution, deletion, insertion)

    pairs: list[tuple[int | None, int | None]] = []
    i = len(a)
    j = len(b)
    while i > 0 or j > 0:
        if i > 0 and j > 0 and costs[i][j] == costs[i - 1][j - 1] + (a[i - 1] != b[j - 1]):
            pairs.append((i - 1, j - 1))
            i -= 1
            j -= 1
        elif i > 0 and costs[i][j] == costs[i - 1][j] + 1:
            pairs.append((i - 1, None))
            i -= 1
        else:
            pairs.append((None, j - 1))
            j -= 1

    pairs.reverse()
    return pairs


def normalize_word_item(item: dict[str, Any], duration: float | None = None) -> list[dict[str, Any]]:
    raw_word = str(item.get("word") or item.get("text") or item.get("token") or "")
    start = item.get("start")
    end = item.get("end")
    if start is None:
        start = item.get("start_time")
    if end is None:
        end = item.get("end_time")
    if start is None or end is None:
        return []

    start = float(start)
    end = float(end)

    # Some providers, notably AssemblyAI, use milliseconds in transcript words.
    if duration and max(start, end) > duration + 60:
        start /= 1000.0
        end /= 1000.0

    return [
        {
            "token": token,
            "word": raw_word,
            "start": start,
            "end": end,
            "confidence": item.get("confidence") or item.get("score"),
        }
        for token in word_tokens(raw_word)
    ]


def extract_provider_words(provider_json: dict[str, Any], duration: float | None = None) -> list[dict[str, Any]]:
    candidate_lists: list[Any] = []

    if isinstance(provider_json.get("words"), list):
        candidate_lists.append(provider_json["words"])

    if isinstance(provider_json.get("word_segments"), list):
        candidate_lists.append(provider_json["word_segments"])

    if isinstance(provider_json.get("segments"), list):
        words = []
        for segment in provider_json["segments"]:
            words.extend(segment.get("words") or [])
        candidate_lists.append(words)

    deepgram_alt = (
        provider_json.get("results", {})
        .get("channels", [{}])[0]
        .get("alternatives", [{}])[0]
    )
    if isinstance(deepgram_alt.get("words"), list):
        candidate_lists.append(deepgram_alt["words"])

    parakeet_words = extract_parakeet_words(provider_json)
    if parakeet_words:
        return parakeet_words

    for candidate in candidate_lists:
        normalized = []
        for item in candidate:
            if isinstance(item, dict):
                normalized.extend(normalize_word_item(item, duration=duration))
        if normalized:
            return normalized

    raise ValueError("Could not find word-level timestamps in provider JSON")


def extract_parakeet_words(provider_json: dict[str, Any]) -> list[dict[str, Any]]:
    """Group Parakeet MLX subword token JSON into word timestamps."""
    sentences = provider_json.get("sentences")
    if not isinstance(sentences, list):
        return []

    words: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None

    def flush_current() -> None:
        nonlocal current
        if not current:
            return
        tokens = word_tokens(current["word"])
        if tokens:
            # Parakeet tokens are already subword pieces, so this should usually
            # be exactly one token. Split defensively if punctuation/formatting
            # makes more than one word-like token.
            for token in tokens:
                words.append({
                    "token": token,
                    "word": current["word"],
                    "start": current["start"],
                    "end": current["end"],
                    "confidence": current.get("confidence"),
                })
        current = None

    for sentence in sentences:
        tokens = sentence.get("tokens")
        if not isinstance(tokens, list):
            continue
        for token_item in tokens:
            if not isinstance(token_item, dict):
                continue
            piece = str(token_item.get("text") or "")
            if not piece:
                continue
            start = float(token_item.get("start", sentence.get("start", 0.0)))
            end = float(token_item.get("end", sentence.get("end", start)))
            confidence = token_item.get("confidence")
            stripped = piece.strip()
            starts_new_word = piece[:1].isspace() and bool(word_tokens(stripped))
            is_word_piece = bool(word_tokens(stripped))

            if starts_new_word or (current is None and is_word_piece):
                flush_current()
                current = {
                    "word": stripped,
                    "start": start,
                    "end": end,
                    "confidence": confidence,
                }
            elif current is not None:
                current["word"] += stripped
                current["end"] = end
                if confidence is not None and current.get("confidence") is not None:
                    current["confidence"] = min(float(current["confidence"]), float(confidence))
            elif is_word_piece:
                current = {
                    "word": stripped,
                    "start": start,
                    "end": end,
                    "confidence": confidence,
                }

    flush_current()
    return words


def score_provider_json(manifest_path: pathlib.Path, provider_json_path: pathlib.Path, provider_name: str) -> dict[str, Any]:
    manifest = json.loads(manifest_path.read_text())
    provider_json = json.loads(provider_json_path.read_text())
    predicted = extract_provider_words(provider_json, duration=manifest["duration"])

    expected = []
    for phrase in manifest["phrases"]:
        for token in phrase["tokens"]:
            expected.append({
                "token": token,
                "phrase": phrase["index"],
                "phrase_start": phrase["start"],
                "phrase_end": phrase["end"],
            })

    expected_tokens = [item["token"] for item in expected]
    predicted_tokens = [item["token"] for item in predicted]
    wer = levenshtein(expected_tokens, predicted_tokens) / max(1, len(expected_tokens))
    pairs = alignment_pairs(expected_tokens, predicted_tokens)

    phrase_metrics = []
    for phrase in manifest["phrases"]:
        expected_indexes = [i for i, item in enumerate(expected) if item["phrase"] == phrase["index"]]
        expected_index_set = set(expected_indexes)
        mapped = [
            predicted[predicted_index]
            for expected_index, predicted_index in pairs
            if expected_index in expected_index_set and predicted_index is not None
        ]
        if not mapped:
            phrase_metrics.append({
                "index": phrase["index"],
                "expected_window": [phrase["start"], phrase["end"]],
                "predicted_window": None,
                "token_count": len(expected_indexes),
                "inside_window_tokens": 0,
                "text": phrase["text"],
            })
            continue

        starts = [item["start"] for item in mapped]
        ends = [item["end"] for item in mapped]
        mids = [(item["start"] + item["end"]) / 2 for item in mapped]
        inside = sum(1 for mid in mids if phrase["start"] - 3 <= mid <= phrase["end"] + 3)
        phrase_metrics.append({
            "index": phrase["index"],
            "expected_window": [phrase["start"], phrase["end"]],
            "predicted_window": [round(min(starts), 3), round(max(ends), 3)],
            "start_error_seconds": round(min(starts) - phrase["start"], 3),
            "end_error_seconds": round(max(ends) - phrase["end"], 3),
            "token_count": len(mapped),
            "inside_window_tokens": inside,
            "text": phrase["text"],
        })

    expanded_windows = [(p["start"] - 3, p["end"] + 3) for p in manifest["phrases"]]

    def in_any_window(time_seconds: float) -> bool:
        return any(start <= time_seconds <= end for start, end in expanded_windows)

    outside = [
        item
        for item in predicted
        if not in_any_window((item["start"] + item["end"]) / 2)
    ]
    start_errors = [
        abs(metric["start_error_seconds"])
        for metric in phrase_metrics
        if "start_error_seconds" in metric
    ]

    return {
        "provider": provider_name,
        "audio_duration_seconds": manifest["duration"],
        "speech_duration_seconds": manifest["speech_duration"],
        "silence_ratio": manifest["silence_ratio"],
        "expected_tokens": len(expected_tokens),
        "predicted_tokens": len(predicted_tokens),
        "wer": round(wer, 4),
        "outside_expanded_speech_window_tokens": len(outside),
        "outside_expanded_speech_window_rate": round(len(outside) / max(1, len(predicted)), 4),
        "median_abs_phrase_start_error_seconds": round(sorted(start_errors)[len(start_errors) // 2], 3) if start_errors else None,
        "max_abs_phrase_start_error_seconds": round(max(start_errors), 3) if start_errors else None,
        "phrase_metrics": phrase_metrics,
    }


def multipart_body(fields: dict[str, str], file_field: str, file_path: pathlib.Path, content_type: str) -> tuple[bytes, str]:
    boundary = f"----codex-asr-eval-{secrets.token_hex(12)}"
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.append(f"--{boundary}\r\n".encode())
        chunks.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        chunks.append(str(value).encode())
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}\r\n".encode())
    chunks.append(
        f'Content-Disposition: form-data; name="{file_field}"; filename="{file_path.name}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n".encode()
    )
    chunks.append(file_path.read_bytes())
    chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def post_json(url: str, headers: dict[str, str], body: bytes) -> dict[str, Any]:
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=900) as response:
        return json.loads(response.read().decode("utf-8"))


def run_deepgram(manifest_path: pathlib.Path, model: str, out_path: pathlib.Path) -> pathlib.Path:
    api_key = os.environ.get("DEEPGRAM_API_KEY")
    if not api_key:
        raise RuntimeError("DEEPGRAM_API_KEY is not set")
    manifest = json.loads(manifest_path.read_text())
    audio_path = pathlib.Path(manifest["audio"])
    query = urllib.parse.urlencode({
        "model": model,
        "language": "en",
        "smart_format": "false",
        "punctuate": "true",
    })
    url = f"https://api.deepgram.com/v1/listen?{query}"
    started = time.perf_counter()
    result = post_json(
        url,
        {
            "Authorization": f"Token {api_key}",
            "Content-Type": "audio/wav",
        },
        audio_path.read_bytes(),
    )
    result["_eval_elapsed_seconds"] = round(time.perf_counter() - started, 3)
    out_path.write_text(json.dumps(result, indent=2))
    return out_path


def run_openai_whisper1(manifest_path: pathlib.Path, out_path: pathlib.Path) -> pathlib.Path:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    manifest = json.loads(manifest_path.read_text())
    audio_path = pathlib.Path(manifest["audio"])
    body, content_type = multipart_body(
        {
            "model": "whisper-1",
            "response_format": "verbose_json",
            "timestamp_granularities[]": "word",
            "language": "en",
        },
        "file",
        audio_path,
        "audio/wav",
    )
    started = time.perf_counter()
    result = post_json(
        "https://api.openai.com/v1/audio/transcriptions",
        {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": content_type,
        },
        body,
    )
    result["_eval_elapsed_seconds"] = round(time.perf_counter() - started, 3)
    out_path.write_text(json.dumps(result, indent=2))
    return out_path


def run_elevenlabs_scribe_v2(manifest_path: pathlib.Path, out_path: pathlib.Path) -> pathlib.Path:
    api_key = os.environ.get("ELEVENLABS_API_KEY")
    if not api_key:
        raise RuntimeError("ELEVENLABS_API_KEY is not set")
    manifest = json.loads(manifest_path.read_text())
    audio_path = pathlib.Path(manifest["audio"])
    body, content_type = multipart_body(
        {
            "model_id": "scribe_v2",
            "timestamps_granularity": "word",
            "language_code": "en",
            "tag_audio_events": "false",
        },
        "file",
        audio_path,
        "audio/wav",
    )
    started = time.perf_counter()
    result = post_json(
        "https://api.elevenlabs.io/v1/speech-to-text",
        {
            "xi-api-key": api_key,
            "Content-Type": content_type,
        },
        body,
    )
    result["_eval_elapsed_seconds"] = round(time.perf_counter() - started, 3)
    out_path.write_text(json.dumps(result, indent=2))
    return out_path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    fixture_parser = subparsers.add_parser("make-fixture")
    fixture_parser.add_argument("--out-dir", type=pathlib.Path, default=DEFAULT_OUT_DIR)
    fixture_parser.add_argument("--voice", default="Alex")

    score_parser = subparsers.add_parser("score")
    score_parser.add_argument("--manifest", type=pathlib.Path, required=True)
    score_parser.add_argument("--provider-json", type=pathlib.Path, required=True)
    score_parser.add_argument("--provider", required=True)
    score_parser.add_argument("--out", type=pathlib.Path)

    deepgram_parser = subparsers.add_parser("run-deepgram")
    deepgram_parser.add_argument("--manifest", type=pathlib.Path, required=True)
    deepgram_parser.add_argument("--model", default="nova-3")
    deepgram_parser.add_argument("--out", type=pathlib.Path)

    openai_parser = subparsers.add_parser("run-openai-whisper1")
    openai_parser.add_argument("--manifest", type=pathlib.Path, required=True)
    openai_parser.add_argument("--out", type=pathlib.Path)

    elevenlabs_parser = subparsers.add_parser("run-elevenlabs-scribe-v2")
    elevenlabs_parser.add_argument("--manifest", type=pathlib.Path, required=True)
    elevenlabs_parser.add_argument("--out", type=pathlib.Path)

    args = parser.parse_args()

    if args.command == "make-fixture":
        manifest_path = make_fixture(args.out_dir, args.voice)
        print(manifest_path)
        return 0

    if args.command == "score":
        summary = score_provider_json(args.manifest, args.provider_json, args.provider)
        if args.out:
            args.out.write_text(json.dumps(summary, indent=2))
            print(args.out)
        else:
            print(json.dumps(summary, indent=2))
        return 0

    if args.command == "run-deepgram":
        out = args.out or args.manifest.parent / f"deepgram_{args.model}_result.json"
        result_path = run_deepgram(args.manifest, args.model, out)
        print(result_path)
        return 0

    if args.command == "run-openai-whisper1":
        out = args.out or args.manifest.parent / "openai_whisper1_result.json"
        result_path = run_openai_whisper1(args.manifest, out)
        print(result_path)
        return 0

    if args.command == "run-elevenlabs-scribe-v2":
        out = args.out or args.manifest.parent / "elevenlabs_scribe_v2_result.json"
        result_path = run_elevenlabs_scribe_v2(args.manifest, out)
        print(result_path)
        return 0

    raise AssertionError(args.command)


if __name__ == "__main__":
    raise SystemExit(main())
