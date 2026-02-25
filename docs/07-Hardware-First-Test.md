# Hardware First Test

The software stack is validated and ready for hardware integration (see [Test Analysis Report](06-Test-Analysis-Report.md)). This tutorial walks through the first real-hardware test using a **tethered, wheels-in-the-air** approach that isolates the hardware from the OpenClaw cloud infrastructure and ensures the robot doesn't drive off a table if a bug occurs.

## Prerequisites

Before starting, make sure you have:

- **Flashed ESP32-S3** running `4_somatic_firmware/esp32_s3_spinal_cord/esp32_s3_spinal_cord.ino`
- **Camera source** — ESP32-CAM or Android phone (see [Camera Setup](05-Camera-Setup.md))
- **Wi-Fi network** — Host computer, ESP32-S3, and camera all on the same network
- **`.env` configured** — Copy `.env.example` to `.env` and fill in your IPs:

```env
ESP32_S3_HOST=192.168.1.100   # Your ESP32-S3's IP
ESP32_S3_PORT=4210             # UDP port (matches firmware UDP_PORT)
ESP32_CAM_HOST=192.168.1.101   # Camera IP
ESP32_CAM_PORT=80
ESP32_CAM_PATH=/stream         # /video for IP Webcam, /mjpegfeed for DroidCam
OPENROUTER_API_KEY=sk-or-v1-...
QWEN_MODEL=qwen/qwen-2.5-vl-72b-instruct
```

- **VLM inference** — Either an OpenRouter API key or a local Ollama instance with `qwen3-vl:8b-instruct`

---

## Step 1: Bench Test Setup

1. **Elevate the chassis.** Place the robot on top of a box, a stack of books, or a 3D-printer spool so the wheels are suspended in the air.
2. **Tether the power.** Don't rely on batteries yet. Plug the ESP32-S3 directly into your computer via USB. This gives you power and lets you keep the Arduino Serial Monitor open to watch for errors.
3. **Verify IPs.** Confirm your host computer, the ESP32-S3, and the camera are all on the same Wi-Fi network. Update `.env` with the correct IPs.

Open the Arduino Serial Monitor (115200 baud) — you should see the ESP32-S3 print its IP address and `UDP listening on port 4210`.

---

## Step 2: Raw UDP Motor Test

Before spinning up the VLM or camera, verify that the ESP32-S3 receives bytecode and turns the steppers. This sends a single `FORWARD` frame directly over UDP.

