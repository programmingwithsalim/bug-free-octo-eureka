"""Dependency-free test runner: python mt5-bridge/run_tests.py"""
import glob
import importlib
import os
import sys
import traceback

here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
failed = passed = 0
for path in sorted(glob.glob(os.path.join(here, "test_*.py"))):
    mod = importlib.import_module(os.path.basename(path)[:-3])
    for name in sorted(dir(mod)):
        if name.startswith("test_"):
            try:
                getattr(mod, name)()
                passed += 1
            except Exception:
                failed += 1
                print(f"FAIL {mod.__name__}.{name}")
                traceback.print_exc()
print(f"{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
