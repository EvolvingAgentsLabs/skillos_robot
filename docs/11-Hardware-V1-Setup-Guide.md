# V1 Hardware Setup Guide — External Camera Architecture

Complete guide to assembling, wiring, flashing, calibrating, and testing RoClaw V1 with an Android phone as the external camera.

## System Overview

V1 separates **vision** (external Android camera on tripod) from **control** (ESP32-S3 driving stepper motors). The host PC runs the LLM brain, receives video from the phone, makes decisions, and sends 6-byte bytecodes to the ESP32-S3 via UDP.

```
[ Android Phone Camera (tripod, top-down) ]
        | (MJPEG over WiFi)
        v
[ Host PC — LLM Brain ]
        | (UDP bytecodes, port 4210)
        v
[ ESP32-S3-DevKitC-1 ]
        |
   [ ULN2003 x2 ]
        |
   [ 28BYJ-48 Stepper Motors x2 ]
        |
   [ Differential Drive Chassis ]
```

This is an **offboard perception** architecture — the same pattern used in professional robotics where a central server processes sensor data and commands actuators remotely.

---

## Bill of Materials (BOM)

| # | Component | Part | Quantity | Notes |
|---|-----------|------|----------|-------|
| 1 | Controller | ESP32-S3-DevKitC-1 | 1 | WiFi + BLE, dual-core, USB-C |
| 2 | Stepper Motors | 28BYJ-48 (5V) | 2 | 4096 steps/rev, 64:1 gear ratio |
| 3 | Motor Drivers | ULN2003 breakout board | 2 | Darlington array, LED indicators |
| 4 | Power Supply | 5V 3A USB adapter + MB102 breadboard PSU | 1 | Must deliver 3A sustained |
| 5 | Breadboard | Full-size (830 tie points) | 1 | For prototyping connections |
| 6 | Capacitor | 1000uF 10V electrolytic | 1 | Motor noise suppression (mandatory) |
| 7 | Jumper Wires | Male-to-male + male-to-female | ~20 | For breadboard connections |
| 8 | USB Cable | USB-C (for ESP32-S3) | 1 | Programming + serial monitor |
| 9 | Camera | Android phone + tripod | 1 | IP Webcam app (free) |
| 10 | Chassis | 3D-printed or 20cm cube frame | 1 | < 200g total weight |
| 11 | Wheels | 6cm diameter, press-fit to motor shaft | 2 | Match 28BYJ-48 D-shaft |
| 12 | Caster | Small ball caster or furniture slider | 1 | Rear balance point |

**Optional:**
- Rubber bands or O-rings for wheel traction
- Hot glue gun for chassis assembly
- Battery pack (4x AA = 6V, use with regulator) for untethered operation

---

## Electrical Wiring

### Power Architecture

All components share a single 5V rail. The MB102 breadboard power supply converts your wall adapter to clean 5V on both breadboard rails.

```
5V 3A Wall Adapter
    |
[ MB102 Breadboard PSU ] (both jumpers set to 5V)
    |
Breadboard + Rail ──────────── Breadboard - Rail (GND)
    |         |         |
  ESP32-S3  ULN2003#1  ULN2003#2
  (VIN/5V)  (VCC)      (VCC)
```

### Mandatory Capacitor

Solder or plug a **1000uF electrolytic capacitor** across the power rails. Observe polarity — the long leg (+) goes to the + rail, the striped side (-) goes to GND.

```
+ Rail ─── (+) 1000uF 10V (─) ─── GND Rail
```

This prevents:
- ESP32 brownout resets when motors start
- Voltage spikes from motor back-EMF
- Random WiFi disconnections under load

### Step-by-Step Wiring

#### Step 1 — Power Supply

1. Insert the MB102 onto the breadboard power rails.
2. Set **both** jumpers to `5V` (not 3.3V).
3. Connect your 5V wall adapter to the MB102 barrel jack.
4. Verify with a multimeter: + rail = 5V, - rail = GND.

#### Step 2 — ESP32-S3

```
ESP32-S3 Pin    Breadboard
──────────────  ──────────
5V (VIN)    →   + Rail (5V)
GND         →   - Rail (GND)
```

> The ESP32-S3 can be powered via USB-C during development. For standalone operation, power through VIN.

#### Step 3 — ULN2003 Motor Drivers

For **both** ULN2003 boards:

```
ULN2003 Pin     Breadboard
──────────────  ──────────
VCC         →   + Rail (5V)
GND         →   - Rail (GND)
```

#### Step 4 — Left Motor (ULN2003 #1)

