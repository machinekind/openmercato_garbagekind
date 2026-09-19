import cv2
import numpy as np
import pytest

from om_bridge.vision import VisionError, fetch_observation_images, jpeg_to_chw_rgb


def jpeg_of(color_bgr):
    frame = np.zeros((8, 12, 3), dtype=np.uint8)
    frame[:, :] = color_bgr
    ok, buf = cv2.imencode(".jpg", frame)
    assert ok
    return buf.tobytes()


def test_decode_returns_channel_first_rgb():
    # Pure blue in BGR must come back as blue in the *last* RGB channel.
    chw = jpeg_to_chw_rgb(jpeg_of((255, 0, 0)))

    assert chw.shape == (3, 8, 12)
    assert chw.dtype == np.uint8
    assert chw[2].mean() > 200 and chw[0].mean() < 50


def test_decode_rejects_garbage():
    with pytest.raises(VisionError, match="could not decode"):
        jpeg_to_chw_rgb(b"not a jpeg")


class StubArm:
    def __init__(self, frames):
        self.frames = frames

    async def frame(self, camera):
        value = self.frames[camera]
        if isinstance(value, Exception):
            raise value
        return value


async def test_frames_are_keyed_for_the_policy_server():
    arm = StubArm({"robot": jpeg_of((0, 0, 255)), "wrist": jpeg_of((0, 255, 0))})

    images = await fetch_observation_images(arm)

    assert set(images) == {"head_rgb", "left_wrist_rgb"}
    assert images["head_rgb"].shape == (3, 8, 12)


async def test_a_missing_wrist_camera_is_fatal():
    # Without a view down the grasp axis the plans were not reproducible.
    arm = StubArm({"robot": jpeg_of((0, 0, 255)), "wrist": RuntimeError("stream ended")})

    with pytest.raises(VisionError, match="wrist camera unavailable"):
        await fetch_observation_images(arm)
