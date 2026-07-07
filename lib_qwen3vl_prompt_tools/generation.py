from __future__ import annotations

import threading
from collections.abc import Sequence

import torch
import torch.nn.functional as F
from PIL import Image

from backend import attention as forge_attention
from backend import memory_management, operations
from backend.nn.llm import llama as forge_llama
from backend.nn.llm import qwen35 as forge_qwen35
from modules import sd_models, shared
from modules.processing import logger

from .images import prepare_image
from .prompts import build_caption_chat, build_enhance_chat, clean_generation


_GENERATION_LOCK = threading.Lock()
STOP_TOKENS = {151643, 151645}


def _interleaved_mrope(head_dim: int, position_ids: torch.Tensor, theta: float, rope_dims: Sequence[int], device: torch.device):
    numerator = torch.arange(0, head_dim, 2, device=device).float()
    inv_freq = 1.0 / (theta ** (numerator / head_dim))
    expanded = inv_freq[None, :, None].expand(position_ids.shape[0], -1, 1)
    positions = position_ids[:, None, :].float()
    freqs = (expanded @ positions).transpose(1, 2)

    if position_ids.shape[0] > 1:
        mixed = freqs[0].clone()
        for axis, offset in ((1, 1), (2, 2)):
            mixed[..., slice(offset, rope_dims[axis] * 3, 3)] = freqs[axis, ..., slice(offset, rope_dims[axis] * 3, 3)]
        emb = torch.cat((mixed, mixed), dim=-1)
        cos = emb.cos().unsqueeze(0)
        sin = emb.sin().unsqueeze(0)
    else:
        emb = torch.cat((freqs, freqs), dim=-1)
        cos = emb.cos().unsqueeze(1)
        sin = emb.sin().unsqueeze(1)

    split = sin.shape[-1] // 2
    return cos, sin[..., :split], -sin[..., split:]


def _init_kv_cache(model, batch: int, max_length: int, device: torch.device, dtype: torch.dtype):
    config = model.config
    shape = (batch, config.num_key_value_heads, max_length, config.head_dim)
    return [(torch.empty(shape, device=device, dtype=dtype), torch.empty(shape, device=device, dtype=dtype), 0) for _ in model.layers]


def _prefill(model, embeds: torch.Tensor, position_ids: torch.Tensor | None, deepstack, visual_mask, cache):
    x = embeds
    sequence = x.shape[1]
    if position_ids is None:
        position_ids = torch.arange(sequence, device=x.device).unsqueeze(0)
        freqs = forge_llama.precompute_freqs_cis(
            model.config.head_dim,
            position_ids,
            model.config.rope_theta,
            model.config.rope_scale,
            model.config.rope_dims,
            device=x.device,
        )
    else:
        freqs = _interleaved_mrope(
            model.config.head_dim,
            position_ids,
            model.config.rope_theta,
            model.config.rope_dims,
            x.device,
        )

    causal_mask = torch.full((sequence, sequence), torch.finfo(x.dtype).min / 4, dtype=x.dtype, device=x.device).triu_(1)
    next_cache = []
    for index, layer in enumerate(model.layers):
        x, present = layer(
            x=x,
            attention_mask=causal_mask,
            freqs_cis=freqs,
            optimized_attention=forge_attention.attention_function,
            past_key_value=cache[index],
        )
        next_cache.append(present)
        if deepstack is not None and index < len(deepstack):
            x[visual_mask] = x[visual_mask] + deepstack[index].to(x)
    if model.norm is not None:
        x = model.norm(x)
    return x, next_cache


def _logits(text_encoder, hidden: torch.Tensor) -> torch.Tensor:
    module = text_encoder.model.embed_tokens
    last = hidden[:, -1:]
    if getattr(module, "parameters_manual_cast", False):
        weight, _, signal = operations.weights_manual_cast(module, last, skip_bias_dtype=True)
        with operations.main_stream_worker(weight, None, signal):
            return F.linear(last, weight, None)
    return F.linear(last, module.weight.to(device=last.device, dtype=last.dtype), None)


def _sample(logits: torch.Tensor, history: list[int], *, temperature: float, top_k: int, top_p: float, repetition_penalty: float, generator):
    logits = logits.float()
    if repetition_penalty != 1.0 and history:
        ids = torch.tensor(sorted(set(history)), device=logits.device)
        selected = logits[:, ids]
        logits[:, ids] = torch.where(selected < 0, selected * repetition_penalty, selected / repetition_penalty)
    if temperature <= 0:
        return torch.argmax(logits, dim=-1, keepdim=True)
    logits /= max(temperature, 1e-5)
    if top_k > 0:
        top_k = min(int(top_k), logits.shape[-1])
        logits, indices = torch.topk(logits, top_k)
    else:
        indices = None
    if top_p < 1.0:
        sorted_logits, order = torch.sort(logits, descending=True)
        cumulative = torch.cumsum(torch.softmax(sorted_logits, dim=-1), dim=-1)
        remove = cumulative > top_p
        remove[..., 0] = False
        mask = torch.zeros_like(remove).scatter(1, order, remove)
        logits = logits.masked_fill(mask, torch.finfo(logits.dtype).min)
    token = torch.multinomial(torch.softmax(logits, dim=-1), 1, generator=generator)
    return indices.gather(1, token) if indices is not None else token


