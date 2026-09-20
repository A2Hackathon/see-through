import unittest

from server.spatial import (
    CalibrationConfig,
    bearing_degrees,
    bbox_geometry,
    estimate_distance_m,
)


class SpatialCalibrationTests(unittest.TestCase):
    def setUp(self):
        self.calibration = CalibrationConfig()

    def test_bbox_geometry_returns_expected_points(self):
        geometry = bbox_geometry([100, 50, 200, 400], 1000, 800)

        self.assertEqual(geometry["center"], {"x": 200.0, "y": 250.0})
        self.assertEqual(geometry["bottom_center"], {"x": 200.0, "y": 450.0})
        self.assertEqual(geometry["normalized_center"], {"x": 0.2, "y": 0.3125})

    def test_center_has_zero_bearing_and_sides_have_opposite_signs(self):
        self.assertAlmostEqual(bearing_degrees(500, 1000), 0.0)
        self.assertLess(bearing_degrees(250, 1000), 0.0)
        self.assertGreater(bearing_degrees(750, 1000), 0.0)

    def test_larger_object_is_estimated_as_closer(self):
        far = estimate_distance_m(100, "person", 1000, self.calibration)
        near = estimate_distance_m(200, "person", 1000, self.calibration)

        self.assertGreater(far, near)

    def test_unsupported_label_has_no_distance(self):
        self.assertIsNone(estimate_distance_m(100, "bicycle", 1000, self.calibration))

    def test_invalid_geometry_has_no_result(self):
        self.assertIsNone(bbox_geometry([0, 0, 0, 10], 1000, 800))
        self.assertIsNone(bearing_degrees(10, 0))
        self.assertIsNone(estimate_distance_m(0, "person", 1000, self.calibration))


if __name__ == "__main__":
    unittest.main()