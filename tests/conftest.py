"""Tests never call a real model, even when .env holds a Foundry key."""

import os

os.environ["CHALK_OFFLINE"] = "1"