def _active_qwen():
    if getattr(shared.opts, "forge_preset", None) != "krea":
        raise RuntimeError("Qwen3-VL 扩写/反推仅在 UI Preset = krea 时启用；请先切到 krea preset。")

    sd_model, _ = sd_models.forge_model_reload()
    engine = getattr(sd_model, "text_processing_engine_qwen", None) if sd_model is not None else None
    clip = getattr(getattr(sd_model, "forge_objects", None), "clip", None) if sd_model is not None else None
    text_encoder = getattr(engine, "text_encoder", None)
    if engine is None or clip is None or text_encoder is None or not hasattr(text_encoder, "build_image_inputs"):
        raise RuntimeError("请先加载带 Qwen3-VL 4B 文本编码器的 Krea 2 模型。")
    return engine, clip, text_encoder


def _process_embeds(engine, tokens, has_image: bool):
    if not has_image:
        return engine.process_embeds([tokens])

    # Neo's current Qwen3-VL vision port imported the selected attention kernel,
    # but still calls it like Comfy's newer per-device kernel selector. Adapt the
    # call only while the vision tower is running and restore the module global.
    selected_attention = forge_qwen35.attention_function
    forge_qwen35.attention_function = lambda *_args, **_kwargs: selected_attention
    try:
        return engine.process_embeds([tokens])
    finally:
        forge_qwen35.attention_function = selected_attention


@torch.inference_mode()
def _generate(chat: str, image: Image.Image | None, *, max_side: int, max_tokens: int, temperature: float, top_k: int, top_p: float, repetition_penalty: float, seed: int, release_after: bool) -> str:
    engine, clip, text_encoder = _active_qwen()
    if getattr(shared.state, "job", ""):
        raise RuntimeError("当前正在生图，请等待采样结束后再调用 Qwen3-VL，避免模型换入时争用显存。")
    if not _GENERATION_LOCK.acquire(blocking=False):
        raise RuntimeError("Qwen3-VL 正在处理另一个请求，请稍后再试。")

    try:
        memory_management.load_model_gpu(clip.patcher)
        token_ids = engine.tokenizer(chat)["input_ids"]
        tokens = list(token_ids)
        if image is not None:
            image_tensor = prepare_image(image, max_side)
            replaced = False
            for index, token in enumerate(tokens):
                if int(token) == engine.id_image:
                    tokens[index] = {"type": "image", "data": image_tensor, "original_type": "image"}
                    replaced = True
                    break
            if not replaced:
                raise RuntimeError("图像占位符没有被 tokenizer 识别，无法执行视觉反推。")

        embeds, _, _, embeds_info = _process_embeds(engine, tokens, image is not None)
        position_ids, visual_mask, deepstack = text_encoder.build_image_inputs(embeds, embeds_info)
        execution_dtype = embeds.dtype if embeds.dtype in (torch.float16, torch.bfloat16) else torch.float32
        embeds = embeds.to(execution_dtype)
        model = text_encoder.model
        cache = _init_kv_cache(model, embeds.shape[0], embeds.shape[1] + int(max_tokens), embeds.device, execution_dtype)
        hidden, cache = _prefill(model, embeds, position_ids, deepstack, visual_mask, cache)

        generator = torch.Generator(device=embeds.device).manual_seed(int(seed))
        history = [int(token) for token in token_ids]
        generated = []
        next_position = int(position_ids[:, -1].max()) + 1 if position_ids is not None else embeds.shape[1]

        for _ in range(max(1, int(max_tokens))):
            logits = _logits(text_encoder, hidden)[:, -1]
            next_token = _sample(
                logits,
                history + generated,
                temperature=float(temperature),
                top_k=int(top_k),
                top_p=float(top_p),
                repetition_penalty=float(repetition_penalty),
                generator=generator,
            )
            token = int(next_token.item())
            if token in STOP_TOKENS:
                break
            generated.append(token)
            token_embed = model.embed_tokens(next_token).to(execution_dtype)
            decode_position = torch.tensor([[next_position]], device=embeds.device)
            next_position += 1
            hidden, _, cache = model.forward(None, embeds=token_embed, past_key_values=cache, position_ids=decode_position)

        result = clean_generation(engine.tokenizer.decode(generated, skip_special_tokens=True, clean_up_tokenization_spaces=False))
        if not result:
            raise RuntimeError("模型没有返回有效文本；可尝试提高最大输出长度或更换随机种子。")
        return result
    finally:
        if release_after:
            logger.info("Qwen3-VL prompt tools: offloading models after generation")
            memory_management.unload_all_models()
            memory_management.soft_empty_cache()
        _GENERATION_LOCK.release()


def enhance(text: str, task: str, *, language: str = "English", max_tokens: int = 256, temperature: float = 0.65, top_k: int = 20, top_p: float = 0.85, repetition_penalty: float = 1.05, seed: int = 42, release_after: bool = True) -> str:
    if not text or not text.strip():
        raise RuntimeError("请先输入要增强的提示词。")
    chat = build_enhance_chat(text, task, language)
    return _generate(chat, None, max_side=768, max_tokens=max_tokens, temperature=temperature, top_k=top_k, top_p=top_p, repetition_penalty=repetition_penalty, seed=seed, release_after=release_after)


def caption(image: Image.Image, task: str, guidance: str = "", *, language: str = "English", max_side: int = 768, max_tokens: int = 320, temperature: float = 0.65, top_k: int = 20, top_p: float = 0.85, repetition_penalty: float = 1.05, seed: int = 42, release_after: bool = True) -> str:
    if image is None:
        raise RuntimeError("请先放入一张图片。")
    chat = build_caption_chat(task, guidance, language)
    return _generate(chat, image, max_side=max_side, max_tokens=max_tokens, temperature=temperature, top_k=top_k, top_p=top_p, repetition_penalty=repetition_penalty, seed=seed, release_after=release_after)
