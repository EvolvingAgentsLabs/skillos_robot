# RoClaw V1 — Hardware Bill of Materials

## Bill of Materials

| # | Component | Quantity | Description |
|---|-----------|----------|-------------|
| 1 | ESP32-S3-DevKitC-1 | 1 | WiFi motor controller (GPIO4-7, GPIO15-18 for ULN2003) |
| 2 | ESP32-CAM (AI-Thinker) | 1 | WiFi camera, MJPEG streaming at 320x240 ~10fps |
| 3 | 28BYJ-48 Stepper Motor | 2 | 5V unipolar, 4096 steps/rev (64:1 gear ratio), ~15 RPM |
| 4 | ULN2003 Driver Board | 2 | Darlington array stepper driver |
| 5 | Wheels (6cm diameter) | 2 | Press-fit or 3D-printed for 28BYJ-48 shaft |
| 6 | Ball Caster | 1 | Rear support, low friction |
| 7 | 5V 2A Power Supply | 1 | USB-C or barrel jack, powers both ESP32s and motors |
| 8 | 3D-Printed Cube Chassis | 1 | 20cm cube, mounts all components |
| 9 | Jumper Wires | ~20 | Dupont female-female and male-female |
| 10 | USB-C Cable | 2 | Programming and power for each ESP32 |

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Host PC                         │
│  ┌──────────────┐    ┌────────────────────────┐ │
│  │  Qwen-VL     │    │  RoClaw Cerebellum     │ │
│  │  (VLM)       │◄──►│  (TypeScript runtime)  │ │
│  └──────┬───────┘    └───────────┬────────────┘ │
│         │                        │               │
│         │ Vision Frames          │ Bytecode (6B) │
└─────────┼────────────────────────┼───────────────┘
          │ HTTP MJPEG             │ UDP Binary
          │ port 80               │ port 4210
          ▼                        ▼
   ┌─────────────┐         ┌──────────────┐
   │  ESP32-CAM   │         │  ESP32-S3     │
   │  (eyes)      │         │  (spinal cord)│
   │  WiFi STA    │         │  WiFi STA     │
   └─────────────┘         └──────┬───────┘
                                   │
                            ┌──────┴───────┐
                            │   ULN2003    │
                            │   x2         │
                            └──────┬───────┘
                                   │
                            ┌──────┴───────┐
                            │  28BYJ-48    │
                            │  x2          │
                            └──────────────┘
```

## Wiring — ESP32-S3 to ULN2003 Drivers

**Left Motor (ULN2003 #1):**

| ESP32-S3 GPIO | ULN2003 Pin | 28BYJ-48 Coil |
|---------------|-------------|----------------|
| GPIO 4 | IN1 | Blue |
| GPIO 5 | IN2 | Pink |
| GPIO 6 | IN3 | Yellow |
| GPIO 7 | IN4 | Orange |

**Right Motor (ULN2003 #2):**

| ESP32-S3 GPIO | ULN2003 Pin | 28BYJ-48 Coil |
|---------------|-------------|----------------|
| GPIO 15 | IN1 | Blue |
| GPIO 16 | IN2 | Pink |
| GPIO 17 | IN3 | Yellow |
| GPIO 18 | IN4 | Orange |

**Power:**
- ULN2003 VCC -> 5V rail
- ULN2003 GND -> Common ground
- 28BYJ-48 Red wire -> 5V (via ULN2003 board connector)

## Motor Specifications — 28BYJ-48

| Parameter | Value |
|-----------|-------|
| Steps per revolution | 4096 (with 64:1 gear ratio) |
| Max RPM | ~15 |
| Operating voltage | 5V DC |
| Current draw (per coil) | ~240mA |
| Holding torque | ~34 mN-m |
| Step angle (internal) | 5.625 deg |
| Gear ratio | 64:1 |

## Kinematic Constants

| Parameter | Value |
|-----------|-------|
| Wheel diameter | 6.0 cm |
| Wheel circumference | 18.85 cm |
| Wheel base | 10.0 cm |
| Steps per cm | ~217.3 |
| Max speed | 1024 steps/s (~4.71 cm/s) |
| Max acceleration | 512 steps/s^2 |

## Bytecode Protocol — 6-byte Binary Frames

RoClaw uses a 6-byte binary protocol over UDP port 4210. No JSON. No parsing overhead.

**Frame Format:**

```
Byte 0: 0xAA  (start marker)
Byte 1: OPCODE
Byte 2: PARAM_LEFT  (0-255)
Byte 3: PARAM_RIGHT (0-255)
Byte 4: CHECKSUM    (XOR of bytes 1-3)
Byte 5: 0xFF  (end marker)
```

**Example — "Move forward at speed 100":**

```
JSON (58 bytes):     {"cmd":"move_cm","left_cm":10,"right_cm":10,"speed":500}
Bytecode (6 bytes):  AA 01 64 64 CB FF
```

## 3D-Printed Parts

See `stl_files/` for all printable chassis components:
- `base.stl` — Main base plate
- `Shell.stl` / `Shell_B.stl` — Outer shell halves
- `Base_Shell_Flex_support.stl` / `Base_Shell_Flex_support_2.stl` — Flexible supports
- `ESP32_front_support.stl` — Camera mount
- `wheel.stl` / `wheel_B.stl` — Left and right wheels

Open `Robot_one_scene.blend` in Blender to see the full assembly.
