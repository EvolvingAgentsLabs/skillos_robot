/**
 * Quick diagnostic: grab one camera frame and test both describe + motor prompts.
 * Shows what the model "sees" vs what motor command it produces.
 *
 * Usage: npx tsx scripts/test_describe_scene.ts
 * Requires: GOOGLE_API_KEY env, bridge running (npm run sim:3d), browser open
 */

import * as http from 'http';
import * as dotenv from 'dotenv';
dotenv.config();

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
if (!GOOGLE_API_KEY) { console.error('Need GOOGLE_API_KEY'); process.exit(1); }

// Grab one JPEG frame from MJPEG stream
function grabFrame(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get('http://127.0.0.1:8081/stream', (res) => {
      let buf = Buffer.alloc(0);
      let foundStart = false;
      res.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const startIdx = buf.indexOf(Buffer.from([0xff, 0xd8]));
        if (startIdx >= 0) foundStart = true;
        if (foundStart) {
          const endIdx = buf.indexOf(Buffer.from([0xff, 0xd9]), startIdx + 2);
          if (endIdx >= 0) {
            const jpeg = buf.slice(startIdx, endIdx + 2);
            res.destroy();
            resolve(jpeg.toString('base64'));
          }
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    setTimeout(() => { req.destroy(); reject(new Error('timeout')); }, 5000);
  });
}

// Call Gemini with image
async function callGemini(systemPrompt: string, userMsg: string, image: string): Promise<string> {
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType: 'image/jpeg', data: image } },
      { text: userMsg },
    ]}],
    generationConfig: { maxOutputTokens: 1024, temperature: 0.1 },
  };

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${GOOGLE_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  const data = await resp.json() as any;
  const parts = data.candidates?.[0]?.content?.parts;
  if (parts) {
    const fc = parts.find((p: any) => p.functionCall);
    if (fc) return `FUNCTION_CALL: ${JSON.stringify(fc.functionCall)}`;
    const text = parts.find((p: any) => p.text);
    if (text) return text.text;
  }
  return `RAW: ${JSON.stringify(data, null, 2)}`;
}

async function main() {
  console.log('Grabbing camera frame from MJPEG stream...');
  const frame = await grabFrame();
  console.log(`Got frame: ${(frame.length * 3 / 4 / 1024).toFixed(1)} KB\n`);

  // Test 1: Describe what the model sees (no tools, just text)
  console.log('='.repeat(60));
  console.log('TEST 1: DESCRIBE SCENE (text output, no tools)');
  console.log('='.repeat(60));
  const description = await callGemini(
    'You are a robot scene analyst. Describe exactly what you see in this camera frame. ' +
    'Be specific about: all visible objects (color, shape, size, estimated distance), ' +
    'spatial layout (left, right, center, near, far), obstacles, walls, open paths, floor texture. ' +
    'Report distances in centimeters. Output ONLY the scene description as plain text.',
    'Describe this scene in detail for a text-based robot navigation system.',
    frame,
  );
  console.log(description);

  // Test 2: Motor command (same prompt as VisionLoop uses)
  console.log('\n' + '='.repeat(60));
  console.log('TEST 2: MOTOR COMMAND (tool calling)');
  console.log('='.repeat(60));
  const motorSystemPrompt = `You are a robot motor controller. GOAL: navigate to the red cube

ACTIONS:
- move_forward(speed_l, speed_r) — Speed 0-255. Equal = straight.
- move_backward(speed_l, speed_r)
- turn_left(speed_l, speed_r) — speed_l < speed_r
- turn_right(speed_l, speed_r) — speed_l > speed_r
- rotate_cw(degrees, speed) — Clockwise 0-180deg
- rotate_ccw(degrees, speed) — Counter-clockwise 0-180deg
- stop() — ONLY when target < 20cm

Output format: TOOLCALL:{"name":"<action>","args":{...}}
Output ONLY the TOOLCALL line. No explanation.`;

  const motor = await callGemini(
    motorSystemPrompt,
    'What do you see? Call the appropriate motor control function for the goal: navigate to the red cube',
    frame,
  );
  console.log(motor);

  // Test 3: Motor command with the description as context
  console.log('\n' + '='.repeat(60));
  console.log('TEST 3: MOTOR COMMAND WITH SCENE CONTEXT');
  console.log('='.repeat(60));
  const motorWithContext = await callGemini(
    motorSystemPrompt,
    `Scene analysis: ${description}\n\nBased on this scene, call the appropriate motor control function to navigate to the red cube.`,
    frame,
  );
  console.log(motorWithContext);

  console.log('\n' + '='.repeat(60));
  console.log('GAP ANALYSIS');
  console.log('='.repeat(60));
  console.log(`Scene description length: ${description.length} chars`);
  console.log(`Motor command (image only): ${motor.slice(0, 100)}`);
  console.log(`Motor command (image + text): ${motorWithContext.slice(0, 100)}`);
}

main().catch(console.error);
