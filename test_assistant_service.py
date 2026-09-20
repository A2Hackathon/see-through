import io
import os
import unittest
from unittest.mock import patch

import httpx
from fastapi import HTTPException, UploadFile

from server import assistant_service


class FakeAsyncClient:
    response = None
    last_request = None

    def __init__(self, **kwargs):
        self.options = kwargs

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return False

    async def post(self, url, **kwargs):
        FakeAsyncClient.last_request = {"url": url, **kwargs}
        return FakeAsyncClient.response


def response(status_code, payload):
    return httpx.Response(
        status_code,
        json=payload,
        request=httpx.Request("POST", "https://api.x.ai/test"),
    )


class AssistantServiceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        assistant_service._conversations.clear()
        FakeAsyncClient.last_request = None
        self.env = patch.dict(
            os.environ,
            {"XAI_API_KEY": "test-secret", "XAI_MODEL": "test-grok"},
            clear=False,
        )
        self.env.start()

    def tearDown(self):
        self.env.stop()

    async def test_transcribe_proxies_multipart_audio(self):
        FakeAsyncClient.response = response(200, {"text": "turn left"})
        upload = UploadFile(
            filename="command.wav",
            file=io.BytesIO(b"RIFFaudio"),
            headers={"content-type": "audio/wav"},
        )

        with patch.object(assistant_service.httpx, "AsyncClient", FakeAsyncClient):
            result = await assistant_service.transcribe(upload)

        self.assertEqual(result, {"text": "turn left"})
        request = FakeAsyncClient.last_request
        self.assertEqual(request["url"], assistant_service.XAI_STT_URL)
        self.assertEqual(request["headers"]["Authorization"], "Bearer test-secret")
        self.assertEqual(request["files"]["file"], ("command.wav", b"RIFFaudio", "audio/wav"))

    async def test_transcribe_rejects_oversized_audio_before_request(self):
        upload = UploadFile(
            filename="huge.wav",
            file=io.BytesIO(b"x" * (assistant_service.MAX_AUDIO_BYTES + 1)),
        )

        with self.assertRaises(HTTPException) as caught:
            await assistant_service.transcribe(upload)

        self.assertEqual(caught.exception.status_code, 413)
        self.assertIsNone(FakeAsyncClient.last_request)

    async def test_turn_parses_text_and_function_calls(self):
        FakeAsyncClient.response = response(
            200,
            {
                "id": "resp_1",
                "output": [
                    {
                        "type": "message",
                        "content": [{"type": "output_text", "text": "I found it."}],
                    },
                    {
                        "type": "function_call",
                        "call_id": "call_1",
                        "name": "get_profile",
                        "arguments": '{"name":"Mom"}',
                    },
                ],
            },
        )
        turn = assistant_service.AssistantTurn(
            conversation_id="conversation-1",
            input="Where is Mom?",
            app_context={"screen": "home"},
        )

        with patch.object(assistant_service.httpx, "AsyncClient", FakeAsyncClient):
            result = await assistant_service.assistant_turn(turn)

        self.assertEqual(result["reply"], "I found it.")
        self.assertEqual(result["tool_calls"][0]["name"], "get_profile")
        self.assertEqual(result["tool_calls"][0]["arguments"], {"name": "Mom"})
        sent = FakeAsyncClient.last_request["json"]
        self.assertEqual(sent["model"], "test-grok")
        self.assertNotIn("previous_response_id", sent)
        self.assertTrue(all(tool["strict"] for tool in sent["tools"]))
        self.assertTrue(
            all(
                tool["parameters"]["additionalProperties"] is False
                for tool in sent["tools"]
            )
        )

    async def test_followup_sends_previous_response_and_tool_output(self):
        assistant_service._conversations["conversation-1"] = (
            assistant_service.ConversationState(
                previous_response_id="resp_previous",
                expires_at=assistant_service.time.monotonic() + 100,
            )
        )
        FakeAsyncClient.response = response(200, {"id": "resp_2", "output_text": "Done."})
        turn = assistant_service.AssistantTurn(
            conversation_id="conversation-1",
            input="",
            tool_outputs=[
                assistant_service.ToolOutput(
                    call_id="call_1", output={"success": True}
                )
            ],
        )

        with patch.object(assistant_service.httpx, "AsyncClient", FakeAsyncClient):
            result = await assistant_service.assistant_turn(turn)

        sent = FakeAsyncClient.last_request["json"]
        self.assertEqual(sent["previous_response_id"], "resp_previous")
        self.assertEqual(sent["input"][0]["type"], "function_call_output")
        self.assertEqual(sent["input"][0]["call_id"], "call_1")
        self.assertEqual(result["reply"], "Done.")

    async def test_delete_call_returns_pending_confirmation_metadata(self):
        FakeAsyncClient.response = response(
            200,
            {
                "id": "resp_delete",
                "output": [
                    {
                        "type": "function_call",
                        "call_id": "delete_1",
                        "name": "remove_safe_space",
                        "arguments": '{"name":"Home"}',
                    }
                ],
            },
        )
        turn = assistant_service.AssistantTurn(
            conversation_id="conversation-delete", input="Delete home"
        )

        with patch.object(assistant_service.httpx, "AsyncClient", FakeAsyncClient):
            result = await assistant_service.assistant_turn(turn)

        self.assertEqual(
            result["pending_confirmation"]["tool"], "remove_safe_space"
        )
        self.assertTrue(result["pending_confirmation"]["required"])
        stored = assistant_service._conversations["conversation-delete"]
        self.assertEqual(stored.pending_confirmation["call_id"], "delete_1")

    async def test_rejects_unallowlisted_tool_from_upstream(self):
        FakeAsyncClient.response = response(
            200,
            {
                "id": "unsafe",
                "output": [
                    {
                        "type": "function_call",
                        "call_id": "unsafe_1",
                        "name": "run_arbitrary_code",
                        "arguments": "{}",
                    }
                ],
            },
        )
        with patch.object(assistant_service.httpx, "AsyncClient", FakeAsyncClient):
            with self.assertRaises(HTTPException) as caught:
                await assistant_service.assistant_turn(
                    assistant_service.AssistantTurn(
                        conversation_id="conversation-unsafe", input="Do something unsafe"
                    )
                )
        self.assertEqual(caught.exception.status_code, 502)

    async def test_rejects_wrong_tool_argument_shape(self):
        FakeAsyncClient.response = response(
            200,
            {
                "id": "bad-args",
                "output": [
                    {
                        "type": "function_call",
                        "call_id": "bad_1",
                        "name": "set_live_gps",
                        "arguments": '{"enabled":"yes"}',
                    }
                ],
            },
        )
        with patch.object(assistant_service.httpx, "AsyncClient", FakeAsyncClient):
            with self.assertRaises(HTTPException) as caught:
                await assistant_service.assistant_turn(
                    assistant_service.AssistantTurn(
                        conversation_id="conversation-bad-args", input="Turn GPS on"
                    )
                )
        self.assertEqual(caught.exception.status_code, 502)

    async def test_expired_conversation_does_not_send_previous_response(self):
        assistant_service._conversations["expired"] = (
            assistant_service.ConversationState(
                previous_response_id="old_response",
                expires_at=assistant_service.time.monotonic() - 1,
            )
        )
        FakeAsyncClient.response = response(200, {"id": "new", "output_text": "Hello"})

        with patch.object(assistant_service.httpx, "AsyncClient", FakeAsyncClient):
            await assistant_service.assistant_turn(
                assistant_service.AssistantTurn(
                    conversation_id="expired", input="Hello"
                )
            )

        self.assertNotIn(
            "previous_response_id", FakeAsyncClient.last_request["json"]
        )

    async def test_upstream_error_is_sanitized(self):
        FakeAsyncClient.response = response(
            401, {"error": "invalid API key test-secret"}
        )

        with patch.object(assistant_service.httpx, "AsyncClient", FakeAsyncClient):
            with self.assertRaises(HTTPException) as caught:
                await assistant_service.assistant_turn(
                    assistant_service.AssistantTurn(
                        conversation_id="conversation-1", input="Hello"
                    )
                )

        self.assertEqual(caught.exception.status_code, 502)
        self.assertNotIn("test-secret", str(caught.exception.detail))

    def test_health_reports_configuration_without_key(self):
        result = assistant_service.health()
        self.assertEqual(result, {"status": "ok", "xai_configured": True})
        self.assertNotIn("test-secret", str(result))


if __name__ == "__main__":
    unittest.main()
