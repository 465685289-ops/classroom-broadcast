# Tencent Cloud TTS Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the classroom screen's Baidu demo voice with Tencent Cloud standard TTS using the purchased premium voice package.

**Architecture:** Keep credentials and Tencent SDK calls on the Express server. Install a dedicated `tts-routes.js` route domain, call a small `tencent-tts.js` adapter, return MP3 bytes to the classroom screen, and fall back to the browser's local speech engine on errors.

**Tech Stack:** Node.js, Express, Tencent Cloud product-specific Node.js TTS SDK, Node test runner, browser Web Audio API.

---

### Task 1: Lock the TTS contracts with failing tests

**Files:**
- Create: `tests/tencent-tts.test.js`
- Modify: `tests/classroom-screen.test.js`

**Steps:**
1. Add a client test that supplies a fake SDK client and asserts the literal Tencent request contract: text, UUID session, MP3 codec, 16 kHz sample rate and default VoiceType `101001`.
2. Add success and malformed-response cases that assert Base64 decoding and safe errors.
3. Add route integration cases for unauthenticated access, invalid text, missing credentials, one upstream call for repeated identical text, and `audio/mpeg` success.
4. Add a classroom-screen behavior test proving the page calls `/api/tts`, contains no Baidu TTS URL, falls back to browser speech and never boosts Web Audio gain above `1.0`.
5. Run focused tests and observe the expected failures before implementation.

### Task 2: Add configuration and the official product SDK

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `platform-config.js`
- Modify: `.env.example`

**Steps:**
1. Install `tencentcloud-sdk-nodejs-tts` rather than the full Tencent Cloud SDK.
2. Add secret ID, secret key, region and voice type configuration with safe defaults.
3. Export the configuration from `platform-config.js` and document placeholders in `.env.example` without real credentials.
4. Run configuration/client tests.

### Task 3: Implement the Tencent TTS adapter

**Files:**
- Create: `tencent-tts.js`
- Test: `tests/tencent-tts.test.js`

**Steps:**
1. Build the official SDK client only when credentials are present.
2. Normalize and validate text to Tencent basic synthesis limits.
3. Call `TextToVoice` with MP3, 16 kHz, normal speed/volume and the configured premium voice.
4. Decode returned Base64 into a Buffer and reject empty or malformed audio with a public-safe error code.
5. Run focused tests to green, then refactor without changing behavior.

### Task 4: Move `/api/tts` into its own route domain

**Files:**
- Create: `tts-routes.js`
- Modify: `server.js`
- Test: `tests/tencent-tts.test.js`

**Steps:**
1. Implement `installTtsRoutes(app)` following the repository installer pattern.
2. Keep current teacher-token or valid classroom-bind-code authorization and the 20/minute IP limit.
3. Add a bounded 200-entry LRU cache keyed by voice and text.
4. Return MP3 with private cache headers; map missing configuration and provider errors to safe `503`/`502` responses.
5. Remove the legacy Baidu proxy from `server.js` and install the new route beside the other route modules.
6. Run route tests to green.

### Task 5: Make Tencent the classroom screen's primary voice

**Files:**
- Modify: `public/screen.html`
- Test: `tests/classroom-screen.test.js`

**Steps:**
1. Remove direct browser requests to `tts.baidu.com`.
2. Call the server TTS route first and keep browser speech as the final fallback.
3. Reuse the decoded audio buffer for repeated playback.
4. Reduce Web Audio gain from the clipping value `3.0` to `1.0`.
5. Run the classroom-screen tests and validate inline JavaScript syntax.

### Task 6: Verify and hand off

**Files:**
- Modify if needed: `README.md`

**Steps:**
1. Run `npm test` serially.
2. Review `git diff --check`, `git status`, and ensure no secret values are tracked.
3. Commit implementation using the repository's commit style.
4. Explain the Tencent CAM key setup and local/server environment variable steps in plain Chinese.
5. Mark the work as developed but not deployed until credentials and a live试听 are verified.
