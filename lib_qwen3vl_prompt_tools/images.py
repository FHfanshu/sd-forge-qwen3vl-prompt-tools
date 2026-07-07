from __future__ import annotations

import numpy as np
import torch
from PIL import Image


def prepare_image(image: Image.Image, max_side: int) -> torch.Tensor:
    image = image.convert("RGB")
    width, height = image.size
    limit = max(224, int(max_side))
    if max(width, height) > limit:
        ratio = limit / max(width, height)
        width = max(28, round(width * ratio))
        height = max(28, round(height * ratio))
        image = image.resize((width, height), Image.Resampling.LANCZOS)
    array = np.asarray(image, dtype=np.float32) / 255.0
    return torch.from_numpy(array).unsqueeze(0)
