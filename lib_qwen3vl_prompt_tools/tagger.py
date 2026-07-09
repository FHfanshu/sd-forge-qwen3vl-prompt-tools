from __future__ import annotations

import json
import threading
from dataclasses import dataclass

import huggingface_hub
import numpy as np
import onnxruntime as ort
import pandas as pd
from PIL import Image

from .constants import KAOMOJI_TAGS, LABEL_FILENAME, MODEL_FILENAME, TAGGER_MODELS

@dataclass(slots=True)
class TaggerResult:
    tags: str
    characters: str
    rating: str
    raw_json: str


def _load_labels(dataframe: pd.DataFrame):
    name_series = dataframe["name"].map(lambda value: value if value in KAOMOJI_TAGS else value.replace("_", " "))
    tag_names = name_series.tolist()
    rating_indexes = list(np.where(dataframe["category"] == 9)[0])
    general_indexes = list(np.where(dataframe["category"] == 0)[0])
    character_indexes = list(np.where(dataframe["category"] == 4)[0])
    return tag_names, rating_indexes, general_indexes, character_indexes


def _mcut_threshold(probs: np.ndarray) -> float:
    sorted_probs = probs[probs.argsort()[::-1]]
    if len(sorted_probs) < 2:
        return 0.0
    difs = sorted_probs[:-1] - sorted_probs[1:]
    t = int(difs.argmax())
    return float((sorted_probs[t] + sorted_probs[t + 1]) / 2)


class WDTagger:
    def __init__(self):
        self.lock = threading.Lock()
        self.session: ort.InferenceSession | None = None
        self.loaded_repo: str | None = None
        self.model_target_size = 448
        self.tag_names: list[str] = []
        self.rating_indexes: list[int] = []
        self.general_indexes: list[int] = []
        self.character_indexes: list[int] = []

    def load(self, repo: str) -> str:
        with self.lock:
            if repo == self.loaded_repo and self.session is not None:
                return f"loaded: {repo}"

            csv_path = huggingface_hub.hf_hub_download(repo, LABEL_FILENAME)
            model_path = huggingface_hub.hf_hub_download(repo, MODEL_FILENAME)
            labels = _load_labels(pd.read_csv(csv_path))

            available = ort.get_available_providers()
            providers = [
                provider
                for provider in ("CUDAExecutionProvider", "DmlExecutionProvider", "CPUExecutionProvider")
                if provider in available
            ] or available

            session = ort.InferenceSession(model_path, providers=providers)
            _, height, _, _ = session.get_inputs()[0].shape

            self.session = session
            self.loaded_repo = repo
            self.model_target_size = int(height)
            self.tag_names, self.rating_indexes, self.general_indexes, self.character_indexes = labels
            return f"loaded: {repo} · {self.model_target_size}px · {', '.join(session.get_providers())}"

    def unload(self) -> str:
        with self.lock:
            self.session = None
            self.loaded_repo = None
            return "tagger unloaded"

    def _prepare_image(self, image: Image.Image) -> np.ndarray:
        target_size = self.model_target_size
        image = image.convert("RGBA")
        canvas = Image.new("RGBA", image.size, (255, 255, 255, 255))
        canvas.alpha_composite(image)
        image = canvas.convert("RGB")

        max_dim = max(image.size)
        pad_left = (max_dim - image.size[0]) // 2
        pad_top = (max_dim - image.size[1]) // 2
        padded = Image.new("RGB", (max_dim, max_dim), (255, 255, 255))
        padded.paste(image, (pad_left, pad_top))
        if max_dim != target_size:
            padded = padded.resize((target_size, target_size), Image.BICUBIC)

        image_array = np.asarray(padded, dtype=np.float32)
        image_array = image_array[:, :, ::-1]
        return np.expand_dims(image_array, axis=0)

    def predict(
        self,
        image: Image.Image,
        repo: str,
        general_threshold: float,
        general_mcut: bool,
        character_threshold: float,
        character_mcut: bool,
        include_character_tags: bool,
        limit_tags: int,
    ) -> TaggerResult:
        if image is None:
            raise RuntimeError("请先放入一张图片。")

        self.load(repo)
        if self.session is None:
            raise RuntimeError("Tagger model is not loaded.")

        input_name = self.session.get_inputs()[0].name
        output_name = self.session.get_outputs()[0].name
        preds = self.session.run([output_name], {input_name: self._prepare_image(image)})[0][0].astype(float)
        labels = list(zip(self.tag_names, preds))

        rating_items = [labels[index] for index in self.rating_indexes]
        rating = max(rating_items, key=lambda item: item[1])[0] if rating_items else ""

        general_items = [labels[index] for index in self.general_indexes]
        if general_mcut:
            general_threshold = _mcut_threshold(np.array([score for _, score in general_items]))
        general = [(name, score) for name, score in general_items if score > float(general_threshold)]
        general.sort(key=lambda item: item[1], reverse=True)

        character_items = [labels[index] for index in self.character_indexes]
        if character_mcut:
            character_threshold = max(0.15, _mcut_threshold(np.array([score for _, score in character_items])))
        characters = [(name, score) for name, score in character_items if score > float(character_threshold)]
        characters.sort(key=lambda item: item[1], reverse=True)

        if int(limit_tags) > 0:
            general = general[: int(limit_tags)]

        tag_names = [name for name, _ in general]
        if include_character_tags:
            tag_names = [name for name, _ in characters] + tag_names

        raw = {
            "rating": rating,
            "characters": [{"tag": name, "score": round(float(score), 4)} for name, score in characters],
            "general": [{"tag": name, "score": round(float(score), 4)} for name, score in general],
        }
        return TaggerResult(
            tags=", ".join(tag_names),
            characters=", ".join(name for name, _ in characters),
            rating=rating,
            raw_json=json.dumps(raw, ensure_ascii=False, indent=2),
        )


TAGGER = WDTagger()
def repo_from_label(label_or_repo: str) -> str:
    return TAGGER_MODELS.get(label_or_repo, label_or_repo)
