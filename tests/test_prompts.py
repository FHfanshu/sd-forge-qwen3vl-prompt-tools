import unittest

from PIL import Image

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


if __name__ == "__main__":
    unittest.main()
