"""
Tests for Parakeet speech server helpers.

Run with: uv run pytest test_speechServer.py -v
"""

from dataclasses import dataclass

from speechServer import (
    DownloadProgressBar,
    ModelDownloadRequired,
    SAMPLE_RATE,
    SAMPLE_WIDTH,
    adjust_timestamps,
    clamp_word_ends,
    parakeet_sentence_words,
    remove_skip_regions,
    resolve_model_path,
    result_to_alignment,
    validate_model_path,
)


@dataclass
class FakeToken:
    text: str
    start: float
    end: float
    confidence: float = 1.0


@dataclass
class FakeSentence:
    tokens: list[FakeToken]


def pcm_for_seconds(seconds: float) -> bytes:
    samples = int(seconds * SAMPLE_RATE)
    return b"\x01\x00" * samples


def test_download_progress_bar_reports_percent(capsys):
    bar = DownloadProgressBar(total=100, initial=0)
    bar.update(40)
    bar.update(40)
    bar.update(20)

    stderr = capsys.readouterr().err

    assert "Progress: Downloading model: 0%" in stderr
    assert "Progress: Downloading model: 40%" in stderr
    assert "Progress: Downloading model: 80%" in stderr
    assert "Progress: Downloading model: 100%" in stderr


def test_validate_model_path_requires_model_files(tmp_path):
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    (model_dir / "config.json").write_text("{}", encoding="utf-8")

    try:
        validate_model_path(str(model_dir))
    except RuntimeError as exc:
        assert "model.safetensors" in str(exc)
    else:
        raise AssertionError("expected missing model.safetensors to fail validation")


def test_resolve_model_path_accepts_valid_local_folder(tmp_path):
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    (model_dir / "config.json").write_text("{}", encoding="utf-8")
    (model_dir / "model.safetensors").write_bytes(b"weights")

    assert resolve_model_path("unused", model_path=str(model_dir)) == str(model_dir)


def test_resolve_model_path_requires_download_when_not_cached(monkeypatch):
    monkeypatch.setattr("speechServer.cached_model_path", lambda *_args, **_kwargs: None)

    try:
        resolve_model_path("mlx-community/parakeet-tdt-0.6b-v3", allow_download=False)
    except ModelDownloadRequired as exc:
        assert exc.size_bytes > 2_000_000_000
    else:
        raise AssertionError("expected missing cached model to require download")


def test_remove_skip_regions_removes_middle_region():
    pcm = pcm_for_seconds(10)
    result = remove_skip_regions(pcm, 0.0, [{"start": 2.0, "end": 4.0}])

    assert len(result) == int(8 * SAMPLE_RATE) * SAMPLE_WIDTH


def test_remove_skip_regions_accounts_for_start_offset():
    pcm = pcm_for_seconds(10)
    result = remove_skip_regions(pcm, 5.0, [{"start": 7.0, "end": 9.5}])

    assert len(result) == int(7.5 * SAMPLE_RATE) * SAMPLE_WIDTH


def test_adjust_timestamps_expands_start_and_skips():
    result = {
        "segments": [
            {
                "start": 1.0,
                "end": 4.0,
                "words": [
                    {"word": "hello", "start": 1.0, "end": 1.5},
                    {"word": "world", "start": 3.0, "end": 4.0},
                ],
            }
        ]
    }

    adjusted = adjust_timestamps(result, 10.0, [{"start": 12.0, "end": 15.0}])

    words = adjusted["segments"][0]["words"]
    assert words[0]["start"] == 11.0
    assert words[1]["start"] == 16.0


def test_parakeet_sentence_words_groups_subwords_and_punctuation():
    sentence = FakeSentence(tokens=[
        FakeToken(" Hel", 0.0, 0.1),
        FakeToken("lo", 0.1, 0.2),
        FakeToken(",", 0.2, 0.25),
        FakeToken(" world", 0.3, 0.5),
        FakeToken(".", 0.5, 0.6),
    ])

    words = parakeet_sentence_words(sentence)

    assert [word["word"] for word in words] == ["Hello,", "world."]
    assert words[0]["start"] == 0.0
    assert words[0]["end"] == 0.25
    assert words[1]["start"] == 0.3
    assert words[1]["end"] == 0.6


def test_clamp_word_ends_shortens_silence_stretch():
    segments = [
        {
            "start": 0.0,
            "end": 30.0,
            "text": "hello world",
            "words": [
                {"word": "hello", "start": 0.0, "end": 30.0},
                {"word": "world", "start": 31.0, "end": 31.5},
            ],
        }
    ]

    clamp_word_ends(segments)

    assert segments[0]["words"][0]["end"] < 1.0
    assert segments[0]["end"] == 31.5


def test_result_to_alignment_inserts_paragraph_breaks_for_segment_gaps():
    result = type("FakeResult", (), {})()
    result.text = "First sentence. Second sentence. Third sentence."
    result.sentences = [
        FakeSentence(tokens=[
            FakeToken(" First", 0.0, 0.2),
            FakeToken(" sentence", 0.3, 0.6),
            FakeToken(".", 0.6, 0.7),
        ]),
        FakeSentence(tokens=[
            FakeToken(" Second", 1.2, 1.5),
            FakeToken(" sentence", 1.6, 2.0),
            FakeToken(".", 2.0, 2.1),
        ]),
        FakeSentence(tokens=[
            FakeToken(" Third", 5.2, 5.5),
            FakeToken(" sentence", 5.6, 6.0),
            FakeToken(".", 6.0, 6.1),
        ]),
    ]

    alignment = result_to_alignment(result, paragraph_break_gap=2.0)

    assert alignment["text"] == "First sentence. Second sentence.\n\nThird sentence."
