"""Runtime configuration checks without using service credentials."""

import os
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from wind_forecast.agent import settings


class RuntimeSettingsTests(TestCase):
    def test_shared_typesafe_key_is_fallback_to_host_key(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "typesafe.env").write_text("TYPESAFE_API_KEY=example-shared\n")
            module_file = root / "src/wind_forecast/agent/settings.py"
            module_file.parent.mkdir(parents=True)
            with patch.object(settings, "__file__", str(module_file)):
                with patch.dict(os.environ, {"TYPESAFE_API_KEY": ""}):
                    self.assertEqual(
                        settings.runtime_settings()["typesafe_api_key"], "example-shared"
                    )
                with patch.dict(os.environ, {"TYPESAFE_API_KEY": "example-host"}):
                    self.assertEqual(
                        settings.runtime_settings()["typesafe_api_key"], "example-host"
                    )
