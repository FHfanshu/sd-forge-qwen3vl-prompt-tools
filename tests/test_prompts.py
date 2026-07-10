import json
import unittest
from unittest.mock import Mock, patch

from PIL import Image

from lib_qwen3vl_prompt_tools.assistant import _prompt_assistant_chat_once, ask_teacher, prompt_assistant_chat, prompt_assistant_stream
from lib_qwen3vl_prompt_tools.assistant_common import _assistant_request_messages
from lib_qwen3vl_prompt_tools.constants import DEFAULT_ASSISTANT_BACKEND, DEFAULT_ASSISTANT_FALLBACK_BACKEND, DEFAULT_ASSISTANT_FALLBACK_MODEL, DEFAULT_ASSISTANT_MODEL
from lib_qwen3vl_prompt_tools.generic import _PromptSanitizer, _restore_gemini_result
from lib_qwen3vl_prompt_tools.assistant_gemini import _assistant_use_gemini_native, _gemini_request_body, _prompt_assistant_chat_gemini
from lib_qwen3vl_prompt_tools.assistant_teacher import qwen_teacher_enabled
from lib_qwen3vl_prompt_tools.images import prepare_image
from lib_qwen3vl_prompt_tools.prompts import build_caption_chat, build_enhance_chat, clean_generation