Open your terminal and run (replace `192.168.1.100` with your ESP32-S3's IP):

```bash
node -e "
const dgram = require('dgram');
const client = dgram.createSocket('udp4');
// FORWARD frame: AA 01 64 64 01 FF
// Opcode 0x01 = MOVE_FORWARD, params 0x64 0x64 (100, 100)
// Checksum: 0x01 XOR 0x64 XOR 0x64 = 0x01
const frame = Buffer.from([0xAA, 0x01, 0x64, 0x64, 0x01, 0xFF]);
client.send(frame, 4210, '192.168.1.100', (err) => {
  if (err) console.error(err); else console.log('Sent FORWARD bytecode!');
  client.close();
});
"
```

**What should happen:** Both wheels should rotate forward (about 100 steps each), then stop.

**If nothing happens**, check the Arduino Serial Monitor for errors. Common causes:

- **IP filtering** — The firmware's `CORTEX_IP` variable (`esp32_s3_spinal_cord.ino:35`) defaults to `"0.0.0.0"` which accepts commands from any source. If you changed this to a specific IP, make sure it matches your host computer.
- **Wrong port** — The firmware listens on `UDP_PORT = 4210` (line 31). Make sure your `.env` has `ESP32_S3_PORT=4210`.
- **Wi-Fi not connected** — The Serial Monitor should show the ESP32's IP address on boot. If it shows connection failures, double-check `WIFI_SSID` and `WIFI_PASSWORD` in the firmware.

See [Bytecode Compiler & ISA](03-Bytecode-Compiler-ISA.md) for the full frame format and opcode reference.

---

## Step 3: Full Loop Test

Once the motors respond to raw UDP, test the **Camera → VLM → Bytecode → Motor** pipeline using the standalone script. This bypasses OpenClaw Gateway entirely — it calls the RoClaw tools directly.

```bash
npx tsx scripts/standalone-test.ts
```

The script (`scripts/standalone-test.ts`) runs 6 tools in sequence:

| # | Tool | What to observe |
|---|------|-----------------|
| 1 | `robot.status` | ESP32-S3 responds with its pose (`x: 0, y: 0, heading: 0`) |
| 2 | `robot.read_memory` | Loads the robot's identity and skills from disk |
| 3 | `robot.describe_scene` | Pulls a real MJPEG frame from the camera, sends it to the VLM, and prints a scene description. Wave your hand in front of the camera to verify it sees you. |
| 4 | `robot.explore` | The VLM takes over — watch the terminal. It should compile bytecode, send it via UDP, and the suspended wheels will spin in bursts as it "explores" the scene. |
| 5 | `robot.stop` | Wheels should immediately halt. |
| 6 | `robot.go_to` | Navigates to "the kitchen" — similar to explore but goal-directed. |

At the end, the script prints inference stats (total calls, latency, token usage).

**If the VLM times out**, your inference endpoint may be slow. Set `LOCAL_INFERENCE_URL` in `.env` if running Ollama locally, or try a smaller model (`QWEN_MODEL=qwen3-vl:2b`).

---

## Step 4: Floor Drop

Once the wheels behave correctly in the air:

1. **Unplug USB** — Switch to battery power.
2. **Place on the floor** — Set the robot on a smooth, flat surface.
3. **Run the standalone test again:**

```bash
npx tsx scripts/standalone-test.ts
```

### Calibration

**Motor skipping steps** — If the 28BYJ-48 motors struggle with the robot's weight and skip steps, lower the speed or acceleration:

- **Firmware** (`esp32_s3_spinal_cord.ino:63-64`):
  ```cpp
  #define MAX_SPEED_STEPS_S  1024  // try 512
  #define DEFAULT_ACCEL      512   // try 256
  ```
- **TypeScript** (`src/shared/stepper-kinematics.ts:40-46`):
  ```typescript
  export const DEFAULT_28BYJ48_SPEC: StepperMotorSpec = {
    maxStepsPerSecond: 1024,  // match firmware value
    maxAcceleration: 512,     // match firmware value
    // ...
  };
  ```

**Rotation is inaccurate** — If the VLM commands a 90-degree turn but the robot only turns 70 degrees, the wheel geometry constants need calibration. Measure your actual wheel diameter and wheel base (center-to-center distance between wheels), then update both locations:

- **Firmware** (`esp32_s3_spinal_cord.ino:61-62`):
  ```cpp
  #define WHEEL_DIAMETER_CM  6.0f   // measure your actual wheel
  #define WHEEL_BASE_CM      10.0f  // measure center-to-center
  ```
- **TypeScript** (`src/shared/stepper-kinematics.ts:40-46`):
  ```typescript
  export const DEFAULT_28BYJ48_SPEC: StepperMotorSpec = {
    wheelDiameterCm: 6.0,   // match firmware value
    wheelBaseCm: 10.0,      // match firmware value
    // ...
  };
  ```

Keep both firmware and TypeScript values in sync — the firmware uses them for dead-reckoning pose updates, and the TypeScript kinematics uses them for trajectory planning.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Motors don't move at all | IP filtering or wrong port | Check `CORTEX_IP` in firmware (line 35), verify `ESP32_S3_PORT=4210` in `.env` |
| Motors skip steps under load | Speed/accel too high for weight | Lower `MAX_SPEED_STEPS_S` and `DEFAULT_ACCEL` in firmware |
| VLM inference timeout | Slow API or large model | Use `qwen3-vl:2b` or increase timeout; check network connectivity |
| Camera stream not connecting | Wrong IP/port/path | Open `http://<host>:<port><path>` in a browser to verify the stream works |
| Robot turns wrong amount | Wheel geometry mismatch | Measure and update `WHEEL_DIAMETER_CM`/`WHEEL_BASE_CM` in both firmware and TypeScript |
| `robot.describe_scene` returns empty | Camera not streaming | See [Camera Setup](05-Camera-Setup.md) for stream verification |
| ESP32 emergency-stops after 2 seconds | No heartbeat received | The firmware's `HOST_TIMEOUT_MS` (2000ms) triggers if no command arrives. The standalone script sends commands continuously during explore/go_to — if it pauses too long between commands, the firmware will cut the motors. |
| Wheels spin opposite directions | Motor wiring swapped | Swap `IN1`/`IN3` or `IN2`/`IN4` pin pairs for the affected motor in the firmware pin definitions |
