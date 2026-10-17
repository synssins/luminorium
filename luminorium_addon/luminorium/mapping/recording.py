"""Raw capture sessions on disk, so every capture can be analysed again offline.

/config/mapping/sessions/<session id>/
    session.json            targets, stations, sync light, status, results summary
    commands.json           the command log (app clock)
    <station>/frames.csv    seq, phone time (s), file
    <station>/f_000000.jpg  frames exactly as the phone sent them
    <station>/motion.json   [[t, rot_a, rot_b, rot_g, acc_x, acc_y, acc_z], ...] (phone clock)
    <station>/orientation.json  [[t, alpha, beta, gamma], ...]
    <station>/clock.json    handshake samples [[t_server_sent, t_phone, t_server_received], ...]
    <station>/live.json     the live detector's decision for each step
    <station>/photo.jpg     the reference photo (full resolution)
    results.json            the analysis
"""

from __future__ import annotations

import csv
import json
import os
import re
import shutil
import tempfile
from pathlib import Path

import cv2
import numpy as np

from . import motion as motion_mod

_NAME = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


def _ext(data: bytes) -> str:
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    raise ValueError("frames must be JPEG, PNG or WebP")


def write_json(path: Path, data) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


class StationRecorder:
    def __init__(self, folder: Path):
        self.folder = folder
        folder.mkdir(parents=True, exist_ok=True)
        self.count = 0
        self.times: list[float] = []
        self.motion: list = []
        self.orientation: list = []
        self.clock: list = []
        self.live: list = []  # the live detector's decision per step
        self._csv = open(folder / "frames.csv", "w", newline="", encoding="utf-8")  # noqa: SIM115
        self._writer = csv.writer(self._csv)
        self._writer.writerow(["seq", "t", "file"])

    def frame(self, t_phone: float, data: bytes) -> str:
        name = f"f_{self.count:06d}.{_ext(data)}"
        (self.folder / name).write_bytes(data)
        self._writer.writerow([self.count, f"{t_phone:.6f}", name])
        self.count += 1
        self.times.append(t_phone)
        return name

    def photo(self, data: bytes) -> None:
        (self.folder / "photo.jpg").write_bytes(data)

    def flush(self) -> None:
        self._csv.flush()
        write_json(self.folder / "motion.json", self.motion)
        write_json(self.folder / "orientation.json", self.orientation)
        write_json(self.folder / "clock.json", self.clock)
        write_json(self.folder / "live.json", self.live)

    def close(self) -> None:
        if not self._csv.closed:
            self.flush()
            self._csv.close()


class Frames:
    """A station's recorded frames as a sequence of RGB arrays, decoded on access."""

    def __init__(self, folder: Path, max_side: int = 640):
        self.folder = folder
        self.max_side = max_side
        self.files: list[str] = []
        self.times: list[float] = []
        with open(folder / "frames.csv", newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                self.files.append(row["file"])
                self.times.append(float(row["t"]))

    def __len__(self) -> int:
        return len(self.files)

    def __getitem__(self, k: int) -> np.ndarray:
        img = cv2.imread(str(self.folder / self.files[k]), cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError(f"unreadable frame {self.files[k]}")
        scale = self.max_side / max(img.shape[:2])
        if scale < 1:
            img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def load_station(folder: Path) -> dict:
    """Everything recorded at one station, ready for the analysis."""
    frames = Frames(folder)
    return {
        "frames": frames,
        "t": np.asarray(frames.times, float),
        "motion": motion_mod.from_rows(read_json(folder / "motion.json", [])),
        "clock": read_json(folder / "clock.json", []),
    }


def video_to_frames(video: Path, folder: Path, max_side: int = 640) -> int:
    """Decode an uploaded video into a station's frames (record-and-upload fallback). The video's
    own clock is the "phone clock"; the sync blink finds its offset."""
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise ValueError("can't read this video")
    folder.mkdir(parents=True, exist_ok=True)
    n = 0
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    with open(folder / "frames.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["seq", "t", "file"])
        while True:
            ok, img = cap.read()
            if not ok:
                break
            t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
            if n and t <= 0:
                t = n / fps
            scale = max_side / max(img.shape[:2])
            if scale < 1:
                img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
            name = f"f_{n:06d}.jpg"
            cv2.imwrite(str(folder / name), img, [cv2.IMWRITE_JPEG_QUALITY, 95])
            w.writerow([n, f"{t:.6f}", name])
            n += 1
    cap.release()
    if n < 20:
        raise ValueError("the video is too short")
    for name in ("motion.json", "orientation.json", "clock.json"):
        write_json(folder / name, [])
    return n


def check_name(name: str) -> str:
    if not _NAME.match(name or ""):
        raise ValueError(f"bad name {name!r}")
    return name


def remove(folder: Path) -> None:
    shutil.rmtree(folder, ignore_errors=True)