| ESP32-S3 GPIO | ULN2003 #1 Input | Wire Color (suggested) |
|---------------|------------------|----------------------|
| GPIO 4 | IN1 | Orange |
| GPIO 5 | IN2 | Yellow |
| GPIO 6 | IN3 | Green |
| GPIO 7 | IN4 | Blue |

#### Step 5 — Right Motor (ULN2003 #2)

| ESP32-S3 GPIO | ULN2003 #2 Input | Wire Color (suggested) |
|---------------|------------------|----------------------|
| GPIO 15 | IN1 | Orange |
| GPIO 16 | IN2 | Yellow |
| GPIO 17 | IN3 | Green |
| GPIO 18 | IN4 | Blue |

#### Step 6 — Motors

Plug each 28BYJ-48 motor connector into its ULN2003 board. The connector is keyed — it only fits one way. No polarity concerns.

#### Step 7 — Ground Verification

**Critical:** All grounds must be connected. Verify continuity between:

```
ESP32-S3 GND ↔ ULN2003 #1 GND ↔ ULN2003 #2 GND ↔ Power Supply GND
```

A missing ground connection is the #1 cause of "nothing works" issues.

### Wiring Diagram (ASCII)

```
                    ┌──────────────────────────────┐
                    │      MB102 PSU (5V 3A)       │
                    └───────┬────────────┬─────────┘
                         +5V│            │GND
                    ┌───────┴────────────┴─────────┐
                    │        Breadboard Rails       │
                    └──┬──────┬──────┬──────┬──────┘
                       │      │      │      │
                  ┌────┴──┐ ┌─┴───┐ ┌┴────┐ │
                  │ESP32  │ │ULN  │ │ULN  │ │
                  │  S3   │ │2003 │ │2003 │ 1000uF
                  │       │ │ #1  │ │ #2  │ Cap
                  └──┬──┬─┘ └─┬───┘ └┬────┘
                     │  │     │      │
                GPIO │  │GPIO │      │
                4-7  │  │15-18│      │
                     │  │     │      │
                     │  │  ┌──┴──┐ ┌─┴───┐
                     │  │  │Motor│ │Motor│
                     │  │  │Left │ │Right│
                     │  │  └─────┘ └─────┘
                     │  │
                   USB-C (programming)
```

---

## ESP32-S3 Firmware

### Prerequisites