class PromptToolsTests(unittest.TestCase):
    def test_enhance_template_has_generation_boundary(self):
        prompt = build_enhance_chat("a blue fox", "expand")
        self.assertIn("a blue fox", prompt)
        self.assertTrue(prompt.endswith("<think>\n\n</think>\n\n"))
        self.assertNotIn("<|image_pad|>", prompt)

    def test_caption_template_has_one_image_token(self):
        prompt = build_caption_chat("完整反推", "focus on the coat")
        self.assertEqual(prompt.count("<|image_pad|>"), 1)
        self.assertIn("focus on the coat", prompt)

    def test_clean_generation_removes_reasoning_and_label(self):
        value = clean_generation('<think>hidden</think> Prompt: "a silver tower"<|im_end|>')
        self.assertEqual(value, "a silver tower")

    def test_prepare_image_limits_long_side(self):
        value = prepare_image(Image.new("RGB", (1600, 800)), 800)
        self.assertEqual(tuple(value.shape), (1, 400, 800, 3))

    def test_prompt_sanitizer_restores_tool_arguments(self):
        sanitizer = _PromptSanitizer(True)
        sanitized = sanitizer.sanitize_text("moqing, erection, precum")
        self.assertIn("SAFE_SLOT_001", sanitized)
        self.assertNotIn("erection", sanitized)

        result = {
            "text": "",
            "tool_calls": [
                {
                    "tool": "edit_prompt",
                    "arguments": {
                        "diff": "<<<<<<< SEARCH\nmoqing, SAFE_SLOT_001, SAFE_SLOT_002\n=======\nmoqing, glasses, SAFE_SLOT_001, SAFE_SLOT_002\n>>>>>>> REPLACE"
                    },
                }
            ],
        }
        restored = _restore_gemini_result(result, sanitizer)
        diff = restored["tool_calls"][0]["arguments"]["diff"]
        self.assertIn("erection", diff)
        self.assertIn("precum", diff)
        self.assertNotIn("SAFE_SLOT", diff)
        self.assertEqual(restored["sanitized_slots"], 2)

    def test_regex_teacher_mode_disables_qwen_preprocess(self):
        self.assertFalse(qwen_teacher_enabled({"teacher_mode": "regex"}))

    def test_gemini_chat_uses_teacher_preprocessor(self):
        payload = {"messages": [{"role": "user", "content": "nude SAFE_SLOT_001"}], "teacher_mode": "qwen-redact"}
        with patch(
            "lib_qwen3vl_prompt_tools.assistant_gemini.prepare_teacher_messages",
            return_value=([{"role": "user", "content": "teacher safe briefing SAFE_SLOT_001"}], {"teacher_mode": "local-qwen-redact", "teacher_model": "qwen"}),
        ) as prepare, patch(
            "lib_qwen3vl_prompt_tools.assistant_gemini._gemini_post_generate",
            return_value={"text": "ok", "tool_calls": []},
        ) as post:
            result = _prompt_assistant_chat_gemini(payload, "https://moyuu.cc", "gemini-3.1-pro-high", "test-key")

        prepare.assert_called_once()
        body = post.call_args.args[3]
        self.assertEqual(body["contents"][0]["parts"][0]["text"], "teacher safe briefing SAFE_SLOT_001")
        self.assertEqual(result["teacher_mode"], "local-qwen-redact")
        self.assertEqual(result["teacher_model"], "qwen")

    def test_gemini_body_can_disable_tools_for_teacher(self):
        body, _tokens = _gemini_request_body({"disable_tools": True}, [{"role": "user", "content": "teacher only"}])
        self.assertNotIn("tools", body)
        self.assertNotIn("toolConfig", body)
        self.assertIn("Tools are disabled", body["systemInstruction"]["parts"][0]["text"])
        self.assertEqual({"thinkingLevel": "LOW"}, body["generationConfig"]["thinkingConfig"])

    def test_gemini_reasoning_effort_maps_to_native_thinking_level(self):
        high, _tokens = _gemini_request_body({"reasoning_effort": "high"}, [{"role": "user", "content": "hello"}])
        maximum, _tokens = _gemini_request_body({"reasoning_effort": "max"}, [{"role": "user", "content": "hello"}])
        self.assertEqual({"thinkingLevel": "HIGH"}, high["generationConfig"]["thinkingConfig"])
        self.assertEqual({"thinkingLevel": "HIGH"}, maximum["generationConfig"]["thinkingConfig"])

    def test_openai_messages_preserve_native_image_attachment(self):
        messages = _assistant_request_messages(
            [{"role": "user", "content": "describe this", "image": "data:image/png;base64,AAAA"}]
        )
        self.assertEqual("text", messages[1]["content"][0]["type"])
        self.assertEqual("image_url", messages[1]["content"][1]["type"])
        self.assertEqual("data:image/png;base64,AAAA", messages[1]["content"][1]["image_url"]["url"])

    def test_openai_body_can_disable_tools_for_convergence(self):
        response = Mock(status_code=200)
        response.json.return_value = {"choices": [{"message": {"content": "hello"}}]}
        with patch("lib_qwen3vl_prompt_tools.assistant.requests.post", return_value=response) as post:
            result = _prompt_assistant_chat_once(
                {
                    "backend": "openai",
                    "endpoint": "https://example.com/v1",
                    "model": "test-model",
                    "messages": [{"role": "user", "content": "hello"}],
                    "disable_tools": True,
                }
            )

        body = post.call_args.kwargs["json"]
        self.assertNotIn("tools", body)
        self.assertNotIn("tool_choice", body)
        self.assertIn("Tools are disabled", body["messages"][0]["content"])
        self.assertEqual("hello", result["text"])

    def test_openai_backend_can_force_moyuu_compatible_route(self):
        self.assertFalse(_assistant_use_gemini_native("openai", "https://moyuu.cc", "grok-4.5"))
        self.assertTrue(_assistant_use_gemini_native("moyuu", "https://moyuu.cc", "gemini-3.5-flash-high"))

    def test_default_remote_route_uses_moyuu_gemini_with_grok_fallback(self):
        self.assertEqual("moyuu", DEFAULT_ASSISTANT_BACKEND)
        self.assertEqual("gemini-3.5-flash-preview", DEFAULT_ASSISTANT_MODEL)
        self.assertEqual("openai", DEFAULT_ASSISTANT_FALLBACK_BACKEND)
        self.assertEqual("grok-4.5", DEFAULT_ASSISTANT_FALLBACK_MODEL)

    def test_chat_falls_back_to_grok_on_same_moyuu_endpoint(self):
        payload = {
            "backend": "moyuu",
            "endpoint": "https://moyuu.cc",
            "model": "gemini-3.5-flash-preview",
            "api_key": "same-moyuu-key",
            "messages": [{"role": "user", "content": "hello"}],
        }
        with patch(
            "lib_qwen3vl_prompt_tools.assistant._prompt_assistant_chat_once",
            side_effect=[RuntimeError("gemini unavailable"), {"text": "fallback ok", "tool_calls": [], "model": "grok-4.5", "endpoint": "https://moyuu.cc"}],
        ) as chat:
            result = prompt_assistant_chat(payload)

        fallback_payload = chat.call_args_list[1].args[0]
        self.assertEqual("openai", fallback_payload["backend"])
        self.assertEqual("grok-4.5", fallback_payload["model"])
        self.assertEqual("https://moyuu.cc", fallback_payload["endpoint"])
        self.assertEqual("same-moyuu-key", fallback_payload["api_key"])
        self.assertTrue(result["fallback_used"])

    def test_stream_announces_fallback_before_grok_result(self):
        primary = iter([json.dumps({"type": "error", "error": "gemini unavailable"}) + "\n"])
        fallback = iter([json.dumps({"type": "done", "text": "fallback ok", "tool_calls": [], "model": "grok-4.5"}) + "\n"])
        with patch("lib_qwen3vl_prompt_tools.assistant._prompt_assistant_stream_once", side_effect=[primary, fallback]):
            events = [json.loads(item) for item in prompt_assistant_stream({"backend": "moyuu", "model": "gemini-3.5-flash-preview"})]

        self.assertEqual(["fallback", "done"], [event["type"] for event in events])
        self.assertEqual("grok-4.5", events[0]["model"])

    def test_ask_teacher_uses_gemini_without_tools(self):
        with patch(
            "lib_qwen3vl_prompt_tools.assistant._prompt_assistant_chat_gemini",
            return_value={"text": "teacher advice", "model": "gemini-3.1-pro-high", "endpoint": "https://moyuu.cc", "teacher_mode": "regex"},
        ) as chat:
            result = ask_teacher({"question": "How should I improve this?", "context": "SAFE_SLOT_001 composition", "api_key": "test-key"})

        teacher_payload = chat.call_args.args[0]
        self.assertTrue(teacher_payload["disable_tools"])
        self.assertEqual(teacher_payload["teacher_mode"], "regex")
        self.assertIn("SAFE_SLOT_001", teacher_payload["messages"][0]["content"])
        self.assertEqual(result["text"], "teacher advice")


if __name__ == "__main__":
    unittest.main()
