"""
tts_synth.py — Hebrew text (stdin) to an OGG/Opus voice note (argv[1]).

Driven by tts.ts as a short-lived child. Prints one JSON line on stdout:
    {"ok": true, "path": "...", "seconds": 7.73}
    {"ok": false, "error": "..."}

Runs inside the venv at $TTS_HOME/.venv, with the models beside it in
$TTS_HOME. Nothing here is installed system-wide, and no ffmpeg is involved:
libsndfile (bundled in the soundfile wheel, 1.2.2 on the droplet) writes the
OGG/Opus that Telegram's sendVoice requires directly.

Setup that produced $TTS_HOME, for whoever rebuilds it:
    uv venv .venv
    uv pip install --python .venv/bin/python phonikud-tts soundfile
    curl -sSL https://huggingface.co/thewh1teagle/phonikud-onnx/resolve/main/phonikud-1.0.int8.onnx -o phonikud-1.0.int8.onnx
    curl -sSL https://huggingface.co/thewh1teagle/phonikud-tts-checkpoints/resolve/main/shaul.onnx -o tts-model.onnx
    curl -sSL https://huggingface.co/thewh1teagle/phonikud-tts-checkpoints/resolve/main/model.config.json -o tts-model.config.json
"""

import json
import os
import sys


def fail(msg: str) -> None:
    print(json.dumps({"ok": False, "error": msg}))
    sys.exit(1)


def main() -> None:
    if len(sys.argv) < 2:
        fail("usage: tts_synth.py <out.ogg>")
    out_path = sys.argv[1]

    home = os.environ.get("TTS_HOME") or os.path.join(os.path.expanduser("~"), "tts")
    text = sys.stdin.read().strip()
    if not text:
        fail("empty text")

    import numpy as np
    import soundfile as sf
    from phonikud_tts import Phonikud, phonemize, Piper

    phonikud = Phonikud(os.path.join(home, "phonikud-1.0.int8.onnx"))
    piper = Piper(
        os.path.join(home, "tts-model.onnx"),
        os.path.join(home, "tts-model.config.json"),
    )

    phonemes = phonemize(phonikud.add_diacritics(text))
    samples, sample_rate = piper.create(phonemes, is_phonemes=True)
    if len(samples) == 0:
        fail("synthesizer produced no audio")

    # Opus only accepts 48/24/16/12/8 kHz and Piper here emits 22050, so resample
    # before writing. Linear interpolation is plenty for speech at this ratio.
    target_sr = 48000
    if sample_rate != target_sr:
        n = int(len(samples) * target_sr / sample_rate)
        samples = np.interp(
            np.linspace(0, len(samples), n, endpoint=False),
            np.arange(len(samples)),
            samples,
        )
        seconds = n / target_sr
    else:
        seconds = len(samples) / target_sr

    sf.write(out_path, samples, target_sr, format="OGG", subtype="OPUS")
    print(json.dumps({"ok": True, "path": out_path, "seconds": round(seconds, 2)}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 — the caller only needs ok/error
        fail(f"{type(e).__name__}: {e}")
