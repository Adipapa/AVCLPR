from __future__ import annotations

import threading

# Ultralytics/Tesseract execution is shared by camera workers. Serializing model
# calls avoids unsafe concurrent access to a single loaded model instance.
AI_INFERENCE_LOCK = threading.RLock()