1. Install [Arduino IDE 2.x](https://www.arduino.cc/en/software) or [PlatformIO](https://platformio.org/).
2. Add the ESP32 board package:
   - Arduino IDE: **File > Preferences > Additional Board URLs** → add `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
   - Install **esp32** by Espressif Systems from Board Manager.
3. Install the **AccelStepper** library:
   - Arduino IDE: **Tools > Manage Libraries** → search "AccelStepper" → Install.

### Configure WiFi

Edit `4_somatic_firmware/esp32_s3_spinal_cord/esp32_s3_spinal_cord.ino`:

```cpp
const char* WIFI_SSID = "YOUR_WIFI_SSID";       // ← Your WiFi network name
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD"; // ← Your WiFi password
```

For extra security, set the host IP filter so only your PC can send commands:

```cpp
const char* CORTEX_IP = "192.168.1.42";  // ← Your host PC's local IP
```

Leave as `"0.0.0.0"` to accept commands from any device on the network.

### Flash the Firmware

1. Connect ESP32-S3 via USB-C.
2. Select board: **ESP32S3 Dev Module**.
3. Select port: the USB serial port that appeared.
4. Set **USB CDC On Boot: Enabled** (for Serial Monitor output).
5. Click **Upload**.

After flashing, open **Serial Monitor** at 115200 baud. You should see:

```
[RoClaw] Spinal Cord — Bytecode Motor Controller V1
[RoClaw] Connecting to WiFi....
[RoClaw] Connected! IP: 192.168.1.100
[RoClaw] Bytecode UDP listening on port 4210
```

**Note the IP address** — you need it for the `.env` file.

### Troubleshooting Firmware

| Issue | Solution |
|-------|----------|
| "WiFi connection failed!" | Check SSID/password. Move closer to router. |
| No serial output | Enable "USB CDC On Boot" in Arduino IDE board settings. |
| Upload fails | Hold BOOT button while pressing RST, then release BOOT. |
| Motors don't move | Check ULN2003 LED indicators — they should blink during commands. |

---

## External Camera Setup (Android Phone)

### Why External Camera?

V1 uses a phone on a tripod looking down at the arena instead of a camera on the robot. This gives:

- **Full arena visibility** — see the robot + all obstacles + target
- **Higher resolution** — phone cameras far exceed ESP32-CAM quality
- **Better ML inference** — VLM sees the complete scene, not just forward view
- **Easier debugging** — you can see exactly what the AI sees
- **No bandwidth limits** — phone WiFi is much faster than ESP32

### Physical Setup

```
        📱 Phone on tripod (60-90cm high)
        ↓  (angled ~60° from vertical, or straight down)
   ┌──────────────┐
   │              │
   │    Arena     │
   │              │
   │   🤖 Robot   │
   │              │
   │   🟥 Target  │
   │              │
   └──────────────┘
```

**Recommended arena:** 60x60 cm to 100x100 cm tabletop or floor area.

**Tripod position:**
- Height: 60-90 cm above the arena
- Angle: Top-down (bird's eye) or slight perspective (~60° from horizontal)
- Ensure the entire arena is visible with the robot at any position

### Install IP Webcam

1. Install **[IP Webcam](https://play.google.com/store/apps/details?id=com.pas.webcam)** from the Google Play Store (free).
2. Open the app.
3. Configure video settings:
   - **Video preferences > Resolution:** 640x480 (good balance of quality and bandwidth)
   - **Video preferences > Quality:** 50 (reduce bandwidth, VLM doesn't need high quality)
   - **Video preferences > FPS:** 10 (higher than the 2 FPS vision loop needs)
4. Optionally enable **Data logging** (for compass/accelerometer sensor data).
5. Tap **Start server** at the bottom.
6. Note the IP and port shown: e.g., `http://192.168.1.50:8080`

### Verify the Stream

Open in your browser:

```
http://192.168.1.50:8080/video
```

You should see a live MJPEG video stream. If it loads, the camera is working.

### Optional: Verify Sensors

If you enabled Data logging:

```bash
curl http://192.168.1.50:8080/sensors.json | python3 -m json.tool
```

The `orientation` field gives `[azimuth, pitch, roll]` — azimuth is compass heading.

### Configure RoClaw

Add to your `.env` file:

```env
# External Camera (Android phone on tripod)
ESP32_CAM_HOST=192.168.1.50
ESP32_CAM_PORT=8080
ESP32_CAM_PATH=/video
EXTERNAL_CAMERA_MODE=overhead

# Optional: compass from phone sensors
IP_WEBCAM_HOST=192.168.1.50
IP_WEBCAM_PORT=8080
```

---

## Host PC Configuration

### Prerequisites

```bash
cd RoClaw
npm install
```

### Environment File

Create `.env` from the template:

```bash
cp .env.example .env
```

Edit `.env` with your actual values:

```env
# ESP32-S3 (motor controller)
ESP32_S3_HOST=192.168.1.100    # ← IP from Serial Monitor
ESP32_S3_PORT=4210

# Android Camera (phone on tripod)
ESP32_CAM_HOST=192.168.1.50    # ← IP from IP Webcam app
ESP32_CAM_PORT=8080
ESP32_CAM_PATH=/video
EXTERNAL_CAMERA_MODE=overhead

# Inference (choose one)
GOOGLE_API_KEY=AIza...         # Gemini Robotics
# or
OPENROUTER_API_KEY=sk-or-v1-... # OpenRouter + Qwen-VL
```

### Network Checklist

All three devices must be on the **same WiFi network**:

```
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│   Host PC   │   │  ESP32-S3   │   │   Android   │
│ 192.168.1.42│   │192.168.1.100│   │192.168.1.50 │
└──────┬──────┘   └──────┬──────┘   └──────┬──────┘
       │                 │                  │
       └─────────────────┴──────────────────┘
                  Same WiFi Network
```

Verify connectivity:

```bash
# From host PC:
ping 192.168.1.100    # ESP32-S3 — should respond
ping 192.168.1.50     # Android phone — should respond
curl http://192.168.1.50:8080/video -o /dev/null -w "%{http_code}"  # Should print 200
```

---

## Testing Procedure

### Test 0 — Connectivity

Verify all devices can communicate:

```bash
npm run hardware:test -- --test connectivity
```

Or manually:

```bash
# Test ESP32-S3 (send GET_STATUS bytecode, expect JSON response)
echo -ne '\xAA\x08\x00\x00\x08\xFF' | nc -u -w1 192.168.1.100 4210

# Test camera stream
curl -s -o /dev/null -w "%{http_code}" http://192.168.1.50:8080/video
```

### Test 1 — Single Motor (Left Only)

```bash
npm run hardware:test -- --test single-motor
```

Sends: `AA 01 80 00 81 FF` (MOVE_FORWARD, left=128, right=0)

**Expected:** Only the left wheel spins forward for ~2 seconds.

**If wrong wheel spins:** Swap the motor connectors on the ULN2003 boards.

### Test 2 — Both Motors Forward

```bash
npm run hardware:test -- --test forward
```

Sends: `AA 01 80 80 01 FF` (MOVE_FORWARD, left=128, right=128)

**Expected:** Robot drives forward ~5cm in a straight line.

**If it curves:** The motors have slightly different characteristics. This is normal — calibration will fix it.

### Test 3 — Rotation

```bash
npm run hardware:test -- --test rotate
```

Sends: `AA 05 5A 80 DB FF` (ROTATE_CW, 90 degrees, speed=128)

**Expected:** Robot rotates ~90 degrees clockwise in place.

### Test 4 — Status Query

```bash
npm run hardware:test -- --test status
```

Sends GET_STATUS (`AA 08 00 00 08 FF`) and prints the JSON response:

```json
{
  "pose": { "x": 0.00, "y": 0.00, "h": 0.0000 },
  "steps": { "l": 0, "r": 0 },
  "run": false,
  "estop": false,
  "rssi": -45
}
```

### Test 5 — Full Loop (Camera + Motor)

```bash
npm run hardware:test -- --test full-loop
```

This:
1. Captures one frame from the Android camera
2. Displays the frame info (resolution, size)
3. Sends a MOVE_FORWARD command
4. Captures another frame
5. Queries status to confirm pose changed

---

## Calibration

### Initial Parameters

The default parameters match the BOM spec:

```
Wheel diameter: 6.0 cm
Wheel base: 10.0 cm
Steps per revolution: 4096
```

These are already set in the firmware. If your wheels are different sizes, update the firmware constants.

### Forward Distance Calibration

1. Mark a starting position on the floor.
2. Mark a point 50cm away.
3. Run the forward calibration test:

```bash
npm run hardware:test -- --test calibrate-forward
```

4. Measure the actual distance traveled.
5. Adjust `WHEEL_DIAMETER_CM` in the firmware:

```
actual_diameter = nominal_diameter * (measured_distance / commanded_distance)
```

Example: If the robot only traveled 47cm instead of 50cm:

```
actual_diameter = 6.0 * (47 / 50) = 5.64 cm
```

### Rotation Calibration

1. Mark the robot's heading direction.
2. Command a 360-degree rotation:

```bash
npm run hardware:test -- --test calibrate-rotation
```

3. Measure the actual rotation angle.
4. Adjust `WHEEL_BASE_CM` in the firmware:

```
actual_base = nominal_base * (measured_angle / 360)
```

Example: If the robot only rotated 340 degrees:

```
actual_base = 10.0 * (340 / 360) = 9.44 cm
```

### Apply Calibration

After determining the correct values, update the firmware:

```cpp
#define WHEEL_DIAMETER_CM  5.64f   // Calibrated (was 6.0)
#define WHEEL_BASE_CM      9.44f   // Calibrated (was 10.0)
```

Re-flash the ESP32-S3 after changing these values.

---

## Running the Full System

### Option A — Simulation First (Recommended)

Test the full pipeline in simulation before using real hardware:

```bash
# Terminal 1: Build and launch mjswan scene
cd sim && python build_scene.py

# Terminal 2: Start the WebSocket bridge
npm run sim:3d

# Terminal 3: Start the RoClaw stack (pointing to bridge)
# .env should have ESP32_S3_HOST=127.0.0.1
npm run dev
```

Open `http://localhost:8000?bridge=ws://localhost:9090` to see the 3D simulation.

### Option B — Real Hardware

```bash
# Ensure .env points to real hardware IPs
# ESP32_S3_HOST=192.168.1.100
# ESP32_CAM_HOST=192.168.1.50

# Start the RoClaw stack
npm run dev
```

The system will:
1. Connect to the Android camera stream
2. Connect to the ESP32-S3 via UDP
3. Wait for tool invocations from the OpenClaw Gateway (or run standalone)

### Option C — Quick Test Without Gateway

Run a standalone navigation command:

```bash
npm run hardware:test -- --test navigate --goal "go to the red object"
```

This starts the vision loop with the specified goal, runs for 30 seconds, and logs the trace.

---

## Architecture Comparison: Simulation vs Hardware

```
┌─────────────────────────────────────────────────┐
│                 SIMULATION                       │
│                                                  │
│  Browser (mjswan)                                │
│  ├── MuJoCo WASM (physics)                       │
│  ├── Three.js (rendering)                        │
│  └── Camera "eyes" (virtual)                     │
│         ↕ WebSocket :9090                        │
│  mjswan_bridge.ts                                │
│  ├── Translates bytecodes → ctrl values          │
│  ├── Renders MJPEG from MuJoCo camera            │
│  └── Serves MJPEG on :8081                       │
│         ↕ UDP :4210                              │
│  RoClaw Stack (index.ts)                         │
│  ├── VisionLoop → reads :8081/stream             │
│  ├── VLM inference (Gemini/Qwen)                 │
│  └── BytecodeCompiler → UDPTransmitter           │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│                 REAL HARDWARE                     │
│                                                  │
│  Android Phone (tripod, overhead)                │
│  └── IP Webcam (MJPEG on :8080/video)            │
│         ↕ WiFi                                   │
│  RoClaw Stack (index.ts)                         │
│  ├── VisionLoop → reads phone MJPEG              │
│  ├── VLM inference (Gemini/Qwen)                 │
│  └── BytecodeCompiler → UDPTransmitter           │
│         ↕ UDP :4210 (WiFi)                       │
│  ESP32-S3                                        │
│  ├── Receives 6-byte bytecodes                   │
│  ├── AccelStepper motor control                  │
│  └── ULN2003 → 28BYJ-48 motors                  │
│         ↕                                        │
│  Physical Robot (wheels on floor)                │
└─────────────────────────────────────────────────┘
```

The RoClaw stack (`index.ts`) is **identical** in both cases. The only difference is the `.env` configuration pointing to either localhost (simulation) or real device IPs (hardware).

---

## Sim2Real Transfer

Experiences gained in simulation transfer to real hardware through the evolving-memory dream engine:

| Source | Fidelity Weight | Description |
|--------|----------------|-------------|
| `REAL_WORLD` | 1.0 | Real hardware traces (highest trust) |
| `SIM_3D` | 0.8 | mjswan MuJoCo simulation |
| `SIM_2D` | 0.5 | Virtual simulator (kinematics only) |
| `DREAM_TEXT` | 0.3 | Text-based dream scenarios |

Strategies learned in simulation are validated against real-world traces during dream consolidation. Over time, the system learns to trust patterns that are consistent across both simulation and reality.

---

## Safety Notes

1. **Host Timeout:** The ESP32 firmware triggers an emergency stop if no command is received for 2 seconds. The VisionLoop sends heartbeat frames during slow VLM inference to prevent this.

2. **Emergency Stop:** Send `AA 07 00 00 07 FF` (STOP) at any time to halt all motors immediately.

3. **Maximum Continuous Runtime:** The firmware limits continuous motor operation to 30 seconds per command sequence.

4. **Power:** Never exceed 5V on the motor drivers. The 28BYJ-48 draws ~240mA per motor when energized — ensure your supply can handle 500mA+ sustained.

5. **Motor Coils:** After a STOP command (with holdMode=0), motor coils are de-energized to save power and reduce heat. Use holdMode=1 (`AA 07 01 00 06 FF`) if you need position hold.

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Motors don't move | Ground not shared | Verify all GNDs are connected |
| ESP32 resets during motor start | Missing capacitor | Add 1000uF cap across power rails |
| Only one motor works | Wrong GPIO pins | Check wiring matches pin table above |
| Robot curves instead of straight | Motor speed mismatch | Normal — run calibration |
| WiFi disconnects under load | Power supply too weak | Use 5V 3A supply, add capacitor |
| "Host timeout — emergency stop!" | VLM too slow | Check heartbeat is working, or increase `HOST_TIMEOUT_MS` in firmware |
| Camera stream loads in browser but not in RoClaw | Wrong path | IP Webcam = `/video`, DroidCam = `/mjpegfeed` |
| `RSSI: -80` or worse in status | Weak WiFi signal | Move ESP32 closer to router |
| Robot oscillates left/right | VLM stuck pattern | Normal — stuck detection triggers recovery automatically |

---

## Next Steps

After completing V1 setup and testing:

1. **Run navigation experiments** — Use `npm run dev` with a goal like "navigate to the red cube"
2. **Record traces** — All bytecodes are logged for dream consolidation
3. **Trigger dreaming** — Run `npm run dream` to consolidate experiences into strategies
4. **Compare sim vs real** — Run the same goal in simulation and on hardware
5. **Iterate calibration** — Adjust wheel diameter and base as you collect more data

### Future Upgrades

| Upgrade | What Changes |
|---------|-------------|
| **Add ESP32-CAM** | Mount on robot, switch `ESP32_CAM_PATH=/stream` — onboard perception |
| **Hybrid vision** | Use both external + onboard cameras for redundancy |
| **Battery power** | 4x AA batteries + voltage regulator for untethered operation |
| **Encoders** | Optical encoders on wheels for better odometry than dead reckoning |
| **IMU** | Add MPU6050 to ESP32-S3 for accelerometer + gyroscope data |
