"""Camera geometry and provisional monocular distance estimates."""

from dataclasses import dataclass, field
import math
from typing import Any, Mapping, Optional, Sequence


@dataclass(frozen=True)
class CalibrationConfig:
    """Provisional camera calibration, replace with OpenGlass measurements later."""

    hfov_deg: float = 70.0
    reference_heights_m: Mapping[str, float] = field(
        default_factory=lambda: {
            "person": 1.70,
            "car": 1.50,
            "stop sign": 0.75,
        }
    )

    def focal_length_x(self, image_width: int) -> Optional[float]:
        if image_width <= 0 or not 0 < self.hfov_deg < 180:
            return None
        return image_width / (2.0 * math.tan(math.radians(self.hfov_deg) / 2.0))


def bbox_geometry(
    box: Sequence[float], image_width: int, image_height: int
) -> Optional[dict[str, Any]]:
    """Return pixel and normalized geometry for [x, y, width, height]."""
    if len(box) != 4 or image_width <= 0 or image_height <= 0:
        return None

    x, y, width, height = (float(value) for value in box)
    if width <= 0 or height <= 0:
        return None

    center_x = x + width / 2.0
    center_y = y + height / 2.0
    return {
        "center": {"x": round(center_x, 2), "y": round(center_y, 2)},
        "bottom_center": {
            "x": round(center_x, 2),
            "y": round(y + height, 2),
        },
        "normalized_center": {
            "x": round(center_x / image_width, 4),
            "y": round(center_y / image_height, 4),
        },
        "width_px": round(width, 2),
        "height_px": round(height, 2),
    }


def bearing_degrees(
    center_x: float, image_width: int, hfov_deg: float = 70.0
) -> Optional[float]:
    """Estimate horizontal bearing: negative left, positive right."""
    if image_width <= 0 or not 0 < hfov_deg < 180:
        return None

    focal_length_x = image_width / (
        2.0 * math.tan(math.radians(hfov_deg) / 2.0)
    )
    bearing = math.degrees(math.atan((center_x - image_width / 2.0) / focal_length_x))
    return round(bearing, 2)


def estimate_distance_m(
    pixel_height: float,
    label: str,
    image_width: int,
    calibration: CalibrationConfig,
) -> Optional[float]:
    """Estimate distance from apparent object height using a pinhole model."""
    if pixel_height <= 0 or image_width <= 0:
        return None

    reference_height = calibration.reference_heights_m.get(label.lower().strip())
    focal_length = calibration.focal_length_x(image_width)
    if reference_height is None or focal_length is None:
        return None

    return round((focal_length * reference_height) / pixel_height, 2)
