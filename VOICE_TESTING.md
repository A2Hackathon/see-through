# Voice-control device test

Voice control is push-to-talk and runs in Expo Go.

## Setup

1. Start `assistant_service` on port 8003 with `XAI_API_KEY` set.
2. Confirm `ASSISTANT_SERVER_URL` uses the laptop's reachable LAN address.
3. Open the project in Expo Go on the phone.
4. Grant microphone, notification, and location permissions.

## Required end-to-end checks

- Tap microphone, say “Which profiles are saved?”, tap again, and verify only
  profile names and relationships are spoken.
- Say “Delete [profile].” Verify the profile remains until a separate recording
  contains exactly a clear confirmation. Verify “no” cancels.
- Say “Save this place as Home.” Verify the assistant reads the mapped location,
  requests confirmation, and saves only after “yes.”
- Say “Add Library at [address].” If several map results exist, reject the first
  and verify the next result is offered.
- Say “List my safe spaces,” “Where am I?”, and “Remove Home.” Verify stale or
  inaccurate GPS is disclosed and removal requires confirmation.
- Say “Turn live GPS off.” Verify confirmation is required. Turn it back on and
  verify denied location permission is announced.
- Say “What was the latest scene?”, “Repeat the last alert,” “Stop talking,” and
  “Describe this screen.”
- Disconnect Wi-Fi and verify the assistant announces the failure without
  deleting local data or repeating an action when connectivity returns.
- Start a glasses or GPS announcement during an assistant reply. Verify the
  assistant reply has priority and queued safety audio follows without overlap.
- With TalkBack or VoiceOver enabled, verify the microphone, quick actions,
  profile actions, place controls, and confirmation dialogs have useful
  labels and roles.

## Privacy check

Run `rg "XAI_API_KEY|xai-" .` before release. Only the backend environment
variable name, test placeholder, and documentation should match; no real key
may appear in the repository or mobile bundle.
