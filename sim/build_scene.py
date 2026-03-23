"""
Build the RoClaw 3D simulation scene using mjswan.

Loads the MJCF robot model and creates a mjswan project with a
"Navigation Arena" scene. No ONNX policy is used — RoClaw's VLM
is the policy, controlled via the WebSocket bridge.

The scene includes two cameras:
  - "eyes": Forward-facing on robot chassis (first-person view)
  - "external_cam": Overhead bird's-eye view (matches V1 Android phone on tripod)

The bridge (mjswan_bridge.ts) can render from either camera. By default
it uses "eyes" for the VisionLoop. Set --camera external_cam on the bridge
to simulate the V1 external camera architecture.

Usage:
    cd sim && python build_scene.py
"""

import os
import mjswan
import mujoco

# Resolve paths relative to this script's directory
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MJCF_PATH = os.path.join(SCRIPT_DIR, "roclaw_robot.xml")
DIST_DIR = os.path.join(SCRIPT_DIR, "dist")

spec = mujoco.MjSpec.from_file(MJCF_PATH)

builder = mjswan.Builder()
project = builder.add_project("RoClaw Sim")
project.add_scene(spec=spec, name="Navigation Arena")

app = builder.build(DIST_DIR)
app.launch(port=8000)
