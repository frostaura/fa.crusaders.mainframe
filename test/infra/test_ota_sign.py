"""ota_sign.py: the release key and the signature every OTA image carries (device-api.md section 7).

The tool had been named by the spec, the gate's secrets.h.example, the server's errors and the
go-live checklist, and did not exist — so no image could ever have been signed, and the gate's
signed OTA was a lifeline nobody could pull. These tests hold it to the contract's own reference
verifier (ota/gen_cases.py), the one the C++ and C# verifiers are already held to, so a signature
this tool writes is one every board and the server accept, and nothing else is.
"""

from __future__ import annotations

import importlib.util
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path

from infra_support import REPO


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sign = load("ota_sign", REPO / "src" / "iot" / "tools" / "ota_sign.py")
reference = load("ota_reference", REPO / "src" / "contracts" / "device-protocol" / "ota" / "gen_cases.py")


class OtaSignTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        cls.key_path = Path(cls.dir.name) / "release.key"
        cls.n, cls.d = sign.generate()
        sign.write_key(cls.key_path, cls.n, cls.d)

    @classmethod
    def tearDownClass(cls):
        cls.dir.cleanup()

    def test_a_fresh_key_is_2048_bits_and_written_for_its_owner_only(self):
        self.assertEqual(self.n.bit_length(), 2048)
        self.assertEqual(stat.S_IMODE(os.stat(self.key_path).st_mode), 0o600)
        self.assertEqual(sign.read_key(self.key_path), (self.n, self.d))

    def test_keygen_never_overwrites_a_release_key(self):
        with self.assertRaises(SystemExit):
            sign.write_key(self.key_path, self.n, self.d)

    def test_a_signed_manifest_verifies_under_the_contracts_reference_and_binds_every_field(self):
        image = bytes(range(256)) * 40
        m = sign.build_manifest(image, "court_bridge", "3.0.1", self.n, self.d)
        self.assertEqual(set(m), {"target", "version", "size", "sha256", "sig"})
        text = reference.manifest_text(m["target"], m["version"], m["size"], m["sha256"])
        self.assertEqual(reference.verify(text, m["sig"], self.n)[0], True)
        # Each signed field, varied on its own, no longer verifies: the target, the version and the
        # size are inside what is signed, so an image cannot be re-offered as something it is not.
        for varied in (reference.manifest_text("door_gate", m["version"], m["size"], m["sha256"]),
                       reference.manifest_text(m["target"], "3.0.2", m["size"], m["sha256"]),
                       reference.manifest_text(m["target"], m["version"], m["size"] + 1, m["sha256"])):
            self.assertEqual(reference.verify(varied, m["sig"], self.n)[0], False)
        # And the corpus's own test key does not accept it.
        self.assertEqual(reference.verify(text, m["sig"], reference.N)[0], False)

    def test_the_corpus_test_keys_are_refused_both_ways(self):
        with tempfile.TemporaryDirectory() as tmp:
            test_key = Path(tmp) / "test.key"
            sign.write_key(test_key, reference.N, reference.D)
            with self.assertRaises(SystemExit):
                sign.read_key(test_key)
        self.assertIn(reference.N, sign.corpus_test_moduli())
        self.assertIn(reference.N_OTHER, sign.corpus_test_moduli())

    def test_an_image_the_board_could_not_take_is_refused(self):
        for target, version, size in (("court_mega", "3.0.1", 10), ("court_bridge", "3.01", 10),
                                      ("court_bridge", "3.0.1", 0), ("door_gate", "2.0.1", 1310721)):
            with self.subTest(target=target, version=version, size=size), self.assertRaises(SystemExit):
                sign.build_manifest(b"\x00" * size, target, version, self.n, self.d)

    def test_sign_writes_the_manifest_the_console_uploads(self):
        with tempfile.TemporaryDirectory() as tmp:
            image = Path(tmp) / "door_gate.bin"
            image.write_bytes(b"\xe9" + os.urandom(4095))
            self.assertEqual(sign.main(["sign", "--key", str(self.key_path), "--target", "door_gate",
                                        "--version", "2.0.1", str(image)]), 0)
            manifest = json.loads((Path(tmp) / "door_gate.bin.manifest.json").read_text())
            self.assertEqual((manifest["target"], manifest["version"], manifest["size"]), ("door_gate", "2.0.1", 4096))
            text = reference.manifest_text("door_gate", "2.0.1", 4096, manifest["sha256"])
            self.assertTrue(reference.verify(text, manifest["sig"], self.n)[0])


if __name__ == "__main__":
    unittest.main()
